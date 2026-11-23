OpenAI desa a la memòria cau els prompts llargs de manera automàtica: quan el principi d'una petició coincideix amb una altra que ha processat fa poc, aquests tokens d'entrada es facturen amb descompte i la resposta comença abans. No has d'activar res. Per això mateix és fàcil no adonar-se'n quan deixa de funcionar. Si `cached_tokens` torna com a `0` a cada petició, aquesta guia repassa les causes en l'ordre en què convé revisar-les, mostra com seguir la taxa d'encerts per petició i com contrastar-la amb les dades d'ús de la mateixa OpenAI.

## On llegir-ho

Cada resposta et diu quants tokens d'entrada han sortit de la memòria cau:

- **Chat Completions:** `usage.prompt_tokens_details.cached_tokens`, sobre el total d'`usage.prompt_tokens`.
- **Responses API:** `usage.input_tokens_details.cached_tokens`, sobre el total d'`usage.input_tokens`.

Els tokens en memòria cau formen part del total d'entrada; no s'hi sumen. La [guia de prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) d'OpenAI és la referència de les regles vigents. Ara distingeix entre els models més nous, que a més informen de les escriptures a la memòria cau, les facturen i accepten opcions de memòria cau explícites, i els anteriors, en què escriure a la memòria cau és gratuït. Consulta-la per al model que facis servir.

## Per què cached_tokens és 0

1. **El prompt és massa curt.** La memòria cau comença a partir d'uns 1,024 tokens de prompt; el llindar exacte i com s'arrodoneix el recompte en memòria cau depenen del model. Un prompt de sistema de 600 tokens i una pregunta curta no encerten mai a la memòria cau, i res no te n'avisa.
2. **Canvia el principi del prompt.** La memòria cau coincideix des del mateix primer token. Un timestamp, un id de petició o el nom de l'usuari al primer missatge fan que cada petició sigui única des del primer token. Les eines, les imatges i els formats de resposta també formen part del prefix, així que unes eines llistades en un altre ordre, o un schema serialitzat d'una altra manera, trenquen la coincidència.
3. **L'entrada s'ha expulsat de la memòria cau.** Les entrades es conserven poc temps després de l'últim ús, normalment minuts quan hi ha poc trànsit. Les peticions separades per una hora rarament encerten.
4. **El trànsit es reparteix.** Les peticions s'encaminen segons un hash del principi del prompt. Un volum molt alt amb el mateix prefix es desborda cap a altres màquines que no tenen l'entrada. El paràmetre `prompt_cache_key` d'OpenAI agrupa les peticions que comparteixen prefix; fes servir una clau per plantilla de prompt, no per usuari, i mantén moderat el ritme de peticions de cada clau, com explica la guia.
5. **No estàs llegint el camp.** Una petició de Chat Completions en streaming no porta cap dada d'ús tret que la demanis amb `stream_options: { include_usage: true }`. Molts wrappers descarten `prompt_tokens_details`. Alguns proveïdors compatibles amb OpenAI i alguns desplegaments d'Azure informen de la memòria cau d'una altra manera o no n'informen gens.

## Prova-ho en dos minuts

Abans de depurar la teva aplicació, comprova primer de tot que la memòria cau funciona amb el teu compte i el teu model. Envia el mateix prompt llarg dues vegades, amb uns segons de diferència, i llegeix l'ús de cada resposta:

```bash
# A system prompt well above the threshold, sent twice. The second answer should report cached tokens.
BODY=$(python3 -c 'import json; print(json.dumps({"model": "gpt-4o-mini", "messages": [{"role": "system", "content": "You are a careful assistant for an invented shop. " * 200}, {"role": "user", "content": "Say OK."}]}))')
for i in 1 2; do
  curl -s https://api.openai.com/v1/chat/completions \
    -H "Authorization: Bearer $OPENAI_API_KEY" -H "Content-Type: application/json" \
    -d "$BODY" | python3 -c 'import json, sys; u = json.load(sys.stdin)["usage"]; print(u["prompt_tokens"], u.get("prompt_tokens_details"))'
done
```

