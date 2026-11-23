Totes les API de LLM cobren per crida. Si la teva aplicació envia dues vegades la mateixa petició, pagues dues vegades, encara que la segona resposta no hi aporti res. Aquesta guia mostra dues tècniques que ho eviten: una **memòria cau de respostes per coincidència exacta** per a les repeticions que arriben més tard, i la **fusió de peticions en curs** per a les peticions idèntiques que arriben en el mateix moment. Totes dues funcionen en qualsevol llenguatge i amb qualsevol proveïdor. Al final veuràs com l'SDK open source BV-SALA fa totes dues coses per defecte, i com contrastar l'estalvi amb les xifres d'ús del teu proveïdor.

## D'on surten les peticions duplicades

Els duplicats són més habituals del que sembla, perquè rarament surten d'un únic lloc evident:

- **Reintents i dobles clics.** Un usuari prem «Genera» dues vegades, o una biblioteca client reintenta després d'un timeout que el proveïdor, de fet, sí que havia respost.
- **Processos batch i crons.** Un procés nocturn classifica les mateixes descripcions de producte, entrades de FAQ o macros de suport que ja va classificar ahir.
- **Fan-out.** Dos workers, dues pestanyes del navegador o un efecte de React que s'executa dues vegades en desenvolupament envien el mateix prompt amb mil·lisegons de diferència.
- **Agents i pipelines.** Un pipeline de diversos passos fa la mateixa subpregunta en diverses branques.
- **Tests i evals.** La CI executa els mateixos fixtures contra l'API real a cada push.

El primer grup i l'últim són repeticions al llarg del temps; el fan-out és concurrència. Necessiten solucions diferents, i per això aquesta guia cobreix tots dos casos.

## Mesura primer la teva taxa de duplicats

Abans de construir res, esbrina quina part del teu trànsit es repeteix. Calcula el hash de cada cos de petició durant un dia i compta. La clau ha de ser **canònica**: la mateixa petició ha de donar els mateixos bytes sigui quin sigui l'ordre de les claus del JSON.

```ts
import { createHash } from "node:crypto";

// Canonical JSON: the same object gives the same text, whatever the key order.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function requestKey(body: object, scope = "global"): string {
  return createHash("sha256").update(`${scope}\n${canonical(body)}`).digest("hex");
}

// Feed it one day of request bodies, then read the share that repeated.
const seen = new Map<string, number>();
export function record(body: object): void {
  const key = requestKey(body);
  seen.set(key, (seen.get(key) ?? 0) + 1);
}
export function duplicateRate(): number {
  let total = 0;
  for (const n of seen.values()) total += n;
  return total === 0 ? 0 : (total - seen.size) / total;
}
```

Si la taxa s'acosta a zero, una memòria cau de respostes no t'estalviarà gaire, i et convé mirar més aviat la [memòria cau de prompts](/ca/guides/claude-prompt-caching-not-working) o l'[elecció de model](/ca/guides/reduce-openai-api-costs). Si una part apreciable de les teves peticions es repeteix, continua llegint.

## Construeix una clau de memòria cau que sigui segura de debò

Una memòria cau exacta és tan bona com la seva clau. La regla és senzilla: **tot el que pot canviar la resposta entra a la clau, i res no es perd en normalitzar.**

- L'id del model, la llista completa de missatges, el prompt de sistema, les definicions d'eines, el format de resposta o el JSON schema, i tots els paràmetres de mostreig (`temperature`, `top_p`, `max_tokens`, `seed`, esforç de raonament).
- Un **àmbit** (scope) quan el prompt porta dades de l'usuari. Dos usuaris que pregunten «quin és el meu saldo?» envien el mateix text i necessiten respostes diferents. Posa l'id de l'usuari o del tenant a la clau, o no desis aquestes peticions a la memòria cau.
- Res de normalitzacions «enginyoses». Passar a minúscules, retallar espais o treure la puntuació per aconseguir més encerts converteix una memòria cau exacta en una de difusa, i una memòria cau difusa pot retornar la resposta a una altra pregunta.

## El que no s'ha de servir mai des d'una memòria cau

Algunes peticions es repeteixen, però tot i així han d'arribar al model cada vegada:

