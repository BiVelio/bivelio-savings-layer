Elke tool voor LLM-kosten toont een besparingscijfer. Weinig tools laten zien hoe je dat controleert, en bij die controle vallen de meeste claims door de mand: het dashboard toont een grote besparing en de factuur beweegt nauwelijks. Deze gids geeft een methode die je met elke tool kunt toepassen, of zonder tool: wat je logt, hoe je dat afstemt op de gebruiksgegevens van de provider, hoe je een echte besparing onderscheidt van een schatting, en hoe je zeker weet dat de besparing uit jouw wijziging komt. Aan het eind zie je hoe de open-source SDK BV-SALA elk bedrag labelt zodat deze controle mogelijk is.

## Waarom besparingscijfers en facturen niet met elkaar kloppen

Het verschil komt bijna altijd uit een van deze hoeken:

- **Lijstprijs tegenover jouw prijs.** Tools beprijzen tokens tegen openbare lijstprijzen. Je factuur kan kortingen, contracten met afnameverplichting, regionale tarieven of tarieven voor dataresidentie, prioriteitsniveaus en belastingen bevatten.
- **Schattingen gepresenteerd als metingen.** Als een tool 2,000 tokens uit een prompt heeft gehaald, heeft de provider die nooit geteld. Het “bespaarde” getal is de eigen telling van de tool, gemaakt met een tokenizer die misschien niet die van de provider is.
- **De korting van de provider opgeëist door de tool.** Prompt caching bij OpenAI, Anthropic, DeepSeek of Gemini wordt door de provider tegen een lager tarief gefactureerd. Een tool die die korting als eigen besparing telt, blaast zijn getal op.
- **Verkeer dat de tool nooit heeft gezien.** Aanroepen vanuit een andere service, het script van een collega, de bijverzoeken van een coding-agent of een batchjob staan allemaal op de factuur en niet in de tool.
- **Ontbrekende usage.** Een gestreamd verzoek zonder het afsluitende usage-event heeft helemaal geen tokentellingen. Het stilzwijgend als nul tellen laat alles wat erna komt goedkoper lijken.
- **Tijd.** Providers groeperen gebruik per UTC-dag, en een deel van het gebruik verschijnt met vertraging.

## De methode, stap voor stap

### 1. Log per verzoek de eigen tellers van de provider

Niet je eigen schatting: het `usage`-blok dat de provider teruggaf. Input, gecachete input (en cache-schrijfacties waar die bestaan), output, redeneertokens, de model-id die de provider rapporteert, de API-sleutel of het project, en de UTC-tijdstempel. Markeer een verzoek waarvan de usage niet binnenkwam als **niet gemeten**, nooit als nul.

### 2. Stem tokens af vóór dollars

