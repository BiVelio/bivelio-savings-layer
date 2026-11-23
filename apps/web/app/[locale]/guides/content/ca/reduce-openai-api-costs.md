Una factura d'OpenAI és la suma d'unes quantes xifres per petició: tokens d'entrada sense memòria cau, tokens d'entrada en memòria cau, escriptures a la memòria cau (a GPT-5.6 i posteriors), tokens de sortida (raonament inclòs) i el preu del model. Qualsevol manera de reduir-la mou una d'aquestes xifres. Aquesta guia repassa les palanques en l'ordre en què solen sortir a compte, explica quan no hi surt cadascuna i mostra com demostrar cada estalvi amb les dades d'ús de la mateixa OpenAI, no amb una projecció. Gairebé tot es fa sense cap eina; allà on l'SDK open source BV-SALA automatitza una palanca, veuràs com.

## Comença per mesurar cada petició

Abans de canviar res, registra el bloc `usage` de cada resposta juntament amb la funcionalitat o la plantilla de prompt que l'ha generat: `prompt_tokens`, `prompt_tokens_details.cached_tokens`, `cache_write_tokens` si el model el retorna, `completion_tokens` i, en els models de raonament, `completion_tokens_details.reasoning_tokens`. Posa preu a cada partida amb les tarifes de la pàgina de preus d'OpenAI i apunta la data en què les vas copiar. A GPT-5.6 i posteriors, les escriptures a la memòria cau són una partida a part: OpenAI les factura a 1,25 vegades la tarifa d'entrada sense memòria cau amb la durada per defecte de 30 minuts, i a 2,5 vegades amb la de 12 hores ([guia de prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), consultada el 23 de novembre de 2026). Si les valores com a entrada normal, et quedes curt. Una setmana així respon l'única pregunta que importa al principi: **quines dues o tres funcionalitats s'emporten la major part de la factura.** Optimitza aquestes; oblida't de la resta.

## 1. No paguis dues vegades la mateixa petició

Els reintents, els dobles clics, els processos nocturns que tornen a classificar el que ja van classificar ahir i els workers en paral·lel que envien el mateix prompt costen, cadascun, una crida sencera. Una memòria cau de respostes per coincidència exacta i la deduplicació de peticions en curs els eliminen sense canviar ni una sola resposta. Quant estalvies depèn del tot de la freqüència amb què es repeteixen les teves peticions, així que mesura primer la teva taxa de duplicats. Guia completa: [deduplicar peticions idèntiques a un LLM](/ca/guides/deduplicate-llm-requests).

## 2. Deixa treballar la memòria cau de prompts d'OpenAI

Els prompts d'uns 1.024 tokens o més es desen a la memòria cau automàticament, i els tokens d'entrada en memòria cau es facturen amb descompte. A GPT-5.6 i posteriors, omplir la memòria cau no surt de franc: la part que s'hi escriu es factura per sobre de la tarifa sense memòria cau, com s'explica més amunt, de manera que un prompt que s'escriu i no es torna a llegir costa més que sense memòria cau, i un que es torna a llegir aviat costa molt menys. Els models anteriors no cobren res de més per les escriptures. La memòria cau només coincideix des del primer token, així que només funciona quan el principi del teu prompt és idèntic entre peticions. Posa primer les instruccions, les definicions d'eines i els exemples, i al final les dates, els noms d'usuari i la pregunta. Si `cached_tokens` es queda encallat a 0, consulta [per què cached_tokens és 0 a OpenAI](/ca/guides/openai-prompt-caching-cached-tokens).

## 3. Envia a la Batch API la feina que pot esperar

