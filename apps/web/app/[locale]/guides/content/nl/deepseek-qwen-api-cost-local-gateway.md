DeepSeek en Qwen zijn goedkoop per token, waardoor je de factuur makkelijk uit het oog verliest. Beide providers cachen prompts aan hun kant, en input die de cache raakt, wordt veel lager gefactureerd dan input die hem mist. De echte kosten van je verkeer hangen dus af van een getal dat de meeste dashboards verbergen: hoeveel inputtokens bij elk verzoek de cache raken. Deze gids legt uit hoe beide providers factureren en cachen, hoe je een verzoek beprijst op basis van zijn usage-velden, en hoe je dat per verzoek ziet met een gratis lokale gateway.

## Hoe DeepSeek een verzoek factureert

DeepSeek splitst de input van elk verzoek in tweeën: tokens die zijn contextcache raken en tokens die hem missen, elk met een eigen prijs, plus de outputtokens. Zijn [context caching](https://api-docs.deepseek.com/guides/kv_cache) staat voor elk account standaard aan. Voor een hit moet het begin van het verzoek exact overeenkomen met een eerder verzoek, de cache werkt op basis van best effort, en ongebruikte entries worden na enkele uren of dagen gewist. Het antwoord vertelt je wat er gebeurde:

- `usage.prompt_cache_hit_tokens`: inputtokens die uit de cache zijn geleverd.
- `usage.prompt_cache_miss_tokens`: inputtokens die volledig zijn verwerkt.
- `usage.prompt_tokens_details.cached_tokens`: hetzelfde aantal hits, in het veld dat OpenAI-compatibele tools uitlezen.

De [prijspagina](https://api-docs.deepseek.com/quick_start/pricing) van DeepSeek vermeldt per model de prijzen voor hits, misses en output, en een daluurvenster met een lagere prijs. Prijzen veranderen; neem ze over met de datum waarop je ze las.

## Hoe Qwen een verzoek factureert

Qwen-modellen op Alibaba Cloud Model Studio hebben twee soorten [contextcache](https://www.alibabacloud.com/help/en/model-studio/context-cache). De impliciete cache werkt automatisch voor prompts boven een minimale lengte, en de hits ervan worden met korting gefactureerd. De expliciete cache werkt zoals die van Anthropic: je markeert een blok met `cache_control`, de entry leeft een paar minuten, en schrijven kost iets meer dan gewone input, terwijl lezen veel minder kost. In de OpenAI-compatibele API komt het aantal hits binnen in `usage.prompt_tokens_details.cached_tokens`. Model Studio heeft regionale endpoints, dus controleer bij welk endpoint je sleutel hoort.

## Zorg dat je de cache raakt, bij beide providers

De regels zijn dezelfde als bij elke prefix-cache:

1. Zet wat nooit verandert vooraan: de systeemprompt, de tooldefinities, lange referentietekst, few-shot-voorbeelden.
2. Houd dat byte voor byte identiek tussen verzoeken: geen tijdstempels, request-id's of gebruikersnamen erin, en tooldefinities in een vaste volgorde.
3. Zet wat verandert achteraan: de vraag van de gebruiker, het nieuwste toolresultaat.
4. Voeg bij agents toe aan de geschiedenis in plaats van die te herschrijven. Een oud bericht in het midden aanpassen maakt alles daarna ongeldig.

## Bereken de kosten van één verzoek

Je hebt geen enkele tool nodig om een verzoek te beprijzen. Lees het usage-blok en vermenigvuldig elke post met zijn prijs:

```python
def request_cost(usage: dict, price_miss: float, price_hit: float, price_out: float) -> float:
    """USD cost of one chat completion. Prices are per million tokens, from the provider's pricing page."""
    details = usage.get("prompt_tokens_details") or {}
    hit = usage.get("prompt_cache_hit_tokens", details.get("cached_tokens", 0)) or 0
    miss = usage["prompt_tokens"] - hit
    return (miss * price_miss + hit * price_hit + usage["completion_tokens"] * price_out) / 1_000_000
```

Log dat getal bij elk verzoek samen met het model, het aandeel hits (`hit / prompt_tokens`) en een tijdstempel, en je kunt de vragen beantwoorden die ertoe doen: welke feature het meest kost, of de cache-hitrate na een deploy is gedaald, en hoeveel van je verkeer in het daluurvenster valt.

## Zie elk verzoek met een lokale gateway

Om niet elke plek in je code aan te hoeven passen waar een aanroep gebeurt, zet je een gateway vóór de provider. [BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) levert er een mee in zijn npm-pakket: Apache-2.0, lokaal, **zonder sleutel en zonder aanmelding**, en er gaat niets naar BiVelio. Draai één gateway per provider, elk op een eigen poort:

```bash
# DeepSeek
npx @bivelio/savings-layer gateway --upstream deepseek --port 8403

# Qwen on Model Studio's international endpoint (`--upstream qwen` is the Beijing one)
npx @bivelio/savings-layer gateway --upstream https://dashscope-intl.aliyuncs.com --port 8404
```

De gateway stuurt het pad dat je client meestuurt door naar de provider, dus je base URL is die van de provider zelf, met de gateway als host:

| Provider | `--upstream` | Base URL voor je OpenAI-client |
| --- | --- | --- |
| DeepSeek | `deepseek` | `http://127.0.0.1:8403` |
| Qwen (Beijing) | `qwen` | `http://127.0.0.1:<port>/compatible-mode/v1` |
| Qwen (internationaal) | `https://dashscope-intl.aliyuncs.com` | `http://127.0.0.1:8404/compatible-mode/v1` |
| GLM | `glm` | `http://127.0.0.1:<port>/api/paas/v4` |

`npx @bivelio/savings-layer --help` toont de andere upstreams (Moonshot, MiniMax, OpenRouter, Gemini, Ollama, vLLM, LM Studio).

In Python regelt de kleine client van het pakket de base URL voor je: maak je gebruikelijke OpenAI-client voor de provider aan, en `wrap()` geeft een kopie terug die via de gateway loopt en het pad van de provider behoudt.

```python
# pip install bivelio-savings-layer openai
import os

import bvsala
from openai import OpenAI

gw = bvsala.Gateway("http://127.0.0.1:8403")  # the DeepSeek gateway started above
deepseek = gw.wrap(OpenAI(base_url="https://api.deepseek.com", api_key=os.environ["DEEPSEEK_API_KEY"]))

resp = deepseek.chat.completions.create(
    model="deepseek-flash",
    messages=[
        {"role": "system", "content": "You review Python diffs for an invented team. House rules: ..."},
        {"role": "user", "content": "Review this diff: ..."},
    ],
)
report = gw.report(resp)
print(report.summary())  # model · basis · cost (in, cached, out)
print(report.tokens.provider_cached_input, report.cost.actual)
```

Voor Qwen werkt hetzelfde met de andere gateway en `OpenAI(base_url="https://dashscope-intl.aliyuncs.com/compatible-mode/v1", ...)`. Is er een HTTP-proxyvariabele ingesteld, voeg dan `NO_PROXY=127.0.0.1,localhost` toe voordat je de client aanmaakt, anders gaan verzoeken naar de lokale gateway, inclusief je providersleutel, via de proxy; versie 1.2.5 waarschuwt als dat zou gebeuren. Draait er geen gateway, dan gooit `wrap()` `GatewayUnavailable` in plaats van de provider rechtstreeks aan te roepen, en zegt hoe je er een start, zonder sleutel.

Elke andere taal of tool werkt ook: richt de OpenAI-base-URL ervan op de gateway, en elk verzoek wordt één regel in de log van de gateway, met het model, de kosten tegen lijstprijs en de input uitgesplitst in tokens tegen de volle prijs en cache-lezingen (`cache↓`).

Eén uitzondering is van belang voor chattools en agents: een **gestreamd** verzoek dat niet om usage vraagt (`stream_options: {"include_usage": true}`), krijgt die niet van de provider, dus versie 1.2.5 logt het als `not metered: the request did not ask for usage`. Vraag om usage in je client, of start de gateway met `BVSALA_GATEWAY_USAGE_INJECT=1`, die die optie toevoegt aan streams die hem missen. De laatste chunk van die streams heeft dan een lege `choices`-lijst, iets waar code die `choices[0]` zonder controle uitleest niet op rekent.

## Coding-agents op DeepSeek of Qwen

DeepSeek publiceert ook een endpoint in Anthropic-formaat en documenteert hoe je dat met Claude Code gebruikt. Met `--upstream deepseek` stuurt de gateway verzoeken in Anthropic-formaat zelf naar dat endpoint:

```bash
npx @bivelio/savings-layer gateway --upstream deepseek --port 8402
ANTHROPIC_BASE_URL=http://127.0.0.1:8402 ANTHROPIC_AUTH_TOKEN="$DEEPSEEK_API_KEY" ANTHROPIC_MODEL=deepseek-flash claude
```

Op deze route meet de gateway, maar bespaart hij niets: het endpoint in Anthropic-formaat van DeepSeek negeert `cache_control` en meldt geen cache-schrijfacties ([de gids](https://api-docs.deepseek.com/guides/anthropic_api)), dus de standaardhefboom heeft niets te verlagen. Een niet-Claude-model achter Claude Code draaien is een integratie van DeepSeek, geen setup die Anthropic ondersteunt, en of het model goed genoeg is voor jouw werk, moet je zelf beoordelen.

**Qwen Code met Qwen-modellen** vraagt om een andere route: in versie 1.2.5 vereist `npx @bivelio/savings-layer qwen` dat Qwen Code het Anthropic-authenticatietype gebruikt, en stuurt het verkeer door naar de API van Anthropic, dus hij meet alleen Claude-modellen die met een Anthropic-sleutel worden gebruikt, en hij weigert een DashScope-base-URL in Anthropic-formaat. Gebruik voor Qwen-modellen de OpenAI-compatibele modus van Qwen Code, die [de documentatie](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/) configureert met `OPENAI_API_KEY`, `OPENAI_BASE_URL` en `OPENAI_MODEL`, en richt die base URL op een gateway. Zet `DASHSCOPE_PROXY_BASE_URL` op precies dezelfde URL:

```bash
npx @bivelio/savings-layer gateway --upstream https://dashscope-intl.aliyuncs.com --port 8404

GW=http://127.0.0.1:8404/compatible-mode/v1
OPENAI_BASE_URL="$GW" DASHSCOPE_PROXY_BASE_URL="$GW" OPENAI_API_KEY="$DASHSCOPE_API_KEY" OPENAI_MODEL=qwen-plus qwen
```

De tweede variabele maakt verschil voor de factuur. Qwen Code bepaalt aan de host van de base URL of het met DashScope praat, en `127.0.0.1` is geen DashScope-host. Zonder de variabele valt het terug op zijn generieke OpenAI-provider, die geen expliciete cachemarkeringen meestuurt (`cache_control` en de header `X-DashScope-CacheControl`). Je verzoeken vallen dan terug op de impliciete cache van Model Studio, waar hits doorgaans 20% van de inputprijs kosten en best effort zijn, in plaats van de 10% van de expliciete cache ([contextcache](https://www.alibabacloud.com/help/en/model-studio/context-cache)). Qwen Code behandelt een base URL die exact overeenkomt met `DASHSCOPE_PROXY_BASE_URL` als DashScope en houdt de markeringen dan aan ([de DashScope-provider](https://github.com/QwenLM/qwen-code/blob/8fab857da5/packages/core/src/core/openaiContentGenerator/provider/dashscope.ts), geraadpleegd op 23 november 2026).

We hebben de gatewaykant van deze route met versie 1.2.5 gecontroleerd (beide markeringen komen ongewijzigd door), niet Qwen Code zelf, dus lees de log van de gateway: één regel met kosten per verzoek. Een regel met `not metered` zegt waarom: meestal een stream die niet om usage vraagt (herstart de gateway met `BVSALA_GATEWAY_USAGE_INJECT=1`), of een model zonder rij in de catalogus van 1.2.5, die `qwen-plus`, `qwen-flash`, `qwen3.7-flash`, `qwen3.8-flash` en `qwen3.8-max` bevat, maar bijvoorbeeld niet `qwen3-coder-plus`.

Twee prijsgaten in 1.2.5 hangen af van die tweede variabele. **Met `DASHSCOPE_PROXY_BASE_URL` ingesteld**, zoals hierboven, factureert Model Studio elke schrijfactie naar de expliciete cache tegen 125% van de inputprijs en rapporteert die in `usage.prompt_tokens_details.cache_creation_input_tokens`. De 1.2.5-gateway leest dat veld niet: hij logt die tokens als gewone input, met `cache↑0`, tegen 80% van wat ze kosten. Zijn hitprijs voor `qwen-plus` is de 10% van de expliciete cache, en die klopt. **Zonder de variabele** zijn er geen expliciete schrijfacties, maar zijn de hits impliciet, gefactureerd tegen ongeveer 20%, en logt de gateway ze tegen dezelfde 10%, ongeveer de helft van wat ze kosten.

## Wat de gateway meet, en wat niet

- **Het dollarbedrag komt uit een catalogus, niet uit de tijdafhankelijke prijzen van DeepSeek.** Versie 1.2.5 heeft rijen voor `deepseek-flash` en `deepseek-v4-pro`. Voor cache-misses en output gebruiken die de piekprijs van DeepSeek, dus in de daluren tonen die posten het dubbele van wat DeepSeek factureert. Voor cache-hits gebruiken beide rijen US$ 0,003 per miljoen tokens, de dalprijs van DeepSeek voor een hit op `deepseek-flash` (de hitprijs in de piekuren is het dubbele) en lager dan beide hitprijzen die DeepSeek voor `deepseek-v4-pro` publiceert ([prijspagina](https://api-docs.deepseek.com/quick_start/pricing), geraadpleegd op 23 november 2026). Afhankelijk van het uur en van hoeveel van je input de cache raakt, kan het totaal van de gateway hoger of lager uitvallen dan de factuur. De tokentellingen zijn exact; vergelijk die eerst. De klassieke alias `deepseek-chat` heeft geen rij: hij wordt doorgestuurd, en de log zegt dat hij niet is gemeten.
- **Hij verandert deze verzoeken niet.** Op OpenAI-compatibel verkeer meet de gateway en stuurt hij door (de enige uitzondering is de opt-in usage-injectie van hierboven); zijn besparingshefbomen zijn voor verkeer in Anthropic-formaat. De besparing bij DeepSeek en Qwen komt uit hun eigen caches, en daarom is het aantal hits het getal om in de gaten te houden.

## Als je DeepSeek of Qwen vanuit TypeScript aanroept

De SDK van BV-SALA praat met elk OpenAI-compatibel endpoint en slaat exacte herhalingen en identieke verzoeken die al onderweg zijn over, gratis en zonder sleutel ([hoe dat werkt](/nl/guides/deduplicate-llm-requests)). Bij DeepSeek worden die vermeden aanroepen gerapporteerd als `estimated`, niet als `reference`: versie 1.2.5 waardeert een herhaling alleen via referentie als de aanroep die draaide naar de eigen API van OpenAI, Anthropic of Google ging. Eén waarschuwing voor agent-loops: het standaard inkorten van achterhaalde toolresultaten herschrijft het midden van de geschiedenis, en bij een provider die zelf de hele prompt cachet, kan dat meer kosten dan het oplevert. De changelog van het project meldt +166% op een agent-loop van 60 stappen op DeepSeek, gemeten tegen een nepprovider met versies 1.2.3 en 1.2.4 en zonder sleutel; 1.2.5 kort op dezelfde manier in. Zet het voor agent-loops per verzoek uit:

```ts
// npm i @bivelio/savings-layer   (ESM: a "type": "module" project or a .mts file)
import { createSavingsLayer, OpenAICompatibleProvider } from "@bivelio/savings-layer";

const layer = createSavingsLayer({
  provider: new OpenAICompatibleProvider({ baseUrl: "https://api.deepseek.com/v1", apiKey: process.env.DEEPSEEK_API_KEY }),
});

const { text, report } = await layer.generate({
  model: "deepseek-flash",
  messages: [{ role: "user", content: "Explain what a race condition is in two sentences." }],
  savings: { elision: false }, // keep the history byte-identical for DeepSeek's own cache
});
console.log(text, report.tokens.providerCachedInput, report.cost.basis);
```

## Controleer de cijfers tegen je provider

Vergelijk één keer per dag de totalen per model van de gateway (input, cache-hits, output) met de gebruikspagina van het DeepSeek-platform of Model Studio voor dezelfde sleutel. De totale tokentellingen moeten overeenkomen, met één uitzondering in hoe ze zijn verdeeld: bij Qwen telt versie 1.2.5 schrijfacties naar de expliciete cache als gewone input, niet als cache-schrijfacties. Dollarbedragen kunnen verschillen, in beide richtingen: de catalogus negeert de tijdafhankelijke prijzen van DeepSeek, bij Qwen beprijst hij schrijfacties naar de expliciete cache als gewone input en impliciete hits tegen het expliciete tarief, en regionale prijzen en kortingen veranderen het bedrag ook. Voor een methode stap voor stap, zie [hoe je LLM-besparingen controleert aan de hand van de factuur van je provider](/nl/guides/verify-llm-savings-against-provider-bill). De code van de gateway en zijn gidsen per terminal staan op [GitHub](https://github.com/BiVelio/bivelio-savings-layer), en wat het project heeft gemeten, en wat niet, staat op de [benchmarkpagina](/nl/benchmarks).