- **Respostes que han de canviar**: «tria un nom a l'atzar», «genera una contrasenya», «quina hora és», «el preu d'avui». Aquí una resposta en memòria cau és un bug, no un estalvi.
- **Eines amb efectes secundaris.** Si la resposta demana cridar `send_email` o `create_order`, tornar-la a servir des de la memòria cau se salta l'acció. Desa a la memòria cau només les peticions amb eines de només lectura, o sense cap eina.
- **Sortides mostrejades que els usuaris esperen que variïn.** Amb una `temperature` alta, una resposta en memòria cau és només una mostra, servida per sempre.
- **Errors, respostes buides, negatives i respostes truncades.** No les escriguis mai a la memòria cau; deixa que la petició següent ho torni a provar.
- **Temes sensibles.** Un bot de suport que desa a la memòria cau respostes sobre autolesions o una urgència mèdica no ho hauria de fer; envia aquestes peticions al model cada vegada.

## Fusiona les peticions idèntiques en curs

Una memòria cau només ajuda quan ja ha arribat la primera resposta. Si deu peticions idèntiques comencen dins dels mateixos 300 ms, totes deu fallen. La solució és un patró minúscul que sovint s'anomena *singleflight*: el primer que crida fa la crida i els altres esperen la mateixa promesa.

```ts
const inFlight = new Map<string, Promise<unknown>>();

export function singleflight<T>(key: string, call: () => Promise<T>): Promise<T> {
  const running = inFlight.get(key) as Promise<T> | undefined;
  if (running) return running; // join the call that is already on its way
  const p = call().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p; // an error reaches every caller that joined, so nobody waits forever
}
```

En producció importen tres detalls. Els errors han d'arribar a tots els que esperen (el patró de dalt ho fa). Que un cancel·li no ha de cancel·lar la crida compartida per als altres. I l'streaming és més difícil: un stream que ja ha començat no es pot passar tal qual a un segon client, així que la majoria d'implementacions deixen que una petició normal s'afegeixi a una crida en curs, però no deixen que res s'afegeixi a un stream.

## Com ho fa BV-SALA

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) és una capa d'estalvi Apache-2.0 per a TypeScript. El seu SDK embolcalla el teu proveïdor i, **sense clau i sense registre**, activa per defecte totes dues tècniques: una memòria cau exacta i la deduplicació de peticions en curs. També aplica les regles de «mai a la memòria cau» de més amunt: les peticions que demanen alguna cosa actual o aleatòria, les formulades en termes personals sense una sessió, els temes sensibles, les negatives i els errors es queden fora de la memòria cau.

```ts
// npm i @bivelio/savings-layer   (ESM: a "type": "module" project or a .mts file)
import { createSavingsLayer, OpenAICompatibleProvider } from "@bivelio/savings-layer";

const layer = createSavingsLayer({
  provider: new OpenAICompatibleProvider({
    baseUrl: "https://api.openai.com/v1",
    apiKey: process.env.OPENAI_API_KEY,
  }),
  // Nothing else is required: the exact cache and deduplication are on by default.
});

const request = {
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user" as const, content: "Classify the sentiment as positive or negative: The battery lasts two days." }],
  temperature: 0,
};

const first = await layer.generate(request);
const again = await layer.generate(request);
console.log(first.report.cache.result, again.report.cache.result); // "miss" "exact"
console.log(again.report.calls.avoidedLlm); // 1: the repeat never reached the provider

// Two identical requests at the same moment: one call, shared by both.
const other = { ...request, messages: [{ role: "user" as const, content: "Classify the sentiment as positive or negative: Shipping took a month." }] };
const [a, b] = await Promise.all([layer.generate(other), layer.generate(other)]);
console.log(a.report.cache.result, b.report.cache.result); // "miss" "singleflight"
```

Una petició que sembla personal («la meva comanda», «la nostra factura») no es desa a la memòria cau tret que diguis de qui és. Passa-hi un àmbit i la memòria cau torna a funcionar, per separat per a cada sessió:

```ts
import { createSavingsLayer, OpenAICompatibleProvider } from "@bivelio/savings-layer";

const layer = createSavingsLayer({
  provider: new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY }),
});

const answer = await layer.generate({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "Translate to French: the invoice for my order is attached." }],
  context: { sessionId: "user-42" }, // cached for this session only
});
console.log(answer.report.cache.result);
```

