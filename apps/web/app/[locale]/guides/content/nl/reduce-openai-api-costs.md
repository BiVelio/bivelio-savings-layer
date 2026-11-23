Een OpenAI-factuur is de som van een paar getallen per verzoek: niet-gecachete inputtokens, gecachete inputtokens, cache-schrijfacties (op GPT-5.6 en later), outputtokens (redeneren inbegrepen) en de prijs van het model. Elke manier om hem te verlagen verschuift een van die getallen. Deze gids loopt de hefbomen langs in de volgorde waarin ze meestal het meest opleveren, zegt wanneer ze niets opleveren en laat zien hoe je elke besparing bewijst met de gebruiksgegevens van OpenAI zelf in plaats van met een projectie. Voor het meeste heb je geen enkele tool nodig; waar de open-source SDK BV-SALA een hefboom automatiseert, zie je hoe.

## Begin met meten per verzoek

Log, voordat je iets verandert, het `usage`-blok van elk antwoord samen met de feature of het prompttemplate dat het opleverde: `prompt_tokens`, `prompt_tokens_details.cached_tokens`, `cache_write_tokens` als het model dat rapporteert, `completion_tokens` en, voor redeneermodellen, `completion_tokens_details.reasoning_tokens`. Beprijs elke post met de tarieven van de prijspagina van OpenAI en noteer de datum waarop je ze overnam. Op GPT-5.6 en later zijn cache-schrijfacties een aparte post: OpenAI rekent ze tegen 1.25 keer het niet-gecachete inputtarief met de standaardlevensduur van 30 minuten, en tegen 2.5 keer met de levensduur van 12 uur ([prompt-caching-gids](https://developers.openai.com/api/docs/guides/prompt-caching), geraadpleegd op 23 november 2026). Reken je ze als gewone input, dan kom je te laag uit. Een week van deze gegevens beantwoordt de enige vraag die aan het begin telt: **welke twee of drie features het grootste deel van de factuur maken.** Optimaliseer die; negeer de rest.

## 1. Betaal niet twee keer voor hetzelfde verzoek

Retries, dubbelklikken, nachtelijke jobs die de items van gisteren opnieuw classificeren en parallelle workers die dezelfde prompt sturen kosten elk een volledige aanroep. Een responscache op exacte overeenkomst en deduplicatie van verzoeken die al onderweg zijn halen ze weg zonder ook maar één antwoord te veranderen. Hoeveel je bespaart hangt volledig af van hoe vaak je verzoeken zich herhalen, dus meet eerst je percentage duplicaten. Volledige gids: [identieke LLM-verzoeken dedupliceren](/nl/guides/deduplicate-llm-requests).

## 2. Laat de prompt-cache van OpenAI zijn werk doen

Prompts van ongeveer 1,024 tokens of meer worden automatisch gecachet, en gecachete inputtokens worden met korting gefactureerd. Op GPT-5.6 en later is de cache vullen niet gratis: het deel dat erin wordt geschreven, wordt boven het niet-gecachete tarief gefactureerd, zoals hierboven beschreven, dus een prompt die wordt geschreven en nooit meer gelezen kost meer dan zonder cache, en een prompt die snel weer wordt gelezen kost veel minder. Oudere modellen rekenen niets extra voor schrijfacties. De cache zoekt alleen een overeenkomst vanaf het eerste token, dus hij werkt alleen als het begin van je prompt tussen verzoeken identiek is. Zet instructies, tooldefinities en voorbeelden vooraan, en datums, gebruikersnamen en de vraag achteraan. Blijft `cached_tokens` op 0 steken, lees dan [waarom cached_tokens van OpenAI 0 is](/nl/guides/openai-prompt-caching-cached-tokens).

## 3. Stuur werk dat kan wachten naar de Batch API

Evaluaties, backfills, embeddings van een documentenset en nachtelijke classificatie hebben geen antwoord binnen twee seconden nodig. De [Batch API](https://developers.openai.com/api/docs/guides/batch) van OpenAI neemt een bestand met verzoeken aan, levert de resultaten binnen een dag en rekent er een lager tarief voor dan voor dezelfde verzoeken één voor één (zie de [gids voor kostenoptimalisatie](https://developers.openai.com/api/docs/guides/cost-optimization) voor de actuele voorwaarden). Voor offline werk is het vaak de grootste losse besparing, en aan de antwoorden verandert niets.

## 4. Gebruik het kleinste model dat je evaluatie haalt

De prijsverschillen tussen modelklassen zijn groot, en veel taken (classificatie, extractie, korte herschrijvingen, routering) hebben het grootste model niet nodig. Bouw een kleine evaluatieset uit echte verzoeken, draai die tegen twee of drie modellen en kies het goedkoopste dat slaagt. Draai hem opnieuw als er een nieuw model uitkomt. Zonder evaluatie is een kleiner model een gok, en de kosten van foute antwoorden staan niet op de API-factuur.

## 5. Houd de output in de hand

Outputtokens kosten meestal meerdere keren zoveel als inputtokens, en redeneertokens worden als output gefactureerd.

- Zet `max_completion_tokens` op wat de feature echt nodig heeft.
- Verlaag bij redeneermodellen de redeneerinspanning voor taken die geen diep redeneren vragen, en meet `reasoning_tokens` ervoor en erna.
- Vraag om gestructureerde output met een JSON-schema als je code het antwoord parset. Een mislukte parse gevolgd door een retry betaalt het hele verzoek twee keer.

## 6. Stuur minder input

- Stuur niet het hele gesprek opnieuw mee als de taak alleen de laatste beurten nodig heeft.
- Houd grote tooloutputs (logs, bestandsinhoud, zoekresultaten) buiten latere beurten zodra ze zijn gebruikt.
- Stuur gestructureerde data compact: mooi opgemaakte JSON verspilt tokens aan witruimte.
- Haal de drie relevante alinea's op in plaats van het hele document te plakken.

Wees voorzichtig met de laatste twee in lange agent-loops: het midden aanpassen van een geschiedenis die OpenAI al heeft gecachet, zorgt dat alles na de aanpassing opnieuw wordt gefactureerd, tegen het niet-gecachete tarief of, op GPT-5.6 en later, tegen het hogere cache-schrijftarief als het opnieuw wordt gecachet. Kort in wat nieuw is, niet wat al gecachet is.

## Hoe BV-SALA een deel hiervan automatiseert

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) is een besparingslaag onder Apache-2.0 die elk OpenAI-compatibel endpoint in TypeScript omhult. Hij bespaart met elke hefboom **gratis, zonder sleutel en zonder aanmelding**, en stuurt niets naar BiVelio, tenzij je een sleutel toevoegt voor het optionele clouddashboard. Standaard aan: de exacte cache, deduplicatie van identieke verzoeken die al onderweg zijn, kale rekensommen lokaal beantwoorden en compacte serialisatie van de gestructureerde data die je meegeeft. Opt-in, met één optie per stuk: de modelcascade, het compacter maken van tooloutput en het herordenen van de cachebare prefix. Elk verzoek levert een rapport op dat zegt wat er is bespaard en waar het getal vandaan komt.

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

Twee eerlijke beperkingen. Ten eerste bespaart verkeer dat zich nooit herhaalt met de cache en deduplicatie ongeveer 0 %, en dat is zo bedoeld. Ten tweede kan het standaard inkorten van achterhaalde toolresultaten in lange agent-loops meer kosten dan het oplevert bij een provider die de hele prompt cachet: de changelog van het project meldt +12.2 % op een loop van 60 stappen met `gpt-5`, gemeten tegen een nepprovider met versies 1.2.3 en 1.2.4 en zonder sleutel. Geef voor lange agent-loops `savings: { elision: false }` mee in het verzoek en vergelijk.

## Bewijs elke besparing met de cijfers van OpenAI

Een besparing die je niet kunt controleren, is een projectie. Per hefboom:

1. **Kies de teller die hij moet verschuiven.** Cache en deduplicatie verschuiven het aantal verzoeken. Prompt caching verschuift `cached_tokens`, en op GPT-5.6 en later ook `cache_write_tokens`. Batch verschuift de prijs. De modelkeuze verschuift de prijs per token. Outputbeheersing verschuift `completion_tokens`.
2. **Lees die teller uit bij OpenAI.** De [Usage API](https://developers.openai.com/api/reference/resources/organization/subresources/usage) geeft verzoeken, inputtokens, gecachete inputtokens en outputtokens per dag, model, project en sleutel. Het Costs-endpoint en het gebruiksdashboard geven de bedragen.
3. **Vergelijk gelijk met gelijk.** Dezelfde feature, dezelfde weekdagen, ervoor en erna, of beter: twee armen van hetzelfde verkeer op hetzelfde moment. Kijk eerst naar tokens en pas daarna naar dollars: dollars bewegen ook mee met de prijzen.

Met de laag bevat elk rapport `cost.basis`: bedragen met `measured` en `reference` komen uit de eigen teller van OpenAI, bedragen met `estimated` worden apart gerapporteerd en nooit erbij opgeteld. De volledige methode: [LLM-besparingen controleren aan de hand van de factuur van je provider](/nl/guides/verify-llm-savings-against-provider-bill).

## Wat de gepubliceerde cijfers zeggen

De [benchmarkpagina](/nl/benchmarks) van het project meet beide armen van elke test met de eigen gebruiksteller van de provider. Op een openbare workload van GSM8K-vragen waarin 30 % van de verzoeken exacte herhalingen waren, was de gepoolde verlaging op `gpt-4o-mini` **31.50 %**, met een 95 %-interval van 25.7 % tot 36.7 % (artefacten van SDK 0.4.31, september 2026; ook in de README). Bij chat van twee beurten zonder herhalingen (MT-Bench) waren de verschillen niet van nul te onderscheiden of niet aan de laag toe te schrijven, en de pagina zegt dat ook. De methode, de intervallen en elke beperking staan in [de paper](/nl/paper). De code staat op [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
