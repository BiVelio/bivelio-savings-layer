# Recomendación n.º 8: adaptadores para AI SDK, Mastra, LangChain.js y el SDK de Anthropic. Especificación implementable

Estado: diseño terminado. No he tocado ningún repositorio. No he creado el worktree `/Users/fisagol/bsl-adaptadores`, que crea el implementador siguiendo las reglas duras. Los supuestos arriesgados los he comprobado con experimentos en el scratchpad (§12), sin tocar el repositorio. Este diseño no introduce ningún precio.

---

## 0. Qué aporta y qué no (el porqué, del informe de competencia)

- **§3 y §5.1.** Las palancas grandes ya son gratis en los frameworks: caché de prefijo, selección de herramientas y compactación [92][93][94]. Lo que sigue teniendo valor diferencial es **evitar llamadas** (resolvers, singleflight, caché exacta con valoración por referencia) y **la contabilidad** con el contador del proveedor.
- **§4.2.** «Romper la caché hunde la propuesta», y el gateway ya se hizo daño apagando el tool search. De ahí la regla central: **el adaptador nunca reescribe lo que manda el framework**. Solo puede ahorrarse la llamada entera o medirla.
- **§8 n.º 8.** Audiencias de 6 a 150 M de descargas al mes. La cuota por versión (API de npm, 27‑sep‑2026, https://api.npmjs.org/versions/<pkg>/last-week) queda así:
  - `ai`: v6 47,3 %, v7 33,9 %, v5 12,8 %.
  - `@mastra/core`: 1.x 95,9 %.
  - `langchain`: 1.x 74,5 %.
  - Por eso se da soporte a **ai 6 y 7**, **Mastra 1.x**, **LangChain 1.x** y **@anthropic-ai/sdk 0.x ≥ 0.103**.

**Fuera de alcance en la v1**, forzado y no configurable:
- compresión, elisión, serialización, selector de herramientas, `toolDiscovery`, cascada de modelos, codebook y `deferrable`;
- caché semántica (§8 n.º 10: apagada en tráfico agéntico);
- verificación A/B;
- Python;
- la web (paridad de 12 idiomas);
- subir la versión.

---

## 1. Decisiones con su porqué

| # | Decisión | Porqué |
|---|---|---|
| D1 | **Subpaths del paquete principal**: `./ai-sdk`, `./mastra`, `./langchain`, `./anthropic-sdk`. Los frameworks van como **peerDependencies opcionales**. | Una sola versión, una LICENSE y un tarball, así que no puede haber desfase de versión entre adaptador y núcleo. El dueño no tiene que crear 4 paquetes npm con la publicación en CI rota (EOTP, §5.2). `exports["."]` no cambia, así que dx-empaquetado sigue en verde. **Coste:** npm no desglosa descargas por subpath, y la señal de éxito de la n.º 8 necesita el paso del dueño P3. |
| D2 | Los adaptadores **solo usan la API pública** (`import … from "@bivelio/savings-layer"`, marcado `external` en tsup). No importan nada de `src/pipeline`, `src/license` ni `src/metering`. | Así no pueden saltarse `assertLicensed` ni el metering **por construcción**: el único punto de entrada es `layer.generate()`/`generateStream()`, que gatea y registra. Además se comparte una sola instancia del núcleo, que tampoco se duplica en tamaño. Lo fija un test estático (T9). |
| D3 | **Proveedor puente** (`Provider`) que despacha con `AsyncLocalStorage` a la llamada del framework en curso. El adaptador crea la capa con `createSavingsLayer({ ...opciones, provider: puente })`. | Cuando el núcleo decide llamar al proveedor, lo que se ejecuta es la llamada original del framework, con sus params intactos. Funciona con singleflight: el líder llama en su propio contexto. Validado contra el núcleo de origin/main (§12). |
| D4 | **Palancas forzadas** en cada `SavingsRequest`: `{ router:false, compression:false, elision:false, serialization:false, toolDiscovery:false, modelCascade:"off", outputCodebook:false, deferrable:false, semanticCache:false, verification:false }`. Por llamada solo se pueden **apagar** `exactCache`, `singleflight` y `deterministicResolvers`. | Con esto el núcleo entrega al puente **los mismos objetos** `ChatMessage` que renderizó el adaptador, verificado. El puente además comprueba igualdad profunda antes de llamar (R1). |
| D5 | La **identidad** de todo lo que el núcleo no modela (maxOutputTokens, stop, topP/K, penalties, responseFormat, toolChoice, providerOptions, partes no textuales, argumentos crudos de tool‑calls y tool‑results, definiciones completas de herramientas, `anthropic-beta`/`openai-beta`) se mete como huella en **`context.authorizationScope`**: `"<scope del usuario o default>|bvsala-adapter:<sha256>"`. | `authorizationScope` ya entra en la clave exacta, en la de vuelo y en la identidad semántica. Dos peticiones que difieren solo ahí nunca comparten respuesta, **sin tocar la generación de claves** (ni `GENERACION` ni las claves de usuarios actuales). Del hash se excluyen ids de tool‑call, `abortSignal`, cabeceras (salvo las dos betas), `providerOptions.bivelio` y `providerOptions.mastra` (Mastra sella `createdAt` en cada parte, visto en el experimento). |
| D6 | **Cambio mínimo en el núcleo:** `ProviderResponse.replayable?: boolean`. Con `false` no se escribe en la caché exacta y un seguidor concurrente hace su propia llamada. | Una respuesta con ficheros, fuentes, herramientas ejecutadas por el proveedor o razonamiento que el proveedor espera recibir de vuelta (firma o cifrado) no se puede reproducir desde un texto. Envolver la caché desde fuera dejaría una traza engañosa (`reference … exactCache:true`). Hacerlo en el núcleo deja la traza honesta. Sin el campo, el comportamiento no cambia. |
| D7 | Herramientas **sin declarar = con efectos** (`risk:"write"`). `readOnlyTools` las declara de lectura. Las herramientas ejecutadas por el proveedor son siempre `write`. | Es la política del núcleo («write/destructive tools are never cached»). El framework no dice el riesgo, así que la opción segura es suponer efectos. |
| D8 | **Solo se mide el contador del proveedor.** Uso ausente o incompleto → `complete:false`. Modelo simulado (`provider` que empiece por `mock`, `_llmType()` con `fake`) → `complete:false`. En LangChain, con `model.cache` activo → `complete:false` y un aviso. En Anthropic, `usage.iterations.length > 1` → `complete:false` hasta que la n.º 1 sume las iteraciones. | Aplica el principio del negocio y la regla E0 del núcleo: un contador fabricado o repetido por una caché intermedia no es la factura. |
| D9 | **Fail‑closed**: sin licencia, `LicenseError` llega al llamante tal cual y el modelo **no se llama**. | Coherente con el SDK. Lo verifica T4‑T7 y, en el tarball publicado, T11. |
| D10 | **Cero campos nuevos en el cable** hacia BiVelio. | licencia-alineada no cambia. No se pasa `attribution` ni `sessionId` al metering. |
| D11 | CI **sigue en Node 20**. | ai 7, @ai-sdk/openai 4 y Mastra declaran `engines >=22`, pero los cuatro frameworks funcionaron con Node 20.20.2 en las rutas probadas (§12). pnpm solo avisa. Subir `engines` o la CI es decisión del dueño (P2). |

---

## 2. Versiones soportadas (verificadas el 2026‑09‑27)

| Framework | Rango del peer (opcional) | Versión de test (devDep exacta) | Punto de extensión | Fuente |
|---|---|---|---|---|
| Vercel AI SDK | `ai: ^6.0.0 \|\| ^7.0.0` | `ai 7.0.118` y alias `ai-v6: npm:ai@6.0.293` | `LanguageModelMiddleware` con `wrapLanguageModel`. En ai 7 el tipo relaja `specificationVersion` (acepta `'v3'`). El mismo objeto `specificationVersion:"v3"` funciona en ai 6 y en ai 7 (probado). | https://ai-sdk.dev/docs/ai-sdk-core/middleware (consultado 2026‑09‑27); `ai@7.0.118` `dist/index.d.ts` (`type LanguageModelMiddleware = Omit<LanguageModelV4Middleware,'specificationVersion'> & { specificationVersion?: string }`) |
| Mastra | `@mastra/core: >=1.68.0 <2` | `1.71.0` | Processor con `processLLMRequest` (puede devolver `{ response: { chunks } }` y se salta el modelo) + `processLLMResponse` (recibe los chunks, también el chunk `error` si falla) + `processInputStep` (herramientas y ajustes). | https://mastra.ai/docs/agents/processors ; https://mastra.ai/reference/processors/processor-interface ; CHANGELOG https://github.com/mastra-ai/mastra/blob/main/packages/core/CHANGELOG.md: hooks en **1.33.0**, arreglos de durable en **1.68.0** |
| LangChain.js | `langchain: >=1.1.0 <2`, `@langchain/core: >=1.1.0 <2` | `1.5.14` / `1.2.13` | `createMiddleware({ wrapModelCall(request, handler) })`. Llamar al handler 0 veces es cortocircuito documentado. | https://docs.langchain.com/oss/javascript/langchain/middleware/custom (consultado 2026‑09‑27). Ojo: `langchain@1.0.0` es un paquete **de 2023** sin relación con la línea v1, por eso el suelo es 1.1.0 (tiene `wrapModelCall`, verificado en el tarball). |
| SDK oficial de Anthropic (TS) | `@anthropic-ai/sdk: >=0.103.0 <1` | `0.128.0` | Opción de cliente `middleware: Middleware[]` con la firma `(request, next, ctx)`. Se ejecuta por intento HTTP dentro del bucle de reintentos. `ctx.options` expone opciones de petición desconocidas. Se puede cortocircuitar devolviendo un `Response`. Ve el cuerpo canónico también en Bedrock, Vertex y Foundry. | CHANGELOG del SDK: `add support for middleware` en **0.101.0** (2026‑06‑05), firma antes del signing en 0.102.0 y orden 3P en **0.103.0**. Tipos en `core/middleware.d.ts` (0.103.0 ya trae `ctx.options` y `ctx.parse`). **La página https://platform.claude.com/docs/en/api/sdks/typescript no lo documenta** (riesgo X4). |

---

## 3. Invariantes (cada uno con su test)

- **R1 Fidelidad.** Lo que llega al proveedor es exactamente lo que mandó el framework: `params`/`request`/`body` pasan sin cambios, el `body` sin re‑serializar. Antes de llamar, el puente comprueba que el `ProviderRequest` coincide con lo renderizado (modelo, mensajes y herramientas en igualdad profunda; se ignoran `stablePrefixMessages`, `promptCacheKey` y `constraintBackend`, que son pistas). Si no coincide, lanza **antes de gastar** con `"[bvsala] internal: the layer changed a request this adapter must forward unchanged; nothing was sent."`.
- **R2 Sin atajos.** Toda llamada al modelo que dispare un adaptador pasa por `layer.generate`/`generateStream`. El puente admite **una sola** llamada al framework por petición de la capa; la segunda lanza sin llamar.
- **R3 Palancas** según D4.
- **R4 Identidad** según D5.
- **R5 Contador** según D8.
- **R6 Reproducible** solo si la respuesta tiene texto + tool‑calls del cliente, `finish` es `stop` y no trae razonamiento con metadatos del proveedor, ficheros, fuentes, herramientas ejecutadas por el proveedor, aprobaciones ni partes custom. En cualquier otro caso: `replayable:false`.
- **R7 Herramientas** según D7. Además, los resolvers se apagan si hay formato JSON o una herramienta forzada (`responseFormat.type:"json"`, `toolChoice` `required`/`tool`, `tool_choice` `any`/`tool`, `output_config.format`, `structuredOutput`, `responseFormat` de LangChain).
- **R8 Fail‑closed** según D9.
- **R9 Cable** según D10.
- **R10 Orden.** El adaptador va **lo más cerca posible del modelo**: último del array en AI SDK, LangChain y Anthropic, y último `inputProcessor` en Mastra. Nada que pueda contestar en nombre del proveedor debe quedar entre él y el modelo. Se documenta en el README.

---

## 4. API pública (en inglés)

### 4.1 Exportado desde `@bivelio/savings-layer` (solo tipos, en `src/index.ts`)

```ts
/** Options shared by every framework adapter. Same meaning as in createSavingsLayer. */
export type SavingsAdapterOptions = Pick<SavingsLayerConfig,
  | "licenseKey" | "licenseServerUrl" | "serviceAccountKey" | "licenseRefresh" | "licenseRevocation"
  | "licensePollIntervalSeconds" | "licenseFetch" | "metering" | "meteringUrl" | "meteringFetch"
  | "costModels" | "defaultCostModel" | "exactCache" | "exactCacheTtlMs" | "resolvers"
  | "exactTokenizer" | "silenceWarnings" | "failOpen"
> & {
  /** Tools without side effects. Any other tool keeps the request out of every cache and out of in-flight sharing. */
  readOnlyTools?: readonly string[] | ((toolName: string) => boolean);
  /** Switch off, for every call, the levers that answer without calling the model. They are on by default. */
  savings?: SavingsAdapterLevers;
  /** Called once per model call with its report. Errors thrown here are caught and never reach the call. */
  onReport?: (report: SavingsReport) => void;
};
export type SavingsAdapterLevers = Pick<SavingsToggles, "exactCache" | "singleflight" | "deterministicResolvers">;
/** Per-call options, where the framework has a place for them. */
export interface SavingsCallOptions { context?: RequestContext; savings?: SavingsAdapterLevers; }
```

Además, en `ProviderResponse` (`src/providers/types.ts`):

```ts
/**
 * Whether this answer can be handed to a later identical request (exact cache) or to a
 * concurrent identical request. `false` when it carries content the layer keeps no copy of,
 * such as generated files, cited sources, results of tools the provider ran itself, or
 * reasoning the provider expects back: it is served to this caller only, it is not written
 * to the exact cache, and a concurrent identical request makes its own call. Absent means
 * replayable.
 */
replayable?: boolean;
```

### 4.2 `@bivelio/savings-layer/ai-sdk`

```ts
import type { LanguageModelMiddleware } from "ai";
export interface SavingsMiddlewareOptions extends SavingsAdapterOptions {
  /** Cache identity for this call (tenant, sessionId…). `providerOptions.bivelio.context` wins over it. */
  context?: (call: { provider: string; modelId: string; params: unknown }) => RequestContext | undefined;
  /** The model id the report is priced with. Default: `<provider prefix>/<modelId>` (`openai.responses` → `openai/…`; ids that already contain "/" are kept). */
  modelId?: (model: { provider: string; modelId: string }) => string;
  /** Put the report in `providerMetadata.bivelio.savingsReport` (default true). */
  reportInMetadata?: boolean;
}
export type SavingsMiddleware = LanguageModelMiddleware & { close(): void };
export function savingsMiddleware(options: SavingsMiddlewareOptions): SavingsMiddleware;
/** Reads the report from a generateText result or step, or from `{ providerMetadata: await stream.providerMetadata }`. */
export function getSavingsReport(source: { providerMetadata?: unknown } | null | undefined): SavingsReport | undefined;
```

Por llamada: `providerOptions: { bivelio: { context, savings } }` (tipo `SavingsCallOptions`). No se elimina antes de llamar al modelo: los proveedores solo leen su propia clave.

### 4.3 `@bivelio/savings-layer/mastra`

```ts
import type { Processor } from "@mastra/core/processors";
export interface SavingsProcessorOptions extends SavingsAdapterOptions {
  context?: (args: { requestContext?: unknown }) => RequestContext | undefined;
  /** Also emit the report as a `data-bivelio-savings-report` part (default false). */
  emitReportPart?: boolean;
  /** Give up on a model call Mastra never reported back (default 15 min); nothing is recorded. */
  providerTimeoutMs?: number;
  modelId?: (model: { provider: string; modelId: string }) => string;
}
export type SavingsProcessor = Processor<"bivelio-savings"> & { close(): void };
export function savingsProcessor(options: SavingsProcessorOptions): SavingsProcessor;
```

- Se registra como **último** de `inputProcessors`. Opcionalmente también en `errorProcessors`.
- **No cubre** `generateLegacy()`/`streamLegacy()` (Mastra no llama ahí a `processLLMRequest`) ni agentes durables repartidos entre procesos. Se documenta.
- En Mastra, `singleflight` va **forzado a off** (ver A3).

### 4.4 `@bivelio/savings-layer/langchain`

```ts
import type { AgentMiddleware } from "langchain";
export interface SavingsAgentMiddlewareOptions extends SavingsAdapterOptions {
  context?: (request: unknown /* ModelRequest */) => RequestContext | undefined;
  modelId?: (model: unknown) => string;
  /** Put the report in `response_metadata.bivelio.savingsReport` of the AIMessage (default true). */
  reportInMetadata?: boolean;
}
export function savingsAgentMiddleware(options: SavingsAgentMiddlewareOptions): AgentMiddleware & { close(): void };
export function getSavingsReportFromMessage(message: unknown): SavingsReport | undefined;
```

### 4.5 `@bivelio/savings-layer/anthropic-sdk`

```ts
import type { Middleware } from "@anthropic-ai/sdk";
export interface AnthropicSavingsOptions extends SavingsAdapterOptions {
  /** `requestOptions` is what the call passed as its second argument (visible to middleware as ctx.options). */
  context?: (call: { body: unknown; requestOptions: unknown }) => RequestContext | undefined;
  /** How many reports `reportFor` keeps (default 1000, oldest first out). */
  reportCacheSize?: number;
}
export interface AnthropicSavings {
  readonly middleware: Middleware;
  reportFor(message: { id: string } | string): SavingsReport | undefined;
  close(): void;
}
export function anthropicSavings(options: AnthropicSavingsOptions): AnthropicSavings;
```

- Solo intercepta `POST …/v1/messages` (también `?beta=true`).
- `count_tokens`, `batches`, `models` y `files` pasan sin tocar: no hay generación que medir ni optimizar.
- Si el cuerpo no es un string, falla cerrado: `"[bvsala] could not read the request body; nothing was sent."`.

Los nombres importados son **únicos entre todos los bloques del README**, porque fragmento‑instalacion iza los imports a un solo programa.

---

## 5. Comportamiento por adaptador

**Común** (`src/adapters/comun/`):
1. Renderiza a `ChatMessage[]` con este criterio: texto concatenado; tool‑calls del cliente en `toolCalls`; cada tool‑result como `role:"tool"` con `toolCallId`, `name` y `content` (el output en texto o JSON). El razonamiento, los ficheros y el resto de partes quedan fuera del texto y dentro de la huella.
2. Construye los `ToolDescriptor` (`id` = nombre, `intents: []`, `risk` según R7, `parameters` = JSON Schema).
3. Calcula la huella (D5) y compone el scope.
4. Fusiona las palancas (D4 + R7).
5. Ejecuta `als.run(llamada, () => layer.generate(req))`.
6. Si el puente nunca se invocó, hubo atajo y se **sintetiza** la respuesta. Si se invocó, se devuelve **el resultado original del framework** más el informe.
7. `onReport` va dentro de try/catch, con aviso una vez.
8. El informe se clona a JSON (`JSON.parse(JSON.stringify(report))`).
9. Los atajos devuelven uso **0** (el proveedor no facturó nada).

**AI SDK:**
- `wrapGenerate` llama a `doGenerate()` sin tocarlo y guarda el resultado completo en la llamada.
- `wrapStream` usa `layer.generateStream(req, { signal: params.abortSignal })` y una carrera entre «el puente abrió `doStream`» y «`result` se resolvió» (atajo).
- En vivo: `stream.pipeThrough(observador)`. El observador reenvía **todas** las partes en su orden (razonamiento, `tool-input-*`, `raw`, `error`…) y alimenta la cola del puente (`text-delta` → `{type:"text"}`, `tool-call` del cliente → `toolCalls`). Al llegar `finish`: **primero** lo empuja al puente y **después** espera `result` para reemitir `finish` con `providerMetadata.bivelio.savingsReport`. Si falla, emite el `finish` original y avisa una vez. Con ese orden no hay interbloqueo.
- Cancelar el stream se propaga hacia arriba (sin `tee`).
- Atajo en stream: `stream-start`, `response-metadata`, `text-start/delta/end`, tool‑calls y `finish`.
- Fail‑open en stream: el puente usa `doGenerate()` y se sintetiza desde el **resultado completo** del framework.
- Uso: `inputTokens.total`, `cacheRead`, `cacheWrite`, `outputTokens.total`, `reasoning` (solo si es número).

**Mastra:**
- `processInputStep` guarda en `state` **datos serializables**: nombres, descripciones y JSON Schema de las herramientas activas (si un esquema no se puede serializar, la petición va como `write`), `toolChoice`, `providerOptions`, `modelSettings` y `structuredOutput`, indexados por `stepNumber`.
- `processLLMRequest`: arranca `layer.generate` con un proveedor **diferido**. Si hay atajo, devuelve `{ response: { chunks } }` con la secuencia del fixture (T6g). Si el núcleo decide llamar, guarda un token en `state` y deja el diferido en un `Map` del módulo, porque `state` puede persistirse.
- `processLLMResponse` (`fromCache:false`):
  - chunk `error` → rechaza (sin registro);
  - si no, extrae texto, tool‑calls y el uso del `finish` (`payload.output.usage.raw` anidado; sin `raw` → `complete:false`) y resuelve.
- `processAPIError`, `abortSignal` y `providerTimeoutMs` rechazan y limpian.

**LangChain:**
- El puente llama a `handler(request)` sin tocarlo. Es no‑stream: el streaming de tokens sigue saliendo por los callbacks del modelo.
- Atajo: `new AIMessage({ content, tool_calls, usage_metadata:{0,0,0}, response_metadata:{ bivelio:{ savingsReport } } })`.
- Uso: `usage_metadata.input_tokens`, `input_token_details.cache_read`/`cache_creation` y `output_token_details.reasoning`. Si los detalles suman más que el total → `complete:false`.
- `modelId` sale de `model.model ?? model.modelName`, con `_llmType()` como prefijo.

**Anthropic SDK:**
- El puente llama a `next(request)` sin tocarlo.
- Con un `Response` no 2xx lo guarda, lanza y el middleware **devuelve ese mismo `Response`**, para que el SDK aplique sus reintentos y errores tipados.
- JSON: `response.clone().json()`.
- SSE: observador de bytes → `sseMessages` (reutilizado de `src/providers/sse.ts`) → deltas y uso. Devuelve `new Response(cuerpoObservado, response)`.
- Atajo: Message JSON (`id: msg_bvsala_<requestId>`, cabecera `request-id`) o SSE sintético. Los dos funcionan con `create`, `stream` y `finalMessage` (probado).
- Mapeo de uso: mismo que el del núcleo (ver F7).

---

## 6. Cambios por fichero

| Fichero | Cambio |
|---|---|
| `package.json` | `exports`: añadir `./ai-sdk`, `./mastra`, `./langchain`, `./anthropic-sdk`, cada uno `{ "types": "./dist/adapters/<x>.d.ts", "import": "./dist/adapters/<x>.js", "default": "./dist/adapters/<x>.js" }`, con `types` el primero y `default` el último. `peerDependencies` + `peerDependenciesMeta.optional` según §2. `devDependencies` exactas según §7. **No** tocar `version`. Keywords `ai-sdk`, `langchain`, `mastra`, `anthropic` solo si el dueño lo aprueba (P5). |
| `pnpm-lock.yaml` | `pnpm install` tras añadir las devDeps (la CI usa `--frozen-lockfile`). |
| `tsup.config.ts` | En la **config 1** (así el `clean` corre una sola vez): añadir entradas `"adapters/ai-sdk": "src/adapters/ai-sdk.ts"` (y las otras tres) y `external: ["@bivelio/savings-layer", "ai", "@mastra/core", "langchain", "@langchain/core", "@anthropic-ai/sdk", /^node:/]`. Comentario en español: por qué `external` + `paths` (D2). |
| `tsconfig.json` | `"paths": { "@bivelio/savings-layer": ["./src/index.ts"] }`, para que tsc y el dts resuelvan al fuente sin carrera con `dist`. |
| `vitest.config.ts` | Pasar el `alias` a array con regex exactas: `/^@bivelio\/savings-layer$/` → `src/index.ts` y `/^@bivelio\/savings-layer\/(ai-sdk\|mastra\|langchain\|anthropic-sdk)$/` → `src/adapters/$1.ts`. Mantener `@bivelio/protocol`, `@bivelio/license-client` y `"@/"` el último. |
| `src/index.ts` | `export type { SavingsAdapterOptions, SavingsAdapterLevers, SavingsCallOptions } from "./adapters/comun/opciones.js";` |
| `src/providers/types.ts` | Campo `replayable` (§4.1). |
| `src/pipeline/pipeline.ts` | (a) `cacheable` añade `&& response.replayable !== false`, con una rama de traza nueva en `cache-write`: `"skipped: the provider answer carries content this layer cannot replay"`. (b) `WeakSet<SavingsResult>` `noReproducibles` (gemelo de `referenciasDeLider`), marcado al terminar el líder. (c) En los dos caminos de singleflight (`run` y `join`): si `noReproducibles.has(value)`, el seguidor devuelve `runExpensive()`. Comentarios en `//` y en español. |
| `src/providers/anthropic-uso.ts` (nuevo, interno) | Mover **tal cual** el cálculo de uso (input + cache_creation + cache_read, `reasoningTokens:0` sin bloque de pensamiento, `complete:false` si falta un contador), `fusionarUso` y la traducción de `stop_reason`. `anthropic.ts` los importa. **No se reexporta.** |
| `src/adapters/comun/{opciones,capa,puente,palancas,huella,herramientas,informe,prompt-ai-sdk,diferido}.ts` | El runtime compartido de §5. `capa.ts` construye la capa: `createSavingsLayer({ ...opcionesPermitidas, provider: puente(marco) })`, `id` del puente `bivelio-adapter:<marco>`. `prompt-ai-sdk.ts` renderiza prompts V2, V3 y V4 (compartido entre AI SDK y Mastra). |
| `src/adapters/{ai-sdk,mastra,langchain,anthropic-sdk}.ts` | Entradas públicas (§4). **Imports de framework solo `import type`**, salvo en LangChain (`createMiddleware` de `langchain`, `AIMessage` de `@langchain/core/messages` y `toJsonSchema` de `@langchain/core/utils/json_schema`). |
| `README.md` | §9. |
| Tests | §8. |

Todo lo que ve el cliente va en inglés (identificadores, JSDoc, mensajes y avisos con prefijo `[bvsala]`). Los comentarios internos, en español y con `//` sobre exports, para que no viajen al `.d.ts`.

---

## 7. Dependencias (todas devDependencies, versiones exactas)

| Paquete | Versión | Para qué |
|---|---|---|
| `ai` | 7.0.118 | tests v7 (`MockLanguageModelV4`), tipos |
| `ai-v6` | `npm:ai@6.0.293` | tests v6 (`MockLanguageModelV3`) |
| `@ai-sdk/openai` | 4.0.78 | solo compilar el fragmento del README |
| `@mastra/core` | 1.71.0 | tests con `Agent` real |
| `langchain` / `@langchain/core` | 1.5.14 / 1.2.13 | tests con `createAgent` y `FakeToolCallingModel` |
| `@anthropic-ai/sdk` | 0.128.0 | tests con `new Anthropic({ fetch: stub, middleware })` |
| `zod` | 4.6.5 | peer de ai, Mastra y LangChain |

- Sin `dependencies` nuevas. Mastra añade bastante peso a la instalación de CI (69 MB desempaquetado más sus dependencias).
- La superficie de cadena de suministro solo crece en desarrollo y CI. Las versiones exactas en el lockfile lo acotan (§8 n.º 7 del informe).

---

## 8. Tests (todo sin red: `globalThis.fetch` se sustituye por un stub que falla o que registra)

**Núcleo:**
- **T1 `test/adaptadores/puente-fidelidad.test.ts`**:
  - con D4, el `ProviderRequest` son los **mismos objetos** renderizados, en mensajes mixtos (system inicial y a mitad de conversación, assistant con toolCalls, tool);
  - un `ProviderRequest` alterado lanza sin llamar;
  - una segunda llamada lanza.
- **T2 `…/huella-de-opciones.test.ts`**:
  - peticiones que difieren solo en maxOutputTokens, stop, responseFormat, toolChoice, providerOptions, argumentos de tool‑call, bytes de un fichero, `cache_control` o `anthropic-beta` → nunca aciertan ni se coalescen;
  - peticiones que difieren solo en ids de tool‑call, `providerOptions.mastra.createdAt` o cabeceras de traza → sí aciertan;
  - un `authorizationScope` del usuario se conserva como prefijo.
- **T3 `…/respuesta-no-reutilizable.test.ts`**:
  - `replayable:false` → no se escribe en la caché exacta y hay traza nueva;
  - el seguidor concurrente hace su propia llamada (2 llamadas, las dos `measured`);
  - sin el campo, todo igual (los tests actuales del pipeline pasan sin tocarlos);
  - en stream, `join` también.

**Por adaptador (T4 AI SDK con v7 y v6, T5 LangChain, T6 Mastra, T7 Anthropic):**
- a) llamada viva: 1 llamada al modelo, `basis:"measured"` con los contadores del doble, `onReport` una vez, el informe en su sitio (`providerMetadata` / `response_metadata` / `reportFor` / data part);
- b) repetición idéntica con `temperature:0`: 0 llamadas, `cache.result:"exact"`, `basis:"reference"` cuando pasan L0‑L7, uso 0 en el resultado;
- c) `"What is 2 + 2 * 3?"` → «8» sin llamar y `estimated`;
- d) stream vivo: partes idénticas y en el mismo orden, incluidos razonamiento, `tool-input-*` y `raw` (AI SDK); SSE byte a byte (Anthropic); `streaming.delivery:"live"`;
- e) atajo en stream que el framework parsea: `textStream`, `agent.stream`, `messages.stream().finalMessage()`;
- f) herramienta sin declarar → sin caché y con la razón en la traza; declarada en `readOnlyTools` → caché de la respuesta final de texto; herramienta del proveedor → nunca;
- g) respuesta con fichero, fuente o razonamiento firmado → `replayable:false`;
- h) sin licencia (`delete process.env.BVSALA_DEV_OPEN`, sin `licenseKey`) → `LicenseError` y el modelo, handler o fetch **no** se llama;
- i) el objeto de params, request o body que recibe el modelo es **el original** (R1);
- j) AI SDK: el mismo `savingsMiddleware` es asignable a `LanguageModelMiddleware` de `ai` y de `ai-v6` (test de tipos compilado) y funciona en tiempo de ejecución con ambos;
- k) Mastra: error del modelo → sin registro de metering (espía en `meteringFetch`) y sin diferidos pendientes; `abortSignal` limpia; **test de contrato**: capturar con un modelo simulado los chunks reales de `processLLMResponse` para una respuesta de solo texto y comprobar que el sintetizador emite los mismos `type` y claves de `payload`, con Mastra 1.71 como fuente del fixture;
- l) Anthropic: 529 y después 200 → el middleware corre por intento y hay **un solo** registro; `count_tokens`, `batches` y `models` pasan sin llamar a la capa; `usage.iterations` con 2 entradas → `unmeasured`; paridad de uso con `AnthropicProvider` sobre los mismos fixtures JSON y SSE;
- m) LangChain: `model.cache` activo → `unmeasured` y aviso una vez; modelo `fake*` → `unmeasured`.

