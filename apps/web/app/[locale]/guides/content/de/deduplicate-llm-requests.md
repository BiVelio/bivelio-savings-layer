Jede LLM-API rechnet pro Aufruf ab. Sendet deine App dieselbe Anfrage zweimal, zahlst du zweimal, obwohl die zweite Antwort nichts Neues bringt. Dieser Leitfaden zeigt zwei Techniken, die das verhindern: einen **Antwort-Cache mit exakter Übereinstimmung** für Wiederholungen, die später eintreffen, und **In-Flight-Coalescing** für identische Anfragen, die im selben Moment eintreffen. Beide funktionieren in jeder Sprache und mit jedem Anbieter. Am Ende siehst du, wie das Open-Source-SDK von BV-SALA standardmäßig beides tut und wie du die Einsparung mit den eigenen Nutzungszahlen deines Anbieters abgleichst.

## Woher doppelte Anfragen kommen

Duplikate sind häufiger, als es scheint, weil sie selten von einer einzigen offensichtlichen Stelle kommen:

- **Retries und Doppelklicks.** Ein Nutzer drückt zweimal auf „Generieren“, oder eine Client-Bibliothek wiederholt nach einem Timeout eine Anfrage, die der Anbieter in Wirklichkeit schon beantwortet hatte.
- **Batch-Jobs und Crons.** Ein nächtlicher Job klassifiziert dieselben Produktbeschreibungen, FAQ-Einträge oder Support-Textbausteine, die er gestern schon klassifiziert hat.
- **Fan-out.** Zwei Worker, zwei Browser-Tabs oder ein React-Effect, der in der Entwicklung zweimal läuft, senden denselben Prompt innerhalb von Millisekunden.
- **Agents und Pipelines.** Eine mehrstufige Pipeline stellt dieselbe Teilfrage in mehreren Zweigen.
- **Tests und Evals.** Die CI lässt bei jedem Push dieselben Fixtures gegen die Live-API laufen.

Die erste und die letzte Gruppe sind Wiederholungen über die Zeit; Fan-out ist Nebenläufigkeit. Sie brauchen unterschiedliche Lösungen, und deshalb behandelt dieser Leitfaden beide.

## Miss zuerst deine Duplikatrate

Bevor du irgendetwas baust, finde heraus, wie viel deines Traffics sich wiederholt. Hashe einen Tag lang jeden Request-Body und zähle. Der Schlüssel muss **kanonisch** sein: Dieselbe Anfrage muss dieselben Bytes ergeben, egal in welcher Reihenfolge die JSON-Schlüssel stehen.

```ts
import { createHash } from "node:crypto";

// Canonical JSON: the same object gives the same text, whatever the key order.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function requestKey(body: object, scope = "global"): string {
  return createHash("sha256").update(`${scope}\n${canonical(body)}`).digest("hex");
}

// Feed it one day of request bodies, then read the share that repeated.
const seen = new Map<string, number>();
export function record(body: object): void {
  const key = requestKey(body);
  seen.set(key, (seen.get(key) ?? 0) + 1);
}
export function duplicateRate(): number {
  let total = 0;
  for (const n of seen.values()) total += n;
  return total === 0 ? 0 : (total - seen.size) / total;
}
```

Liegt die Rate nahe null, spart dir ein Antwort-Cache nicht viel, und du solltest dir stattdessen [Prompt-Caching](/de/guides/claude-prompt-caching-not-working) oder die [Modellwahl](/de/guides/reduce-openai-api-costs) ansehen. Wiederholt sich ein spürbarer Teil deiner Anfragen, lies weiter.

## Einen Cache-Schlüssel bauen, der wirklich sicher ist

Ein exakter Cache ist nur so gut wie sein Schlüssel. Die Regel ist einfach: **Alles, was die Antwort ändern kann, gehört in den Schlüssel, und nichts wird wegnormalisiert.**

- Die Modell-ID, die vollständige Nachrichtenliste, der System-Prompt, die Tool-Definitionen, das Antwortformat oder JSON-Schema und jeder Sampling-Parameter (`temperature`, `top_p`, `max_tokens`, `seed`, Reasoning-Aufwand).
- Ein **Scope**, wenn der Prompt Nutzerdaten enthält. Zwei Nutzer, die fragen „Wie hoch ist mein Kontostand?“, senden denselben Text und brauchen unterschiedliche Antworten. Nimm die Nutzer- oder Mandanten-ID in den Schlüssel auf, oder cache diese Anfragen gar nicht.
- Keine „clevere“ Normalisierung. Wer Kleinbuchstaben erzwingt, Leerzeichen trimmt oder Satzzeichen entfernt, um mehr Treffer zu bekommen, macht aus einem exakten Cache einen unscharfen, und ein unscharfer Cache kann die Antwort auf eine andere Frage zurückgeben.