Les avaluacions, els backfills, els embeddings d'un conjunt de documents i la classificació nocturna no necessiten resposta en dos segons. La [Batch API](https://developers.openai.com/api/docs/guides/batch) d'OpenAI rep un fitxer de peticions, retorna els resultats en menys d'un dia i els factura a una tarifa més baixa que les mateixes peticions enviades una a una (les condicions vigents són a la [guia d'optimització de costos](https://developers.openai.com/api/docs/guides/cost-optimization)). Per a la feina offline sol ser l'estalvi individual més gran, i no canvia res de les respostes.

## 4. Fes servir el model més petit que superi la teva avaluació

Les diferències de preu entre gammes de models són grans, i moltes tasques (classificació, extracció, reescriptures curtes, encaminament) no necessiten el model més gran. Munta un petit conjunt d'avaluació amb peticions reals, passa'l per dos o tres models i queda't amb el més barat que el superi. Torna'l a passar quan surti un model nou. Sense l'avaluació, baixar de model és una aposta, i el cost de les respostes errònies no apareix a la factura de l'API.

## 5. Controla la sortida

Els tokens de sortida solen costar diverses vegades més que els d'entrada, i els tokens de raonament es facturen com a sortida.

- Ajusta `max_completion_tokens` al que la funcionalitat necessita de debò.
- En els models de raonament, abaixa l'esforç de raonament en les tasques que no necessiten raonar a fons, i mesura `reasoning_tokens` abans i després.
- Demana sortida estructurada amb un JSON schema quan el teu codi analitza la resposta. Un error d'anàlisi seguit d'un reintent paga la petició sencera dues vegades.

## 6. Envia menys entrada

- No tornis a enviar tota la conversa quan la tasca només necessita els darrers torns.
- Treu dels torns següents les sortides grans d'eines (logs, contingut de fitxers, resultats de cerca) un cop utilitzades.
- Envia les dades estructurades en format compacte: el JSON formatat gasta tokens en espais en blanc.
- Recupera els tres paràgrafs rellevants en lloc d'enganxar el document sencer.

Compte amb les dues últimes en bucles d'agent llargs: editar el mig d'un historial que OpenAI ja té a la memòria cau fa que tot el que ve després de l'edició es torni a facturar, a la tarifa sense memòria cau o, a GPT-5.6 i posteriors, a la tarifa més alta d'escriptura a la memòria cau quan s'hi torna a desar. Escurça el que és nou, no el que ja és a la memòria cau.

## Com automatitza BV-SALA algunes d'aquestes palanques

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) és una capa d'estalvi Apache-2.0 que embolcalla qualsevol endpoint compatible amb OpenAI en TypeScript. Estalvia amb totes les palanques **gratis, sense clau i sense registre**, i no envia res a BiVelio tret que hi afegeixis una clau per al tauler opcional al núvol. Activades per defecte: la memòria cau exacta, la deduplicació de peticions idèntiques en curs, la resolució en local d'operacions aritmètiques senzilles i la serialització compacta de les dades estructurades que li passes. S'activen amb una opció cadascuna: la cascada de models, la compactació de les sortides d'eines i la reordenació per a un prefix apte per a la memòria cau. Cada petició retorna un informe que diu què s'ha estalviat i d'on surt la xifra.

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

Dos límits, dits amb franquesa. Primer, el trànsit que mai no es repeteix estalvia prop d'un 0 % amb la memòria cau i la deduplicació, per disseny. Segon, la retallada que la capa fa per defecte dels resultats d'eines substituïts pot costar més del que estalvia en bucles d'agent llargs amb un proveïdor que desa a la memòria cau tot el prompt: el changelog del projecte registra un +12,2 % en un bucle de 60 passos amb `gpt-5`, mesurat contra un proveïdor fals amb les versions 1.2.3 i 1.2.4 i sense clau. En bucles d'agent llargs, passa `savings: { elision: false }` a la petició i compara.

## Demostra cada estalvi amb les xifres d'OpenAI

Un estalvi que no pots comprovar és una projecció. Per a cada palanca:

1. **Tria el comptador que s'hauria de moure.** La memòria cau i la deduplicació mouen el nombre de peticions. La memòria cau de prompts mou `cached_tokens` i, a GPT-5.6 i posteriors, també `cache_write_tokens`. Batch mou el preu. L'elecció de model mou el preu per token. El control de la sortida mou `completion_tokens`.
2. **Llegeix aquest comptador a OpenAI.** La [Usage API](https://developers.openai.com/api/reference/resources/organization/subresources/usage) retorna peticions i tokens d'entrada, d'entrada en memòria cau i de sortida per dia, model, projecte i clau. L'endpoint de Costs i el tauler d'ús donen els diners.
3. **Compara coses comparables.** La mateixa funcionalitat, els mateixos dies de la setmana, abans i després o, encara millor, dos braços del mateix trànsit alhora. Mira primer els tokens i després els dòlars: els dòlars també es mouen amb els preus.

Amb la capa, cada informe porta `cost.basis`: els imports `measured` i `reference` surten del comptador de la mateixa OpenAI, i els `estimated` es donen a part i mai no s'hi barregen. El mètode complet: [verificar l'estalvi en LLM amb la factura del teu proveïdor](/ca/guides/verify-llm-savings-against-provider-bill).

## El que diuen les xifres publicades

La [pàgina del banc públic](/ca/benchmarks) del projecte mesura els dos braços de cada prova amb el comptador d'ús del mateix proveïdor. En una càrrega pública construïda amb preguntes de GSM8K en què el 30 % de les peticions eren repeticions exactes, la reducció agregada amb `gpt-4o-mini` va ser del **31,50 %**, amb un interval del 95 % entre el 25,7 % i el 36,7 % (artefactes de l'SDK 0.4.31, setembre de 2026; també al README). En xat de dos torns sense repeticions (MT-Bench), les diferències van ser indistingibles de zero o no atribuïbles a la capa, i la pàgina ho diu. El mètode, els intervals i totes les limitacions són al [paper](/ca/paper). El codi és a [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
