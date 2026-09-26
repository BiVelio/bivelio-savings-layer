# Frente 2 · Especificación final: streaming en el SDK y Python (o cualquier lenguaje) a través del gateway

Base leída: `/Users/fisagol/bsl-comprador` @ `ffa93eb`, es decir, origin/main + #310 más dos commits de web/chore que no tocan nada citado aquí. Paquete 0.4.22. He comprobado en el código cada cita fichero:línea de la que depende el diseño; las que el diseño original o las críticas daban mal están corregidas abajo. Solo lectura: no he modificado nada.

---

## 0 · Qué cambia respecto al diseño original y por qué

El diseño se sostenía en una premisa equivocada: que al streamear había que apagar algunas palancas. No hace falta. Todas las palancas que reescriben o descartan la respuesta (codebook, cascada `on`/`shadow`, rescate local, reparación y aviso de truncado) solo existen cuando hay contrato de salida (`response.schema`). Está verificado:

- Codebook: `schema && toggles.outputCodebook === true` (pipeline.ts:1785).
- Cascada: `fuerzaDelVerificador(undefined) === "none"` ⇒ la petición no es elegible (verificador-de-cascada.ts:62-63 y 122-130).
- Rescate, reparación y truncado: dentro de `if (schema && !pidioHerramientas)` (pipeline.ts:2244-2364).

El diseño final queda así:

- **Entrega «whole».** Aplica si la petición lleva contrato, si se declaró `deferrable` o si el proveedor no implementa `generateStream`. La petición se ejecuta con el `generate()` de hoy, sin tocar un byte, y se entrega de una pieza. Las palancas siguen todas encendidas, la paridad con `generate()` es exacta y no se añade ningún camino de reparación en stream.
- **Entrega «live».** Aplica al resto. La única diferencia con `generate()` es que la llamada primaria (pipeline.ts:1931-1940) va por `provider.generateStream` y el texto se reenvía según llega. No se apaga ninguna palanca, así que desaparece `disabledLevers`.

Cómo se resuelve cada defecto bloqueante de las críticas:

| # | Defecto | Resolución |
|---|---|---|
| C1-1 / C2-2 | La cascada se apagaba dentro de expensivePath cuando ya había fijado modelo, precio y claves (pipeline.ts:1026-1031, 1087, 1122-1132, 1932) | Con contrato la entrega es «whole» y usa `generate()` entero: la cascada decide como hoy. Sin contrato, la cascada no es elegible por construcción. No se toca `decidirCascada`. |
| C1-1 | Apagar codebook o rescate encarecía la petición | No se apaga nada: con contrato, «whole». |
| C1-2 / C2-3 | Un líder en stream contagiaba su abort y `report.streaming` a los seguidores `generate()` (pipeline.ts:1140-1146, 459-467, 3439) | **Una petición en stream nunca lidera un singleflight.** Solo se une como seguidora si ya hay en vuelo una idéntica (`Singleflight.join`, §5.5). Además, `asCoalescedFollower` quita `streaming` igual que ya quita `deferred`. |
| C1-3 | Inyectar `stream_options` por defecto rompe `chunk.choices[0]` en Python, y no se reintentaba con 422 | La inyección pasa a ser **opt-in** (`BVSALA_GATEWAY_USAGE_INJECT=1`). Se hace por inserción textual, sin volver a serializar el JSON. El reintento intacto cubre 400 y 422. Sin inyección, se avisa una vez y hay línea de log. En el adaptador del SDK, 422 también degrada. |
| C1-4 / C2-4 | Los `argumentsDelta` de Anthropic no coincidían con `leer()`, y el filtro de nombres desalineaba índices en OpenAI | Los eventos `tool_call` públicos se emiten **completos, desde `result.toolCalls`, después de todo el texto y antes de `done`**. El proveedor ya no emite deltas de herramienta. La paridad y el invariante se cumplen por construcción. En Anthropic, `arguments = JSON.stringify(JSON.parse(json \|\| "{}"))`. |
| C1-5 / C2-5 | Rutas con dialecto que responden 2xx sin usage pasaban sin línea de log (servidor.ts:296, 793-807) | Nueva línea `· not metered: <motivo>` y aviso único por ruta; `/v1/responses` en JSON pasa a medirse. La copia pública dice «every request whose usage the provider reports». |
| C1-6 | Un acierto semántico en stream no emitía `text` | La síntesis del `text` entero depende de si hubo servicio en vivo (`sirvioEnVivo`), no del modo elegido. |
| C2-1 | Primaria sin usage más reparación con usage salía `measured` (accounting.ts:307-344 con pipeline.ts:2516-2545) | Se añade `ProviderUsage.complete?: false` y `SavingsLedger.callsWithoutUsage`. Si alguna llamada facturada llega sin contador completo, la petición es `unmeasured` y no hay más que discutir. Además, en stream la reparación ya no existe porque con contrato la entrega es «whole». |
| C2-6 | El gateway medía con `usage()` y no con `usageFinal()` (servidor.ts:795), lo que generaba registros «measured» a medias | Se usa `usageFinal()` en todos los observadores, también en la réplica coalescida. |
| C2-7 | La tarjeta de la landing vendía como medido lo que es estimado | Texto reescrito: «same basis rules… a stream without it is reported as unmeasured and never billed». |

También se adoptan las mejoras no bloqueantes que valen la pena: exigir `finish_reason`/`stop_reason` para cerrar un stream (media respuesta nunca se cachea), `requireUsage` lanza en el propio 4xx, la verja de prefijo no registra llamadas sin contador, `usageFinal` del chat exige `[DONE]` o el chunk de usage con `choices: []` (cubre el caso vLLM), `getReader()` en lugar de `for await` sobre `ReadableStream`, el try/catch dentro del callback de metering, `firstEventMs` solo en entrega «live», `requestSent` en lugar de `billed`, abort alineado con el gateway, y no refactorizar `ObservadorSse`/`ObservadorResponses`.

`Singleflight.has()` no hace falta, pero sí algo equivalente para «seguir sin liderar»: `run()` siempre registra como líder cuando la clave no está en vuelo. Por eso se añade `join()` (§5.5).

---

## 1 · Principio (no negociable) y cómo lo cumple esta especificación

«Ahorro medido con el contador del proveedor, nunca una estimación; comisión solo sobre lo medido; publicamos el suelo.»

1. **La fórmula de `basis` no cambia.** Sigue siendo `SavingsLedger.estimateCost` (accounting.ts:283-429). Solo se le antepone una guarda: si alguna llamada facturada llegó sin contador completo, el resultado es `unmeasured` (§4).
2. **El contador se lee del evento FINAL del proveedor.** En OpenAI chat es el chunk con `usage` (el SDK siempre pide `stream_options.include_usage`). En Anthropic es `message_delta`: el `output_tokens: 1` de `message_start` es un marcador (medidor.ts:94-96). Un stream sin ese evento lleva `usage {0, 0, complete: false}` y sale `unmeasured`, con baseline de entrada 0 y `netSavings ≤ 0` (§4.3).
3. **El registro de metering se emite una sola vez, cuando `result` se resuelve, y nunca si `result` se rechaza** (§5.8).
4. **El wire y la base de datos no cambian.** `toWire` (emitter.ts:313-375) arma el registro campo a campo, así que `report.streaming` no viaja. `basis` sigue en {measured, estimated, unmeasured, shadow}. No hay migraciones y no hace falta `vercel --prod` antes del npm.
5. **Media respuesta nunca se cachea.** Un stream que termina sin `finish_reason` (OpenAI) o sin `message_delta` ni `message_stop` (Anthropic) hace que el adaptador lance un error. Cuenta como fallo del proveedor: se propaga, no hay fail-open, no hay registro y no hay caché.

---

## 2 · Política de entrega

```
motivoDeEntregaEntera(request):
  request.response?.schema != null                      → "output-contract"
  request.savings?.deferrable === true                  → "deferrable"
  typeof config.provider.generateStream !== "function"  → "provider-without-streaming"
  en otro caso                                          → null  (entrega "live")
```

Con «whole» se ejecuta `this.generate(request)`, idéntico a hoy: licencia, fail-open, singleflight como líder o seguidor, cascada, codebook, validación, rescate, reparación, truncado y caché. Después se emite `text` (si `result.text !== ""`), luego un `tool_call` por cada `result.toolCalls[i]` y por último `done`.

Con «live» se ejecuta `generateOptimized(request, testigo, sumidero)`. Todas las etapas son las de hoy, con tres diferencias:

- Etapa 3 (singleflight): nunca lidera. Se une a una ejecución idéntica si ya está en vuelo; si no, ejecuta sin registrarse y deja la traza `singleflight: "skipped (streaming: a streamed request never leads)"`.
- Llamada primaria (pipeline.ts:1931): `llamarProveedorEnStream`, que reenvía cada `text` en cuanto llega.
- Si el resultado salió de un atajo (resolver, caché exacta o semántica, o seguidor), se entrega entero con `wholeReason: "shortcut"`. Si hubo fail-open, con `"fail-open"`.

Palanca por palanca, en «live»: el router, el selector de herramientas, la serialización, la compresión, la elisión, la marca de prefix cache, el TTL, la policy y `toolDiscovery` (su sondeo va antes de la primaria, no se streamea y nunca se sirve; pipeline.ts:2805-2815) funcionan igual. El codebook, la cascada y la validación no aplican porque no hay contrato. El caché se escribe con las mismas reglas de pipeline.ts:2665-2667.

---

## 3 · API pública del SDK

Nombres en inglés. Todo el JSDoc nuevo en ASCII, sin acentos (el trinquete de superficie-publica-limpia.test.ts:175 tiene techo 81), sin rutas `src/…ts` ni `x.ts:NN` y sin vocabulario de incidente.

### 3.1 `src/contracts/types.ts` (añadir tras `SavingsResult`)

```ts
/** One event of a streamed answer. */
export type SavingsStreamEvent<T = unknown> =
  /** A piece of the answer text, as the provider wrote it. Never empty. */
  | { type: "text"; delta: string }
  /** One complete tool call the model requested, in the order of `result.toolCalls`. */
  | { type: "tool_call"; call: ToolCallRequest }
  /** Always the last event, exactly once. `result` is the same object `SavingsStream.result` resolves to. */
  | { type: "done"; result: SavingsResult<T> };

export interface SavingsStreamOptions {
  /** Aborting it has the same effect as calling `abort()` on the stream. */
  signal?: AbortSignal;
}

/**
 * The handle returned by `generateStream`. Iterate it (once) for the events, or
 * await `result` for the final SavingsResult; both work on their own, because
 * the request starts as soon as the handle is created.
 *
 * Invariants: the concatenation of every `text` delta equals `result.text`; the
 * `tool_call` events, in order, equal `result.toolCalls`; `done` is the last
 * event and `result` is already resolved when it arrives.
 */
export interface SavingsStream<T = unknown> extends AsyncIterable<SavingsStreamEvent<T>> {
  /**
   * Resolves with the final SavingsResult (the same object the `done` event
   * carries). Rejects with the provider or license error that ended the stream,
   * or with StreamAbortedError when the stream was aborted before the provider
   * finished its answer.
   */
  readonly result: Promise<SavingsResult<T>>;
  /**
   * Stops the stream. Iteration ends at once, without an error. While the
   * provider is still writing a live answer, its request is cancelled: `result`
   * rejects with StreamAbortedError, nothing is cached and nothing is reported.
   * Once the provider's answer is complete, or when it is produced in one piece
   * (output contract, deferrable request), nothing is cancelled: `result`
   * resolves with the full report and it is recorded like any other request.
   * Breaking out of a for-await loop calls abort(). No-op after `done`.
   */
  abort(reason?: unknown): void;
}

/** How a streamed request reached the caller. Present only on results of `generateStream`. */
export interface StreamingReport {
  /**
   * "live": the text was handed over as the provider produced it.
   * "whole": the complete answer arrived as one `text` event.
   */
  delivery: "live" | "whole";
  /**
   * Why the answer arrived whole. Absent when `delivery` is "live".
   * - "output-contract": the request carried `response.schema`; it was validated first.
   * - "deferrable": the request was declared `deferrable`.
   * - "provider-without-streaming": the provider has no `generateStream`.
   * - "shortcut": answered without a provider call (cache, deterministic resolver, or an identical request in flight).
   * - "fail-open": an internal error sent the request down the direct fallback path.
   */
  wholeReason?: "output-contract" | "deferrable" | "provider-without-streaming" | "shortcut" | "fail-open";
  /**
   * Milliseconds from the `generateStream` call to the first `text` or
   * `tool_call` event handed to the caller. Present only when `delivery` is
   * "live" and such an event exists.
   */
  firstEventMs?: number;
}
```