**Verjas:**
- **T8 `test/superficie-publica-limpia.test.ts`**: ampliar a `dist/adapters/*.d.ts` con las mismas reglas: sin rutas del repo, sin relatos, sin nombres en español, sin terceros prohibidos (ojo con la subcadena `toon`), **0 líneas con acentos** y `SavingsReport` importado de `'@bivelio/savings-layer'`, nunca redeclarado. El `TECHO` de `index.d.ts` no sube.
- **T9 `test/adaptadores/solo-superficie-publica.test.ts`**: escaneo de imports en `src/adapters/**`. Permitido: `@bivelio/savings-layer`, `./comun/*`, los frameworks, `node:async_hooks` y `../providers/{sse,anthropic-uso}.js`. Prohibido `src/{pipeline,license,metering,cache}`.
- **T10 `test/dx-empaquetado.test.ts`**: cada subpath con `types` el primero y `default` el último, y los ficheros existen. Cada `dist/adapters/*.js`: minificado con líneas por debajo de 4000, contiene `"@bivelio/savings-layer"`, **no** contiene `bvsala:exact:` (señal de que el núcleo no se ha empaquetado dentro) y pesa menos de 60 KB.
- **T11 `test/sala-limpia-del-tarball.test.ts`**: nuevo `describe` para ai‑sdk, mastra y anthropic‑sdk, que no importan frameworks en tiempo de ejecución. Desde el tarball y sin clave, invocar el hook con un modelo o `next` falsos → rechaza con `LicenseError` y el falso no se llama.
- **T12 `test/fragmento-instalacion.test.ts`**: el directorio temporal pasa a `join(RAIZ, "node_modules/.cache/bvsala-frag-*")` para que resuelvan los frameworks, y se añaden `paths` para `@bivelio/savings-layer/*` → `src/adapters/*.ts`. Medir el tiempo: si pasa de 60 s, compilar los bloques de adaptadores en un `it` aparte.

