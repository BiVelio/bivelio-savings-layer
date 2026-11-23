«Quant costa Claude Code?» té dues respostes honestes. Amb una subscripció de Claude, el preu és el del pla, i el cost per token només importa quan en superes els límits. Amb una clau d'API o un proveïdor cloud, pagues per token, i el cost d'una sessió depèn de quantes peticions envia Claude Code, de com és de gran cadascuna i de quina part es llegeix de la memòria cau de prompts. Aquesta guia mostra el que publica Anthropic, quines eines integrades et donen totals i com veure el cost de cada petició a la teva pròpia màquina, gratis, per trobar els torns que encareixen una sessió.

## El que diu Anthropic que costa

La [pàgina de costos de Claude Code](https://code.claude.com/docs/en/costs) de la mateixa Anthropic dona mitjanes de desplegaments empresarials: uns $13 per desenvolupador i dia actiu i de $150 a $250 per desenvolupador al mes, amb el 90 % dels usuaris per sota de $30 per dia actiu. Són mitjanes de molts equips. La teva xifra depèn del model que triïs, de la mida del teu repositori i de com treballis, i per això la resta d'aquesta guia tracta de com mesurar-la.

## Les eines integrades, i el que no mostren

- **`/usage` a Claude Code.** El bloc Session mostra un cost *estimat* a preu de llista, amb els tokens per model desglossats en entrada, sortida, lectures de memòria cau i escriptures a la memòria cau. Les versions recents hi afegeixen una línia de memòria cau de prompts amb la taxa d'encerts i el nombre de fallades. És un total de la sessió, calculat en local.
- **La Claude Console.** Per a claus d'API, les pàgines Cost i Usage mostren el que s'ha facturat per dia, workspace i model. Aquesta és la xifra amb què cal conciliar.
- **Exportació a OpenTelemetry.** Claude Code pot enviar mètriques de tokens i de cost al teu propi stack d'observabilitat, per usuari i sessió ([documentació de monitoratge](https://code.claude.com/docs/en/monitoring-usage)).

El que cap d'aquestes eines no posa fàcil és la **vista per petició**: quin torn va ser el car, i per què. Una sessió són desenes o centenars de crides a l'API, i les cares tenen causes recognoscibles:

- **Una memòria cau freda.** El primer torn després d'una pausa més llarga que la durada de la memòria cau torna a llegir tota la conversa a preu complet, i la torna a escriure.
- **Un canvi de model.** Cada model té la seva pròpia memòria cau, així que canviar de model a mitja sessió ho torna a processar tot.
- **Resultats d'eines enormes.** Un log de tests o un fitxer gran llegit una sola vegada es queda en el context de tots els torns següents.
- **Massa definicions d'eines.** Els servidors MCP poden afegir molts kilobytes de definicions a cada petició.
- **La compactació.** Resumir una conversa llarga ja és, en si mateix, una petició grossa.

## Mesura cada petició amb un gateway local

Un gateway és un petit proxy entre Claude Code i l'API que llegeix els comptadors d'ús de cada resposta. Claude Code ho admet oficialment mitjançant `ANTHROPIC_BASE_URL`. [BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) n'inclou un al seu paquet d'npm: Apache-2.0, **sense clau, sense registre**, i no s'envia res a BiVelio. Necessita Node.js 20 o posterior.

Amb una sola ordre:

```bash
# Starts a local gateway on a free port, runs Claude Code through it, and stops it on exit.
npx @bivelio/savings-layer claude
```

L'embolcall silencia el log per petició perquè no pinti per sobre de la interfície de Claude Code. En sortir, mostra quantes peticions ha mesurat, quines ha reenviat sense mesurar i per què. Per veure cada petició en el moment, o bé demanes el log per stderr:

```bash
BVSALA_GATEWAY_LOG=1 npx @bivelio/savings-layer claude
```

o bé engegues el gateway al seu propi terminal, en un port fix:

```bash
# Terminal 1: the gateway (Anthropic is the default upstream, port 8402)
npx @bivelio/savings-layer gateway

# Terminal 2: Claude Code, pointed at it (no /v1 at the end).
# ENABLE_TOOL_SEARCH=true only matters before Claude Code v2.1.304 (see below).
ENABLE_TOOL_SEARCH=true ANTHROPIC_BASE_URL=http://127.0.0.1:8402 claude
```

Cada petició es converteix en una línia. Aquestes dues surten d'una prova local contra un servidor de prova, amb trànsit inventat: el format és real i les xifres no són les teves:

```text
[gateway] POST /v1/messages  · claude-sonnet-5 · $0.007700 (in 40, cache↑3000 cache↓0, out 12)
[gateway] POST /v1/messages  · claude-sonnet-5 · $0.000800 (in 40, cache↑0 cache↓3000, out 12)
```

Es llegeix d'esquerra a dreta: el model, el cost al preu de llista estàndard del model (els torns en mode ràpid en són l'excepció, més avall), i després els tokens d'entrada facturats sencers, els tokens escrits a la memòria cau (`cache↑`), els que s'hi han llegit (`cache↓`) i els tokens de sortida. La primera línia és un torn en fred que escriu el prefix; la segona el torna a llegir per una fracció del preu. Una sessió en què `cache↑` es manté alt torn rere torn té un problema de memòria cau: consulta [per què deixa de funcionar el prompt caching de Claude](/ca/guides/claude-prompt-caching-not-working).