En `SavingsReport`, después de `deferred?` (types.ts:726):

```ts
  /** How a streamed request was delivered. Present only on results of `generateStream`. */
  streaming?: StreamingReport;
```

### 3.2 `SavingsLayer` (create.ts:52-61)

```ts
export interface SavingsLayer {
  generate<T = unknown>(request: SavingsRequest): Promise<SavingsResult<T>>;
  /**
   * Same request as generate(), delivered as a stream of events.
   *
   * Iterate the returned object for `text` deltas as the provider writes them,
   * then one `tool_call` event per requested tool call, then exactly one `done`
   * event carrying the same SavingsResult that `result` resolves to. The report
   * follows the same basis rules as generate(): the provider's final usage is
   * read at the end of the stream, and a stream that ends without it is
   * reported as `unmeasured`.
   *
   * Requests with an output contract (`response.schema`) or declared
   * `deferrable`, and providers without streaming support, are produced exactly
   * as generate() would and delivered in one piece; `report.streaming` says how
   * the answer was delivered and why.
   *
   * Work starts immediately, so awaiting `result` without iterating is valid.
   * Concurrent identical streamed requests each call the provider; a streamed
   * request can still reuse an identical generate() call already in flight.
   * Await `result` before calling close(), or its usage record may be lost.
   */
  generateStream<T = unknown>(request: SavingsRequest, options?: SavingsStreamOptions): SavingsStream<T>;
  close(): void;
}
```

`generateStream` **nunca lanza de forma síncrona**. Cualquier error, incluido `LicenseError`, aparece en `result` y en el primer `next()` del iterador.

### 3.3 `src/pipeline/errors.ts` (NUEVO; reexportado con `export * from "./errors.js";` en src/pipeline/index.ts)

```ts
/**
 * Rejection of `SavingsStream.result` when the stream was aborted before the
 * provider finished its answer. Nothing was cached and no usage was recorded.
 */
export class StreamAbortedError extends Error {
  /**
   * True when a request had already been sent to the provider: the provider may
   * bill the tokens it generated before the cancel, and that cost is in no report.
   */
  readonly requestSent: boolean;
  constructor(requestSent: boolean) {
    super(
      requestSent
        ? "[bvsala] stream aborted: the provider request was cancelled before its final usage; nothing was cached or recorded"
        : "[bvsala] stream aborted before any provider request was sent",
    );
    this.name = "StreamAbortedError";
    this.requestSent = requestSent;
  }
}
```

---

## 4 · Contrato del proveedor y contabilidad

### 4.1 `src/providers/types.ts`

En `ProviderUsage`:

```ts
  /**
   * False when the provider did not report both counters for this call (for a
   * stream: its final usage event never arrived), so the adapter filled the
   * missing ones with 0. Absent means complete. A request with any such call is
   * reported as `unmeasured`.
   */
  complete?: boolean;
```

Tipos nuevos, y el método opcional en `Provider`:

```ts
/** One event of a provider-level stream. */
export type ProviderStreamEvent =
  | { type: "text"; delta: string }
  | { type: "done"; response: ProviderResponse };

export interface ProviderStreamOptions {
  /** Cancels the HTTP request. */
  signal?: AbortSignal;
}

export interface Provider {
  readonly id: string;
  generate(req: ProviderRequest): Promise<ProviderResponse>;
  /**
   * Optional streaming variant of generate(). It must yield `text` events in
   * order and end with exactly one `done` whose `response` is what generate()
   * would have returned for the same answer: `response.text` equals the
   * concatenated deltas, and tool calls travel only in `response.toolCalls`.
   * When the provider's final usage event is missing, both counters are 0 and
   * `usage.complete` is false. A body that ends before the provider signalled
   * completion must throw, never yield `done`.
   */
  generateStream?(req: ProviderRequest, options?: ProviderStreamOptions): AsyncIterable<ProviderStreamEvent>;
}
```

Es opcional porque más de 30 tests (clases que implementan `Provider` o literales `{ id, generate }`) deben compilar sin cambios.

### 4.2 Los adaptadores marcan `complete: false` también en `generate()`

- `openai-compatible.ts` en `leer()` (≈443): dentro de `usage`, `...(inputAbsent || outputAbsent ? { complete: false } : {})`.
- `anthropic.ts` en `leer()` (≈613): dentro de `usage`, `...(entradaAusente || salidaAusente ? { complete: false } : {})`.
- Cuando el usage es completo, la clave **no aparece**: proveedor-anthropic.test.ts:275 compara `toEqual({ inputTokens: 123, outputTokens: 7 })`.

Esto cambia a propósito un caso borde de `generate()`: un usage parcial (por ejemplo `prompt_tokens` sin `completion_tokens`) hoy sale `measured` con salida 0 y pasa a salir `unmeasured`. Es el principio aplicado. No hay ningún test que fije el comportamiento anterior (lo he comprobado con grep de `unmeasured` en test/).

### 4.3 `src/tokenizer/accounting.ts`

Campo nuevo en `SavingsLedger`, junto a `repairInput`:

```ts
  /**
   * Billed provider calls in this request that came back WITHOUT a complete
   * usage counter (`usage.complete === false`). Any value above zero makes the
   * request `unmeasured`: a figure built on a missing counter is not the
   * provider's meter.
   */
  callsWithoutUsage = 0;
```

En `estimateCost`, la guarda va **la primera** dentro de `if (ranCall)` (accounting.ts:306):

```ts
    if (ranCall) {
      if (this.callsWithoutUsage > 0) {
        this.baselineInput = 0;
        basis = "unmeasured";
      } else if (this.actualInput > 0 && this.sentInputLocal > 0) {
        …                      // sin cambios
```

Aritmética: con `baselineInput = 0` queda `baseline = precioEntrada(0) + baselineOutputHonesto·out ≤ actual`, luego `netSavings ≤ 0`. Nunca se publica un ahorro positivo.

Coordinación con el Frente 1, que también toca `estimateCost`: esta guarda tiene que quedar como primera comprobación dentro de `ranCall`, sean cuales sean las reglas nuevas del Frente 1.

### 4.4 Cómo llega el contador al ledger (pipeline.ts)

- `interface TestigoDeFacturacion` (pipeline.ts:120) gana `sinContador: number`. Hay que actualizar los dos literales: 438 y el valor por defecto de 1007 → `{ llamadas: 0, falloDelProveedor: false, sinContador: 0 }`.
- `llamarProveedor` (478-489): tras obtener la respuesta, `if (r.usage.complete === false) testigo.sinContador += 1;`. Lo mismo en `llamarProveedorEnStream`. Así quedan cubiertas la primaria, la escalada, la reparación, el sondeo y la muestra sombra, porque todas pasan por ahí.
- En `expensivePath`, justo antes de `const result = this.finish<T>(` (2733): `ledger.callsWithoutUsage = testigo.sinContador;`.
- En `failOpenDirect` (3307+), tras la llamada de 3340: `if (response.usage.complete === false) ledger.callsWithoutUsage = 1;`.
- En la verja de prefijo (2124-2154), sustituir `if (marcado.marcar) {` por:
  ```ts
  if (marcado.marcar && usoDeLaLlamadaMarcada.complete === false) {
    trace.record("prefix-cache", "not measured: the provider reported no usage for this call");
  } else if (marcado.marcar) {
    …                                   // bloque actual, intacto
  }
  ```
  Así una llamada sin contador no apunta «0 leídos» y no apaga la verja para esa huella.

---

## 5 · Cambios por fichero en el SDK

### 5.1 `src/providers/sse.ts` (NUEVO, interno)

No se reexporta desde src/providers/index.ts. Ni `import` de `node:` ni `Buffer`: solo `TextDecoder`, porque el fichero va al bundle web.

```ts
export interface SseMessage { event: string; data: string; id?: string }   // event: "message" si no vino
export class SseParser {
  push(chunk: string | Uint8Array): SseMessage[];
  end(): SseMessage[];
}
export async function* sseMessages(source: ReadableStream<Uint8Array> | string): AsyncGenerator<SseMessage>;
```

Comportamiento (WHATWG EventSource):

- Líneas separadas por `\r\n`, `\n` o `\r`. Un `\r` al final de un chunk seguido de `\n` al principio del siguiente cuenta como una sola ruptura (estado `crPendiente`).
- Una línea que empieza por `:` es comentario. `campo:valor` quita un único espacio inicial; una línea sin `:` es un campo con valor "".
- `data` acumula con `\n`. `event` fija el tipo. `id` se guarda. `retry` y los campos desconocidos se ignoran.
- La línea en blanco despacha el mensaje si hay data (sin la `\n` final) y reinicia `event`.
- `Uint8Array` se decodifica con `TextDecoder("utf-8")` y `{ stream: true }`, de modo que no se parte un carácter multibyte.
- `end()` vacía el decodificador y despacha el mensaje pendiente aunque falte la línea en blanco final.
- `sseMessages`: con un `string`, `push` y `end` directos. Con un `ReadableStream`, `getReader()` y bucle `read()`. En el `finally`, `reader.cancel()` envuelto en try/catch, para liberar la conexión si el consumidor sale antes.

### 5.2 `src/providers/openai-compatible.ts`

- Campo nuevo `private streamOptionsRejected = false;`, con comentario `//` en inglés. Es una propiedad del ENDPOINT, no del modelo, así que un booleano basta.
- `enviar(model, req, nativo, stream?: { includeUsage: boolean; signal?: AbortSignal })`. Si llega `stream`: `body["stream"] = true`; si `includeUsage`, `body["stream_options"] = { include_usage: true }`; y `fetchImpl(url, { …, signal: stream.signal })`. Sin `stream`, el cuerpo es idéntico al de hoy.
- Método público nuevo, con JSDoc en inglés ASCII:

```ts
  /**
   * Streaming variant of generate() over Chat Completions. It always asks for
   * the final usage chunk (`stream_options.include_usage`); an endpoint that
   * rejects that option is retried once without it and remembered, and its
   * streamed answers then report `usage.complete: false`. With `requireUsage`,
   * that rejection throws instead. Requests with an output contract or a
   * deferrable tier are not streamed: they are served by generate() and yielded
   * as one text event.
   */
  async *generateStream(req: ProviderRequest, options: ProviderStreamOptions = {}): AsyncGenerator<ProviderStreamEvent, void, undefined>
```

Algoritmo:

1. Si `req.schema != null || req.deferrable === true`: `const r = await this.generate(req)`; si `r.text !== ""`, `yield { type: "text", delta: r.text }`; luego `yield { type: "done", response: r }`; `return`.
2. `model = quitarPrefijoDeProveedor(…)`; `let conUso = !this.streamOptionsRejected`; `let response = await this.enviar(model, req, false, { includeUsage: conUso, signal })`.
3. Si `!response.ok && conUso && (status === 400 || status === 422)`: `detalle = await safeText(response)`. Si `status === 422 || /stream_options|include_usage/i.test(detalle)`:
   - con `this.opts.requireUsage`, `throw new Error(\`provider ${status}: this endpoint rejects stream_options, so a streamed answer would carry no usage and requireUsage is set. ${detalle}\`)`;
   - si no: `streamOptionsRejected = true`, luego `avisarUnaVez(\`sin-stream-options:${this.opts.baseUrl}\`, "[bvsala] This endpoint rejects \`stream_options\`, so streamed answers from it carry no usage: they are reported as \`unmeasured\` and never billed. Use \`generate()\` for a measured figure, or an endpoint that reports usage when streaming.")`, y se reenvía sin `stream_options`. Un 400/422 se rechaza antes de generar nada, así que no se consumen tokens (es el mismo razonamiento que openai-compatible.ts:190-205).
   - En cualquier otro 4xx de este paso: `throw new Error(\`provider ${status}: ${detalle}\`)`.
