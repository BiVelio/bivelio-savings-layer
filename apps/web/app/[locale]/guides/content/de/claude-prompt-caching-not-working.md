Du hast deinen Claude-Anfragen `cache_control` hinzugefügt, und die Rechnung hat sich nicht bewegt. Oder `cache_read_input_tokens` kommt bei jedem Aufruf als `0` zurück. Dieser Leitfaden erklärt, warum das passiert, wie du genau das Byte findest, das deinen Cache bricht, und wie du das Ergebnis mit Anthropics eigenen Nutzungszahlen abgleichst. Alles hier funktioniert mit jedem SDK. Am Ende siehst du, wie das Open-Source-SDK von BV-SALA die Breakpoints für dich setzt, und den einen Fall, in dem du es davon abhalten solltest.

## Lies zuerst die drei Usage-Felder

Jede Antwort der Messages API sagt dir, was mit dem Cache passiert ist. Achte auf drei Zahlen in `usage`:

| Feld | Was es zählt |
| --- | --- |
| `cache_creation_input_tokens` | Tokens, die bei diesem Aufruf in den Cache geschrieben wurden, berechnet über dem normalen Eingabepreis |
| `cache_read_input_tokens` | Tokens, die aus dem Cache kamen, berechnet zu einem Bruchteil des Eingabepreises |
| `input_tokens` | Tokens nach dem letzten Cache-Breakpoint, berechnet zum normalen Preis |

An drei Mustern erkennst du, wo du suchen musst:

- **Beide Cache-Felder sind 0.** Es wurde überhaupt nichts gecacht: Das Präfix ist kürzer als das Minimum des Modells, es gibt keinen Breakpoint, oder etwas zwischen dir und der API hat ihn entfernt.
- **Die Schreibvorgänge sind bei jedem Aufruf hoch, die Lesevorgänge bleiben bei 0.** Der Cache wird geschrieben und nie wiederverwendet: Das Präfix ändert sich zwischen den Aufrufen, der Eintrag ist abgelaufen, oder die Aufrufe gehen an ein anderes Modell oder einen anderen Workspace.
- **Die Lesevorgänge sind hoch.** Es funktioniert. Jetzt geht es nur noch darum, wie viel des Prompts vor dem Breakpoint steht.

## So funktioniert Claudes Prompt-Cache, in sechs Punkten