`ENABLE_TOOL_SEARCH=true` depèn de la teva versió de Claude Code. Des de la v2.1.304, la cerca d'eines (tool search) continua activa darrere d'un gateway ([documentació de MCP de Claude Code](https://code.claude.com/docs/en/mcp)), i la variable no canvia res. Abans de la v2.1.304, Claude Code desactivava tool search darrere de qualsevol base URL que no fos la d'Anthropic i ficava totes les definicions d'eines a cada petició. En aquelles versions antigues sortia car: la guia de Claude Code del gateway, inclosa al paquet d'npm, recull una configuració amb 226 eines MCP, mesurada el 9 de setembre de 2026, en què això suposava 450 KB per petició i una quarta part de la factura d'aquell dia. L'embolcall `claude` defineix la variable per tu, tret que ja l'hagis definida tu.

## El que veu el gateway, i el que no

- **Reenvia el que envia Claude Code.** Si cap palanca no actua sobre una petició, el cos arriba a Anthropic byte a byte, amb les marques `cache_control` i la capçalera `anthropic-beta`, de manera que la memòria cau funciona exactament igual que sense el gateway. Un test del repositori ho comprova contra un upstream fals a cada canvi.
- **Dues crides petites se'l salten.** Segons la [guia de compatibilitat amb gateways](https://code.claude.com/docs/en/llm-gateway-protocol) de Claude Code, la comprovació de disponibilitat del mode ràpid i la comprovació de seguretat de dominis de WebFetch criden directament `api.anthropic.com` en lloc de seguir `ANTHROPIC_BASE_URL`. Cap de les dues no és una petició al model: la inferència en mode ràpid sí que segueix la base URL i passa pel gateway.
- **Els torns en mode ràpid es registren al preu estàndard.** Anthropic marca una petició en mode ràpid amb `speed: "fast"` i la factura amb un sobrecost: $8 d'entrada i $40 de sortida per milió de tokens a Claude Opus 5.5, el doble de la tarifa estàndard, amb els multiplicadors de memòria cau a sobre ([documentació del mode ràpid](https://platform.claude.com/docs/en/build-with-claude/fast-mode)). La versió 1.2.3 del gateway no llegeix `speed`, així que compta bé aquests tokens però els posa preu de torn estàndard: a Opus 5.5, la meitat del que factura Anthropic. Si fas servir `/fast`, el total del gateway per a aquests torns es queda curt.
- **El trànsit de subscripció es mesura, no es factura.** Si inicies la sessió amb Claude Pro o Max, no hi ha factura per token; el gateway valora aquest trànsit al seu equivalent en preu de llista perquè el vegis, i no li atribueix cap estalvi.

## El gateway també estalvia diners?

Tal com ve, amb Claude Code sobre una clau d'API, mesura i no estalvia res. No prenguis el missatge d'arrencada de la versió 1.2.3 com una promesa: diu que totes les palanques d'estalvi locals són actives, i el seu resum de sortida només compta les peticions que ha mesurat, així que cap dels dos no et diu que l'estalvi ha estat zero. La palanca per defecte del gateway rebaixa la durada de l'escriptura a la memòria cau d'una hora a cinc minuts en els torns en què bona part de la petició és nova, perquè una escriptura d'una hora costa el doble del preu d'entrada i una de cinc minuts 1.25 vegades. Claude Code amb clau d'API ja demana cinc minuts, tret que posis `promptCacheTtl` a `1h`, així que no hi ha res a rebaixar.

Quan entra en joc la memòria cau d'una hora, l'estalvi és petit i depèn del teu trànsit. La [pàgina del banc públic](/ca/benchmarks#gateway-ttl) publica una reproducció del propi trànsit de Claude Code d'una organització: un net de **+2.49 %** de la factura a preu de llista ($113.45 de $4,563.61), amb un interval del 95 % de +1.50 % a +3.57 % en remostrejar per sessió, i un sostre del 7.2 % per a qualsevol política d'aquest tipus. En un model el resultat va ser gairebé nul, i en un període va perdre diners. És una reproducció amb una línia base reconstruïda en part, no una factura, i la pàgina n'enumera tots els límits.

## Contrasta les xifres del gateway amb la teva factura

1. **Amb `/usage`.** Per a una sessió, suma els costos per petició del gateway i compara'ls amb el bloc Session de `/usage`. Tots dos valoren els mateixos comptadors a preu de llista, així que haurien de sortir semblants, excepte en els torns en mode ràpid, que `/usage` valora a la tarifa ràpida i el gateway 1.2.3 a l'estàndard.
2. **Amb la Console.** Fes servir una clau d'API o un workspace dedicats durant un dia i compara els totals per model del gateway amb la pàgina Usage de la Console per a aquella clau: entrada, sortida, escriptures i lectures de memòria cau, primer en tokens i després en dòlars.
3. **Explica qualsevol diferència.** El preu de llista no sempre és el teu preu: els descomptes contractats, la residència de dades o els nivells de prioritat canvien els diners, però no els recomptes de tokens. El mode ràpid també: amb `/fast` activat, el total del gateway queda per sota del de la Console, perquè la 1.2.3 valora els torns en mode ràpid a la tarifa estàndard. El trànsit que no ha passat per aquest gateway, com ara una altra màquina, un script o un job de CI que fa servir la mateixa clau, només apareix a la Console.

Si els tokens quadren i els dòlars no, la diferència és als preus, no a la mesura. Per al mètode complet, llegeix [com verificar l'estalvi en LLM amb la factura del teu proveïdor](/ca/guides/verify-llm-savings-against-provider-bill).

## Retallar la factura quan ja la veus

Amb les xifres per petició al davant, les solucions habituals són senzilles: buida el context entre tasques que no tenen relació en lloc d'arrossegar un context llarg, tria el model abans de la sessió i no el canviïs, compacta a les pauses naturals, deixa els logs grans fora del context i treu els servidors MCP que no fas servir. Com fer servir el model d'un altre proveïdor darrere de Claude Code s'explica a [costos de l'API de DeepSeek i Qwen](/ca/guides/deepseek-qwen-api-cost-local-gateway).

El codi font del gateway, la seva guia de Claude Code i els tests que comproven que reenvia les teves peticions sense canvis són a [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