## Was nie aus einem Cache kommen darf

Manche Anfragen wiederholen sich, müssen das Modell aber trotzdem jedes Mal erreichen:

- **Antworten, die sich ändern müssen**: „wähle einen zufälligen Namen“, „generiere ein Passwort“, „wie spät ist es“, „der heutige Preis“. Eine gecachte Antwort ist hier ein Bug, keine Einsparung.
- **Tools mit Seiteneffekten.** Fordert die Antwort einen Aufruf von `send_email` oder `create_order` an, überspringt ein Replay die Aktion. Cache nur Anfragen, deren Tools rein lesend sind, oder solche ohne Tools.
- **Gesampelte Ausgabe, bei der Nutzer Abwechslung erwarten.** Bei hoher `temperature` ist eine gecachte Antwort nur eine einzige Stichprobe, die für immer ausgeliefert wird.
- **Fehler, leere Antworten, Ablehnungen und abgeschnittene Antworten.** Schreib sie nie in den Cache; lass die nächste Anfrage es erneut versuchen.
- **Sensible Themen.** Ein Support-Bot sollte Antworten zu Selbstverletzung oder einem medizinischen Notfall nicht cachen; schick diese jedes Mal an das Modell.

## Identische Anfragen im Flug zusammenführen

Ein Cache hilft erst, wenn die erste Antwort angekommen ist. Starten zehn identische Anfragen innerhalb derselben 300 ms, verfehlen alle zehn den Cache. Die Lösung ist ein winziges Muster, das oft *singleflight* genannt wird: Der erste Aufrufer macht den Aufruf, die anderen warten auf dasselbe Promise.

```ts
const inFlight = new Map<string, Promise<unknown>>();

export function singleflight<T>(key: string, call: () => Promise<T>): Promise<T> {
  const running = inFlight.get(key) as Promise<T> | undefined;
  if (running) return running; // join the call that is already on its way
  const p = call().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p; // an error reaches every caller that joined, so nobody waits forever
}
```

In Produktion zählen drei Details. Fehler müssen jeden wartenden Aufrufer erreichen (das Muster oben tut das). Bricht ein Aufrufer ab, darf das den gemeinsamen Aufruf für die anderen nicht abbrechen. Und Streaming ist schwieriger: Ein Stream, der schon begonnen hat, lässt sich nicht einfach an einen zweiten Aufrufer übergeben, deshalb lassen die meisten Implementierungen eine normale Anfrage an einen laufenden Aufruf andocken, aber nichts an einen Stream.

## So macht es BV-SALA

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) ist eine Sparschicht für TypeScript unter Apache-2.0. Ihr SDK umschließt deinen Anbieter und schaltet **ohne Schlüssel und ohne Registrierung** beide Techniken standardmäßig ein: einen exakten Cache und die Deduplizierung gleichzeitig laufender Anfragen. Außerdem wendet es die „Nie cachen“-Regeln von oben an: Anfragen, deren Formulierung nach Aktuellem oder Zufälligem verlangt, persönliche Formulierungen ohne Session, sensible Themen, Ablehnungen und Fehler bleiben aus dem Cache heraus.

```ts
// npm i @bivelio/savings-layer   (ESM: a "type": "module" project or a .mts file)
import { createSavingsLayer, OpenAICompatibleProvider } from "@bivelio/savings-layer";

const layer = createSavingsLayer({
  provider: new OpenAICompatibleProvider({
    baseUrl: "https://api.openai.com/v1",
    apiKey: process.env.OPENAI_API_KEY,
  }),
  // Nothing else is required: the exact cache and deduplication are on by default.
});

const request = {
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user" as const, content: "Classify the sentiment as positive or negative: The battery lasts two days." }],
  temperature: 0,
};

const first = await layer.generate(request);
const again = await layer.generate(request);
console.log(first.report.cache.result, again.report.cache.result); // "miss" "exact"
console.log(again.report.calls.avoidedLlm); // 1: the repeat never reached the provider

// Two identical requests at the same moment: one call, shared by both.
const other = { ...request, messages: [{ role: "user" as const, content: "Classify the sentiment as positive or negative: Shipping took a month." }] };
const [a, b] = await Promise.all([layer.generate(other), layer.generate(other)]);
console.log(a.report.cache.result, b.report.cache.result); // "miss" "singleflight"
```

Eine Anfrage, die persönlich klingt („meine Bestellung“, „unsere Rechnung“), wird nicht gecacht, solange du nicht sagst, wem sie gehört. Übergib einen Scope, und der Cache funktioniert wieder, getrennt für jede Session:

```ts
import { createSavingsLayer, OpenAICompatibleProvider } from "@bivelio/savings-layer";

const layer = createSavingsLayer({
  provider: new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY }),
});

const answer = await layer.generate({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "Translate to French: the invoice for my order is attached." }],
  context: { sessionId: "user-42" }, // cached for this session only
});
console.log(answer.report.cache.result);
```