1. Er cacht ein **Präfix**: die Anfrage vom Anfang bis zu einem `cache_control`-Breakpoint. Die Übereinstimmung ist exakt; ein einziges abweichendes Byte, und alles danach wird erneut verarbeitet.
2. Die Reihenfolge ist **Tools, dann System, dann Messages**. Eine Änderung in der Tool-Liste macht den System-Prompt und die Messages danach ungültig.
3. Du kannst bis zu **vier Breakpoints** setzen, und die API sucht von jedem aus eine begrenzte Zahl von Blöcken rückwärts nach einem früheren Eintrag (zum Zeitpunkt des Schreibens 20).
4. Einträge leben standardmäßig **fünf Minuten** und werden bei jedem Treffer erneuert. Eine Lebensdauer von einer Stunde gibt es mit `"ttl": "1h"`.
5. Schreiben kostet mehr als Lesen: Ein Schreibvorgang mit fünf Minuten Lebensdauer wird mit dem Faktor 1,25 auf den Eingabepreis berechnet, einer mit einer Stunde mit dem Faktor 2; ein Lesevorgang kostet einen kleinen Bruchteil des Eingabepreises (bei den meisten Modellen den Faktor 0,1). Die Werte für dein Modell stehen auf [Anthropics Preisseite](https://platform.claude.com/docs/en/about-claude/pricing).
6. Es gibt eine **minimale cachebare Länge**, die vom Modell abhängt, zwischen 512 und 4.096 Tokens. Darunter wird die Anfrage einfach nicht gecacht, ohne jede Fehlermeldung.

All das steht in [Anthropics Dokumentation zum Prompt-Caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), der Quelle, auf die du dich verlassen solltest, wenn sich eine Zahl ändert.

## Die üblichen Ursachen, in der Reihenfolge, in der du sie prüfst

1. **Das Präfix ist zu kurz.** Ein System-Prompt mit 600 Tokens liegt bei mehreren Modellen unter dem Minimum. Fasse stabile Anweisungen, Beispiele und Referenztext zusammen, damit der gecachte Teil lang genug ist, um etwas auszumachen.
2. **Etwas im Präfix ändert sich bei jedem Aufruf.** Die Klassiker: ein Zeitstempel oder eine Zeile „Heute ist …“ im System-Prompt, eine Request-ID, der Name des Nutzers, eine zufällige Reihenfolge der Beispiele, Tool-Definitionen aus einem Objekt ohne feste Schlüsselreihenfolge oder ein JSON-Dokument, das mit unterschiedlichen Leerzeichen serialisiert wurde.
3. **Der Breakpoint sitzt auf Inhalt, der sich ändert.** Steht das letzte `cache_control` auf der Frage des Nutzers, schreibt jeder Aufruf einen neuen Eintrag, den niemand liest. Der Breakpoint gehört ans Ende des Teils, der sich nicht ändert.
4. **Der Eintrag ist abgelaufen.** Aufrufe, die mehr als fünf Minuten auseinanderliegen, lesen nie den Eintrag des anderen. Ein nächtlicher Batch, der alle zehn Minuten ein Element verarbeitet, zahlt jedes Mal den Schreibaufschlag und liest nichts.
5. **Die Aufrufe teilen sich keinen Cache.** Ein anderes Modell, ein anderer Workspace oder ein Modellwechsel mitten in der Unterhaltung beginnen jeweils mit einem leeren Cache.
6. **Parallele Aufrufe kommen sich in die Quere.** Ein Eintrag lässt sich erst lesen, wenn die erste Antwort begonnen hat. Zehn identische Aufrufe, die gleichzeitig abgeschickt werden, schreiben alle. Schick zuerst einen, dann den Rest.
7. **Ein Proxy entfernt die Markierung.** Ein Gateway, das `cache_control` entfernt oder ein `system` in Blockform in einen einfachen String umwandelt, sorgt dafür, dass der ganze Prompt als nicht gecachte Eingabe abgerechnet wird, während jeder Aufruf weiterhin erfolgreich ist. Die Dokumentation von Claude Code beschreibt genau diesen Fehler für [LLM-Gateways](https://code.claude.com/docs/en/prompt-caching).

## Finde das Byte, das deinen Cache bricht

Bleiben die Lesevorgänge bei null, protokolliere zwei aufeinanderfolgende Request-Bodys und such die erste Stelle, an der sie sich unterscheiden, in der Reihenfolge, in der der Cache sie liest:

```ts
type Body = { tools?: unknown[]; system?: unknown; messages: unknown[] };

// The cache reads tools, then system, then messages. Compare in that order.
const inCacheOrder = (b: Body) => JSON.stringify([b.tools ?? [], b.system ?? "", b.messages]);

export function firstDifference(a: Body, b: Body): string | null {
  const x = inCacheOrder(a);
  const y = inCacheOrder(b);
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  if (i === x.length && i === y.length) return null;
  return `differs at character ${i}:\n  ${x.slice(Math.max(0, i - 40), i + 40)}\n  ${y.slice(Math.max(0, i - 40), i + 40)}`;
}
```

Liegt der erste Unterschied im System-Prompt oder in der Tool-Liste, hast du deinen Cache-Miss gefunden. Verschiebe diesen Teil ans Ende der Anfrage, meist in die User-Nachricht.

Verfolge danach die Trefferquote pro Aufruf, damit eine Regression am selben Tag auffällt, an dem sie ausgeliefert wird:

```ts
interface ClaudeUsage {
  input_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** Share of the input tokens that were read from the cache on this call. */
export function cacheHitRate(u: ClaudeUsage): number {
  const read = u.cache_read_input_tokens ?? 0;
  const written = u.cache_creation_input_tokens ?? 0;
  const total = read + written + u.input_tokens;
  return total === 0 ? 0 : read / total;
}
```

## Lohnt sich Caching für deinen Traffic?

Weil Schreibvorgänge mehr kosten als normale Eingabe, ist Caching eine Wette darauf, dass das Präfix erneut gelesen wird, bevor es abläuft. Bei der Lebensdauer von fünf Minuten bezahlt schon ein einziger Lesevorgang den Schreibvorgang. Ein Präfix, das geschrieben und nie gelesen wird, kostet etwa 25 % mehr, als es ohne Markierung zu senden. Deshalb ist „überall `cache_control` setzen“ kein sicherer Standard: Es zahlt sich bei Chat- und Agent-Traffic aus, der innerhalb von Minuten wiederkommt, und verliert bei einmaligen Anfragen oder bei Prompts, die sich jedes Mal ändern.

## So geht BV-SALA damit um

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) ist eine Sparschicht unter Apache-2.0. Mit `AnthropicProvider` setzt sie die Breakpoints für dich, kostenlos und ohne Schlüssel: einen am Ende des System-Prompts und einen am Ende des Teils der Unterhaltung, der sich nicht ändert, nie mehr, als die API erlaubt. Der Bericht jedes Aufrufs zeigt anhand von Anthropics eigenen Zählern, was der Cache getan hat:

```ts
// npm i @bivelio/savings-layer   (ESM: a "type": "module" project or a .mts file)
import { createSavingsLayer, AnthropicProvider } from "@bivelio/savings-layer";

const layer = createSavingsLayer({
  provider: new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }),
});

// Long and stable: no dates, no user names, no request ids in here.
const SYSTEM = "You are the support assistant for Acme Outdoor, an invented shop. Our return policy: …";

const { text, report } = await layer.generate({
  model: "anthropic/claude-haiku-4-5",
  messages: [
    { role: "system", content: SYSTEM },
    { role: "user", content: "Can I return hiking boots after 20 days?" },
  ],
});
console.log(text);
console.log(report.nativeSavings?.cacheReadTokens, report.nativeSavings?.cacheWriteTokens);
console.log(report.nativeSavings?.netUsd); // read discount minus write premium; negative on a cold write
```

`report.nativeSavings` ist Anthropics Rabatt, getrennt ausgewiesen: Die Schicht zählt ihn nie als eigene Einsparung, damit dein Bericht mit der Rechnung übereinstimmt.

**Der Fall, in dem du die Markierung abschalten solltest.** Ohne Schlüssel gilt: Ändert sich dein System-Prompt bei jeder Anfrage (ein Zeitstempel, eine User-ID) oder liegen deine Aufrufe in jeweils neuen Prozessen mehr als fünf Minuten auseinander, schreibt die Standardmarkierung einen Cache-Eintrag, den niemand liest, und laut README kostet das etwa 20 % mehr als ganz ohne Schicht. Verschiebe, was sich ändert, in die User-Nachricht, oder schalte die Markierung ab:

```ts
import { createSavingsLayer, AnthropicProvider } from "@bivelio/savings-layer";

// A system prompt that changes every time: no cache marks, no write premium.
export const noMarks = createSavingsLayer({
  provider: new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY, maxCacheBreakpoints: 0 }),
});

// Or keep the marks and, per request, let the layer move timestamp and UUID
// lines to the end of the system prompt, outside the cached part (opt-in: the
// model reads the same lines in a different order).
const layer = createSavingsLayer({
  provider: new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }),
});
export const reply = await layer.generate({
  model: "anthropic/claude-haiku-4-5",
  messages: [
    { role: "system", content: `Today is ${new Date().toISOString()}\nYou are the support assistant for Acme Outdoor, an invented shop. …` },
    { role: "user", content: "Can I return hiking boots after 20 days?" },
  ],
  savings: { cachePrefix: true },
});
```

Dieses optionale Umordnen ist der Hebel hinter einem explorativen Live-Test, der im README veröffentlicht ist: Auf `claude-haiku-4-5` hob es in einer konstruierten Sequenz, in der ein Zeitstempel den Cache vergiftete, die Trefferquote von 0 % auf 95 % und senkte die Kosten pro Anfrage um 82,76 %, verglichen mit der Schicht selbst ohne die Option, 20 Anfragen pro Arm, gemessen mit Version 1.2.0 am 15. November 2026. Es ist ein kleiner, konstruierter Test, keine Prognose für deinen Traffic.

## Gleiche mit Anthropics Zahlen ab

1. **Pro Aufruf.** Protokolliere `usage` aus jeder Antwort (oder `report.nativeSavings`, wenn du die Schicht nutzt) und berechne die Trefferquote wie oben. Eine gesunde Chat- oder Agent-Last zeigt nach dem ersten Aufruf weit mehr Lese- als Schreibvorgänge.
2. **Pro Tag.** In der Claude Console schlüsselt die Usage-Seite die Eingabe nach Cache-Schreib- und Cache-Lesevorgängen pro Modell und API-Schlüssel auf. Summiere deine protokollierten `cache_read_input_tokens` und `cache_creation_input_tokens` für denselben Schlüssel und denselben UTC-Tag: Die Summen sollten übereinstimmen. Für eine programmatische Prüfung liefert die [Usage and Cost Admin API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api) dieselben Zähler.
3. **In Geld.** Bepreise Lesevorgänge, Schreibvorgänge und normale Eingabe getrennt. Ein Bericht, der nur „gesparte Tokens“ zeigt und nicht den Schreibaufschlag, verschweigt die halbe Rechnung.

Die [öffentlichen Benchmarks](/de/benchmarks) des Repositorys messen beide Arme jedes Tests mit dem eigenen Nutzungszähler des Anbieters. Die allgemeine Methode beschreibt [LLM-Einsparungen mit deiner Rechnung abgleichen](/de/guides/verify-llm-savings-against-provider-bill). Die OpenAI-Seite desselben Problems behandelt [warum cached_tokens bei OpenAI 0 ist](/de/guides/openai-prompt-caching-cached-tokens). Der Code liegt auf [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