---

## 9. Documentación (README, en inglés, sin cifras de ahorro)

Nueva sección **`## Inside your framework`**, después de «Streaming» y antes de «What you get on every request», con cuatro `###` de 6 a 10 líneas cada uno: una línea de qué hace, la instalación (`pnpm add @bivelio/savings-layer ai @ai-sdk/openai`…), el bloque `ts` y tres viñetas comunes:

1. «answers it can give without calling the model (computed arithmetic, exact repeats, identical requests already in flight); it never rewrites what your framework sends»;
2. «tools are treated as having side effects unless listed in `readOnlyTools`»;
3. «fail‑closed like the SDK; put it last, so nothing sits between it and the model».

Palabras que no pueden aparecer:
- `singleflight`, `semantic-cache` ni la lista de superficie‑publica‑limpia;
- «does not optimize» (lo caza readme‑alineado);
- porcentajes.

Bloque AI SDK (los otros tres siguen el mismo patrón, con Mastra `model: "openai/gpt-4o-mini"`, LangChain `model: "openai:gpt-4o-mini"` y Anthropic `model: "claude-opus-5"`, y con nombres importados únicos):

```ts
import { generateText, wrapLanguageModel } from "ai";
import { openai } from "@ai-sdk/openai";
import { savingsMiddleware, getSavingsReport } from "@bivelio/savings-layer/ai-sdk";

const savings = savingsMiddleware({
  licenseKey: process.env.BIVELIO_LICENSE_KEY,
  licenseServerUrl: "https://savings.bivelio.com",
  serviceAccountKey: process.env.BIVELIO_SERVICE_KEY,
  readOnlyTools: ["get_weather"],
});
const model = wrapLanguageModel({ model: openai("gpt-4o-mini"), middleware: savings }); // last in the list

const result = await generateText({
  model,
  prompt: "What is 2 + 2 * 3?",
  providerOptions: { bivelio: { context: { sessionId: "user-42" } } },
});
console.log(getSavingsReport(result)?.cost.basis); // "estimated": answered without calling the model
```

