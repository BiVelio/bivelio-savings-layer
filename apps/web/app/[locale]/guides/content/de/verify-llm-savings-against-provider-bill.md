Jedes Tool für LLM-Kosten zeigt eine Einsparung an. Nur wenige zeigen, wie man sie prüft, und genau bei der Prüfung fallen die meisten Behauptungen in sich zusammen: Das Dashboard zeigt eine große Einsparung, und die Rechnung bewegt sich kaum. Dieser Leitfaden gibt dir eine Methode, die du mit jedem Tool oder ganz ohne anwenden kannst: was du protokollierst, wie du es mit den Nutzungsdaten des Anbieters abgleichst, wie du eine echte Einsparung von einer Schätzung unterscheidest und wie du sicherstellst, dass die Einsparung von deiner Änderung kam. Am Ende siehst du, wie das Open-Source-SDK von BV-SALA jeden Betrag kennzeichnet, damit diese Prüfung möglich ist.

## Warum Einsparungszahlen und Rechnungen auseinanderliegen

Die Lücke kommt fast immer aus einer dieser Quellen:

- **Listenpreis gegen deinen Preis.** Tools bepreisen Tokens zu öffentlichen Listenpreisen. Deine Rechnung kann Rabatte, Verträge mit Mindestabnahme, regionale Tarife oder Tarife für Datenresidenz, Priority Tiers und Steuern enthalten.
- **Schätzungen, die als Messungen ausgegeben werden.** Hat ein Tool 2.000 Tokens aus einem Prompt entfernt, hat der Anbieter sie nie gezählt. Die „gesparte“ Zahl ist die eigene Zählung des Tools, gemacht mit einem Tokenizer, der vielleicht nicht der des Anbieters ist.
- **Der Rabatt des Anbieters als Leistung des Tools.** Prompt-Caching bei OpenAI, Anthropic, DeepSeek oder Gemini rechnet der Anbieter zu einem niedrigeren Tarif ab. Ein Tool, das diesen Rabatt als eigene Einsparung zählt, bläht seine Zahl auf.
- **Traffic, den das Tool nie gesehen hat.** Aufrufe aus einem anderen Service, das Skript eines Teamkollegen, Nebenanfragen eines Coding-Agents oder ein Batch-Job erscheinen alle auf der Rechnung und nicht im Tool.
- **Fehlende Nutzungsdaten.** Eine gestreamte Anfrage ohne ihr abschließendes Usage-Event hat überhaupt keine Token-Zahlen. Wird sie stillschweigend als null gezählt, sieht alles danach günstiger aus.
- **Zeit.** Anbieter gruppieren die Nutzung nach UTC-Tag, und manche Nutzung erscheint mit Verzögerung.

## Die Methode, Schritt für Schritt

### 1. Protokolliere für jede Anfrage die eigenen Zähler des Anbieters

Nicht deine Schätzung, sondern den `usage`-Block, den der Anbieter zurückgegeben hat. Eingabe, gecachte Eingabe (und Cache-Schreibvorgänge, wo es sie gibt), Ausgabe, Reasoning-Tokens, die Modell-ID, die der Anbieter meldet, den API-Schlüssel oder das Projekt und den UTC-Zeitstempel. Kennzeichne eine Anfrage, deren Nutzungsdaten nicht angekommen sind, als **ungemessen**, nie als null.

### 2. Gleiche Tokens vor Dollar ab

