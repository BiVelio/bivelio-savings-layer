DeepSeek i Qwen són barats per token, i per això és fàcil deixar de vigilar la factura. Tots dos proveïdors desen els prompts a la memòria cau pel seu compte, i l'entrada que encerta a la memòria cau es factura molt per sota de la que falla. Així que el cost real del teu trànsit depèn d'una xifra que la majoria de taulers amaguen: quants tokens d'entrada encerten a la memòria cau a cada petició. Aquesta guia explica com facturen i com fan servir la memòria cau tots dos proveïdors, com calcular el preu d'una petició a partir dels seus camps d'ús i com veure-ho petició a petició amb un gateway local gratuït.

## Com factura DeepSeek una petició

DeepSeek divideix l'entrada de cada petició en dues parts: els tokens que encerten a la seva memòria cau de context i els que hi fallen, cadascun amb el seu preu, més els tokens de sortida. La seva [memòria cau de context](https://api-docs.deepseek.com/guides/kv_cache) està activada per defecte a tots els comptes. Per encertar, el principi de la petició ha de coincidir exactament amb el d'una d'anterior; la memòria cau funciona sense garanties, i les entrades que no es fan servir s'esborren al cap d'unes hores o dies. La resposta et diu què ha passat:

- `usage.prompt_cache_hit_tokens`: tokens d'entrada servits des de la memòria cau.
- `usage.prompt_cache_miss_tokens`: tokens d'entrada processats sencers.
- `usage.prompt_tokens_details.cached_tokens`: el mateix recompte d'encerts, al camp que llegeixen les eines compatibles amb OpenAI.