Exporteer het dagelijkse gebruik van de provider voor dezelfde sleutels en dagen: de [Usage API](https://developers.openai.com/api/reference/resources/organization/subresources/usage) van OpenAI, de [Usage and Cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api) van Anthropic, of de gebruikspagina's van de consoles van DeepSeek en Model Studio. Vergelijk dan post voor post:

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

Kloppen de tokens, dan is je logging volledig en kun je de rest van de analyse vertrouwen. Toont de provider er meer, zoek dan eerst het verkeer dat je niet logt voordat je verdergaat.

### 3. Beprijs het daarna, met een gedateerde prijstabel

Vermenigvuldig elke post met zijn tarief, bewaar de datum waarop de tarieven zijn overgenomen, en vergelijk met het kostenrapport van de provider. Een vast verschil van een paar procent is meestal een korting of een regionaal tarief, en het is hetzelfde met en zonder je optimalisatie, dus het verandert de besparing niet.

### 4. Houd drie soorten getallen uit elkaar

- **Gemeten:** gelezen uit de teller van de provider voor een aanroep die heeft gedraaid.
- **Gemeten via referentie:** een aanroep die niet heeft plaatsgevonden (een cache-hit, een gededupliceerd verzoek), gewaardeerd met de teller van de provider voor de identieke aanroep die wél draaide. Dit is het beste bewijs dat er bestaat voor een aanroep die nooit heeft plaatsgevonden.
- **Geschat:** alles wat de provider nooit heeft geteld, zoals tokens die een tool uit een prompt heeft gehaald.

Tel elke soort apart op. Tel geschatte bedragen nooit op bij gemeten bedragen, en neem nooit het gemiddelde van percentages over verzoeken: tel het geld op en deel daarna.

### 5. Scheid de korting van de provider van die van jou

Gecachete inputtokens zijn goedkoper dankzij de provider. Als je niets hebt veranderd en je hitrate al hoog was, is die korting geen besparing van jouw project. Beprijs gecachete tokens aan beide kanten van de vergelijking tegen het cachetarief; wat overblijft, is van jou.

## Kwam de besparing door de wijziging?

Een factuur die na een deploy daalt, kan ook gewoon een rustige week zijn. Om een besparing toe te schrijven:

- **Draai twee armen tegelijk.** Stuur dezelfde verzoeken met en zonder de wijziging, op hetzelfde moment, met dezelfde sleutel, en vergelijk de tellers van de provider voor beide. Verzoeken willekeurig over de armen verdelen is de zuivere versie.
- **Rapporteer een interval, geen puntschatting.** Hersample hele gesprekken of dagen en zeg “tussen X en Y %”. Een interval dat nul kruist, betekent dat je het verschil niet van ruis kunt onderscheiden, en dat is een legitiem resultaat.
- **Controleer de kwaliteit in dezelfde run.** Een goedkoper antwoord dat fout is, is geen besparing. Meet de nauwkeurigheid of een taakspecifieke controle in beide armen.

## Hoe BV-SALA deze controle mogelijk maakt

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) is een besparingslaag onder Apache-2.0, gratis en zonder sleutel. Elk verzoek levert een `SavingsReport` op dat precies voor deze methode is gebouwd:

- `cost.basis` is `measured`, `reference`, `estimated` of `unmeasured`, volgens de definities hierboven. Een herhaling wordt alleen via referentie gewaardeerd als de aanroep die draaide rechtstreeks naar de API van OpenAI, Anthropic of Google Gemini ging; overal anders blijft hij `estimated`.
- De besparing wordt bijgehouden in vier aparte grootboeken die nooit tot één getal worden opgeteld: `avoided_calls`, `eliminated_tokens`, `compressed_tokens` en `provider_cached_tokens`.
- De eigen cachekorting van de provider wordt apart gerapporteerd, in `report.nativeSavings`, en nooit als besparing van de laag geteld.
- Een stream die eindigt zonder usage is `unmeasured`, en wordt nooit als nul beprijsd.

De rapporten per basis optellen kost een paar regels:

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

Vanuit Python leest de client van het pakket dezelfde rapporten uit de lokale gateway en houdt hij dezelfde scheiding aan:

```python
# pip install bivelio-savings-layer
import bvsala

gw = bvsala.Gateway("http://127.0.0.1:8403")
# ... send requests with gw.wrap(client) and read each one with gw.report(response) ...
t = gw.totals()
print(t.requests, t.metered, t.not_metered, t.actual_cost_usd)
print(t.net_savings_usd_by_basis)  # one amount per basis, never added together
```

Pas daarna stap 2 hierboven toe op deze totalen: de `measured`-uitgaven van de laag moeten overeenkomen met het gebruik bij de provider voor dezelfde sleutel en dag, in tokens exact en in dollars op je kortingen na. De rapporten rekenen met lijstprijzen; ze zijn geen factuur.

## Dezelfde methode, in het openbaar toegepast

Het project publiceert zijn eigen A/B-runs op de [benchmarkpagina](/nl/benchmarks): twee armen op dezelfde verzoeken, één rechtstreeks naar de provider en één via de laag, beide gemeten met de eigen gebruiksteller van de provider, met 95 %-intervallen en de datum en versie van elke run. Resultaten die niets bespaarden, of meer kostten, staan op dezelfde pagina. De volledige methode, de schatter en de beperkingen ervan staan in [de paper](/nl/paper).

Voor de providerspecifieke details, zie [waarom cached_tokens van OpenAI 0 is](/nl/guides/openai-prompt-caching-cached-tokens), [waarom prompt caching van Claude niet werkt](/nl/guides/claude-prompt-caching-not-working) en [de kosten van Claude Code per verzoek meten](/nl/guides/claude-code-cost-per-request). De code en de ruwe rapporten staan op [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