Exportiere die tägliche Nutzung des Anbieters für dieselben Schlüssel und Tage: OpenAIs [Usage API](https://developers.openai.com/api/reference/resources/organization/subresources/usage), Anthropics [Usage and Cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api) oder die Usage-Seiten der Konsolen von DeepSeek und Model Studio. Vergleiche dann Posten für Posten:

```ts
interface Row { day: string; model: string; input: number; cachedInput: number; output: number }

function byDayAndModel(rows: Row[]): Map<string, Row> {
  const totals = new Map<string, Row>();
  for (const r of rows) {
    const k = `${r.day}|${r.model}`;
    const t = totals.get(k) ?? { day: r.day, model: r.model, input: 0, cachedInput: 0, output: 0 };
    t.input += r.input;
    t.cachedInput += r.cachedInput;
    t.output += r.output;
    totals.set(k, t);
  }
  return totals;
}

/** Lines where your log and the provider disagree by more than the tolerance. Empty means they agree. */
export function reconcile(mine: Row[], provider: Row[], tolerance = 0.01): string[] {
  const a = byDayAndModel(mine);
  const b = byDayAndModel(provider);
  const gaps: string[] = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    for (const field of ["input", "cachedInput", "output"] as const) {
      const yours = a.get(k)?.[field] ?? 0;
      const theirs = b.get(k)?.[field] ?? 0;
      const gap = theirs === 0 ? (yours === 0 ? 0 : 1) : Math.abs(yours - theirs) / theirs;
      if (gap > tolerance) gaps.push(`${k} ${field}: yours ${yours}, provider ${theirs}`);
    }
  }
  return gaps;
}
```

Stimmen die Tokens überein, ist dein Logging vollständig, und du kannst dem Rest der Analyse vertrauen. Zeigt der Anbieter mehr, such den Traffic, den du nicht protokollierst, bevor du weitermachst.

### 3. Bepreise erst dann, mit einer datierten Preistabelle

Multipliziere jeden Posten mit seinem Tarif, notiere das Datum, an dem die Tarife übernommen wurden, und vergleiche mit dem Kostenbericht des Anbieters. Eine gleichbleibende Abweichung von ein paar Prozent ist meist ein Rabatt oder ein regionaler Tarif, und sie ist mit und ohne deine Optimierung dieselbe, ändert an der Einsparung also nichts.

### 4. Halte drei Arten von Zahlen auseinander

- **Gemessen:** aus dem Zähler des Anbieters für einen Aufruf, der stattgefunden hat.
- **Per Referenz gemessen:** ein Aufruf, der nicht stattgefunden hat (ein Cache-Treffer, eine deduplizierte Anfrage), bewertet mit dem Zähler des Anbieters für den identischen Aufruf, der stattgefunden hat. Das ist der beste verfügbare Beleg für einen Aufruf, den es nie gab.
- **Geschätzt:** alles, was der Anbieter nie gezählt hat, etwa Tokens, die ein Tool aus einem Prompt entfernt hat.

Summiere jede Art für sich. Addiere nie geschätzte zu gemessenen Beträgen, und bilde nie den Durchschnitt von Prozentwerten über Anfragen: Summiere das Geld und teile dann.

### 5. Trenne den Rabatt des Anbieters von deinem

Gecachte Eingabe-Tokens sind wegen des Anbieters günstiger. Hast du nichts geändert und war deine Trefferquote schon hoch, ist dieser Rabatt keine Einsparung deines Projekts. Bepreise gecachte Tokens auf beiden Seiten des Vergleichs zum gecachten Tarif; was übrig bleibt, gehört dir.

## Hat die Änderung die Einsparung verursacht?

Eine Rechnung, die nach einem Deployment gesunken ist, kann auch eine ruhige Woche sein. Um eine Einsparung zuzuordnen:

- **Lass zwei Arme gleichzeitig laufen.** Sende dieselben Anfragen mit und ohne die Änderung, zur selben Zeit, über denselben Schlüssel, und vergleiche die Zähler des Anbieters für beide. Zufällig auf die Arme verteilte Anfragen sind die saubere Variante.
- **Gib ein Intervall an, keinen Punktwert.** Ziehe beim Resampling ganze Unterhaltungen oder Tage und sag „zwischen X und Y %“. Ein Intervall, das die Null einschließt, bedeutet, dass du den Unterschied nicht von Rauschen unterscheiden kannst, und das ist ein legitimes Ergebnis.
- **Prüf die Qualität im selben Lauf.** Eine günstigere Antwort, die falsch ist, ist keine Einsparung. Miss in beiden Armen die Genauigkeit oder eine aufgabenspezifische Prüfung.

## Wie BV-SALA diese Prüfung möglich macht

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) ist eine Sparschicht unter Apache-2.0, kostenlos und ohne Schlüssel. Jede Anfrage liefert einen `SavingsReport`, der genau für diese Methode gebaut ist:

- `cost.basis` ist `measured`, `reference`, `estimated` oder `unmeasured`, nach den Definitionen oben. Eine Wiederholung wird nur dann per Referenz bewertet, wenn der Aufruf, der lief, direkt an die API von OpenAI, Anthropic oder Googles Gemini ging; überall sonst bleibt sie `estimated`.
- Die Einsparung wird in vier getrennten Ledgern geführt, die nie zu einer Zahl summiert werden: `avoided_calls`, `eliminated_tokens`, `compressed_tokens` und `provider_cached_tokens`.
- Der eigene Cache-Rabatt des Anbieters wird getrennt ausgewiesen, in `report.nativeSavings`, und nie als Einsparung der Schicht gezählt.
- Ein Stream, der ohne seine Nutzungsdaten endet, ist `unmeasured` und wird nie als null bepreist.

Die Berichte nach Basis zu summieren, braucht nur ein paar Zeilen:

```ts
import type { SavingsReport } from "@bivelio/savings-layer";

/** Spend and saving per basis. Never mix bases, never average ratios. */
export function totalsByBasis(reports: SavingsReport[]) {
  const totals: Record<string, { requests: number; spendUsd: number; savedUsd: number }> = {};
  for (const r of reports) {
    const t = (totals[r.cost.basis] ??= { requests: 0, spendUsd: 0, savedUsd: 0 });
    t.requests += 1;
    t.spendUsd += r.cost.actual;
    t.savedUsd += r.cost.netSavingsUsd;
  }
  return totals;
}
```

Aus Python liest der Client des Pakets dieselben Berichte vom lokalen Gateway und hält dieselbe Trennung ein:

```python
# pip install bivelio-savings-layer
import bvsala

gw = bvsala.Gateway("http://127.0.0.1:8403")
# ... send requests with gw.wrap(client) and read each one with gw.report(response) ...
t = gw.totals()
print(t.requests, t.metered, t.not_metered, t.actual_cost_usd)
print(t.net_savings_usd_by_basis)  # one amount per basis, never added together
```

Wende dann Schritt 2 auf diese Summen an: Die `measured`-Ausgaben der Schicht sollten mit der Nutzung beim Anbieter für denselben Schlüssel und Tag übereinstimmen, in Tokens exakt und in Dollar bis auf deine Rabatte. Die Berichte bepreisen zum Listenpreis; sie sind keine Rechnung.

## Dieselbe Methode, öffentlich angewendet

Das Projekt veröffentlicht seine eigenen A/B-Läufe auf der [Benchmark-Seite](/de/benchmarks): zwei Arme mit denselben Anfragen, einer direkt zum Anbieter und einer durch die Schicht, beide mit dem eigenen Nutzungszähler des Anbieters gemessen, mit 95 %-Intervallen sowie Datum und Version jedes Laufs. Ergebnisse, die nichts gespart oder mehr gekostet haben, stehen auf derselben Seite. Die vollständige Methode, der Schätzer und seine Grenzen stehen im [Paper](/de/paper).

Die anbieterspezifischen Details findest du unter [warum cached_tokens bei OpenAI 0 ist](/de/guides/openai-prompt-caching-cached-tokens), [warum Claudes Prompt-Caching nicht funktioniert](/de/guides/claude-prompt-caching-not-working) und [die Kosten von Claude Code pro Anfrage messen](/de/guides/claude-code-cost-per-request). Code und Rohberichte liegen auf [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
