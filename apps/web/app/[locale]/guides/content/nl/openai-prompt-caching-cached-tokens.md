OpenAI cachet lange prompts automatisch: als het begin van een verzoek overeenkomt met een verzoek dat het onlangs heeft verwerkt, worden die inputtokens met korting gefactureerd en begint het antwoord sneller. Je hoeft niets aan te zetten. Juist daarom valt het makkelijk niet op wanneer het niet meer werkt. Komt `cached_tokens` bij elk verzoek terug als `0`, dan zet deze gids de oorzaken op een rij in de volgorde waarin je ze nagaat, laat hij zien hoe je de hitrate per verzoek bijhoudt en hoe je die controleert met de gebruiksgegevens van OpenAI zelf.

## Waar je het afleest

Elk antwoord vertelt je hoeveel inputtokens uit de cache kwamen:

- **Chat Completions:** `usage.prompt_tokens_details.cached_tokens`, van in totaal `usage.prompt_tokens`.
- **Responses API:** `usage.input_tokens_details.cached_tokens`, van in totaal `usage.input_tokens`.

De gecachete tokens maken deel uit van het inputtotaal; ze komen er niet bij. De [prompt-caching-gids](https://developers.openai.com/api/docs/guides/prompt-caching) van OpenAI is de referentie voor de actuele regels. Hij maakt nu onderscheid tussen nieuwere modellen, die ook cache-schrijfacties rapporteren en factureren en expliciete cache-opties accepteren, en oudere, waarbij schrijven naar de cache gratis is. Kijk wat hij zegt over het model dat jij gebruikt.

## Waarom cached_tokens 0 is

1. **De prompt is te kort.** Caching begint bij ongeveer 1,024 prompttokens; de exacte drempel en hoe het gecachete aantal wordt afgerond, hangen af van het model. Een systeemprompt van 600 tokens plus een korte vraag raakt de cache nooit, en niets vertelt je dat.
2. **Het begin van de prompt verandert.** De cache zoekt een overeenkomst vanaf het allereerste token. Een tijdstempel, een request-id of de naam van de gebruiker in het eerste bericht maakt elk verzoek vanaf token één uniek. Tools, afbeeldingen en responsformaten horen ook bij de prefix, dus tools in een andere volgorde, of een schema dat anders is geserialiseerd, breken de overeenkomst.
3. **De cache-entry is verwijderd.** Entries worden kort bewaard na het laatste gebruik, meestal enkele minuten als het rustig is. Verzoeken die een uur uit elkaar liggen, raken de cache zelden.
4. **Het verkeer is verspreid.** Verzoeken worden gerouteerd op basis van een hash van het begin van de prompt. Een heel hoog volume met dezelfde prefix loopt over naar andere machines die de entry niet hebben. De parameter `prompt_cache_key` van OpenAI groepeert verzoeken die een prefix delen; gebruik één sleutel per prompttemplate, niet per gebruiker, en houd het aantal verzoeken per sleutel gematigd, zoals de gids uitlegt.
5. **Je leest het veld niet uit.** Een gestreamd Chat Completions-verzoek bevat helemaal geen usage, tenzij je erom vraagt met `stream_options: { include_usage: true }`. Veel wrappers laten `prompt_tokens_details` weg. Sommige OpenAI-compatibele providers en sommige Azure-deployments rapporteren caching anders of helemaal niet.

## Test het in twee minuten

Controleer, voordat je je applicatie gaat debuggen, of caching überhaupt werkt voor jouw account en model. Stuur dezelfde lange prompt twee keer, een paar seconden na elkaar, en lees de usage van elk antwoord:

```bash
# A system prompt well above the threshold, sent twice. The second answer should report cached tokens.
BODY=$(python3 -c 'import json; print(json.dumps({"model": "gpt-4o-mini", "messages": [{"role": "system", "content": "You are a careful assistant for an invented shop. " * 200}, {"role": "user", "content": "Say OK."}]}))')
for i in 1 2; do
  curl -s https://api.openai.com/v1/chat/completions \
    -H "Authorization: Bearer $OPENAI_API_KEY" -H "Content-Type: application/json" \
    -d "$BODY" | python3 -c 'import json, sys; u = json.load(sys.stdin)["usage"]; print(u["prompt_tokens"], u.get("prompt_tokens_details"))'
done
```

Toont de tweede regel gecachete tokens, dan werkt de kant van de provider en zit het probleem in hoe je applicatie haar prompts opbouwt: lees verder. Toont hij er geen, probeer het dan een paar keer opnieuw (caching is best effort, en het eerste verzoek kan op een andere machine belanden) en kijk daarna bij het model in de caching-gids van OpenAI. Vervang het model door het model dat je in productie gebruikt; een test op een ander model bewijst weinig.

Deze test geeft je ook een uitgangspunt voor de volgende secties. Zodra je de volgorde van je prompt verandert of een `prompt_cache_key` toevoegt, doe je dezelfde vergelijking op een echt template uit je applicatie en bewaar je de cijfers. Een hitrate die vóór en na de wijziging is gemeten, op een template dat je gebruikers echt raken, is een resultaat dat je kunt laten zien; “caching zou moeten helpen” is dat niet.

## Zet wat verandert achteraan

Bij de meeste gevallen is de oplossing de volgorde. Alles wat voor elk verzoek hetzelfde is, komt vooraan en blijft byte voor byte identiek; alles wat verandert, komt aan het eind.

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

Houd daarna bij welk deel van elke prompt uit de cache kwam, zodat een regressie zichtbaar wordt op de dag dat hij live gaat:

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

Groepeer het per prompttemplate. Een template waarvan het aandeel op 0 % blijft terwijl de prompts boven de 1,024 tokens zitten, heeft iets dat dicht bij het begin verandert: log twee verzoeken en vergelijk ze teken voor teken, zoals in [de Claude-versie van deze gids](/nl/guides/claude-prompt-caching-not-working#vind-de-byte-die-je-cache-breekt).

## Hoe BV-SALA helpt

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) is een besparingslaag onder Apache-2.0 voor TypeScript die elk OpenAI-compatibel endpoint omhult, gratis en zonder sleutel. De cache van OpenAI is automatisch, dus de laag markeert niets bij OpenAI. Wat hij doet voor caching:

- **Hij vraagt bij streams altijd om usage,** zodat een gestreamd verzoek wordt gemeten in plaats van ongemerkt zonder teller te blijven.
- **Hij toont bij elke aanroep de korting van OpenAI,** in `report.nativeSavings`, op basis van de eigen teller van OpenAI, en houdt die apart van zijn eigen besparingen: de korting is van OpenAI, niet van de laag.
- **Hij kan vluchtige regels uit de prefix halen.** Met de opt-in `savings: { cachePrefix: true }` verhuizen regels van de systeemprompt die bij elk verzoek veranderen (ISO-tijdstempels, UUID's, epoch-tijden) naar het eind, zodat het stabiele deel kan worden gecachet. Het model leest dezelfde regels in een andere volgorde, en daarom is het jouw beslissing en staat het nooit standaard aan.

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

De eigen hefbomen van de laag (exacte herhalingen en identieke verzoeken die al onderweg zijn overslaan) staan los van de cache van OpenAI en worden uitgelegd in [identieke LLM-verzoeken dedupliceren](/nl/guides/deduplicate-llm-requests).

## Controleer het met de cijfers van OpenAI

1. **Per verzoek:** log `cached_tokens` en het inputtotaal van elk antwoord, of `report.tokens.providerCachedInput` met de laag.
2. **Per dag:** de [Usage API](https://developers.openai.com/api/reference/resources/organization/subresources/usage) van OpenAI geeft het completions-gebruik in dagelijkse buckets die gecachete inputtokens bevatten, per model en, als je erom vraagt, per API-sleutel of project. Tel je logs op voor dezelfde sleutel, hetzelfde model en dezelfde UTC-dag: de gecachete en niet-gecachete totalen moeten overeenkomen.
3. **In geld:** beprijs gecachete en niet-gecachete input apart. Neem bij modellen die cache-schrijfacties factureren die ook mee, anders valt je schatting van de besparing te hoog uit.

Lees voor de volledige methode [hoe je LLM-besparingen controleert aan de hand van de factuur van je provider](/nl/guides/verify-llm-savings-against-provider-bill). Voor de andere hefbomen op een OpenAI-factuur, zie [hoe je OpenAI API-kosten verlaagt](/nl/guides/reduce-openai-api-costs). Gemeten resultaten, ook waar de laag niets bespaart, staan op de [benchmarkpagina](/nl/benchmarks), en de code staat op [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
