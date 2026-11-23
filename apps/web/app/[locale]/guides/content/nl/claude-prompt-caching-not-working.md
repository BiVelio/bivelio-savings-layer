Je hebt `cache_control` aan je Claude-verzoeken toegevoegd, en de factuur bewoog niet. Of `cache_read_input_tokens` komt bij elke aanroep terug als `0`. Deze gids legt uit waarom dat gebeurt, hoe je de exacte byte vindt die je cache breekt en hoe je het resultaat controleert met de gebruikscijfers van Anthropic zelf. Alles hier werkt met elke SDK. Aan het eind zie je hoe de open-source SDK BV-SALA de breakpoints voor je plaatst, en het ene geval waarin je hem moet vertellen dat hij dat niet moet doen.

## Lees eerst de drie gebruiksvelden

Elk antwoord van de Messages API vertelt je wat er met de cache gebeurde. Kijk naar drie getallen in `usage`:

| Veld | Wat het telt |
| --- | --- |
| `cache_creation_input_tokens` | Tokens die bij deze aanroep naar de cache zijn geschreven, gefactureerd boven de normale inputprijs |
| `cache_read_input_tokens` | Tokens die uit de cache zijn geleverd, gefactureerd tegen een fractie van de inputprijs |
| `input_tokens` | Tokens na het laatste cache-breakpoint, gefactureerd tegen de normale prijs |

De drie patronen vertellen je waar je moet zoeken:

- **Beide cachevelden staan op 0.** Er is helemaal niets gecachet: de prefix is korter dan het minimum van het model, er is geen breakpoint, of iets tussen jou en de API heeft het verwijderd.
- **Creatie is bij elke aanroep hoog en lezingen blijven op 0.** De cache wordt geschreven en nooit hergebruikt: de prefix verandert tussen aanroepen, de entry is verlopen, of de aanroepen gaan naar een ander model of een andere workspace.
- **Lezingen zijn hoog.** Het werkt. Dan is de enige vraag nog hoeveel van de prompt vóór het breakpoint staat.

## Hoe de prompt-cache van Claude werkt, in zes feiten