La [pàgina de preus](https://api-docs.deepseek.com/quick_start/pricing) de DeepSeek dona els preus d'encert, de fallada i de sortida de cada model, i una franja d'hores vall a un preu més baix. Els preus canvien; copia'ls amb la data en què els vas consultar.

## Com factura Qwen una petició

Els models Qwen d'Alibaba Cloud Model Studio tenen dos tipus de [memòria cau de context](https://www.alibabacloud.com/help/en/model-studio/context-cache). La memòria cau implícita és automàtica per als prompts que superen una longitud mínima, i els seus encerts es facturen amb descompte. L'explícita funciona com la d'Anthropic: marques un bloc amb `cache_control`, l'entrada dura uns minuts, i escriure-la costa una mica més que l'entrada normal, mentre que llegir-la costa molt menys. A l'API compatible amb OpenAI, el recompte d'encerts arriba a `usage.prompt_tokens_details.cached_tokens`. Model Studio té endpoints regionals, així que comprova a quin pertany la teva clau.

## Fes que la memòria cau encerti, amb qualsevol dels dos

Les regles són les mateixes que en qualsevol memòria cau de prefix:

1. Posa primer el que no canvia mai: el prompt de sistema, les definicions d'eines, el text de referència llarg, els exemples few-shot.
2. Mantén-ho idèntic byte a byte entre peticions: res de timestamps, ids de petició ni noms d'usuari a dins, i les definicions d'eines en un ordre fix.
3. Posa al final el que canvia: la pregunta de l'usuari, l'últim resultat d'una eina.
4. En els agents, afegeix a l'historial en lloc de reescriure'l. Editar un missatge antic del mig invalida tot el que hi ha darrere.

## Calcula el cost d'una petició

No necessites cap eina per calcular el preu d'una petició. Llegeix el bloc d'ús i multiplica cada partida pel seu preu:

```python
def request_cost(usage: dict, price_miss: float, price_hit: float, price_out: float) -> float:
    """USD cost of one chat completion. Prices are per million tokens, from the provider's pricing page."""
    details = usage.get("prompt_tokens_details") or {}
    hit = usage.get("prompt_cache_hit_tokens", details.get("cached_tokens", 0)) or 0
    miss = usage["prompt_tokens"] - hit
    return (miss * price_miss + hit * price_hit + usage["completion_tokens"] * price_out) / 1_000_000
```

Registra aquesta xifra amb el model, la proporció d'encerts (`hit / prompt_tokens`) i un timestamp a cada petició, i podràs respondre les preguntes que importen: quina funcionalitat costa més, si la taxa d'encerts de la memòria cau va baixar després d'un desplegament i quina part del teu trànsit cau a la franja d'hores vall.

## Mira cada petició amb un gateway local

Per no haver de tocar cada punt del codi que crida l'API, posa un gateway davant del proveïdor. [BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) n'inclou un al seu paquet d'npm: Apache-2.0, local, **sense clau i sense registre**, i no s'envia res a BiVelio. Engega un gateway per proveïdor, cadascun al seu port:

```bash
# DeepSeek
npx @bivelio/savings-layer gateway --upstream deepseek --port 8403

# Qwen on Model Studio's international endpoint (`--upstream qwen` is the Beijing one)
npx @bivelio/savings-layer gateway --upstream https://dashscope-intl.aliyuncs.com --port 8404
```

El gateway reenvia al proveïdor el camí que envia el teu client, així que la teva base URL és la del mateix proveïdor amb el gateway com a host:

| Proveïdor | `--upstream` | Base URL per al teu client d'OpenAI |
| --- | --- | --- |
| DeepSeek | `deepseek` | `http://127.0.0.1:8403` |
| Qwen (Pequín) | `qwen` | `http://127.0.0.1:<port>/compatible-mode/v1` |
| Qwen (internacional) | `https://dashscope-intl.aliyuncs.com` | `http://127.0.0.1:8404/compatible-mode/v1` |
| GLM | `glm` | `http://127.0.0.1:<port>/api/paas/v4` |

`npx @bivelio/savings-layer --help` llista els altres upstreams (Moonshot, MiniMax, OpenRouter, Gemini, Ollama, vLLM, LM Studio).

A Python, el petit client del paquet et resol la base URL: crea el teu client d'OpenAI de sempre per al proveïdor, i `wrap()` en retorna una còpia que passa pel gateway, conservant el camí del proveïdor.

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

El mateix serveix per a Qwen amb l'altre gateway i `OpenAI(base_url="https://dashscope-intl.aliyuncs.com/compatible-mode/v1", ...)`. Si hi ha definida una variable de proxy HTTP, afegeix `NO_PROXY=127.0.0.1,localhost` abans de crear el client, o les peticions al gateway local, amb la clau del proveïdor inclosa, passaran pel proxy; la versió 1.2.5 avisa quan això passarà. Si no hi ha cap gateway en marxa, `wrap()` llança `GatewayUnavailable` en lloc de cridar directament el proveïdor, i diu com engegar-ne un, sense clau.

Qualsevol altre llenguatge o eina també serveix: apunta la seva base URL d'OpenAI al gateway, i cada petició es converteix en una línia del log del gateway, amb el model, el cost a preu de llista i l'entrada separada en tokens a preu complet i lectures de memòria cau (`cache↓`).

Hi ha una excepció que importa en les eines de xat i els agents: una petició en **streaming** que no demana l'ús (`stream_options: {"include_usage": true}`) no en rep cap del proveïdor, així que la versió 1.2.5 la registra com a `not metered: the request did not ask for usage`. Demana l'ús al teu client, o engega el gateway amb `BVSALA_GATEWAY_USAGE_INJECT=1`, que afegeix aquesta opció als streams que no la porten. L'últim chunk d'aquests streams porta llavors una llista `choices` buida, cosa que no espera el codi que llegeix `choices[0]` sense comprovar-ho.

## Agents de programació amb DeepSeek o Qwen

DeepSeek també publica un endpoint amb format d'Anthropic i documenta com fer-lo servir amb Claude Code. Amb `--upstream deepseek`, el gateway envia tot sol a aquest endpoint les peticions amb format d'Anthropic:

```bash
npx @bivelio/savings-layer gateway --upstream deepseek --port 8402
ANTHROPIC_BASE_URL=http://127.0.0.1:8402 ANTHROPIC_AUTH_TOKEN="$DEEPSEEK_API_KEY" ANTHROPIC_MODEL=deepseek-flash claude
```

En aquest camí el gateway mesura però no estalvia res: l'endpoint amb format d'Anthropic de DeepSeek ignora `cache_control` i no informa de cap escriptura a la memòria cau ([la seva guia](https://api-docs.deepseek.com/guides/anthropic_api)), així que la palanca per defecte no té res a rebaixar. Fer servir un model que no és Claude darrere de Claude Code és una integració de DeepSeek, no una configuració que Anthropic admeti, i et toca a tu jutjar la qualitat del model per a la teva feina.

**Qwen Code amb models Qwen** necessita un altre camí: a la versió 1.2.5, `npx @bivelio/savings-layer qwen` executa Qwen Code amb el seu tipus d'autenticació d'Anthropic i reenvia a l'API d'Anthropic, de manera que només mesura models Claude usats amb una clau d'Anthropic, i rebutja una base URL de DashScope amb format d'Anthropic. Per a models Qwen, fes servir el mode compatible amb OpenAI de Qwen Code, que [la seva documentació](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/) configura amb `OPENAI_API_KEY`, `OPENAI_BASE_URL` i `OPENAI_MODEL`, i apunta aquesta base URL a un gateway. Posa a `DASHSCOPE_PROXY_BASE_URL` exactament la mateixa URL:

```bash
npx @bivelio/savings-layer gateway --upstream https://dashscope-intl.aliyuncs.com --port 8404

GW=http://127.0.0.1:8404/compatible-mode/v1
OPENAI_BASE_URL="$GW" DASHSCOPE_PROXY_BASE_URL="$GW" OPENAI_API_KEY="$DASHSCOPE_API_KEY" OPENAI_MODEL=qwen-plus qwen
```

La segona variable importa per a la factura. Qwen Code decideix pel host de la base URL si parla amb DashScope, i `127.0.0.1` no és un host de DashScope. Sense la variable, recorre al seu proveïdor OpenAI genèric, que no envia marques de memòria cau explícita (`cache_control` i la capçalera `X-DashScope-CacheControl`). Les teves peticions van a parar llavors a la memòria cau implícita de Model Studio, on els encerts solen costar el 20 % del preu d'entrada i funcionen sense garanties, en lloc del 10 % de la memòria cau explícita ([memòria cau de context](https://www.alibabacloud.com/help/en/model-studio/context-cache)). Qwen Code tracta com a DashScope una base URL que coincideix exactament amb `DASHSCOPE_PROXY_BASE_URL`, i manté les marques ([el seu proveïdor de DashScope](https://github.com/QwenLM/qwen-code/blob/8fab857da5/packages/core/src/core/openaiContentGenerator/provider/dashscope.ts), consultat el 23 de novembre de 2026).

Vam comprovar la part del gateway d'aquest camí amb la versió 1.2.5 (totes dues marques passen sense canvis), no el mateix Qwen Code, així que llegeix el log del gateway: una línia amb un cost per petició. Una línia `not metered` diu per què: normalment, un stream que no demana l'ús (reinicia el gateway amb `BVSALA_GATEWAY_USAGE_INJECT=1`) o un model sense fila al catàleg de la 1.2.5, que té `qwen-plus`, `qwen-flash`, `qwen3.7-flash`, `qwen3.8-flash` i `qwen3.8-max`, però no, per exemple, `qwen3-coder-plus`.

Hi ha dos desajustos de preu a la 1.2.5 que depenen de la segona variable. **Amb `DASHSCOPE_PROXY_BASE_URL` definida**, com més amunt, Model Studio factura cada escriptura a la memòria cau explícita al 125 % del preu d'entrada i la indica a `usage.prompt_tokens_details.cache_creation_input_tokens`. El gateway 1.2.5 no llegeix aquest camp: registra aquests tokens com a entrada normal, amb `cache↑0`, al 80 % del que costen. El seu preu d'encert per a `qwen-plus` és el 10 % de la memòria cau explícita, que coincideix. **Sense la variable** no hi ha escriptures explícites, però els encerts són implícits, facturats a prop del 20 %, i el gateway els registra al mateix 10 %, més o menys la meitat del que costen.

## El que mesura el gateway, i el que no

- **La xifra en dòlars surt d'un catàleg, no dels preus per franja horària de DeepSeek.** La versió 1.2.5 té files per a `deepseek-flash` i `deepseek-v4-pro`. Per a les fallades de memòria cau i la sortida fan servir el preu d'hora punta de DeepSeek, així que en hores vall aquestes partides mostren el doble del que factura DeepSeek. Per als encerts de memòria cau, totes dues files fan servir 0,003 USD per milió de tokens, que és el preu d'encert en hores vall de DeepSeek per a `deepseek-flash` (el seu preu d'encert en hora punta és el doble) i queda per sota dels dos preus d'encert que DeepSeek publica per a `deepseek-v4-pro` ([pàgina de preus](https://api-docs.deepseek.com/quick_start/pricing), consultada el 23 de novembre de 2026). Segons l'hora i quina part de la teva entrada encerti a la memòria cau, el total del gateway pot sortir per sobre o per sota de la factura. Els recomptes de tokens són exactes; compara'ls primer. El clàssic àlies `deepseek-chat` no té fila: es reenvia, i el log diu que no s'ha mesurat.
- **No canvia aquestes peticions.** Amb trànsit compatible amb OpenAI, el gateway mesura i reenvia (l'única excepció és la injecció opcional de l'ús que s'explica més amunt); les seves palanques d'estalvi són per al trànsit amb format d'Anthropic. L'estalvi a DeepSeek i Qwen surt de les seves pròpies memòries cau, i per això el recompte d'encerts és la xifra que cal vigilar.

## Si crides DeepSeek o Qwen des de TypeScript

L'SDK de BV-SALA parla amb qualsevol endpoint compatible amb OpenAI i se salta les repeticions exactes i les peticions idèntiques en curs, gratis i sense clau ([com funciona](/ca/guides/deduplicate-llm-requests)). A DeepSeek, aquestes crides evitades es donen com a `estimated`, no com a `reference`: la versió 1.2.5 només valora una repetició per referència quan la crida que es va executar va anar a l'API pròpia d'OpenAI, d'Anthropic o de Google. Una advertència per als bucles d'agent: la seva retallada per defecte dels resultats d'eines substituïts reescriu el mig de l'historial, i amb un proveïdor que desa a la memòria cau tot el prompt pel seu compte això pot costar més del que estalvia. El changelog del projecte registra un +166 % en un bucle d'agent de 60 passos amb DeepSeek, mesurat contra un proveïdor fals amb les versions 1.2.3 i 1.2.4 i sense clau; la 1.2.5 retalla igual. En bucles d'agent, desactiva-la per petició:

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

## Contrasta les xifres amb el teu proveïdor

Un cop al dia, compara els totals per model del gateway (entrada, encerts de memòria cau, sortida) amb la pàgina d'ús de la plataforma de DeepSeek o de Model Studio per a la mateixa clau. Els recomptes totals de tokens haurien de coincidir, amb una excepció en com es reparteixen: a Qwen, la versió 1.2.5 compta les escriptures a la memòria cau explícita com a entrada normal, no com a escriptures a la memòria cau. Els imports en dòlars poden diferir, en qualsevol sentit: el catàleg no té en compte els preus per franja horària de DeepSeek, a Qwen valora les escriptures a la memòria cau explícita com a entrada normal i els encerts implícits a la tarifa explícita, i els preus regionals i els descomptes també canvien els diners. Per a un mètode pas a pas, consulta [com verificar l'estalvi en LLM amb la factura del teu proveïdor](/ca/guides/verify-llm-savings-against-provider-bill). El codi del gateway i les seves guies per terminal són a [GitHub](https://github.com/BiVelio/bivelio-savings-layer), i el que el projecte ha mesurat, i el que no, és a la [pàgina del banc públic](/ca/benchmarks).
