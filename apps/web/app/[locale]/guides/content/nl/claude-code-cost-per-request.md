“Wat kost Claude Code?” heeft twee eerlijke antwoorden. Met een Claude-abonnement is de prijs die van het abonnement, en kosten per token tellen pas als je over de limieten heen gaat. Met een API-sleutel of een cloudprovider betaal je per token, en de kosten van een sessie hangen af van hoeveel verzoeken Claude Code stuurt, hoe groot elk verzoek is en hoeveel ervan uit de prompt-cache wordt gelezen. Deze gids laat zien wat Anthropic publiceert, welke ingebouwde tools totalen geven en hoe je gratis op je eigen machine de kosten van elk afzonderlijk verzoek ziet, zodat je de beurten vindt die een sessie duur maken.

## Wat het volgens Anthropic kost

De eigen [kostenpagina van Claude Code](https://code.claude.com/docs/en/costs) van Anthropic geeft gemiddelden van implementaties bij bedrijven: ongeveer US$ 13 per ontwikkelaar per actieve dag en US$ 150 tot US$ 250 per ontwikkelaar per maand, waarbij 90% van de gebruikers onder US$ 30 per actieve dag blijft. Dat zijn gemiddelden over veel teams. Jouw getal hangt af van het model dat je kiest, de grootte van je repository en hoe je werkt, en daarom gaat de rest van deze gids over meten.

## De ingebouwde tools, en wat ze niet laten zien

- **`/usage` in Claude Code.** Het Session-blok toont *geschatte* kosten tegen lijstprijs, met tokens per model uitgesplitst in input, output, cache-lezingen en cache-schrijfacties. Recente versies voegen een regel over de prompt-cache toe met de hitrate en het aantal misses. Het is een sessietotaal, lokaal berekend.
- **De Claude Console.** Voor API-sleutels tonen de pagina's Cost en Usage wat er is gefactureerd, per dag, workspace en model. Dit is het getal om tegen af te stemmen.
- **OpenTelemetry-export.** Claude Code kan token- en kostenmetrics naar je eigen observability-stack sturen, per gebruiker en per sessie ([monitoringdocumentatie](https://code.claude.com/docs/en/monitoring-usage)).

Wat geen van deze makkelijk maakt, is het **zicht per verzoek**: welke beurt was de dure, en waarom. Een sessie bestaat uit tientallen of honderden API-aanroepen, en de dure hebben herkenbare oorzaken:

- **Een koude cache.** De eerste beurt na een pauze die langer is dan de levensduur van de cache, leest het hele gesprek opnieuw tegen de volle prijs, en schrijft het opnieuw.
- **Een modelwissel.** Elk model heeft zijn eigen cache, dus midden in een sessie van model wisselen verwerkt alles opnieuw.
- **Enorme toolresultaten.** Een testlog of een groot bestand dat één keer is gelezen, zit in de context van elke latere beurt.
- **Te veel tooldefinities.** MCP-servers kunnen vele kilobytes aan definities aan elk verzoek toevoegen.
- **Compacteren.** Een lang gesprek samenvatten is zelf een groot verzoek.

## Meet elk verzoek met een lokale gateway

Een gateway is een kleine proxy tussen Claude Code en de API die de gebruikstellers van elk antwoord uitleest. Claude Code ondersteunt dat officieel via `ANTHROPIC_BASE_URL`. [BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) levert er een mee in zijn npm-pakket: Apache-2.0, **geen sleutel, geen aanmelding**, en er gaat niets naar BiVelio. Hij heeft Node.js 20 of nieuwer nodig.

De manier met één commando:

```bash
# Starts a local gateway on a free port, runs Claude Code through it, and stops it on exit.
npx @bivelio/savings-layer claude
```

De wrapper houdt de log per verzoek stil, zodat die niet over de interface van Claude Code heen schrijft. Bij het afsluiten toont hij hoeveel verzoeken hij heeft gemeten, welke hij zonder meting heeft doorgestuurd, en waarom. Om elk verzoek te zien op het moment dat het gebeurt, vraag je de log op stderr:

```bash
BVSALA_GATEWAY_LOG=1 npx @bivelio/savings-layer claude
```

of draai je de gateway in een eigen terminal, op een vaste poort:

```bash
# Terminal 1: the gateway (Anthropic is the default upstream, port 8402)
npx @bivelio/savings-layer gateway

# Terminal 2: Claude Code, pointed at it (no /v1 at the end).
# ENABLE_TOOL_SEARCH=true only matters before Claude Code v2.1.304 (see below).
ENABLE_TOOL_SEARCH=true ANTHROPIC_BASE_URL=http://127.0.0.1:8402 claude
```

Elk verzoek wordt één regel. Deze twee komen uit een lokale test tegen een vervangende server, met verzonnen verkeer, dus de vorm is echt en de getallen zijn niet de jouwe:

```text
[gateway] POST /v1/messages  · claude-sonnet-5 · $0.007700 (in 40, cache↑3000 cache↓0, out 12)
[gateway] POST /v1/messages  · claude-sonnet-5 · $0.000800 (in 40, cache↑0 cache↓3000, out 12)
```

Lees van links naar rechts: het model, de kosten tegen de standaard lijstprijs van het model (beurten in fast mode zijn de uitzondering, zie verderop), dan de inputtokens die volledig zijn gefactureerd, de tokens die naar de cache zijn geschreven (`cache↑`), de tokens die eruit zijn gelezen (`cache↓`) en de outputtokens. De eerste regel is een koude beurt die de prefix schrijft; de tweede leest hem terug voor een fractie van de prijs. Een sessie waarin `cache↑` beurt na beurt groot blijft, heeft een cacheprobleem: zie [waarom prompt caching van Claude ophoudt met werken](/nl/guides/claude-prompt-caching-not-working).

`ENABLE_TOOL_SEARCH=true` hangt af van je versie van Claude Code. Sinds v2.1.304 blijft tool search aan achter een gateway ([MCP-documentatie van Claude Code](https://code.claude.com/docs/en/mcp)), en verandert de variabele niets. Vóór v2.1.304 zette Claude Code tool search uit achter elke base URL die niet van Anthropic was en stopte het elke tooldefinitie in elk verzoek. Op die oudere versies was dat duur: de Claude Code-gids van de gateway, meegeleverd in het npm-pakket, beschrijft een setup met 226 MCP-tools, gemeten op 9 september 2026, waarbij dat 450 KB per verzoek en een kwart van de factuur van die dag betekende. De `claude`-wrapper zet de variabele voor je, tenzij je hem al hebt gezet.

## Wat de gateway ziet, en wat niet

- **Hij stuurt door wat Claude Code stuurt.** Als er geen hefboom op een verzoek werkt, komt de body byte voor byte bij Anthropic aan, inclusief `cache_control`-markeringen en de `anthropic-beta`-header, dus caching werkt precies zoals zonder de gateway. Een test in de repository controleert dat bij elke wijziging tegen een nep-upstream.
- **Twee kleine aanroepen gaan eromheen.** Volgens de [gids voor gatewaycompatibiliteit](https://code.claude.com/docs/en/llm-gateway-protocol) van Claude Code roepen de beschikbaarheidscheck van fast mode en de domeinveiligheidscheck van WebFetch rechtstreeks `api.anthropic.com` aan in plaats van `ANTHROPIC_BASE_URL` te volgen. Geen van beide is een modelverzoek: de inferentie in fast mode zelf volgt de base URL en gaat door de gateway.
- **Beurten in fast mode worden gelogd tegen de standaardprijs.** Anthropic markeert een fast-mode-verzoek met `speed: "fast"` en rekent er een toeslag voor: US$ 8 input en US$ 40 output per miljoen tokens op Claude Opus 5.5, het dubbele van het standaardtarief, met de cachevermenigvuldigers erbovenop ([documentatie over fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode)). Versie 1.2.3 van de gateway leest `speed` niet, dus hij telt die tokens correct maar beprijst ze als standaardbeurten: op Opus 5.5 de helft van wat Anthropic factureert. Gebruik je `/fast`, dan is het totaal van de gateway voor die beurten te laag.
- **Abonnementsverkeer wordt gemeten, niet gefactureerd.** Bij een login met Claude Pro of Max is er geen factuur per token; de gateway beprijst dat verkeer tegen het equivalent in lijstprijs zodat je het kunt zien, en schrijft er geen besparing op bij.

## Bespaart de gateway ook geld?

Standaard, met Claude Code op een API-sleutel, meet hij en bespaart hij niets. Lees de opstartmelding van versie 1.2.3 niet als een belofte: die zegt dat elke lokale besparingshefboom aan staat, en de samenvatting bij het afsluiten telt alleen de verzoeken die hij heeft gemeten, dus geen van beide vertelt je dat de besparing nul was. De standaardhefboom van de gateway verlaagt de levensduur van cache-schrijfacties van een uur naar vijf minuten bij beurten waarin een groot deel van het verzoek nieuw is, omdat een schrijfactie van een uur twee keer de inputprijs kost en een van vijf minuten 1,25 keer. Claude Code op een API-sleutel vraagt al om vijf minuten, tenzij je `promptCacheTtl` op `1h` zet, dus er valt niets te verlagen.

Als de cache van een uur meespeelt, is de besparing klein en hangt ze af van je verkeer. De [benchmarkpagina](/nl/benchmarks#gateway-ttl) publiceert een replay van het eigen Claude Code-verkeer van één organisatie: netto **+2,49%** van de factuur tegen lijstprijs (US$ 113,45 van US$ 4.563,61), met een 95%-interval van +1,50% tot +3,57% bij hersampling per sessie, en een plafond van 7,2% voor elk beleid van dit type. Op één model was het resultaat bijna nul, en in één periode kostte het geld. Het is een replay met een deels gereconstrueerde baseline, geen factuur, en de pagina somt elke beperking op.

## Stem de cijfers van de gateway af op je factuur

1. **Tegen `/usage`.** Tel voor één sessie de kosten per verzoek van de gateway op en vergelijk ze met het Session-blok van `/usage`. Beide beprijzen dezelfde tellers tegen lijstprijs, dus ze moeten dicht bij elkaar liggen, behalve bij beurten in fast mode, die `/usage` tegen het fast-tarief beprijst en de 1.2.3-gateway tegen het standaardtarief.
2. **Tegen de Console.** Gebruik een dag lang een aparte API-sleutel of workspace en vergelijk daarna de totalen per model van de gateway met de Usage-pagina van de Console voor die sleutel: input, output, cache-schrijfacties en cache-lezingen, eerst in tokens, dan in dollars.
3. **Verklaar elk verschil.** De lijstprijs is niet altijd jouw prijs: contractkortingen, dataresidentie of prioriteitsniveaus veranderen het bedrag, maar niet het aantal tokens. Fast mode ook: met `/fast` aan ligt het totaal van de gateway lager dan dat van de Console, omdat 1.2.3 beurten in fast mode tegen het standaardtarief beprijst. Verkeer dat niet via deze gateway is gegaan, zoals een andere machine, een script of een CI-job met dezelfde sleutel, verschijnt alleen in de Console.

Als de tokens kloppen en de dollars niet, zit het verschil in de prijzen, niet in de meting. Lees voor de volledige methode [hoe je LLM-besparingen controleert aan de hand van de factuur van je provider](/nl/guides/verify-llm-savings-against-provider-bill).

## De factuur verlagen zodra je hem ziet

Met cijfers per verzoek voor je neus zijn de gebruikelijke oplossingen eenvoudig: maak de context leeg tussen taken die niets met elkaar te maken hebben in plaats van een lange context mee te slepen, kies het model vóór de sessie en houd het aan, compacteer op natuurlijke rustpunten, houd grote logs buiten de context en schrap de MCP-servers die je niet gebruikt. Het model van een andere provider achter Claude Code gebruiken komt aan bod in [API-kosten van DeepSeek en Qwen](/nl/guides/deepseek-qwen-api-cost-local-gateway).

De broncode van de gateway, zijn Claude Code-gids en de tests die controleren dat hij je verzoeken ongewijzigd doorstuurt, staan op [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
