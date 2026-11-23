Eine OpenAI-Rechnung ist die Summe weniger Zahlen pro Anfrage: nicht gecachte Eingabe-Tokens, gecachte Eingabe-Tokens, Cache-Schreibvorgänge (ab GPT-5.6), Ausgabe-Tokens (Reasoning inklusive) und der Preis des Modells. Jeder Weg, sie zu senken, bewegt eine dieser Zahlen. Dieser Leitfaden geht die Hebel in der Reihenfolge durch, in der sie sich meistens auszahlen, sagt, wann sich einer nicht lohnt, und zeigt, wie du jede Einsparung mit OpenAIs eigenen Nutzungsdaten belegst statt mit einer Hochrechnung. Das meiste davon braucht überhaupt kein Tool; wo das Open-Source-SDK von BV-SALA einen Hebel automatisiert, siehst du, wie.

## Miss zuerst pro Anfrage

Bevor du irgendetwas änderst, protokolliere den `usage`-Block jeder Antwort zusammen mit dem Feature oder Prompt-Template, das sie erzeugt hat: `prompt_tokens`, `prompt_tokens_details.cached_tokens`, `cache_write_tokens`, wo das Modell es meldet, `completion_tokens` und bei Reasoning-Modellen `completion_tokens_details.reasoning_tokens`. Bepreise jeden Posten mit den Tarifen von OpenAIs Preisseite und notiere das Datum, an dem du sie übernommen hast. Ab GPT-5.6 sind Cache-Schreibvorgänge ein eigener Posten: OpenAI berechnet sie bei der Standardlebensdauer von 30 Minuten mit dem Faktor 1.25 auf den Preis für nicht gecachte Eingabe und bei der Lebensdauer von 12 Stunden mit dem Faktor 2.5 ([Leitfaden zum Prompt-Caching](https://developers.openai.com/api/docs/guides/prompt-caching), abgerufen am 23. November 2026). Wer sie als normale Eingabe bepreist, rechnet zu niedrig. Eine Woche solcher Daten beantwortet die einzige Frage, die am Anfang zählt: **Welche zwei oder drei Features machen den Großteil der Rechnung aus?** Optimiere diese; ignoriere den Rest.

## 1. Zahl nicht zweimal für dieselbe Anfrage

Retries, Doppelklicks, nächtliche Jobs, die die Einträge von gestern neu klassifizieren, und parallele Worker, die denselben Prompt senden, kosten jeweils einen vollen Aufruf. Ein Antwort-Cache mit exakter Übereinstimmung und die Deduplizierung gleichzeitig laufender Anfragen beseitigen sie, ohne eine einzige Antwort zu ändern. Wie viel du sparst, hängt ausschließlich davon ab, wie oft sich deine Anfragen wiederholen, also miss zuerst deine Duplikatrate. Ausführlicher Leitfaden: [identische LLM-Anfragen deduplizieren](/de/guides/deduplicate-llm-requests).

## 2. Lass OpenAIs Prompt-Cache arbeiten

Prompts ab etwa 1,024 Tokens werden automatisch gecacht, und gecachte Eingabe-Tokens werden vergünstigt abgerechnet. Ab GPT-5.6 ist das Befüllen des Caches nicht umsonst: Der Teil, der hineingeschrieben wird, kostet wie oben beschrieben mehr als der Tarif für nicht gecachte Eingabe. Ein Prompt, der geschrieben und nie wieder gelesen wird, kostet also mehr als ohne Cache, und einer, der bald wieder gelesen wird, deutlich weniger. Ältere Modelle berechnen für Schreibvorgänge nichts extra. Der Cache greift nur ab dem ersten Token, er funktioniert also nur, wenn der Anfang deines Prompts von Anfrage zu Anfrage identisch ist. Stell Anweisungen, Tool-Definitionen und Beispiele an den Anfang, Datumsangaben, Benutzernamen und die Frage ans Ende. Hängt `cached_tokens` bei 0 fest, lies [warum cached_tokens bei OpenAI 0 ist](/de/guides/openai-prompt-caching-cached-tokens).

## 3. Schick Arbeit, die warten kann, an die Batch API

Evaluierungen, Backfills, Embeddings eines Dokumentbestands und nächtliche Klassifizierungen brauchen keine Antwort in zwei Sekunden. OpenAIs [Batch API](https://developers.openai.com/api/docs/guides/batch) nimmt eine Datei mit Anfragen entgegen, liefert die Ergebnisse innerhalb eines Tages und berechnet dafür einen niedrigeren Tarif als für dieselben Anfragen einzeln (die aktuellen Konditionen stehen im [Leitfaden zur Kostenoptimierung](https://developers.openai.com/api/docs/guides/cost-optimization)). Für Offline-Arbeit ist sie oft die größte Einzeleinsparung, und an den Antworten ändert sie nichts.

## 4. Nimm das kleinste Modell, das deine Evaluierung besteht

Die Preisunterschiede zwischen den Modellstufen sind groß, und viele Aufgaben (Klassifizierung, Extraktion, kurze Umformulierungen, Routing) brauchen nicht das größte Modell. Stell aus echten Anfragen ein kleines Evaluierungsset zusammen, lass es gegen zwei oder drei Modelle laufen und nimm das günstigste, das besteht. Wiederhole das, sobald ein neues Modell erscheint. Ohne Evaluierung ist ein Downgrade reines Raten, und was falsche Antworten kosten, taucht auf der API-Rechnung nicht auf.

## 5. Behalte die Ausgabe im Griff

Ausgabe-Tokens kosten meist ein Mehrfaches der Eingabe-Tokens, und Reasoning-Tokens werden als Ausgabe abgerechnet.

- Setz `max_completion_tokens` auf das, was das Feature wirklich braucht.
- Senke bei Reasoning-Modellen den Reasoning-Aufwand für Aufgaben, die kein tiefes Nachdenken erfordern, und miss `reasoning_tokens` vorher und nachher.
- Fordere strukturierte Ausgabe mit einem JSON-Schema an, wenn dein Code die Antwort parst. Ein Parse-Fehler mit anschließendem Retry bezahlt die ganze Anfrage zweimal.

## 6. Schick weniger Eingabe

- Schick nicht die ganze Unterhaltung erneut, wenn die Aufgabe nur die letzten Runden braucht.
- Halte große Tool-Ausgaben (Logs, Dateiinhalte, Suchergebnisse) aus späteren Runden heraus, sobald sie verwendet wurden.
- Sende strukturierte Daten kompakt: Eingerücktes JSON verbraucht Tokens für Leerzeichen.
- Hol dir die drei relevanten Absätze, statt das ganze Dokument einzufügen.

Vorsicht mit den letzten beiden in langen Agent-Schleifen: Änderst du die Mitte eines Verlaufs, den OpenAI bereits gecacht hat, wird alles nach der Änderung erneut berechnet, zum Tarif für nicht gecachte Eingabe oder, ab GPT-5.6, zum höheren Cache-Schreibtarif, wenn es erneut gecacht wird. Kürze, was neu ist, nicht, was im Cache liegt.

## Wie BV-SALA einige davon automatisiert

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) ist eine Sparschicht unter Apache-2.0, die in TypeScript jeden OpenAI-kompatiblen Endpunkt umschließt. Sie spart mit allen Hebeln **kostenlos, ohne Schlüssel und ohne Registrierung** und sendet nichts an BiVelio, solange du keinen Schlüssel für das optionale Cloud-Dashboard hinzufügst. Standardmäßig aktiv: der exakte Cache, die Deduplizierung identischer Anfragen, die gleichzeitig unterwegs sind, das lokale Beantworten reiner Arithmetik und die kompakte Serialisierung der strukturierten Daten, die du übergibst. Opt-in, jeweils mit einer Option: die Modellkaskade, das Verdichten von Tool-Ausgaben und das Umordnen für ein cachebares Präfix. Jede Anfrage liefert einen Bericht, der sagt, was gespart wurde und woher die Zahl stammt.

```ts
// npm i @bivelio/savings-layer   (ESM: a "type": "module" project or a .mts file)
import { createSavingsLayer, OpenAICompatibleProvider } from "@bivelio/savings-layer";

const layer = createSavingsLayer({
  provider: new OpenAICompatibleProvider({
    baseUrl: "https://api.openai.com/v1",
    apiKey: process.env.OPENAI_API_KEY,
  }),
});

const { text, report } = await layer.generate({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "What is 2 + 2 * 3?" }],
});
console.log(text); // "8": computed on your machine, no call to OpenAI
console.log(report.calls.avoidedLlm); // 1: a whole call you did not pay for
console.log(report.cost.basis); // "estimated": nothing ran, so there is no provider counter to read
```

Zwei ehrliche Grenzen. Erstens spart Traffic, der sich nie wiederholt, durch Cache und Deduplizierung konstruktionsbedingt etwa 0 %. Zweitens kann das standardmäßige Kürzen überholter Tool-Ergebnisse in langen Agent-Schleifen bei einem Anbieter, der den ganzen Prompt cacht, mehr kosten, als es spart: Das Changelog des Projekts meldet +12.2 % bei einer Schleife mit 60 Schritten auf `gpt-5`, gemessen gegen einen simulierten Anbieter mit den Versionen 1.2.3 und 1.2.4 und ohne Schlüssel. Übergib bei langen Agent-Schleifen `savings: { elision: false }` in der Anfrage und vergleiche.

## Belege jede Einsparung mit OpenAIs Zahlen

Eine Einsparung, die du nicht prüfen kannst, ist eine Hochrechnung. Für jeden Hebel gilt:

1. **Wähle den Zähler, den er bewegen sollte.** Caching und Deduplizierung bewegen die Zahl der Anfragen. Prompt-Caching bewegt `cached_tokens` und ab GPT-5.6 auch `cache_write_tokens`. Batch bewegt den Preis. Die Modellwahl bewegt den Preis pro Token. Die Kontrolle der Ausgabe bewegt `completion_tokens`.
2. **Lies diesen Zähler bei OpenAI ab.** Die [Usage API](https://developers.openai.com/api/reference/resources/organization/subresources/usage) liefert Anfragen sowie Eingabe-, gecachte Eingabe- und Ausgabe-Tokens pro Tag, Modell, Projekt und Schlüssel. Der Costs-Endpunkt und das Nutzungs-Dashboard liefern die Beträge.
3. **Vergleiche Gleiches mit Gleichem.** Dasselbe Feature, dieselben Wochentage, vorher und nachher, oder besser: zwei Arme desselben Traffics zur selben Zeit. Schau zuerst auf die Tokens und dann auf die Dollar: Dollarbeträge bewegen sich auch mit den Preisen.

Mit der Schicht trägt jeder Bericht `cost.basis`: Beträge mit `measured` und `reference` stammen aus OpenAIs eigenem Zähler, Beträge mit `estimated` werden getrennt ausgewiesen und nie dazugerechnet. Die vollständige Methode: [LLM-Einsparungen mit der Rechnung deines Anbieters abgleichen](/de/guides/verify-llm-savings-against-provider-bill).

## Was die veröffentlichten Zahlen sagen

Die [Benchmark-Seite](/de/benchmarks) des Projekts misst beide Arme jedes Tests mit dem eigenen Nutzungszähler des Anbieters. Bei einer öffentlichen Last aus GSM8K-Fragen, in der 30 % der Anfragen exakte Wiederholungen waren, lag die gepoolte Reduktion auf `gpt-4o-mini` bei **31.50 %**, mit einem 95 %-Intervall von 25.7 % bis 36.7 % (Artefakte des SDK 0.4.31, September 2026; auch im README). Bei Chats mit zwei Runden ohne Wiederholungen (MT-Bench) ließen sich die Unterschiede nicht von null unterscheiden oder nicht der Schicht zuschreiben, und die Seite sagt das auch. Methode, Intervalle und sämtliche Einschränkungen stehen im [Paper](/de/paper). Der Code liegt auf [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