4. `!response.ok` → `throw new Error(\`provider ${status}: ${await safeText(response)}\`)`.
5. Fuente: `response.body` si tiene `getReader`; si no, `await response.text()`. Se itera `sseMessages`. Por cada mensaje:
   - `data === "[DONE]"` → `vioDone = true; break`.
   - Si `JSON.parse` falla, se ignora el mensaje.
   - `json.error` → `throw new Error(\`provider stream error: ${json.error.message ?? JSON.stringify(json.error)}\`)`.
   - `c = json.choices?.[0]`. Si `c.delta.content` es string no vacío: acumular y `yield { type: "text", delta }`.
   - `c.delta.tool_calls[]`: acumular por `index` en un `Map<number, {id?, name?, args}>`. El `id` y el `name` que cuentan son el **primero no vacío que aparezca**; los nombres no se concatenan. `function.arguments` sí se concatena.
   - `c.finish_reason != null` → `finishReason`. Un `json.usage` que sea objeto no nulo → `uso`. Un `json.service_tier` string no vacío → `servedServiceTier`.
6. Al terminar, `finishReason === undefined` → `throw new Error("provider stream ended before completion (no finish_reason)")`.
7. `usage`: igual que en `leer()`, con `inputTokens = uso?.prompt_tokens ?? 0`, `outputTokens = uso?.completion_tokens ?? 0`, `cachedInputTokens` si `prompt_tokens_details.cached_tokens != null`, y `complete: false` si falta alguno de los dos contadores. Con `requireUsage` y un contador ausente, se lanza el mismo error `provider returned incomplete usage (...)` que usa `leer()`.
8. `toolCalls`: se ordenan por `index` y se mapean a `{ …(id ? {id} : {}), name, arguments }` con `.filter(name !== "")`.
9. `yield { type: "done", response: { text, …(toolCalls.length ? {toolCalls} : {}), finishReason, …(servedServiceTier ? {servedServiceTier} : {}), usage, structuredNatively: false, raw: uso ?? null } }`.

`generate()` solo cambia en `complete: false` (§4.2). Los avisos en castellano de este fichero (206-214, 322-329) son del Frente 4 y no se tocan aquí.

### 5.3 `src/providers/anthropic.ts`

JSDoc público análogo al de §5.2, pero terminando en «…Requests with an output contract or declared deferrable are served by generate() and yielded as one text event.». Así la herramienta `bvsala_contract` nunca aparece en un stream.

```ts
  async *generateStream(req: ProviderRequest, options: ProviderStreamOptions = {}): AsyncGenerator<ProviderStreamEvent, void, undefined>
```

1. Si `req.schema != null || req.deferrable === true`, delega en `generate()` igual que en §5.2.1.
2. `const { body } = this.construirCuerpo(req); body["stream"] = true;`. Mismo `fetch` que `generate()` (anthropic.ts:138-150), más `signal`. `!ok` → `throw new Error(\`provider ${status}: ${await safeText(response)}\`)`.
3. Se procesa `sseMessages` con el tipo `msg.event`; si falta, se usa `data.type`:
   - `message_start` → `usoInicio = data.message?.usage`.
   - `content_block_start` → `bloques.set(data.index, { tipo: data.content_block.type, id, name, json: "" })`.
   - `content_block_delta`: si `delta.type === "text_delta"`, acumular y `yield text`; si es `"input_json_delta"`, `bloque.json += delta.partial_json`; los demás tipos (thinking, signature, citations) se ignoran.
   - `message_delta` → `vioDelta = true`, `stopReason = data.delta?.stop_reason ?? stopReason`, `usoDelta = { ...usoDelta, ...data.usage }`.
   - `message_stop` → `vioStop = true; break`.
   - `error` → `throw new Error(\`provider stream error: ${data.error?.type}: ${data.error?.message}\`)`.
   - `ping` y cualquier otro evento se ignoran.
4. `!vioStop && !vioDelta` → `throw new Error("provider stream ended before completion (no message_delta)")`.
5. `merged`: el delta pisa los escalares y `cache_creation` se fusiona como en `ObservadorSse` (medidor.ts:77-81). La función se escribe dentro de anthropic.ts; el observador del gateway no se toca.
   - Si no hubo `message_delta`: `usage = { inputTokens: 0, outputTokens: 0, complete: false }`.
   - Si hubo: `inputTokens = (merged.input_tokens ?? 0) + (merged.cache_creation_input_tokens ?? 0) + (merged.cache_read_input_tokens ?? 0)`, `outputTokens = usoDelta.output_tokens ?? 0`, `cachedInputTokens` y `cacheWriteInputTokens` como en `leer()`, y `complete: false` si `typeof merged.input_tokens !== "number" || typeof usoDelta?.output_tokens !== "number"`.
   - Con `requireUsage` y usage incompleto, se lanza el mismo mensaje que en 593-600.
6. `toolCalls`: los bloques `tool_use` con `name !== HERRAMIENTA_DE_CONTRATO`, en orden de `index`. `arguments` es `JSON.stringify(JSON.parse(json === "" ? "{}" : json))`, o `json` crudo si no parsea (un corte por `max_tokens` llega con `finishReason: "length"`). Se filtran los que tengan `name === ""`.
7. `yield done` con `{ text, toolCalls?, finishReason: stopReason ? traducirParada(stopReason) : undefined, servedServiceTier: merged.service_tier?, usage, structuredNatively: false, raw: { usage: merged, stop_reason: stopReason } }`.

Métodos privados con comentarios `//`. Recuerda: el JSDoc de un `private` también se emite al `.d.ts` (anthropic.ts:160-163).

### 5.4 `src/providers/mock.ts`

- `MockProviderOptions.streamChunkChars?: number`, con JSDoc «Characters per text event in generateStream (default 8).».
- Método nuevo:
  ```ts
  async *generateStream(req: ProviderRequest): AsyncGenerator<ProviderStreamEvent, void, undefined> {
    const r = await this.generate(req);
    const n = Math.max(1, this.options.streamChunkChars ?? 8);
    for (let i = 0; i < r.text.length; i += n) yield { type: "text", delta: r.text.slice(i, i + n) };
    yield { type: "done", response: r };
  }
  ```
  Con esquema, el pipeline no lo llama porque entrega «whole».

### 5.5 `src/cache/singleflight.ts`

```ts
  /**
   * The in-flight execution under `key`, if one is running, joined as a
   * follower; `undefined` when nothing is in flight. Never starts one.
   */
  join<T>(key: string): Promise<T> | undefined {
    const existing = this.inflight.get(key) as Promise<T> | undefined;
    if (existing) this.waiters.set(key, (this.waiters.get(key) ?? 1) + 1);
    return existing;
  }
```

`run()` no cambia, así que singleflight-concurrencia.test.ts queda intacto. Si una subclase inyectada sobrescribe `run()`, `join()` devuelve `undefined` y la petición en stream simplemente ejecuta la suya: el peor caso es seguro.

### 5.6 `src/pipeline/stream.ts` (NUEVO, interno; no se reexporta)

```ts
export type MotivoEntero = NonNullable<StreamingReport["wholeReason"]>;

export interface SumideroDeStream {
  readonly senal: AbortSignal;       // señal del AbortController interno
  texto(delta: string): void;        // reenvía un delta (ignora "" y lo que llegue tras abort)
  proveedorTermino(): void;          // el proveedor entregó su evento final: abort ya no cancela
  sirvioEnVivo: boolean;             // true si la primaria se sirvió por generateStream
}

export class CanalDeStream<T> {
  constructor(now: () => number, senalExterna?: AbortSignal);
  readonly handle: SavingsStream<T>;
  readonly sumidero: SumideroDeStream;
  get abortado(): boolean;
  entrarEnVivo(): void;
  completar(result: SavingsResult<T>, entrega: { vivo: boolean; motivo?: MotivoEntero }): void;
  fallar(err: unknown): void;
}
```

Semántica:

- **Construcción.** `inicio = now()`. Un `AbortController` interno. El `diferido` de `result` lleva `promise.catch(() => {})` enganchado **por dentro** para que no haya rechazos sin manejar; el llamante que haga `await` sigue viendo el rechazo. Si `senalExterna.aborted` → `abort()`; si no, `senalExterna.addEventListener("abort", () => abort(senalExterna.reason), { once: true })`.
- **Cola.** Sin tope, un solo consumidor. `handle[Symbol.asyncIterator]()` lanza `Error("[bvsala] a SavingsStream can be iterated only once")` en la segunda llamada. `next()`: si hay evento, lo entrega; si la cola está cerrada y vacía, `{done: true}`; si falló, rechaza **una vez** con el error y después devuelve `{done: true}`. `return()` llama a `abort()` y devuelve `{done: true}`.
- **`abort(reason)`.** Si ya se entregó `done`, no hace nada. Si no: `abortado = true`, cierra la cola, y si `vivo && !proveedorTerminado` ejecuta `controlador.abort(reason)`.
- **`sumidero.texto(d)`.** Si `d === ""` o `abortado`, no hace nada. En el primer delta fija `primerEventoAt = now()`. Encola `{type: "text", delta: d}`.
- **`completar(result, {vivo, motivo})`.**
  1. `primer = primerEventoAt ?? ((vivo && (result.toolCalls?.length ?? 0) > 0) ? now() : undefined)`.
  2. `streaming = vivo ? { delivery: "live", ...(primer !== undefined ? { firstEventMs: primer - inicio } : {}) } : { delivery: "whole", wholeReason: motivo }`.
  3. `final = { ...result, report: { ...result.report, streaming } }`. **Nunca se muta `result`**: puede ser el `value` compartido de un singleflight.
  4. `diferido.resolve(final)`.
  5. Si `!abortado`: si `!vivo && final.text !== ""`, encola `text(final.text)`; encola un `tool_call` por cada `final.toolCalls`; encola `{type: "done", result: final}`.
  6. Cierra la cola y marca `terminado = true`.
- **`fallar(err)`.** `diferido.reject(err)`. Si `abortado`, cierra la cola; si no, la cola falla con `err`. Marca `terminado = true`.

### 5.7 `src/pipeline/pipeline.ts`

1. **Imports:** `CanalDeStream`, `SumideroDeStream`, `MotivoEntero` de `./stream.js`; `StreamAbortedError` de `./errors.js`; tipos `SavingsStream`, `SavingsStreamOptions` de contracts.
2. **Método nuevo** (la clase no se exporta, así que el nombre no llega al `.d.ts`):
   ```ts
   generateStream<T = unknown>(request: SavingsRequest, options: SavingsStreamOptions = {}, antes?: Promise<unknown>): SavingsStream<T> {
     const canal = new CanalDeStream<T>(this.now, options.signal);
     void this.ejecutarStream<T>(request, canal, antes);
     return canal.handle;
   }

   private async ejecutarStream<T>(request: SavingsRequest, canal: CanalDeStream<T>, antes?: Promise<unknown>): Promise<void> {
     try {
       if (antes) await antes;
       if (canal.abortado) throw new StreamAbortedError(false);
       const motivo = this.motivoDeEntregaEntera(request);
       if (motivo) {
         const r = await this.generate<T>(request);        // idéntico a hoy
         canal.completar(r, { vivo: false, motivo });
         return;
       }
       this.assertLicensed();
       canal.entrarEnVivo();                                 // síncrono tras la comprobación de abort
       const testigo: TestigoDeFacturacion = { llamadas: 0, falloDelProveedor: false, sinContador: 0 };
       let r: SavingsResult<T>;
       try {
         r = await this.generateOptimized<T>(request, testigo, canal.sumidero);
       } catch (err) {
         if (err instanceof LicenseError || err instanceof StreamAbortedError) throw err;
         if (canal.sumidero.senal.aborted) throw new StreamAbortedError(testigo.llamadas > 0);
         if (this.config.failOpen === false) throw err;
         if (testigo.falloDelProveedor || testigo.llamadas > 0 || errorYaFacturado(err)) throw err;
         const rescate = await this.failOpenDirect<T>(request, err);
         canal.completar(rescate, { vivo: false, motivo: "fail-open" });
         return;
       }
       canal.completar(r, canal.sumidero.sirvioEnVivo ? { vivo: true } : { vivo: false, motivo: "shortcut" });
     } catch (err) {
       canal.fallar(err);
     }
   }

   private motivoDeEntregaEntera(request: SavingsRequest): MotivoEntero | null {
     if (request.response?.schema != null) return "output-contract";
     if (request.savings?.deferrable === true) return "deferrable";
     if (typeof this.config.provider.generateStream !== "function") return "provider-without-streaming";
     return null;
   }
   ```