1. Hij cachet een **prefix**: het verzoek vanaf het begin tot een `cache_control`-breakpoint. De overeenkomst is exact; één afwijkende byte en alles daarna wordt opnieuw verwerkt.
2. De volgorde is **tools, dan system, dan messages**. Een wijziging in de toollijst maakt de systeemprompt en de berichten daarna ongeldig.
3. Je kunt tot **vier breakpoints** plaatsen, en vanaf elk ervan kijkt de API een beperkt aantal blokken terug naar een eerdere entry (20 op het moment van schrijven).
4. Entries leven standaard **vijf minuten**, en dat wordt bij elke hit ververst. Met `"ttl": "1h"` is een levensduur van een uur beschikbaar.
5. Schrijven kost meer dan lezen: een schrijfactie van vijf minuten wordt gefactureerd tegen 1,25 keer de inputprijs en een schrijfactie van een uur tegen 2 keer; een lezing kost een kleine fractie van de inputprijs (0,1 keer op de meeste modellen). Kijk op de [prijspagina van Anthropic](https://platform.claude.com/docs/en/about-claude/pricing) voor jouw model.
6. Er is een **minimale cachebare lengte** die per model verschilt, van 512 tot 4.096 tokens. Daaronder wordt het verzoek gewoon niet gecachet, zonder foutmelding.

Dit alles staat in de [documentatie van Anthropic over prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), de bron om op te vertrouwen als een getal verandert.

## De gebruikelijke oorzaken, in de volgorde waarin je ze nagaat

1. **De prefix is te kort.** Een systeemprompt van 600 tokens zit bij meerdere modellen onder het minimum. Zet de stabiele instructies, voorbeelden en referentietekst bij elkaar, zodat het gecachete deel lang genoeg is om verschil te maken.
2. **Iets in de prefix verandert bij elke aanroep.** De klassiekers: een tijdstempel of een regel “Vandaag is het…” in de systeemprompt, een request-id, de naam van de gebruiker, een willekeurige volgorde van voorbeelden, tooldefinities die zijn opgebouwd uit een object zonder vaste sleutelvolgorde, of een JSON-document dat met andere witruimte is geserialiseerd.
3. **Het breakpoint staat op inhoud die verandert.** Als de laatste `cache_control` op de vraag van de gebruiker staat, schrijft elke aanroep een nieuwe entry die niemand leest. Het breakpoint hoort aan het eind van het deel dat niet verandert.
4. **De entry is verlopen.** Aanroepen die meer dan vijf minuten uit elkaar liggen, lezen nooit elkaars entry. Een nachtelijke batch die elke tien minuten één item verwerkt, betaalt elke keer de schrijftoeslag en leest niets.
5. **De aanroepen delen geen cache.** Een ander model, een andere workspace of een modelwissel midden in een gesprek beginnen elk met een lege cache.
6. **Parallelle aanroepen zitten elkaar in de weg.** Een entry kan pas worden gelezen zodra het eerste antwoord is begonnen. Tien identieke aanroepen die tegelijk worden afgevuurd, schrijven allemaal. Stuur er eerst één, en daarna de rest.
7. **Een proxy haalt de markering weg.** Een gateway die `cache_control` verwijdert, of een `system` in blokvorm omzet naar een gewone string, laat de hele prompt factureren als niet-gecachete input terwijl elke aanroep gewoon slaagt. De documentatie van Claude Code beschrijft precies deze fout voor [LLM-gateways](https://code.claude.com/docs/en/prompt-caching).

## Vind de byte die je cache breekt

Als de lezingen op nul blijven, log dan twee opeenvolgende request-bodies en zoek waar ze voor het eerst verschillen, in de volgorde waarin de cache ze leest:

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

Zit het eerste verschil in de systeemprompt of de toollijst, dan heb je je cache-miss gevonden. Verplaats dat deel naar het eind van het verzoek, meestal naar het gebruikersbericht.

Houd daarna de hitrate per aanroep bij, zodat een regressie zichtbaar wordt op de dag dat hij live gaat:

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

## Loont caching voor jouw verkeer?

Omdat schrijfacties meer kosten dan gewone input, is caching een gok dat de prefix opnieuw wordt gelezen voordat hij verloopt. Met de levensduur van vijf minuten verdient één lezing de schrijfactie al terug. Een prefix die wordt geschreven en nooit gelezen, kost ongeveer 25% meer dan wanneer je hem zonder markering stuurt. Daarom is “overal `cache_control` toevoegen” geen veilige standaard: het loont bij chat- en agentverkeer dat binnen enkele minuten terugkomt, en het kost geld bij eenmalige verzoeken of bij prompts die elke keer veranderen.

## Hoe BV-SALA dit regelt

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) is een besparingslaag onder Apache-2.0. Met `AnthropicProvider` plaatst hij de breakpoints voor je, gratis en zonder sleutel: één aan het eind van de systeemprompt en één aan het eind van het deel van het gesprek dat niet verandert, nooit meer dan de API toestaat. Het rapport van elke aanroep laat zien wat de cache deed, op basis van de eigen tellers van Anthropic:

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

`report.nativeSavings` is de korting van Anthropic, apart getoond: de laag telt die nooit als zijn eigen besparing, zodat je rapport klopt met de factuur.

**Het geval waarin je de markering moet uitzetten.** Zonder sleutel, als je systeemprompt bij elk verzoek verandert (een tijdstempel, een gebruikers-id), of als je aanroepen meer dan vijf minuten uit elkaar liggen in steeds nieuwe processen, schrijft de standaardmarkering een cache-entry die niemand leest, en volgens de README kost dat ongeveer 20% meer dan zonder laag. Verplaats wat verandert naar het gebruikersbericht, of zet de markering uit:

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

Die opt-in herordening is de hefboom achter een verkennende live test die in de README is gepubliceerd: op `claude-haiku-4-5`, in een geconstrueerde reeks waarin een tijdstempel de cache vergiftigde, bracht hij de hitrate van 0% naar 95% en de kosten per verzoek 82,76% omlaag, vergeleken met de laag zelf zonder de optie, met 20 verzoeken per arm, gemeten met versie 1.2.0 op 15 november 2026. Het is een kleine, geconstrueerde test, geen voorspelling voor jouw verkeer.

## Controleer het met de cijfers van Anthropic

1. **Per aanroep.** Log `usage` van elk antwoord (of `report.nativeSavings` als je de laag gebruikt) en bereken de hitrate zoals hierboven. Een gezonde chat- of agentworkload laat na de eerste aanroep veel meer lezingen dan schrijfacties zien.
2. **Per dag.** In de Claude Console splitst de gebruikspagina de input per model en API-sleutel uit in cache-schrijfacties en cache-lezingen. Tel je gelogde `cache_read_input_tokens` en `cache_creation_input_tokens` op voor dezelfde sleutel en dezelfde UTC-dag: de totalen moeten overeenkomen. Voor een geautomatiseerde controle geeft de [Usage and Cost Admin API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api) dezelfde tellers.
3. **In geld.** Beprijs lezingen, schrijfacties en gewone input apart. Een rapport dat alleen “bespaarde tokens” toont en niet de schrijftoeslag, verzwijgt de helft van de afweging.

De [openbare benchmarks](/nl/benchmarks) van de repository meten beide armen van elke test met de eigen gebruiksteller van de provider. Voor de algemene methode, zie [hoe je LLM-besparingen controleert aan de hand van je factuur](/nl/guides/verify-llm-savings-against-provider-bill). Voor de OpenAI-kant van hetzelfde probleem, zie [waarom cached_tokens van OpenAI 0 is](/nl/guides/openai-prompt-caching-cached-tokens). De code staat op [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