Si la segona línia mostra tokens en memòria cau, la part del proveïdor funciona i el problema és en com construeix els prompts la teva aplicació: continua llegint. Si no en mostra cap, torna-ho a provar unes quantes vegades (la memòria cau funciona sense garanties i la primera petició pot anar a parar a una altra màquina) i després revisa l'entrada del model a la guia de memòria cau d'OpenAI. Posa-hi el model que fas servir en producció; una prova amb un altre model demostra ben poc.

Aquesta prova també et dona una línia base per a les seccions següents. Quan canviïs l'ordre del teu prompt o afegeixis un `prompt_cache_key`, fes la mateixa comparació amb una plantilla real de la teva aplicació i guarda les xifres. Una taxa d'encerts mesurada abans i després del canvi, en una plantilla que els teus usuaris fan servir de debò, és un resultat que pots ensenyar; «la memòria cau hauria d'ajudar» no ho és.

## Posa al final el que canvia

En la majoria de casos, la solució és l'ordre. Tot el que és igual a cada petició va primer i es manté idèntic byte a byte; tot el que canvia va al final.

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

Després, segueix quina proporció de cada prompt ha sortit de la memòria cau, perquè una regressió aparegui el mateix dia que arriba a producció:

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

Agrupa aquesta proporció per plantilla de prompt. Una plantilla amb una proporció que es queda al 0 % tot i que els seus prompts superen els 1,024 tokens té alguna cosa que canvia a prop del principi: registra dues peticions i compara-les caràcter a caràcter, com es mostra a [la versió d'aquesta guia per a Claude](/ca/guides/claude-prompt-caching-not-working#troba-el-byte-que-trenca-la-memòria-cau).

## Com hi ajuda BV-SALA

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) és una capa d'estalvi Apache-2.0 per a TypeScript que embolcalla qualsevol endpoint compatible amb OpenAI, gratis i sense clau. La memòria cau d'OpenAI és automàtica, així que amb OpenAI la capa no marca res. El que fa per la memòria cau:

- **Sempre demana l'ús en els streams,** de manera que una petició en streaming es mesura en lloc de quedar-se sense comptador sense que ningú se n'adoni.
- **Mostra el descompte d'OpenAI a cada crida,** a `report.nativeSavings`, a partir del comptador de la mateixa OpenAI, i el separa del seu propi estalvi: el descompte és d'OpenAI, no de la capa.
- **Pot treure del prefix les línies volàtils.** Amb l'opció `savings: { cachePrefix: true }`, les línies del prompt de sistema que canvien a cada petició (timestamps ISO, UUID, temps epoch) passen al final, perquè la part estable pugui anar a la memòria cau. El model llegeix les mateixes línies en un altre ordre, i per això és decisió teva i mai no ve activada per defecte.

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

Les palanques pròpies de la capa (saltar-se les repeticions exactes i les peticions idèntiques en curs) són independents de la memòria cau d'OpenAI i s'expliquen a [deduplicar peticions idèntiques a un LLM](/ca/guides/deduplicate-llm-requests).

## Contrasta-ho amb les xifres d'OpenAI

1. **Per petició:** registra `cached_tokens` i el total d'entrada de cada resposta, o `report.tokens.providerCachedInput` amb la capa.
2. **Per dia:** la [Usage API](https://developers.openai.com/api/reference/resources/organization/subresources/usage) d'OpenAI retorna l'ús de completions en trams diaris que inclouen els tokens d'entrada en memòria cau, per model i, si ho demanes, per clau d'API o projecte. Suma els teus registres de la mateixa clau, el mateix model i el mateix dia UTC: els totals amb memòria cau i sense haurien de coincidir.
3. **En diners:** valora per separat l'entrada amb memòria cau i sense. En els models que facturen les escriptures a la memòria cau, inclou-les també, o la teva estimació de l'estalvi sortirà massa alta.

Per al mètode complet, llegeix [com verificar l'estalvi en LLM amb la factura del teu proveïdor](/ca/guides/verify-llm-savings-against-provider-bill). Per a la resta de palanques d'una factura d'OpenAI, consulta [com reduir els costos de l'API d'OpenAI](/ca/guides/reduce-openai-api-costs). Els resultats mesurats, inclosos els casos en què la capa no estalvia res, són a la [pàgina del banc públic](/ca/benchmarks), i el codi és a [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