3. **`llamarProveedorEnStream`**, el hermano de `llamarProveedor`:
   ```ts
   private async llamarProveedorEnStream(req: ProviderRequest, testigo: TestigoDeFacturacion, sumidero: SumideroDeStream): Promise<ProviderResponse> {
     if (sumidero.senal.aborted) throw new StreamAbortedError(testigo.llamadas > 0);
     testigo.llamadas += 1;
     let enviado = "";
     let final: ProviderResponse | undefined;
     try {
       for await (const ev of this.config.provider.generateStream!(req, { signal: sumidero.senal })) {
         if (ev.type === "text") { if (ev.delta !== "") { enviado += ev.delta; sumidero.texto(ev.delta); } }
         else if (ev.type === "done") { final = ev.response; break; }
       }
     } catch (err) {
       if (sumidero.senal.aborted) throw new StreamAbortedError(true);
       testigo.falloDelProveedor = true;
       throw err;
     }
     if (!final) {
       testigo.falloDelProveedor = true;
       throw new Error(`provider "${this.config.provider.id}" stream ended without a final response`);
     }
     sumidero.proveedorTermino();
     if (final.usage.complete === false) testigo.sinContador += 1;
     if (final.text !== enviado) {
       this.avisar(`stream-texto-distinto:${this.config.provider.id}`,
         `[bvsala] provider "${this.config.provider.id}" streamed text that differs from its final response; ` +
         "the streamed text is what the caller received, so it is what is reported and cached. Its generateStream " +
         "must end with a done whose response.text equals the concatenated deltas.");
       final = { ...final, text: enviado };
     }
     sumidero.sirvioEnVivo = true;
     return final;
   }
   ```
4. **`generateOptimized`** (1003): tercer parámetro `sumidero: SumideroDeStream | null = null`, que se pasa a `expensivePath` como último argumento. paywall-surface.test.ts llama con un solo argumento, así que sigue compilando.
5. **Etapa 3** (1148-1159), dentro de `if (policy.allowSingleflight && toggles.singleflight !== false)` y antes del `run` actual:
   ```ts
   if (sumidero) {
     const enVuelo = this.deps.singleflight.join<SavingsResult<T>>(inflightKey);
     if (enVuelo) {
       const value = await enVuelo;
       trace.record("singleflight", "coalesced", { key: inflightKey });
       return this.asCoalescedFollower<T>(value, baselineInput, this.tokensFor(value.text ?? "", request), costModel, request);
     }
     trace.record("singleflight", "skipped (streaming: a streamed request never leads)");
     return runExpensive();
   }
   ```
6. **`expensivePath`**: nuevo último parámetro `sumidero: SumideroDeStream | null`. El único uso es la primaria (1931):
   ```ts
   const argsPrimaria = { model: cascada.modeloServido, ...peticionAlProveedor, ...(marcado.marcar ? { stablePrefixMessages: marcado.mensajesDePrefijo, promptCacheKey: marcado.huella } : {}) };
   let response = sumidero
     ? await this.llamarProveedorEnStream(argsPrimaria, testigo, sumidero)
     : await this.llamarProveedor(argsPrimaria, testigo);
   ```
   Escalada, reparación, sondeo y muestra siguen con `llamarProveedor`. En «live» no hay esquema, así que ninguna de ellas se alcanza salvo el sondeo, que no se streamea.
7. **`asCoalescedFollower`** (3439): `const { deferred: _delLider, streaming: _streamingDelLider, ...informeDelLider } = leader.report;`.
8. §4.4: `sinContador`, `callsWithoutUsage` y la verja de prefijo.

Con `sumidero === null`, `generate()` queda byte a byte igual, salvo §4.2 y §4.4, que son cambios de contabilidad deliberados.

### 5.8 `src/pipeline/create.ts`

- Se extrae el texto del aviso `tokenizador-exacto-ausente` (294-301) a `const AVISO_TOKENIZADOR = "..."` y se usa en los dos métodos.
- En el literal (282-317):
  ```ts
  generateStream: <T = unknown>(request: SavingsRequest, options?: SavingsStreamOptions): SavingsStream<T> => {
    const stream = pipeline.generateStream<T>(request, options ?? {}, exactoListo);
    void stream.result.then(
      async (result) => {
        if (emitter) {
          try { emitter.record(result.report); } catch { /* metering must never affect the caller */ }
        }
        const exacto = await exactoListo;
        if (!exacto && config.silenceWarnings !== true && MODELOS_CON_EXACTO.has(request.model)) {
          avisarUnaVez("tokenizador-exacto-ausente", AVISO_TOKENIZADOR);
        }
      },
      () => {},
    );
    return stream;
  },
  ```
- El método se añade a la interfaz `SavingsLayer` con el JSDoc de §3.2.

### 5.9 Exports

- `src/contracts/types.ts` ya se reexporta entero, así que los tipos nuevos se publican solos.
- `src/providers/types.ts` también se reexporta entero.
- `src/pipeline/index.ts` gana `export * from "./errors.js";`.
- `sse.ts` y `stream.ts` **no** se reexportan.

Nombres nuevos en el `.d.ts`: `SavingsStreamEvent`, `SavingsStreamOptions`, `SavingsStream`, `StreamingReport`, `StreamAbortedError`, `ProviderStreamEvent`, `ProviderStreamOptions`. Ninguno casa `/(CION|cion|Codificador|Modelos|registrar|silenciar|avisos)/` ni lleva letras acentuadas.

---

## 6 · Gateway

Nada de licencias en este frente. El dialecto nuevo cuelga del mismo `emisor` que `/v1/messages` (servidor.ts:208-233), así que la verja que decida el Frente 3 lo cubre sin trabajo extra.

### 6.1 `gateway/medidor.ts`

`ObservadorSse`, `ObservadorResponses` y `usoDeJson` **no se tocan**. Se añade lo siguiente:

```ts
import { SseParser } from "../src/providers/sse.js";

interface UsoChat {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
}

/** usage de Chat Completions → UsoSse; null si falta alguno de los dos contadores. */
export function mapearUsoChat(u: UsoChat | null | undefined): UsoSse | null {
  if (!u || typeof u.prompt_tokens !== "number" || typeof u.completion_tokens !== "number") return null;
  return mapearUsoResponses({
    input_tokens: u.prompt_tokens,
    output_tokens: u.completion_tokens,
    input_tokens_details: { cached_tokens: u.prompt_tokens_details?.cached_tokens, cache_write_tokens: u.prompt_tokens_details?.cache_write_tokens },
  });
}

/** Observa `chat.completion.chunk` sin tocar bytes. */
export class ObservadorChatCompletions {
  readonly eventos: Record<string, number> = {};
  observar(chunk: Buffer | string): void;
  usage(): UsoSse | null;        // === usageFinal()
  usageFinal(): UsoSse | null;
}
```

Reglas de `ObservadorChatCompletions`:

- Por cada mensaje: `data === "[DONE]"` → `vioDone = true` y `eventos.done++`. Si no es JSON, se ignora. Si lo es: `eventos.chunk++`; un `usage` no nulo con `mapearUsoChat(usage) !== null` → `ultimoUso = mapeado`; y si además `Array.isArray(choices) && choices.length === 0`, `vioUsoFinal = true`.
- `usageFinal()` devuelve `(vioUsoFinal || vioDone) ? ultimoUso : null`.

Qué cubre esa regla: OpenAI con `include_usage` (chunk con `choices: []` y usage, luego `[DONE]`); vLLM con uso continuo (solo cuenta si se llegó a `[DONE]` o al chunk final); un abort a mitad (`null`); y el primer chunk de Azure (`choices: []` con `prompt_filter_results` y sin usage), que no afecta.