Der Standard-Cache liegt im Speicher eines einzelnen Prozesses. Um ihn zwischen mehreren Servern oder Serverless-Instanzen zu teilen, übergib über die Option `exactCache` einen Store, den du selbst betreibst. Er braucht drei Methoden, also funktioniert jeder Key-Value-Store:

```ts
import { createSavingsLayer, OpenAICompatibleProvider, type ExactCache } from "@bivelio/savings-layer";

// The three calls a Redis client offers; adapt the names to yours.
interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "PX", ttlMs: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export function sharedLayer(redis: RedisLike) {
  const exactCache: ExactCache = {
    async get(key) {
      const raw = await redis.get(`bvsala:${key}`);
      return raw ? JSON.parse(raw) : null;
    },
    async set(key, value, ttlMs) {
      await redis.set(`bvsala:${key}`, JSON.stringify(value), "PX", ttlMs ?? 3_600_000);
    },
    async delete(key) {
      await redis.del(`bvsala:${key}`);
    },
  };
  return createSavingsLayer({
    provider: new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY }),
    exactCache,
  });
}
```

Die gecachten Antworten bleiben in deiner Infrastruktur. Wenn du ohne Schlüssel arbeitest, wird nichts an BiVelio gesendet.

## Die Einsparung mit den Zahlen deines Anbieters abgleichen

Eine Cache-Einsparung lässt sich leicht prüfen, denn sie ist eine Zählung von Aufrufen, die nicht stattgefunden haben.

1. **Zähle die Aufrufe auf beiden Seiten.** Zähle einen Tag lang die `generate()`-Aufrufe deiner App und vergleiche sie mit der Zahl der Anfragen, die dein Anbieter für denselben API-Schlüssel und dasselbe Modell anzeigt (die Usage-Seite der OpenAI- oder Anthropic-Console oder ihre Usage-APIs). Die Differenz sollte der Summe von `report.calls.avoidedLlm` entsprechen.
2. **Lies ab, wie jede Wiederholung bewertet wurde.** `report.cost.basis` sagt, woher die Zahl stammt. Eine Wiederholung ist `reference`, wenn der identische Aufruf, der tatsächlich lief, direkt an die API von OpenAI, Anthropic oder Googles Gemini ging (`api.openai.com`, `api.anthropic.com` oder `generativelanguage.googleapis.com`): Ihre Basislinie ist der eigene Nutzungszähler dieses Aufrufs, konservativ zum Tarif für gecachte Eingabe bepreist. Sie bleibt `estimated`, wenn der Aufruf, der lief, irgendwo anders hinging, auch an die eigene API eines anderen Anbieters wie DeepSeek, einen Proxy, Azure oder ein Gateway, weil nur bei diesen drei APIs bekannt ist, dass die Listenpreise der Schicht mit der Rechnung übereinstimmen. Geschätzte Beträge werden immer getrennt ausgewiesen.
3. **Vergleiche Ausgaben, nicht nur Aufrufe.** Summiere `report.cost.netSavingsUsd` pro Basis. Addiere nie gemessene und geschätzte Beträge, und bilde nie den Durchschnitt von `netSavingsRatio` über Anfragen.

Für einen saubereren Test lässt du dieselbe Last zweimal laufen, einmal mit für diesen Lauf abgeschalteten Hebeln (`savings: { exactCache: false, singleflight: false }` in jeder Anfrage) und einmal mit den Standardwerten, und vergleichst die beiden Rechnungen.

## Was die öffentlichen Zahlen sagen

Das Repository veröffentlicht seine Benchmark-Läufe. Bei einer öffentlichen Last aus GSM8K-Fragen, in der 30 % der Anfragen exakte Wiederholungen waren, lag die gemessene gepoolte Reduktion für `gpt-4o-mini` bei **31,50 %**, mit einem 95 %-Intervall von 25,7 % bis 36,7 % (Artefakte des SDK 0.4.31 vom September 2026; Quelle: die [Benchmark-Seite](/de/benchmarks#savings) und das README). Bei Traffic, der sich nie wiederholt, liegt die Einsparung bei etwa 0 %, und die [Benchmark-Seite](/de/benchmarks#no-savings) zeigt auch diese flachen Ergebnisse. Sie zählt außerdem den Fehler, der für einen Cache am meisten zählt: **0 von 198** Fragevarianten bekamen die Antwort auf eine andere Frage ([Garantien](/de/benchmarks#guarantees)).

Deine Einsparung hängt von deiner Duplikatrate ab, also miss sie zuerst mit dem Snippet oben auf dieser Seite. Code, Paper und Rohberichte liegen auf [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