La memòria cau per defecte viu a la memòria d'un sol procés. Per compartir-la entre diversos servidors o instàncies serverless, passa mitjançant l'opció `exactCache` un magatzem que gestionis tu. Necessita tres mètodes, així que serveix qualsevol magatzem clau-valor:

```ts
import { createSavingsLayer, OpenAICompatibleProvider, type ExactCache } from "@bivelio/savings-layer";

// The three calls a Redis client offers; adapt the names to yours.
interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "PX", ttlMs: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export function sharedLayer(redis: RedisLike) {
  const exactCache: ExactCache = {
    async get(key) {
      const raw = await redis.get(`bvsala:${key}`);
      return raw ? JSON.parse(raw) : null;
    },
    async set(key, value, ttlMs) {
      await redis.set(`bvsala:${key}`, JSON.stringify(value), "PX", ttlMs ?? 3_600_000);
    },
    async delete(key) {
      await redis.del(`bvsala:${key}`);
    },
  };
  return createSavingsLayer({
    provider: new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY }),
    exactCache,
  });
}
```

Les respostes en memòria cau es queden a la teva infraestructura. Si el fas servir sense clau, no s'envia res a BiVelio.

## Contrasta l'estalvi amb les xifres del teu proveïdor

L'estalvi d'una memòria cau és fàcil de comprovar, perquè és un recompte de crides que no es van fer.

1. **Compta les crides a tots dos costats.** Durant un dia, compta les crides a `generate()` que ha fet la teva aplicació i compara-les amb el nombre de peticions que mostra el teu proveïdor per a la mateixa clau d'API i el mateix model (la pàgina d'ús de la consola d'OpenAI o d'Anthropic, o les seves API d'ús). La diferència hauria de ser igual a la suma de `report.calls.avoidedLlm`.
2. **Mira com s'ha valorat cada repetició.** `report.cost.basis` diu d'on surt la xifra. Una repetició és `reference` quan la crida idèntica que sí que es va executar va anar directament a l'API d'OpenAI, d'Anthropic o de Gemini de Google (`api.openai.com`, `api.anthropic.com` o `generativelanguage.googleapis.com`): la seva línia base és el comptador d'ús d'aquella mateixa crida, valorat de manera conservadora a la tarifa d'entrada en memòria cau. Es queda en `estimated` quan la crida que es va executar va anar a qualsevol altre lloc, inclosa l'API pròpia d'un altre proveïdor com la de DeepSeek, un proxy, Azure o un gateway, perquè només en aquestes tres API se sap que els preus de llista de la capa coincideixen amb la factura. Els diners estimats sempre es donen a part.
3. **Compara la despesa, no només les crides.** Suma `report.cost.netSavingsUsd` per a cada base. No sumis mai imports mesurats amb estimats, i no facis mai la mitjana de `netSavingsRatio` entre peticions.

Si vols una prova més neta, executa la mateixa càrrega dues vegades, una amb les palanques desactivades en aquella execució (`savings: { exactCache: false, singleflight: false }` a cada petició) i una altra amb la configuració per defecte, i compara les dues factures.

## El que diuen les xifres públiques

El repositori publica les execucions del seu banc. En una càrrega pública construïda amb preguntes de GSM8K en què el 30 % de les peticions eren repeticions exactes, la reducció agregada mesurada va ser del **31.50 %** amb `gpt-4o-mini`, amb un interval del 95 % entre el 25.7 % i el 36.7 % (artefactes de l'SDK 0.4.31 de setembre de 2026; font: la [pàgina del banc públic](/ca/benchmarks#savings) i el README). Amb trànsit que mai no es repeteix, l'estalvi és d'un 0 % aproximadament, i la [pàgina del banc públic](/ca/benchmarks#no-savings) també mostra aquests resultats plans. A més, compta l'error que més importa en una memòria cau: **0 de 198** variants de preguntes van rebre la resposta d'una altra pregunta ([garanties](/ca/benchmarks#guarantees)).

El teu estalvi depèn de la teva taxa de duplicats, així que mesura-la primer amb el fragment del principi d'aquesta pàgina. El codi, el paper i els informes en brut són a [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