```ts
/** usage de una respuesta JSON según el dialecto de la ruta; null si no hay dialecto o no hay contadores. */
export function usoDeJsonPorRuta(path: string, cuerpo: Buffer | string): UsoSse | null {
  if (path === "/v1/messages") return usoDeJson(cuerpo);
  try {
    const d = JSON.parse(typeof cuerpo === "string" ? cuerpo : cuerpo.toString("utf8")) as { usage?: unknown };
    if (path.endsWith("/chat/completions")) return mapearUsoChat(d.usage as UsoChat);
    if (path.endsWith("/responses")) {
      const u = d.usage as UsoResponses | undefined;
      return u && typeof u.input_tokens === "number" && typeof u.output_tokens === "number" ? mapearUsoResponses(u) : null;
    }
  } catch { /* ilegible */ }
  return null;
}

/** ¿La ruta tiene dialecto de usage? */
export function tieneDialecto(path: string): boolean {
  return path === "/v1/messages" || path.endsWith("/chat/completions") || path.endsWith("/responses");
}

export type InyeccionDeUso =
  | { cuerpo: Buffer; motivo: "inyectado" }
  | { cuerpo: null; motivo: "comprimido" | "ilegible" | "no-stream" | "ya-lo-pide" | "cliente-decide" };

/**
 * Añade `"stream_options":{"include_usage":true},` justo tras la `{` inicial,
 * SIN reserializar: los números, el orden y los espacios del cliente viajan
 * intactos. Solo cuando el cuerpo va sin comprimir, stream === true y el
 * cliente no mandó stream_options.
 */
export function inyectarIncludeUsage(cuerpo: Buffer, codificacion?: string): InyeccionDeUso;

/** true / false: la petición es stream y pide / no pide include_usage. null: no es stream o no se puede leer. */
export function pideUsoEnStream(cuerpo: Buffer, codificacion?: string): boolean | null;
```

Reglas de `inyectarIncludeUsage`, en este orden:

1. `codificacion` definida, no vacía y distinta de `"identity"` → `comprimido`.
2. `JSON.parse(utf8)` falla o no es un objeto → `ilegible`.
3. `stream !== true` → `no-stream`.
4. `stream_options?.include_usage === true` → `ya-lo-pide`.
5. `stream_options !== undefined` → `cliente-decide`: se respeta cualquier objeto del cliente, incluido `{}` o `include_usage: false`.
6. Localizar el índice `i` del primer carácter que no sea espacio ni BOM. Tiene que ser `{`; si no, `ilegible`. Devolver `Buffer.concat([cuerpo.subarray(0, i + 1), Buffer.from('"stream_options":{"include_usage":true},'), cuerpo.subarray(i + 1)])`. La coma es válida porque el objeto contiene al menos `stream`.

`pideUsoEnStream` usa `jsonDelCuerpo(cuerpo, codificacion)` (medidor.ts:360): devuelve `null` si `stream !== true`, y si no `stream_options?.include_usage === true`.

### 6.2 `gateway/servidor.ts`

1. `OpcionesGateway.usageInject?: boolean`, por defecto `false`. Comentario: «opt-in: añade include_usage a chat/completions en stream sin stream_options (BVSALA_GATEWAY_USAGE_INJECT=1)».
2. `observadorPara` (273-277) gana un caso: `if (pathname.endsWith("/chat/completions")) return new ObservadorChatCompletions();`. Su tipo de retorno y el de `let observador` (410) pasan a `ObservadorSse | ObservadorResponses | ObservadorChatCompletions | null`.
3. Estado del proceso, dentro de `arrancarGateway`: `let endpointSinStreamOptions = false;`.
4. **Réplica coalescida** (491-492): `const usoReplica = obs.usageFinal() ?? usoDeJsonPorRuta(url.pathname, Buffer.concat(replica.chunks));`. Si `usoReplica === null` y hay emisor, se escribe la línea de `noMedido` (punto 11), sin aviso, y no se llama a `medir`.
5. **Inyección**, tras la palanca de TARIFA (≈680) y antes del `fetch`:
   ```ts
   let inyectado = false;
   const esChat = req.method === "POST" && url.pathname.endsWith("/chat/completions");
   if (esChat && emisor && opts.usageInject === true && !endpointSinStreamOptions) {
     try {
       const r = inyectarIncludeUsage(cuerpo, codificacion);
       if (r.cuerpo) { cuerpoSaliente = r.cuerpo; inyectado = true; }
     } catch { /* passthrough */ }
   }
   ```
   La medición y la clave de coalescencia siguen usando `cuerpo`, el original. `h` no lleva `content-length` (se descarta al copiar las cabeceras), así que no hay que recalcularlo.
6. **Reintento intacto** (715):
   ```ts
   const rechazoDeNuestroCambio =
     ((hermano !== null || esfuerzoPuesto) && upstream.status === 400) ||
     (inyectado && (upstream.status === 400 || upstream.status === 422));
   if (rechazoDeNuestroCambio && !ac.signal.aborted) { …
   ```
   El log del bloque, cuando `inyectado`, pasa a ser `[gateway] the upstream rejected (${status}) the request with stream_options.include_usage added; forwarding it unchanged · ${motivo}`. Hay que conservar la forma actual para hermano y esfuerzo. Tras el reenvío, si hubo inyección y `upstream.ok`: `endpointSinStreamOptions = true`, luego `avisarUnaVez("gateway-sin-stream-options", "[bvsala gateway] the upstream rejects stream_options, so usage injection is off for the rest of this process: streamed /v1/chat/completions answers from it are forwarded but NOT metered (stream=false answers still are).")`. En todos los casos, `inyectado = false`.
7. **`esSse`** (759): el supuesto «sin content-type ⇒ SSE» queda restringido a los dos dialectos de hoy:
   `tipo.includes("text/event-stream") || (tipo === "" && upstream.ok && observadorPara(url.pathname) !== null && !url.pathname.endsWith("/chat/completions"))`.
8. **`esJsonMedible`** (766-772): `url.pathname === "/v1/messages"` pasa a ser `tieneDialecto(url.pathname)`. El resto de condiciones no cambia.
9. **Rama de stream** (793-808): `const uso = observador.usageFinal();` en lugar de `usage()`.
   - `uso === null && emisor` → `noMedido(...)` con motivo: si `observador instanceof ObservadorChatCompletions` y `!(inyectado || pideUsoEnStream(cuerpo, codificacion) === true)`, `"the request did not ask for usage (stream_options.include_usage)"`; en cualquier otro caso, `"the stream ended without the provider's final usage event"`.
   - Si no, `medir(...)` como hoy.
   - La línea `not metered: no BIVELIO_SERVICE_KEY` sin emisor no cambia.
10. **Rama JSON** (809-812): `const uso = usoDeJsonPorRuta(url.pathname, respuesta);`. `elisionDeJson` solo aplica si la ruta es `/v1/messages`; en las demás es `null`. Con `uso === null` → `noMedido(..., "the response carried no usage")`.
11. **Helper local:**
    ```ts
    const noMedido = (metodo: string, path: string, status: number, stream: boolean, motivo: string, aviso: "chat" | "uso" | "dialecto" | null): void => {
      log(`[gateway] ${metodo} ${path} → ${status}${stream ? " (stream)" : ""} · not metered: ${motivo}`);
      if (aviso === "chat") avisarUnaVez("gateway-chat-sin-include-usage", W1);
      if (aviso === "uso") avisarUnaVez(`gateway-sin-usage:${path}`, W2(path));
      if (aviso === "dialecto") avisarUnaVez(`gateway-sin-dialecto:${path}`, W3(path));
    };
    ```
    - En el punto 9, el motivo «did not ask» usa aviso `"chat"` y el motivo «ended without…» usa `"uso"`.
    - En el punto 10, aviso `"uso"`. En la réplica (punto 4), aviso `null`.
    - **Rutas sin dialecto**, en el `else` final (812-816): si `emisor && req.method === "POST" && upstream.ok && !tieneDialecto(url.pathname) && !/\/(count_tokens|input_tokens)$/.test(url.pathname)`, entonces `noMedido(..., esSse, "no usage dialect for this route", "dialecto")`. En cualquier otro caso, la línea de hoy.
12. **Textos exactos** de los avisos, todos en inglés:
    - **W1:** `[bvsala gateway] streamed /v1/chat/completions requests without stream_options.include_usage carry no usage, so they are forwarded but NOT metered. Add stream_options={"include_usage": True} to the call (Node: stream_options: { include_usage: true }); its last chunk then has an empty choices list. Or start the gateway with BVSALA_GATEWAY_USAGE_INJECT=1 to add it for clients you cannot change.`
    - **W2(path):** `[bvsala gateway] POST ${path} answered without the provider's final usage, so it was forwarded but NOT metered. Nothing is estimated in its place.`
    - **W3(path):** `[bvsala gateway] POST ${path} is forwarded but NOT metered: the gateway reads usage from /v1/messages, …/chat/completions and …/responses only.`

### 6.3 `gateway/upstream.ts` (NUEVO, puro)

```ts
export const UPSTREAM_ALIASES: Readonly<Record<string, string>> = {
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
};

export type UpstreamResuelto =
  | { ok: true; upstream: string | undefined; origen: "flag" | "env" | "none"; aviso?: string }
  | { ok: false; error: string };

/** @param flag undefined = no se pasó `--upstream`; null = se pasó sin valor. */
export function resolverUpstream(i: { flag?: string | null; env?: string }): UpstreamResuelto;
```

Reglas:

- `flag === null` → `{ok: false, error: "[bvsala gateway] --upstream needs a value: openai, anthropic or an origin URL such as https://api.openai.com"}`.
- Valor elegido: `flag` → `origen "flag"`; si no, `env` no vacío → `origen "env"`; si no hay ninguno → `{ok: true, upstream: undefined, origen: "none"}`, y bin.ts sigue con la cadena de siempre (anillo 2, envoltorio, Anthropic).
- `valor.trim().toLowerCase()` presente en `UPSTREAM_ALIASES` → ese origen.
- Si no es alias: `new URL(valor)`. Si falla o el protocolo no es `http:`/`https:` → `{ok: false, error: \`[bvsala gateway] invalid upstream "${valor}": use openai, anthropic or an http(s) origin URL\`}`.
- Siempre se devuelve `url.origin`. Si `pathname !== "/"` o hay query o hash, se añade `aviso: \`[bvsala gateway] WARNING: the upstream path "${url.pathname}" is ignored: requests keep the path the client sends (for example /v1/chat/completions), so put that prefix in the client's base URL instead.\``. No se rechaza porque hoy `BVSALA_GATEWAY_UPSTREAM=https://api.openai.com/v1` funciona: servidor.ts:462 descarta la ruta.

### 6.4 `gateway/bin.ts`

1. **Ayuda** (58-130). La línea `gateway [--port N]` se sustituye por:
   ```
     gateway [--port N] [--upstream U]
                            Local metering proxy (default port 8402) for anything that honours a
                            base URL: Claude Code, opencode, Goose, Crush… and the official OpenAI
                            and Anthropic SDKs in any language, Python included.
                            --upstream openai | anthropic | an origin URL (default: anthropic).
                            One gateway talks to ONE upstream: run a second one on another port
                            for the other provider.
   ```
   En Environment, `BVSALA_GATEWAY_UPSTREAM` pasa a `Alternative upstream: openai | anthropic | an origin URL (default: the terminal's own). --upstream wins over it.`, y se añade tras `BVSALA_GATEWAY_COALESCE`:
   ```
     BVSALA_GATEWAY_USAGE_INJECT
                            =1 adds stream_options.include_usage to streamed /v1/chat/completions
                            requests that lack it, so they can be metered. Off by default: the last
                            chunk of those streams then has an empty choices list, which code that
                            reads choices[0] without checking does not expect.
   ```
2. **Parseo**, tras el del puerto (≈176-178):
   ```ts
   const idxUp = comando === "gateway" ? resto.indexOf("--upstream") : -1;
   const valorUp = idxUp >= 0 ? resto[idxUp + 1] : undefined;
   const flagUpstream = idxUp < 0 ? undefined : valorUp !== undefined && !valorUp.startsWith("--") ? valorUp : null;
   const up = resolverUpstream({ flag: flagUpstream, env: process.env.BVSALA_GATEWAY_UPSTREAM });
   if (!up.ok) { console.error(up.error); process.exit(1); }
   ```
   Los envoltorios no parsean `--upstream`: todos sus argumentos son del terminal, según argumentos.ts:28-31.
3. `planDeAnillo2({ …, upstreamEnv: up.upstream, … })` y `const upstreamPedido = up.upstream ?? planAnillo2.upstream;` (sustituye a 235-239).
4. `arrancarGateway({ …, ...(process.env.BVSALA_GATEWAY_USAGE_INJECT === "1" ? { usageInject: true } : {}) })`.
5. **Tras las dos líneas de arranque** (≈287):
   - Si `up.aviso`, se imprime con `console.error(up.aviso)`.
   - Si la inyección está activa: `console.log("[bvsala gateway] usage injection: ON (BVSALA_GATEWAY_USAGE_INJECT=1) — streamed chat completions without stream_options get include_usage; their last chunk has an empty choices list.")`.
6. **Aviso de override** (317-324): la condición usa `up.upstream` en lugar de la variable de entorno: `if (up.upstream && envoltorio?.upstream && up.upstream !== envoltorio.upstream)`. El texto se conserva, con `${up.upstream}`.
7. **Línea final**, cuando no hay envoltorio (≈361-365). Con `const host = new URL(upstreamEfectivo).hostname`:
   - `api.anthropic.com` → la línea de hoy.
   - `api.openai.com` → `[bvsala gateway] point your SDK at it: base_url=http://127.0.0.1:${puerto}/v1 (OpenAI SDKs) · streamed chat completions are metered when the request sets stream_options.include_usage · bvsala doctor for recipes`.
   - Cualquier otro → `[bvsala gateway] point your client at http://127.0.0.1:${puerto} plus the path prefix it already uses (for example /v1) · bvsala doctor for recipes`.

### 6.5 `gateway/doctor.ts`

No se añaden imports: el test de doctor.ts:175-187 los fija.

- `Contexto` gana `puerto: number`. `Terminal` gana `comprobar?: string` y `estadoSinDeteccion?: string`.
- En el bucle, el estado de los no detectables es `t.estadoSinDeteccion ?? "no automatic detection (editor extension)"`, y la línea de comprobación es `t.comprobar ?? COMPROBAR`.
- Dos entradas nuevas al final de `TERMINALES`, ambas con `detectable: false`, `configs: []`, sin `binario` y con `estadoSinDeteccion: "no detection: any language, through the SDK's base URL"`:

```ts
{
  id: "python-openai",
  nombre: "Python, or any OpenAI SDK (Chat Completions)",
  comprobar: "check: the gateway log must show `[gateway] POST /v1/chat/completions …`; if you see `/v1/v1/chat/completions`, there is one /v1 too many.",
  receta: ({ baseV1, puerto }) => [
    `start: bvsala gateway --upstream openai --port ${puerto}   (one gateway per upstream: if Claude Code already uses this port, pick another and change the URL below to match)`,
    `python: client = OpenAI(base_url="${baseV1}")   (WITH /v1: the SDK appends /chat/completions)`,
    `node:   const client = new OpenAI({ baseURL: "${baseV1}" })`,
    'streaming: pass stream_options={"include_usage": True} (Node: stream_options: { include_usage: true }) or the stream is forwarded but NOT metered; the last chunk then has an empty choices list, so read chunk.choices only when it is not empty.',
    "stream=False is metered from the usage in the JSON body, and so is client.responses.create. Cost is priced at the model's list price.",
  ],
},
{
  id: "python-anthropic",
  nombre: "Python, or any Anthropic SDK (Messages)",
  receta: ({ base, puerto }) => [
    `start: bvsala gateway --port ${puerto}   (Anthropic is the default upstream)`,
    `python: client = Anthropic(base_url="${base}")   (NO /v1: the SDK appends /v1/messages)`,
    `node:   const client = new Anthropic({ baseURL: "${base}" })`,
    "streamed and stream=False requests are both metered.",
  ],
},
```

Cada URL va seguida de `"`, que es lo que exige la regex del test `/http:\/\/127\.0\.0\.1:8402[^\s"]*/`. No hay ningún `8402` literal, solo `${puerto}`.

Tres líneas nuevas antes de `"Per-terminal detail: docs/terminales/<terminal>.md"`:

```
"Any language through the gateway: it measures every request whose usage it can read (Anthropic Messages, OpenAI Chat",
"Completions and Responses) for models with a list price, and its log line says when one is not metered. The saving",
"levers of the SDK (npm) are TypeScript; the gateway's own levers apply to Anthropic /v1/messages with a PRO license.",
```

---

## 7 · Copia pública

### 7.1 `README.md` (viaja a npm)

Verjas que aplican: readme-alineado (sin «does not optimi[sz]e», `€4 / seat / month` exactamente 2 veces, sin `≥ N %`); superficie-publica-limpia (sin «singleflight» ni «semantic-cache»); fragmento-instalacion (compila todos los bloques ```ts; del segundo en adelante van dentro de funciones `async`); sala-limpia (ejecuta solo el primer ```ts, que tiene que seguir siendo el de «3 · Wrap the call»).

**(a)** Tras el párrafo «That's it. From the first request…», que termina en «Only measured figures reach your invoice.»:

````markdown
**Streaming.** `generateStream()` takes the same request and hands you the answer as
the provider writes it, then the same `SavingsReport`:

```ts
const stream = layer.generateStream({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "Summarize the release notes in one line." }],
});
for await (const event of stream) {
  if (event.type === "text") process.stdout.write(event.delta);
}
const { report: streamed } = await stream.result;
console.log(streamed.cost.basis);          // same rules as generate(), read from the provider's final usage
console.log(streamed.streaming?.delivery); // "live", or "whole" when the answer arrived in one piece
```

The SDK asks the provider for its final usage at the end of every stream (on
OpenAI‑compatible endpoints, `stream_options.include_usage`); a stream that ends
without it is reported as `unmeasured` and never billed. With an output contract, or
a request declared `deferrable`, the answer is produced exactly as `generate()` would
and arrives as a single `text` event. Breaking out of the loop cancels the request;
`await stream.result` tells you whether it completed.
````

**(b)** Tras el párrafo de terminales («…until you switch them on.», README l.76):

````markdown
**Python, or any other language?** The same gateway sits in front of any SDK that
lets you set a base URL:

```bash
bvsala gateway --upstream openai --port 8403   # one gateway per upstream
bvsala gateway                                 # Anthropic, the default, on 8402
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8403/v1")   # WITH /v1
stream = client.chat.completions.create(
    model="gpt-4o-mini", messages=[{"role": "user", "content": "Hi"}], stream=True,
    stream_options={"include_usage": True},  # without it a stream carries no usage and is not metered
)
for chunk in stream:
    if chunk.choices:  # the last chunk carries only the usage
        print(chunk.choices[0].delta.content or "", end="")

from anthropic import Anthropic
claude = Anthropic(base_url="http://127.0.0.1:8402")    # NO /v1
```

With `BIVELIO_SERVICE_KEY` set, the gateway measures every request whose usage the
provider reports — Anthropic Messages, OpenAI Chat Completions and Responses, streamed
or not — priced at the model's list price, and its log line says when one is not
metered. That is measurement, not savings: the saving levers of the SDK are TypeScript,
and the gateway's own levers apply to Anthropic `/v1/messages` traffic with a PRO
license. `bvsala doctor` prints the recipe for each SDK.
````

Requirements: sin cambios. `ReadableStream`, `TextDecoder` y `AbortSignal` son globales desde Node 18 y el paquete exige ≥ 20.

### 7.2 `docs/terminales/README.md` (viaja en el tarball)

**No se tocan las líneas 10-22 ni 51-68**: son la zona del Frente 3 (licencia y arranque).

Fila nueva en el índice (tras la de Kilo, línea 36):

```
| [Python y cualquier SDK](../../README.md#python-and-any-other-language) (OpenAI · Anthropic) | OpenAI: `http://127.0.0.1:8403/v1` · Anthropic: `http://127.0.0.1:8402` | OpenAI **con**, Anthropic **sin** | `base_url` del SDK | `bvsala gateway --upstream openai` | [V] en test (upstream falso) |
```

Al final del párrafo de las líneas 70-73 se añade: «Desde 0.4.23, `bvsala gateway --upstream openai|anthropic|<origen>` lo elige sin variable de entorno (el flag manda sobre `BVSALA_GATEWAY_UPSTREAM`). Para un SDK de OpenAI (Python, Node…) arranca uno con `--upstream openai` en otro puerto; en streaming, la petición tiene que llevar `stream_options.include_usage` o el gateway la reenvía sin medirla y lo dice en el log.»

El ancla `#python-and-any-other-language` sale del texto en negrita del README. Si GitHub no genera ese ancla desde un párrafo en negrita, el enlace se deja apuntando a `../../README.md`.

### 7.3 Web (PR aparte, después del npm)

Seis claves por 12 locales: 72 cadenas. Van en los 12 ficheros de `apps/web/messages/*.json`. Se entrega el texto en EN y ES; los otros 10 (ca, de, fr, id, it, nl, pl, pt, tr, vi) se traducen fielmente conservando las etiquetas `<b>` y los nombres de código (`generateStream()`, `SavingsReport`, `generate()`, `bvsala doctor`, `stream_options.include_usage`). Lo exige parity.test.ts. Ninguna cadena lleva dígitos.

| Clave | EN | ES |
|---|---|---|
| `landing.devs.sub` | Four facts about the package. None of them is a promise. | Cuatro hechos sobre el paquete. Ninguno es una promesa. |
| `landing.devs.cards.3.title` | Streaming, same report | Streaming, el mismo informe |
| `landing.devs.cards.3.body` | generateStream() hands you the answer as the provider writes it and closes with the same SavingsReport as generate(), under the same basis rules: the provider's final counter is read at the end of the stream, and a stream without it is reported as unmeasured and never billed. With an output contract, the answer arrives validated, in one piece. | generateStream() te entrega la respuesta a medida que la escribe el proveedor y cierra con el mismo SavingsReport que generate(), con las mismas reglas de base: el contador final del proveedor se lee al terminar el stream, y un stream sin él se publica como no medido y jamás se cobra. Con contrato de salida, la respuesta llega validada y de una pieza. |
| `landing.devs.cards.3.mono` | layer.generateStream(request) | layer.generateStream(request) |
| `landing.gateway.pythonNote` (nueva) | Python or any other language? Point the official OpenAI or Anthropic SDK at the gateway and every request whose usage the provider reports is recorded in this dashboard, priced at the model's list price — bvsala doctor prints the base URL for each SDK. For OpenAI streaming, ask for usage in the request (stream_options.include_usage). | ¿Python o cualquier otro lenguaje? Apunta el SDK oficial de OpenAI o de Anthropic al gateway y cada petición cuyo uso informe el proveedor queda registrada en este panel, al precio de lista del modelo — bvsala doctor imprime el base URL de cada SDK. En streaming con OpenAI, pide el uso en la petición (stream_options.include_usage). |
| `howItWorks.s1Note` | That green box is an npm package inside the application's code. That's why the key question is never “what do I install?” but <b>“who wrote the code that calls the API?”</b> — that person is who can install it. The exceptions are a coding terminal like Claude Code and an app in any language that lets you set its SDK's base URL: there the bvsala gateway sits in front without touching a line of code. That traffic is measured; the saving levers of the npm package do not run there, and the gateway's own apply only to Anthropic traffic. | Ese recuadro verde es un paquete npm dentro del código de la aplicación. Por eso la pregunta clave nunca es «¿qué instalo?» sino <b>«¿quién escribió el código que llama a la API?»</b> — esa persona es quien puede instalarlo. Las excepciones son un terminal de codificación como Claude Code y una app en cualquier lenguaje que deje fijar el base URL de su SDK: ahí el gateway de bvsala se pone delante sin tocar ni una línea de código. Ese tráfico se mide; las palancas de ahorro del paquete npm no corren ahí, y las del propio gateway solo se aplican al tráfico de Anthropic. |

Otros cambios de la web:

- `apps/web/app/[locale]/page.tsx`, después del `<p>` de la línea 568-570: `<p style={{ marginTop: 8, opacity: 0.85 }}>{t("gateway.pythonNote")}</p>`. Con eso claves-usadas.test.ts ve la clave usada.
- `apps/web/app/globals.css`: la línea 2113 pasa a `.lp .devs-grid { … grid-template-columns: repeat(2, minmax(0, 1fr)); … }`, y tras la 1997 se añade `.lp .devs-grid > .rv:nth-child(4) { --rd: 270ms; }`. La media query de 820px no cambia. Las cards se pintan con `.map` (page.tsx:288), así que la cuarta aparece sola.
- **No se tocan:**
  - `landing.hero.proofs.0.que`: «no streaming» es la condición del A/B publicado y cifra-del-heroe.test.ts la ata a ab-live.json.
  - `dashboard.installLicensePanel.gatewayNote` y `landing.gateway.note`: son zona del Frente 3. La frase sobre Python va en una clave nueva precisamente para no chocar.

---

## 8 · Modelo de datos y migraciones

**Ninguna.** Wire, ingest, RPC y extracto no cambian. Un registro streameado es indistinguible en la base de datos de uno que no lo es, que es justo lo que se busca: la medición no depende del transporte.

---

## 9 · Plan de tests

### 9.1 Ficheros nuevos

**`test/sse.test.ts`**
1. Un mensaje partido en cada byte posible (patrón de gateway-medidor.test.ts:45-52) produce los mismos mensajes.
2. CRLF, CR solo y `\r` al final de un chunk con `\n` al principio del siguiente dan una sola ruptura.
3. Varias líneas `data:` se unen con `\n`.
4. `: comentario` se ignora.
5. `event:` fija el tipo, y sin él el tipo es `"message"`.
6. `end()` despacha un mensaje sin línea en blanco final.
7. Un carácter UTF-8 de 4 bytes partido entre chunks se decodifica bien.
8. `sseMessages("…")` sobre un string y sobre un `ReadableStream` producen el mismo resultado.
9. Salir del `for await` llama a `reader.cancel()` (espía del reader).

**`test/provider-openai-stream.test.ts`**

`fetchImpl` falso que devuelve `new Response(<string | ReadableStream>, { status, headers: { "content-type": "text/event-stream" } })` y captura el cuerpo.

1. El cuerpo enviado lleva `stream: true` y `stream_options: { include_usage: true }`.
2. Los deltas de `content` en 3 chunks dan eventos `text` iguales; `done.response.text` es su concatenación, con `finishReason "stop"`, `usage {inputTokens: 100, outputTokens: 20, cachedInputTokens: 40}` y sin `complete`.
3. `done.response` es igual en profundidad (salvo `raw`) a lo que devuelve `generate()` sobre el JSON equivalente.
4. `tool_calls` en 3 fragmentos por `index`, con `name` repetido en todos los chunks, dan `toolCalls [{id: "c1", name: "get_weather", arguments: '{"city":"Madrid"}'}]` (nombre sin duplicar) y ningún evento de herramienta.
5. `service_tier` produce `servedServiceTier`.
6. Un 400 con cuerpo `Unrecognized request argument supplied: stream_options` provoca un segundo fetch **sin** `stream_options`, un solo `console.warn` con «rejects `stream_options`» y `usage {0, 0, complete: false}`. Una tercera petición ya sale sin `stream_options` en el primer intento.
7. Un 422 con cualquier cuerpo degrada igual.
8. Con `requireUsage: true`, el mismo 400 hace que la llamada lance `/rejects stream_options/`, habiendo hecho un solo fetch.
9. Con `requireUsage: true` y un stream sin chunk de usage, lanza `/incomplete usage/`.
10. EOF sin `finish_reason` → lanza `/ended before completion/`.
11. `data: {"error":{"message":"boom"}}` a mitad → lanza `/provider stream error: boom/`.
12. `options.signal` llega al `fetch`.
13. Una petición con `schema` o con `deferrable` produce exactamente un evento `text` más `done`, y el fetch no lleva `stream`.

**`test/proveedor-anthropic-stream.test.ts`**
1. El cuerpo lleva `stream: true`.
2. Los `text_delta` se reenvían y `text` es su concatenación.
3. `message_start` con `{input_tokens: 10, cache_read_input_tokens: 400, cache_creation_input_tokens: 50, output_tokens: 1}` más `message_delta {output_tokens: 42}` dan `usage {inputTokens: 460, outputTokens: 42, cachedInputTokens: 400, cacheWriteInputTokens: 50}` sin `complete`.
4. `cache_creation` 1h de `message_start` se conserva tras el delta (fusión).
5. Un `tool_use` con `partial_json` con espacios (`'{"city": '`, `'"Paris"}'`) da `arguments '{"city":"Paris"}'`. Una herramienta sin parámetros (`partial_json` vacío) da `"{}"`.
6. `stop_reason: "max_tokens"` → `finishReason "length"`; `"tool_use"` → `"tool_calls"`.
7. Sin `message_delta` y con `message_stop` → `usage {0, 0, complete: false}`. Con `requireUsage` → lanza.
8. `event: error` (overloaded_error) → lanza `/provider stream error: overloaded_error/`.
9. EOF sin `message_delta` ni `message_stop` → lanza `/ended before completion/`.
10. `usage.service_tier` → `servedServiceTier`.
11. Con `schema`, se delega en `generate()`: el cuerpo no lleva `stream` y hay un solo evento `text`.

**`test/mock-provider-stream.test.ts`**
1. Con `streamChunkChars: 4` y `answer: "abcdefghij"` → deltas `["abcd", "efgh", "ij"]`.
2. `done.response` es igual en profundidad a `await generate(req)`.
3. Es determinista entre ejecuciones.

**`test/contabilidad-sin-contador.test.ts`**
1. Unitario de `SavingsLedger`: `actualInput 100`, `sentInputLocal 80`, `removedInputLocal 0`, `callsWithoutUsage 1` → `basis "unmeasured"` y `netSavings ≤ 0`.
2. Caso de C2-1: `createSavingsLayer` con un proveedor falso cuyo primer `generate` devuelve `{text: "not json", usage: {inputTokens: 0, outputTokens: 0, complete: false}}` y el segundo `{text: '{"answer":8}', usage: {inputTokens: 50, outputTokens: 5}}`, con un esquema `{answer: number}` → `report.cost.basis === "unmeasured"` y `report.calls.actualLlm === 2`.
3. `OpenAICompatibleProvider.generate()` con `usage: {prompt_tokens: 10}` (sin `completion_tokens`) a través de la capa → `basis "unmeasured"`. Hoy sale `"measured"`.
4. Un proveedor sin campo `complete` sigue dando `"measured"` cuando no se quita nada (regresión).

**`test/pipeline-stream.test.ts`** (el principal)

Proveedor falso inline `{ id, generate, async *generateStream(req, {signal}) }` con contadores `llamadasStream` y `llamadasGenerate`, y `createSavingsLayer({ provider, devUnlicensed: true })`.

1. **En vivo.** Trozos `["Hel", "lo ", "world"]` con `usage {12, 3}` y `finish "stop"` → eventos `[text "Hel", text "lo ", text "world", done]`; `result.text === "Hello world"`; `done.result === await stream.result`; `basis "measured"`; `streaming.delivery "live"`; `firstEventMs` es un número ≥ 0; sin `wholeReason`; `llamadasStream 1` y `llamadasGenerate 0`.
2. **`result` sin iterar.** `await stream.result` resuelve. Si después se itera, salen todos los eventos encolados, incluido `done`.
3. **Metering.** Con `serviceAccountKey: "bvk_test"`, `meteringUrl`, `meteringFetch` espía y `metering: { maxBatch: 1, seatId: "t", ci: false }`: tras `await stream.result`, se espera a que haya un POST con exactamente un registro (`basis "measured"`). Hay que hacer `close()` **después**.
4. **Abort a mitad.** El proveedor emite "Hel" y luego espera a que se aborte la señal. El consumidor llama a `stream.abort()` tras el primer `text`. El bucle termina sin error; `result` rechaza con `StreamAbortedError` y `requestSent === true`; hay 0 registros; una segunda petición idéntica vuelve a llamar al proveedor (no hubo caché).
5. **`break`.** Mismo resultado que el caso 4.
6. **Señal ya abortada.** `result` rechaza con `requestSent === false`; `llamadasStream + llamadasGenerate === 0`; la iteración no produce eventos.
7. **Abort tras el `done` del proveedor.** Se usa un `exactCache` inyectado cuyo `set` espera una promesa que controla el test, y se aborta mientras `set` está pendiente. `result` resuelve y hay 1 registro.
8. **Contrato.** Esquema `{answer: number}` y `generate` devuelve `'{"answer":8}'` → eventos `[text '{"answer":8}', done]`; `streaming {delivery: "whole", wholeReason: "output-contract"}`; sin `firstEventMs`; `llamadasStream 0` y `llamadasGenerate 1`; `result.data.answer === 8`.
   - 8b. Primera respuesta inválida y reparación válida → `llamadasGenerate 2`; un solo `text` igual al texto reparado.
   - 8c. `finishReason "length"` → `constraints.structurallyValid === false` y una segunda petición idéntica vuelve a llamar.
9. **Deferrable.** `savings.deferrable: true` → «whole» con `"deferrable"` y va por `generate`.
10. **Proveedor sin `generateStream`** → «whole» con `"provider-without-streaming"`.
11. **Caché exacta tras un stream.** Una segunda `generateStream` idéntica produce `[text entero, done]`, con `cache.result "exact"`, `calls.avoidedLlm 1`, `basis "estimated"` y `wholeReason "shortcut"`; `llamadasStream` sigue en 1.
12. **Acierto semántico sin esquema.** Montaje de cache-isolation.test.ts:97-135 con `InMemorySemanticCache` y `exactCache: false`. La segunda petición produce exactamente un `text` igual a `result.text` y `wholeReason "shortcut"`.
13. **Seguidor de singleflight.**
    - (a) Un `generate()` lento (100 ms) y una `generateStream()` idéntica lanzada 10 ms después → `llamadasGenerate 1` y `llamadasStream 0`; el stream termina con `cache.result "singleflight"`, `basis "estimated"`, `tokens.actualInput 0` y `wholeReason "shortcut"`.
    - (b) Dos `generateStream()` idénticos y concurrentes → `llamadasStream 2`, y cada informe lleva la traza `singleflight` con resultado `"skipped (streaming: a streamed request never leads)"`.
    - (c) Una `generateStream()` lenta y un `generate()` idéntico concurrente → 2 llamadas, y `"streaming" in generateResult.report === false`.
14. **Fail-open.**
    - (a) `exactCache.get` lanza (patrón de fail-open.test.ts:5-8) → `llamadasGenerate 1`, `llamadasStream 0`, `wholeReason "fail-open"`.
    - (b) Con `failOpen: false` → `result` rechaza con «boom».
    - (c) El proveedor lanza `Error("provider 503")` tras 2 deltas → se reciben 2 eventos `text` y luego el `for await` lanza «provider 503»; `result` rechaza con el mismo error; `llamadasStream 1` y `llamadasGenerate 0`.
15. **Tool calls.** `done` con `toolCalls [{id: "c1", name: "get_weather", arguments: '{"city":"Madrid"}'}]`, texto vacío y `finishReason "tool_calls"` → eventos `[tool_call {call}, done]`, sin `text`; `result.toolCalls` igual en profundidad; `finishReason "tool_calls"`; la segunda petición vuelve a llamar.
16. **Sin contador.** `done.usage {0, 0, complete: false}` → `basis "unmeasured"`, `netSavings 0`, `baselineEstimate 0` y **1** registro `unmeasured`.
17. **Texto distinto del final.** Deltas "ab" y `done.response.text` "abc" → un `console.warn` con «streamed text that differs» y `result.text === "ab"`.
18. **Licencia.** Sin `devUnlicensed` y con `BVSALA_DEV_OPEN` borrado (patrón de license-gate.test.ts) → el primer `next()` rechaza con `LicenseError`, `result` también, y no hay ninguna llamada al proveedor.
19. **Doble iteración.** Una segunda llamada a `[Symbol.asyncIterator]()` lanza.
20. **Verja de prefijo.** `new SavingsPipeline({ provider, tokenizer: new TokenizerRegistry(), devUnlicensed: true })`, modelo `"anthropic/claude-sonnet-4-5"`, system `POLITICA` (patrón de cache-de-prefijo-en-el-pipeline.test.ts:24-53) y `done.usage {0, 0, complete: false}` → hay una traza `prefix-cache` con resultado `"not measured: the provider reported no usage for this call"` y ninguna con resultado `"measured"`.

**`test/gateway-chat-completions.test.ts`**

Upstream `node:http` falso que captura el cuerpo recibido y una ingesta falsa que responde `GET /api/org/entitlements` con `{"features":[]}` (patrón de gateway-servidor.test.ts:30-102). Modelo `gpt-4o-mini`.

- (a) SSE con el cliente pidiendo `stream_options.include_usage: true`; el upstream envía 2 chunks de texto, uno de `finish` y uno de usage `{prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: {cached_tokens: 40}}` con `choices: []`, más `[DONE]` → 1 registro con `basis "measured"`, `model "gpt-4o-mini"`, `actualInputTokens 100`, `actualOutputTokens 20`, `providerCachedInputTokens 40`, `actualCost ≈ 0.000024` (tolerancia 1e-10), `baselineCost === actualCost` y `netSavings 0`. El cliente recibe los mismos bytes que envió el upstream.
- (b) Sin `stream_options` → 0 registros; una línea de log con «not metered: the request did not ask for usage (stream_options.include_usage)»; un `console.warn` (tras `reiniciarAvisos()`) que contiene `stream_options={"include_usage": True}`.
- (c) Pide usage pero el upstream no envía el chunk de usage → 0 registros y log «the stream ended without the provider's final usage event».
- (d) Usage en cada chunk (vLLM) y el cliente aborta antes de `[DONE]` → 0 registros.
- (e) JSON con `stream: false` y usage → 1 registro `measured`.
- (f) JSON sin usage → 0 registros y log «the response carried no usage».
- (g) `POST /v1/responses` JSON con `usage {input_tokens: 100, output_tokens: 20, input_tokens_details: {cached_tokens: 40}}` → 1 registro con `actualInputTokens 100` y `providerCachedInputTokens 40`.
- (h) `POST /v1/embeddings` JSON → 0 registros y un aviso con «no usage dialect»; `POST /v1/messages/count_tokens` no dispara ese aviso.
- (i) SSE de Anthropic en `/v1/messages` con `message_start` (usage) y `event: error` sin `message_delta`, status 200 → **0 registros** (hoy sería 1 registro parcial) y log «ended without the provider's final usage event».
- (j) Con `coalescer: true`, dos peticiones idénticas JSON con usage a `/v1/chat/completions` → 2 registros: la primaria `measured` y la gemela `estimated` con `cacheResult "singleflight"`.
- (k) Con `usageInject: true` y un cliente SSE sin `stream_options` → en el cuerpo que recibe el upstream, `JSON.parse(body).stream_options` es igual a `{include_usage: true}`; `body.toString()` es `'{"stream_options":{"include_usage":true},' + original.slice(1)`; hay 1 registro `measured`.
- (l) `usageInject: true` con `stream_options: {include_usage: false}` → cuerpo intacto, 0 registros y log «did not ask for usage».
- (m) `usageInject: true` con `content-encoding: gzip` → el upstream recibe exactamente los mismos bytes.
- (n) `usageInject: true` con un upstream que responde 400 (y otro caso con 422) si el cuerpo contiene `stream_options`, y 200 si no → el cliente recibe 200; el upstream vio 2 peticiones; hay un aviso con «rejects stream_options»; una segunda petición del cliente llega al upstream **sin** inyectar, en un solo intento.
- (o) Por defecto (sin `usageInject`) → el upstream recibe bytes idénticos.

**`test/gateway-upstream.test.ts`** (`resolverUpstream`)
- `openai`, `OpenAI ` y `anthropic` → origen del alias.
- El flag gana a la variable de entorno.
- Nada puesto → `upstream: undefined` con `origen "none"`.
- `https://api.openai.com/v1` → `https://api.openai.com` más un aviso que contiene «is ignored».
- `http://127.0.0.1:9000/` → sin aviso.
- `ftp://x` y `openai.com` → `ok: false`.
- `flag: null` → `ok: false`, con «needs a value».

### 9.2 Tests existentes que cambian o crecen

- **test/gateway-coalescencia.test.ts:223-262.** La ruta pasa de `/v1/chat/completions` a `/v1/embeddings`; el título y la aserción de cero registros se mantienen. El caso de chat/completions queda cubierto por (j).
- **test/gateway-doctor.test.ts.** Las aserciones actuales no cambian (`IDS` es la lista fija de 9). Se añade:
  1. `seccion(texto, "python-openai")` contiene `OpenAI(base_url="http://127.0.0.1:8402/v1")`, `--upstream openai` y `stream_options={"include_usage": True}`, y su línea de comprobación contiene «POST /v1/chat/completions».
  2. `seccion(texto, "python-anthropic")` contiene `Anthropic(base_url="http://127.0.0.1:8402")` y no contiene `8402/v1`.
  3. Las dos secciones dicen «no detection: any language».
  4. `texto` contiene «Any language through the gateway».
  5. Con el puerto 51234 no aparece ningún «8402»: ya lo cubre el test existente de las líneas 100-108.
- **test/gateway-medidor.test.ts.** Se añaden a los imports `ObservadorChatCompletions`, `mapearUsoChat`, `usoDeJsonPorRuta` e `inyectarIncludeUsage`, con estos casos: cortes en cada byte; usage solo con `[DONE]` o `choices: []`; primer chunk de Azure; `mapearUsoChat({prompt_tokens: 10})` → `null`; enrutado de `usoDeJsonPorRuta`; los 6 motivos de `inyectarIncludeUsage`, incluidos BOM y espacios iniciales.
- **Sin cambios, y tienen que seguir en verde:** singleflight-concurrencia, pipeline-tool-calls, fail-open, fail-open-no-repite-cobro, measured-honesty, single-ruler, shortcut-honesty, truncation (el aviso en castellano no se toca), proveedor-anthropic (usage sin `complete` cuando es completo), provider-openai, gateway-servidor (si alguno falla por el paso a `usageFinal()`, se corrige el test: fijaba un registro parcial), gateway-argumentos, no-solape-gateway-pipeline (gateway importa `../src/providers/sse.js`, que no está en `src/pipeline`), superficie-publica-limpia, dx-empaquetado, sala-limpia-del-tarball.
- **test/fragmento-instalacion.test.ts** compila automáticamente el bloque nuevo del README contra `src/index.ts`. Es la verja gratuita de que `generateStream`, `SavingsStreamEvent` y `report.streaming` tipan.
- **Web (PR 2):** parity.test.ts, claves-usadas.test.ts, tarifa-en-parametros.test.ts y cifra-del-heroe.test.ts en verde.

---

## 10 · Orden de trabajo y despliegue

Reglas 0 y 0b. Antes de tocar nada: `git status`, `git log origin/main..main` y `git reflog main`. La rama se corta desde `origin/main` y nunca se commitea a main. En el checkout actual hay cambios ajenos (`M package.json`, `?? corpus/medir-r-local.ts`, `?? docs-citas.txt`, `?? entorno.txt`): no se tocan ni se commitean. Se hace `git commit --only -- <rutas>`.

**PR 1: `feat/streaming-sdk-y-dialecto-chat`** (SDK y gateway). Paquetes de trabajo, en este orden de dependencias:

- **WP0**, sin dependencias: tipos (§3.1, §4.1), `errors.ts`, `Singleflight.join`.
- **WP1**, depende de WP0: `sse.ts`, adaptadores, mock y sus tests.
- **WP2**, depende de WP0: `complete` en `leer()`, `callsWithoutUsage`, guarda en `estimateCost`, `testigo.sinContador`, verja de prefijo, `failOpenDirect`, y test/contabilidad-sin-contador.
- **WP3**, depende de WP0, WP1 y WP2: `stream.ts`, pipeline (§5.7), `create.ts`, y test/pipeline-stream.
- **WP4**, depende de WP1 (`sse.ts`): medidor, servidor, upstream, bin, doctor y sus tests.
- **WP5**: README y docs/terminales.

Versión: la siguiente patch libre en el momento del merge (0.4.23 si nadie la ha tomado), en `package.json` y en `BV_SALA_VERSION` de `src/version.ts` (test/version-declarada). Localmente, `pnpm run build:all && pnpm test` (dx-empaquetado y superficie exigen `dist`) y después `scripts/simular-ci.sh`. CI en verde → merge → `publish.yml` (etiqueta == versión) → npm.

**PR 2: `feat/web-streaming-y-python`** (solo web). Se abre **después** de que npm tenga la versión nueva, para que la web nunca anuncie un `generateStream` que el registro no tiene. Hacer merge a main despliega en Vercel. No hay orden servidor-primero porque el wire no cambia.

Coordinación con los otros frentes:

- **Frente 1** (`estimateCost`): §4.3 es una guarda que va primera dentro de `ranCall`. Si el Frente 1 entra antes, se rebasea y se conserva la guarda en primer lugar.
- **Frente 3** (licencia del gateway): este frente no toca la creación de `emisor`, ni `gatewayNote`/`landing.gateway.note`, ni las líneas 10-22 y 51-68 de docs/terminales, ni LICENSE. El dialecto nuevo hereda cualquier verja que ponga el Frente 3.
- **Frente 4** (castellano): todos los textos nuevos de runtime están en inglés. Los avisos en castellano que ya existen en los adaptadores y en el truncado no se tocan aquí; los traduce el Frente 4. La fila nueva de docs/terminales va en castellano, como el resto de ese fichero.

Opcional, más adelante: un brazo de streaming en `benchmarks/ab-live.ts`. Solo con esa medición se podría tocar `landing.hero.proofs.0.que`.

---

## 11 · Riesgos residuales

| # | Riesgo | Mitigación |
|---|---|---|
| R1 | Un endpoint acepta `stream_options` y aun así no envía usage | SDK: `unmeasured`, visible en el informe. Gateway: aviso W2 y línea «not metered». Nunca se cobra. |
| R2 | Gasto que no se reporta: un stream abortado antes del evento final pudo facturar tokens que no aparecen en el panel (SDK y gateway) | Es el suelo por diseño; lo dicen `StreamAbortedError.requestSent` y el log del gateway. El panel puede quedar por debajo de la factura en esos casos, nunca por encima. |
| R3 | Dos streams idénticos concurrentes no se fusionan en una sola llamada | Es la contrapartida de C1-2. Está documentado en el JSDoc. El tráfico de ráfagas idénticas suele ir por `generate()`, que sí coalesce. |
| R4 | Las peticiones con contrato o `deferrable` no ganan tiempo al primer token | Está documentado: `wholeReason`. Es la condición para no reescribir texto ya emitido. |
| R5 | Con la inyección opt-in activada, un cliente que lea `choices[0]` sin comprobar revienta en el último chunk | Apagada por defecto. Al activarla, una línea de arranque lo avisa y la ayuda del CLI lo explica. |
| R6 | Con `--upstream <url>` de un revendedor (OpenRouter, Azure…), el coste va a precio de lista y no cuadra con su factura | La copia lo dice («priced at the model's list price»). Sin precio de lista no hay registro (`gateway-sin-precio`). En Azure el modelo va en la ruta y ya salta `gateway-sin-modelo`. |
| R7 | Un `Provider.generateStream` de terceros puede incumplir el contrato | El pipeline fuerza que `result.text` sea el texto emitido, con aviso. La honestidad del usage de un proveedor de terceros depende de él, igual que hoy en `generate()`. |
| R8 | Con `requireUsage` y un endpoint que acepta `stream_options` pero no manda usage, el consumidor ve el texto y después `result` rechaza | Está documentado en el JSDoc del adaptador. Con `requireUsage` el cliente pidió justo eso. |
| R9 | Doble registro si tráfico del SDK con `serviceAccountKey` pasa además por un gateway con clave | Ya existía con `/v1/messages`. Fuera de alcance; se anota para el panel. |
| R10 | §4.2 cambia `generate()` en el caso de usage parcial (de `measured` a `unmeasured`), así que `measured_requests` puede bajar en endpoints que omiten un contador | Es intencional y es el principio aplicado. Lo cubre test/contabilidad-sin-contador. |
| R11 | vLLM con `n > 1` y uso continuo, abortado entre el último `finish` y `[DONE]` | `usageFinal` exige `[DONE]` o `choices: []`, así que esto da `null`. El riesgo que queda es despreciable. |
| R12 | `close()` antes de que `result` se resuelva hace perder el registro (emitter.ts:160-165) | Igual que con `generate()`. Está documentado en el JSDoc de `generateStream`. |
| R13 | Conflictos de merge con los Frentes 1, 3 y 4 | Ver §10: zonas separadas y reglas de rebase. |
| R14 | La cifra del héroe sigue siendo «no streaming» | Es deliberado. Cambiarla exige medir el brazo de streaming. |
| R15 | Añadir un método obligatorio a la interfaz `SavingsLayer` rompe a quien la implemente a mano | En el repo solo la implementa create.ts. Es el handle público, no una interfaz pensada para que el cliente la implemente. |

---

## 12 · Impacto en ingresos

- **Comisión directa: 0 €.** Todo ahorro positivo del SDK es `estimated` (accounting.ts:305 y 344) y el extracto solo suma `measured_*` (extracto.ts:18). El streaming no cambia el `basis`. En el gateway, `/v1/chat/completions` sale `measured` con `netSavings 0`, porque las dos únicas palancas de precio (rebaja de TTL y modelo hermano) solo actúan sobre `/v1/messages`. El tráfico streameado aportará comisión exactamente igual que el no streameado cuando el Frente 1 le dé al SDK un `basis` defendible, porque la contabilidad es la misma.
- **Asientos, que es donde hoy hay dinero.** El SDK es fail-closed, así que cada app TypeScript que hoy no puede adoptarlo porque necesita streaming, y a partir de este frente sí puede, paga 4 €/asiento/mes o 39 €/asiento/año. La fórmula es `Δ ≈ asientos_nuevos × 4 €/mes`, o `× 3,25 €` en el plan anual. En el repo no hay datos de embudo para fijar un número. Lo que sí se puede afirmar es que el bloqueo era duro (una app de chat no tiene alternativa al streaming) y que desaparece.
- **Python vía gateway: 0 € hasta el Frente 3.** Genera panel y registro, pero no factura, porque las palancas PRO no aplican a OpenAI y medir hoy no exige licencia. Funciona como captación, y queda listo para que el Frente 3 lo convierta en asientos con la misma `bvk_`.
- **Coste de oportunidad que se evita.** Sin este frente no había forma de medir con streaming, así que la cifra publicada quedaba acotada a un caso que muchos compradores no reconocen como el suyo.

---

## 13 · Criterio de aceptación

1. `pnpm run build:all && pnpm test` en verde, incluidos los 8 ficheros de test nuevos y los cambios de §9.2.
2. `scripts/simular-ci.sh` en verde.
3. `grep -c "[áéíóúñ¿¡]" dist/index.d.ts` no pasa de 81.
4. Tres comprobaciones a mano contra un upstream falso:
   - `bvsala gateway --upstream openai` imprime la línea «point your SDK at it: base_url=…/v1».
   - Una petición `chat/completions` en stream sin `include_usage` deja la línea «not metered: the request did not ask for usage…».
   - Con `include_usage` deja la línea de coste.
5. El README se compila en el test de fragmentos, y el primer bloque ```ts sigue siendo el de «3 · Wrap the call».
6. PR 2 no se abre hasta que npm muestra la versión nueva.