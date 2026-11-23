OpenAI cacht lange Prompts automatisch: Stimmt der Anfang einer Anfrage mit einer überein, die kürzlich verarbeitet wurde, werden diese Eingabe-Tokens vergünstigt abgerechnet, und die Antwort beginnt früher. Du musst dafür nichts einschalten. Genau deshalb fällt es auch kaum auf, wenn es nicht mehr funktioniert. Kommt `cached_tokens` bei jeder Anfrage als `0` zurück, listet dieser Leitfaden die Gründe in der Reihenfolge auf, in der du sie prüfen solltest, und zeigt, wie du die Trefferquote pro Anfrage verfolgst und mit OpenAIs eigenen Nutzungsdaten abgleichst.

## Wo du es ablesen kannst

Jede Antwort sagt dir, wie viele Eingabe-Tokens aus dem Cache kamen:

- **Chat Completions:** `usage.prompt_tokens_details.cached_tokens`, als Teil von `usage.prompt_tokens`.
- **Responses API:** `usage.input_tokens_details.cached_tokens`, als Teil von `usage.input_tokens`.

Die gecachten Tokens sind in der Eingabesumme enthalten, nicht zusätzlich. OpenAIs [Leitfaden zum Prompt-Caching](https://developers.openai.com/api/docs/guides/prompt-caching) ist die Referenz für die aktuellen Regeln. Er unterscheidet inzwischen neuere Modelle, die auch Cache-Schreibvorgänge melden und berechnen und explizite Cache-Optionen akzeptieren, von älteren, bei denen das Schreiben in den Cache kostenlos ist. Schau dort für das Modell nach, das du nutzt.

## Warum cached_tokens 0 ist

1. **Der Prompt ist zu kurz.** Caching beginnt bei etwa 1,024 Prompt-Tokens; die genaue Schwelle und wie die gecachte Zahl gerundet wird, hängen vom Modell ab. Ein System-Prompt mit 600 Tokens und eine kurze Frage treffen den Cache nie, und nichts weist dich darauf hin.
2. **Der Anfang des Prompts ändert sich.** Der Cache vergleicht ab dem allerersten Token. Ein Zeitstempel, eine Request-ID oder der Name des Nutzers in der ersten Nachricht macht jede Anfrage ab Token eins einzigartig. Tools, Bilder und Antwortformate gehören ebenfalls zum Präfix: Tools in anderer Reihenfolge oder ein anders serialisiertes Schema brechen die Übereinstimmung.
3. **Der Cache wurde geräumt.** Einträge werden nach der letzten Nutzung nur kurz aufbewahrt, bei ruhigem Traffic typischerweise Minuten. Anfragen im Abstand von einer Stunde treffen den Cache selten.
4. **Der Traffic ist verteilt.** Anfragen werden über einen Hash des Prompt-Anfangs geroutet. Sehr hohes Volumen mit demselben Präfix läuft auf andere Maschinen über, die den Eintrag nicht haben. OpenAIs Parameter `prompt_cache_key` gruppiert Anfragen mit gemeinsamem Präfix; nutze einen Schlüssel pro Prompt-Template, nicht pro Nutzer, und halte die Anfragerate pro Schlüssel moderat, wie der Leitfaden erklärt.
5. **Du liest das Feld nicht aus.** Eine gestreamte Anfrage an Chat Completions enthält überhaupt keine Nutzungsdaten, wenn du sie nicht mit `stream_options: { include_usage: true }` anforderst. Viele Wrapper verwerfen `prompt_tokens_details`. Manche OpenAI-kompatiblen Anbieter und manche Azure-Deployments melden Caching anders oder gar nicht.

## In zwei Minuten testen

Bevor du deine Anwendung debuggst, prüf, ob Caching für dein Konto und dein Modell überhaupt funktioniert. Sende denselben langen Prompt zweimal im Abstand von ein paar Sekunden und lies die Nutzungsdaten jeder Antwort:

```bash
# A system prompt well above the threshold, sent twice. The second answer should report cached tokens.
BODY=$(python3 -c 'import json; print(json.dumps({"model": "gpt-4o-mini", "messages": [{"role": "system", "content": "You are a careful assistant for an invented shop. " * 200}, {"role": "user", "content": "Say OK."}]}))')
for i in 1 2; do
  curl -s https://api.openai.com/v1/chat/completions \
    -H "Authorization: Bearer $OPENAI_API_KEY" -H "Content-Type: application/json" \
    -d "$BODY" | python3 -c 'import json, sys; u = json.load(sys.stdin)["usage"]; print(u["prompt_tokens"], u.get("prompt_tokens_details"))'
done
```

Zeigt die zweite Zeile gecachte Tokens, funktioniert die Seite des Anbieters, und das Problem liegt darin, wie deine Anwendung ihre Prompts zusammensetzt: Lies weiter. Zeigt sie keine, versuch es ein paar Mal (Caching ist Best Effort, und die erste Anfrage landet vielleicht auf einer anderen Maschine) und prüf dann den Eintrag des Modells in OpenAIs Caching-Leitfaden. Setz das Modell ein, das du in Produktion nutzt; ein Test mit einem anderen Modell beweist wenig.

Dieser Test liefert dir auch eine Basislinie für die nächsten Abschnitte. Sobald du die Reihenfolge deines Prompts änderst oder einen `prompt_cache_key` hinzufügst, führ denselben Vergleich mit einem echten Template aus deiner Anwendung durch und bewahre die Zahlen auf. Eine Trefferquote, gemessen vor und nach der Änderung auf einem Template, das deine Nutzer tatsächlich verwenden, ist ein Ergebnis, das du vorzeigen kannst; „Caching sollte helfen“ ist keins.

## Was sich ändert, kommt ans Ende

Für die meisten Fälle ist die Reihenfolge die Lösung. Alles, was für jede Anfrage gleich ist, kommt an den Anfang und bleibt Byte für Byte identisch; alles, was sich ändert, kommt ans Ende.

```ts
type Message = { role: "system" | "user"; content: string };

const INSTRUCTIONS = "You answer questions about an invented product, Acme Notes. Rules: …"; // long, never changes
const EXAMPLES = "Example question: … Example answer: …"; // long, never changes

export function buildMessages(question: string, userName: string): Message[] {
  return [
    { role: "system", content: INSTRUCTIONS }, // cached
    { role: "system", content: EXAMPLES }, // cached
    // Everything that changes goes in the last message, after the cached part.
    { role: "user", content: `Date: ${new Date().toISOString().slice(0, 10)}. User: ${userName}.\n${question}` },
  ];
}
```

Verfolge danach den gecachten Anteil jedes Prompts, damit eine Regression am selben Tag auffällt, an dem sie ausgeliefert wird:

```ts
interface OpenAIUsage {
  prompt_tokens?: number; // Chat Completions
  prompt_tokens_details?: { cached_tokens?: number };
  input_tokens?: number; // Responses API
  input_tokens_details?: { cached_tokens?: number };
}

/** Share of this request's input tokens that OpenAI served from its cache. */
export function cachedShare(u: OpenAIUsage): number {
  const total = u.prompt_tokens ?? u.input_tokens ?? 0;
  const cached = u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens ?? 0;
  return total === 0 ? 0 : cached / total;
}
```

Gruppiere ihn nach Prompt-Template. Ein Template, dessen Anteil bei 0 % bleibt, obwohl seine Prompts über 1,024 Tokens liegen, hat irgendwo nahe am Anfang etwas, das sich ändert: Protokolliere zwei Anfragen und vergleiche sie Zeichen für Zeichen, wie in [der Claude-Version dieses Leitfadens](/de/guides/claude-prompt-caching-not-working#finde-das-byte-das-deinen-cache-bricht) gezeigt.

## Wie BV-SALA hilft

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) ist eine Sparschicht für TypeScript unter Apache-2.0, die jeden OpenAI-kompatiblen Endpunkt umschließt, kostenlos und ohne Schlüssel. OpenAIs Cache arbeitet automatisch, deshalb markiert die Schicht bei OpenAI nichts. Was sie fürs Caching tut:

- **Sie fordert bei Streams immer Nutzungsdaten an,** damit eine gestreamte Anfrage gemessen wird, statt stillschweigend ohne Zähler zu bleiben.
- **Sie zeigt OpenAIs Rabatt bei jedem Aufruf,** in `report.nativeSavings`, aus OpenAIs eigenem Zähler, und hält ihn von ihren eigenen Einsparungen getrennt: Der Rabatt gehört OpenAI, nicht der Schicht.
- **Sie kann veränderliche Zeilen aus dem Präfix verschieben.** Mit dem Opt-in `savings: { cachePrefix: true }` wandern Zeilen des System-Prompts, die sich bei jeder Anfrage ändern (ISO-Zeitstempel, UUIDs, Epoch-Zeiten), ans Ende, damit der stabile Teil gecacht werden kann. Das Modell liest dieselben Zeilen in anderer Reihenfolge, deshalb ist das deine Entscheidung und nie standardmäßig aktiv.

```ts
// npm i @bivelio/savings-layer   (ESM: a "type": "module" project or a .mts file)
import { createSavingsLayer, OpenAICompatibleProvider } from "@bivelio/savings-layer";

const layer = createSavingsLayer({
  provider: new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY }),
});

const INSTRUCTIONS = "You write one-line summaries of release notes for an invented app. Style rules: …";

const stream = layer.generateStream({
  model: "openai/gpt-4o-mini",
  messages: [
    { role: "system", content: `Generated at ${new Date().toISOString()}\n${INSTRUCTIONS}` },
    { role: "user", content: "Summarize: fixed the export button; faster search; new dark theme." },
  ],
  savings: { cachePrefix: true }, // the timestamp line moves after the stable instructions
});
for await (const event of stream) {
  if (event.type === "text") process.stdout.write(event.delta);
}
const { report } = await stream.result;
console.log(report.tokens.providerCachedInput); // OpenAI's cached_tokens for this request
console.log(report.nativeSavings?.readDiscountUsd); // what those cached tokens saved at list price
```

Die eigenen Hebel der Schicht (exakte Wiederholungen und gleichzeitig laufende identische Anfragen überspringen) sind von OpenAIs Cache unabhängig und werden in [identische LLM-Anfragen deduplizieren](/de/guides/deduplicate-llm-requests) erklärt.

## Mit OpenAIs Zahlen abgleichen

1. **Pro Anfrage:** Protokolliere `cached_tokens` und die Eingabesumme aus jeder Antwort, oder mit der Schicht `report.tokens.providerCachedInput`.
2. **Pro Tag:** OpenAIs [Usage API](https://developers.openai.com/api/reference/resources/organization/subresources/usage) liefert die Nutzung von Completions in Tages-Buckets, die gecachte Eingabe-Tokens enthalten, pro Modell und auf Wunsch pro API-Schlüssel oder Projekt. Summiere deine Logs für denselben Schlüssel, dasselbe Modell und denselben UTC-Tag: Die Summen für gecachte und nicht gecachte Eingabe sollten übereinstimmen.
3. **In Geld:** Bepreise gecachte und nicht gecachte Eingabe getrennt. Bei Modellen, die Cache-Schreibvorgänge berechnen, nimm auch diese auf, sonst schätzt du die Einsparung zu hoch.

Die vollständige Methode findest du in [LLM-Einsparungen mit der Rechnung deines Anbieters abgleichen](/de/guides/verify-llm-savings-against-provider-bill). Die übrigen Hebel einer OpenAI-Rechnung behandelt [OpenAI-API-Kosten senken](/de/guides/reduce-openai-api-costs). Gemessene Ergebnisse, auch dort, wo die Schicht nichts spart, stehen auf der [Benchmark-Seite](/de/benchmarks), und der Code liegt auf [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