En «Requirements», una viñeta nueva:

> Framework adapters: `ai` 6 or 7, `@mastra/core` ≥ 1.68 < 2, `langchain` ≥ 1.1 < 2, `@anthropic-ai/sdk` ≥ 0.103 < 1 (optional peers). AI SDK 7 and Mastra declare Node ≥ 22.

---

## 10. Commits y verificación

Commits en español y con el estilo del repo, con `git commit -F <fichero> --only -- <rutas>` y terminados en `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Orden sugerido:

1. `feat(núcleo): replayable en ProviderResponse`
2. `refactor(anthropic): el uso en una función pura`
3. `feat(adaptadores): puente y comunes`
4. uno por adaptador
5. `test(verjas): …`
6. `docs(readme): …`

Nunca `apps/web/public/vendor/bv-sala.js`.

Verificación (todo en verde):
```
pnpm -s build:all && git checkout -- apps/web/public/vendor/bv-sala.js
pnpm -s run typecheck:all && pnpm --dir apps/web run typecheck
pnpm -s exec vitest run --reporter=dot
```
No hace falta `apps/web`.

---

## 11. Pasos del dueño

- **P1.** Revisar y fusionar el PR. Nada de auto‑merge.
- **P2.** Decidir la política de Node: ai 7, @ai-sdk/openai 4 y Mastra piden ≥ 22; Node 20 es EOL desde el 30‑abr‑2026. O se sube `engines` a ≥ 22 con la CI a 22, o se añade un job en Node 22. Hoy todo pasa en Node 20 «por accidente».
- **P3. Señal de éxito de la n.º 8.** Con subpaths, npm no desglosa descargas. Medirlo necesita marcar la superficie (p. ej. `sdk+ai-sdk/0.4.x` en `x-bvsala-version`), lo que implica validarlo en el servidor y revisar /privacy. Es otra unidad. La §5 de la LICENSE ya habla de «surface and version».
- **P4.** Publicar la versión cuando toque. Las unidades no la suben.
- **P5.** Aprobar o vetar las keywords de npm.
- **P6.** Con una clave real (cuesta dinero), comprobar que reproducir una respuesta cacheada no rompe una conversación con pensamiento preservado (Opus 5.5 / Fable 5.1). Mientras tanto R6 marca como no reproducible todo razonamiento con firma.
- **P7.** Anunciarlo en la web (12 idiomas) y en los directorios de integraciones de cada framework: otra unidad y con su visto bueno.

---

## 12. Evidencia y riesgos abiertos

**Experimentos** (scratchpad, fuera del repo; scripts en `/private/tmp/claude-501/-Users-fisagol-bivelio-savings-layer/faec183e-fcb1-462c-ab1a-cab054013371/scratchpad/exp/`: `core.ts`, `core2.ts`, `aisdk.mjs`, `mastra.mjs`, `mastra2.mjs`, `lc.mjs`, `anth.mjs`; snapshot de origin/main en `…/scratchpad/main/`):

- **Núcleo real** (`BVSALA_DEV_OPEN=1`):
  - con D4, el `ProviderRequest` lleva **los mismos objetos** de mensaje (6/6) y las mismas herramientas; las claves extra son solo `constraintBackend`, `stablePrefixMessages` y `promptCacheKey`;
  - la repetición da `exact` + `reference` con 0 llamadas;
  - dos peticiones concurrentes dan 1 llamada en el contexto del líder y la otra `singleflight`;
  - el stream vivo da `delivery:"live"` y `measured`, y su repetición `whole/shortcut` + `reference`;
  - el resolver contesta «8».
- **AI SDK 6.0.293 y 7.0.118**: un único middleware `"v3"` funciona en los dos; `providerOptions.bivelio` llega a `params`; retener `finish` lleva el informe a `result.providerMetadata`.
- **Mastra 1.71.0**:
  - el `prompt` trae `providerOptions.mastra.createdAt` (volátil);
  - `finish.payload.output.usage.raw` trae el uso anidado V4;
  - devolver `{response:{chunks}}` da `text:"CACHED"`, uso 0 y `providerMetadata` desde `finish.payload.metadata`;
  - si el modelo falla, `processLLMResponse` recibe `step-start,error` y después `processAPIError`.
- **LangChain 1.5.14**: el cortocircuito devuelve un `AIMessage` que conserva `response_metadata`; `_llmType()` del fake es `fake-tool-calling`.
- **Anthropic 0.128.0**:
  - el orden del array es exterior → interior;
  - `ctx.options.bivelio` es visible;
  - el JSON y el SSE sintéticos funcionan con `create` y `stream().finalMessage()`;
  - `count_tokens` pasa por el middleware (por eso se filtra por ruta).
- Las cuatro sondas pasan también en **Node 20.20.2**.

**Riesgos:**
- **X1.** El cambio en `pipeline.ts` es pequeño pero toca un fichero muy vigilado. Mitigación: T3 y toda la suite existente sin cambios.
- **X2.** Mastra depende de hooks que no disparan en todos los caminos (legacy, durable entre procesos). Queda cubierto con timeout y sin registro, y documentado.
- **X3.** El precio del modelo sale del id pedido. Si falta en el catálogo (`claude-opus-5-5`, `gpt-6-*`, la n.º 1), se usa el respaldo ilustrativo con aviso, como en el núcleo.
- **X4.** El middleware del SDK de Anthropic está en los tipos y en el CHANGELOG, pero no en la página de docs. Un cambio en un minor lo detectaría T7 al subir la devDep.
- **X5.** Con herramientas sin declarar (lo normal en agentes), el valor práctico es sobre todo **contabilidad medida por llamada** y cobertura del metering, no aciertos de caché. Es honesto y encaja con §5.1, pero conviene no venderlo como más.
- **X6.** El tiempo de T12 con los tipos de Mastra, por medir.