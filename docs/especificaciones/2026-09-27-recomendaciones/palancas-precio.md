# Especificación: unidad «palancas-precio» (recomendación n.º 9)

**Rama:** `feat/palancas-nativas-de-precio` · **Worktree:** `/Users/fisagol/bsl-palancas-precio`. No existe todavía: como diseñador trabajé en solo lectura, sobre `origin/main` `f157462`. Lo crea el implementador con el comando de las reglas.

**Resumen:**
- **Se construye:** tres cosas, todas apagadas por defecto.
  - Flex de OpenAI y de Gemini valorado con precios de catálogo **por modelo y por componente**. Esto corrige un sobre‑crédito que existe hoy.
  - El modo explícito de caché en GPT‑5.6+ para peticiones declaradas `standalone`.
  - Un respaldo opcional al tier estándar cuando Flex no tiene capacidad.
- **No se construye, con el motivo escrito:** Batch, DeepSeek fuera de punta y Bedrock (D5–D7).
- **Qué no se toca:** nada cambia `cost.*`, el cable de metering ni la comisión.

---

## 1. Lo que ya existe (comprobado en `origin/main`)

- `src/economics/tier-diferido.ts`:
  - `veredictoDelTier()` usa una tabla plana: `flex: 0.5`, `batch: 0.5`, y `default`, `auto`, `priority`, `fast`, `scale` y `standard` a 1.
  - `ahorroDelTier()` devuelve `costeEstandar * (1 - factor)`.
  - `FACTOR_DIFERIDO_MINIMO` sirve al carril de referencia.
  - Batch está «diseñado y no construido», con tres puntos de rotura: informe, caché y metering.
- `src/providers/openai-compatible.ts`:
  - Con `deferrable` manda `service_tier: "flex"` a **cualquier** `baseUrl`.
  - Lee `service_tier` del cuerpo de la respuesta.
  - Ignora `stablePrefixMessages`.
  - **No lee** `prompt_tokens_details.cache_write_tokens`. El gateway sí lo lee (`gateway/medidor.ts:315`).
- `src/pipeline/pipeline.ts`, `informeDeDiferido()`:
  - Acredita con el factor plano sobre la llamada cuyo tier se leyó.
  - El resultado va en `estimatedTierSaving`, con `creditedLedger: "none"`, y **no entra** en `cost.*`.
- Doctrina de la rebaja de TTL del gateway (`gateway/medidor.ts`, `construirInforme`): es «una resta entre dos precios públicos sobre el mismo conteo», y por eso se considera `measured`. La palanca C (modelo hermano) sigue la misma doctrina.
- La verja de prefijo (`src/economics/prefix-cache-gate.ts`, `decidirMarcadoDeCache`) explora, mide h y deja de marcar por debajo del equilibrio (0,217 con 1,25/0,10). Para OpenAI usa `OPENAI_CACHE_TIER`, con escritura 1× y lectura 0,5, así que siempre marca. En OpenAI «marcar» solo añade `prompt_cache_key`.
- Cable (`src/metering/emitter.ts`): la regla es servidor primero, y cada campo nuevo exige un cambio en la LICENSE §5 (verja `licencia-alineada`). La comisión (`apps/web/lib/billing/tarifa.ts`) cobra `measured` y `reference`.

## 2. Hechos de proveedor (leídos el 2026‑09‑27; **el implementador los vuelve a leer y, si difieren, manda la página oficial**)

| Hecho | Fuente |
|---|---|
| Flex: «Tokens are priced at Batch API rates, with additional discounts from prompt caching». El 429 «Resource Unavailable» no se cobra. El timeout del SDK es de 10 min y un 408 se reintenta dos veces. Para respaldo: «set `service_tier` to `auto` … or remove the `service_tier` parameter». | developers.openai.com/api/docs/guides/flex-processing |
| `service_tier` de Chat Completions: 'auto' \| 'default' \| 'flex' \| 'scale' \| 'priority' \| 'fast'. «This response value may be different from the value set in the parameter». Priority pasó a llamarse Fast mode el 30‑jul‑2026 y la respuesta dice `priority`. | openai‑node `src/resources/chat/completions/completions.ts`; pricing |
| Tabla Flex de OpenAI (USD/1M, contexto corto; entrada / cacheada / escritura / salida). Los precios cacheados de gpt‑5.4 (0,13 frente a 0,125) y de o4‑mini (0,138 frente a 0,1375) **no son la mitad exacta**:<br>• gpt‑5: 0.625 / 0.0625 / — / 5.00<br>• gpt‑5‑mini: 0.125 / 0.0125 / — / 1.00<br>• gpt‑5‑nano: 0.025 / 0.0025 / — / 0.20<br>• gpt‑5.2: 0.875 / 0.0875 / — / 7.00<br>• gpt‑5.4: 1.25 / **0.13** / — / 7.50<br>• gpt‑5.4‑mini: 0.375 / 0.0375 / — / 2.25<br>• gpt‑5.4‑nano: 0.10 / 0.01 / — / 0.625<br>• gpt‑5.5: 2.50 / 0.25 / — / 15.00<br>• gpt‑5.6‑luna: 0.10 / 0.01 / 0.125 / 0.60<br>• gpt‑5.6‑sol: 2.00 / 0.20 / 2.50 / 10.00<br>• gpt‑5.6‑terra: 1.00 / 0.10 / 1.25 / 6.00<br>• o3: 1.00 / 0.25 / — / 4.00<br>• o4‑mini: 0.55 / **0.138** / — / 2.20<br>• También lista gpt‑6‑astra, gpt‑6‑sol y gpt‑6‑luna. | developers.openai.com/api/docs/pricing |
| Contexto largo en OpenAI: hay columnas de precio en gpt‑5.4 y siguientes. La nota «(<272K context length)» aparece en gpt‑5.4 y gpt‑5.5. En gpt‑5.6 no encontré el umbral. | idem |
| Caché explícita en GPT‑5.6+:<br>• `prompt_cache_options: { mode: "implicit"\|"explicit", ttl: "30m" }`, con `implicit` por defecto.<br>• Con `explicit`: «does not create an implicit breakpoint … If there are no explicit breakpoints, the request does not use prompt caching».<br>• El marcador es `prompt_cache_breakpoint: { mode: "explicit" }` y va en `ChatCompletionContentPartText/Image/InputAudio`.<br>• La escritura cuesta 1,25× la entrada.<br>• Implícito: «places a breakpoint at the end of the latest eligible message».<br>• Para reutilizar un sistema fijo con entradas variables, la guía recomienda un breakpoint tras el contenido estático.<br>• Está disponible en Chat Completions y en Responses (changelog, 9‑jul‑2026). | developers.openai.com/api/docs/guides/prompt-caching; openai‑node |
| Flex de Gemini (tabla abajo):<br>• Se pide con `service_tier: "flex"`.<br>• «won't automatically upgrade a Flex request to the Standard tier»: sin capacidad devuelve 429 o 503.<br>• Latencia: «Minutes (1–15 min target)».<br>• El endpoint OpenAI‑compatible «matches OpenAI's `service_tier` parameter in name and logic».<br>• El blog nombra la cabecera `x-gemini-service-tier` como forma de ver el tier servido; la página de docs no la menciona. | ai.google.dev/gemini-api/docs/flex-inference (act. 2026‑09‑23); …/docs/openai (act. 2026‑09‑02); blog.google, 2‑abr‑2026 |
| Tabla Flex de Gemini (USD/1M; entrada / salida / caché). La lectura cacheada **no se descuenta** en 2.5‑pro, 2.5‑flash ni 3.1‑pro‑preview:<br>• gemini‑3.7‑flash: 0.375 / 1.875 / 0.0375<br>• gemini‑3.5‑flash: 0.75 / 4.50 / **0.08**<br>• gemini‑3.5‑flash‑lite: 0.15 / 1.25 / sin caché<br>• gemini‑3.1‑pro‑preview: 1.00 / 6.00 / **0.20 (= estándar)**<br>• gemini‑2.5‑pro: 0.625 / 5.00 / **0.125 (= estándar)**<br>• gemini‑2.5‑flash: 0.15 / 1.25 / **0.03 (= estándar)** | ai.google.dev/gemini-api/docs/pricing (act. 2026‑09‑24) |
| Bedrock tiene `service_tier` con los valores reserved / priority / default / flex, y el tier servido se ve en la respuesta. El descuento de Flex depende del modelo. | docs.aws.amazon.com/bedrock/latest/userguide/service-tiers-inference.html |
| DeepSeek: fuera de punta cuesta la mitad. Punta: 01:00–04:00 y 06:00–10:00 UTC, de lunes a viernes, salvo festivos chinos. No dice si manda la hora de inicio o la de fin. | api-docs.deepseek.com/quick_start/pricing |

## 3. Decisiones

**D1 · Doctrina de valoración (la misma que la rebaja de TTL).** El ahorro de un tier es el **mismo `usage` que declaró el proveedor en la llamada cuyo tier se leyó**, tarifado a dos tarifas publicadas: la estándar y la del tier servido. El cálculo va componente a componente: entrada normal, lectura cacheada, escritura de caché y salida. **Nunca se recorta a 0 un componente**; se resta el total y, si sale ≤ 0, no se acredita nada. Los importes se redondean **hacia abajo** a 1e‑10.
- **`measured`** si se cumplen las seis condiciones a la vez:
  - M1: el tier servido se leyó de la respuesta (cuerpo o cabecera documentada).
  - M2: el adaptador propio atestigua origen oficial (`api.openai.com` o `generativelanguage.googleapis.com`).
  - M3: el modelo tiene **fila propia** en `CATALOGO` (regla de `precioDeListaPropio`) y fila en la tabla de tiers.
  - M4: el cliente no declaró `costModels` para ese modelo.
  - M5: todo componente con tokens tiene precio de tier publicado.
  - M6: el `usage` está completo.
- **`estimated`** en estos casos:
  - Origen no oficial o no atestiguado (proxy, Vercel AI Gateway, proveedor propio).
  - Precio del cliente: se usa su precio estándar por el ratio tier/estándar del catálogo.
  - Un componente sin precio de tier: aporta 0.
- Si falta el tier servido, no hay fila estándar o no hay fila de tier, no se acredita nada y se dice el motivo.
- **Por qué:** es la única forma en que el importe cuadra con la factura, porque la línea de flex de la factura es exactamente ese conteo a esa tarifa. Pedir no es obtener, así que sigue mandando solo el tier servido.

**D2 · Tabla de tarifas por modelo, no factor plano.** El factor 0,5 **sobre‑acredita hoy**:
- En Gemini 2.5‑pro, 2.5‑flash y 3.1‑pro‑preview la lectura cacheada en Flex cuesta lo mismo que en estándar, y aun así se acredita la mitad.
- En gemini‑3.5‑flash (0,08 frente a 0,075), gpt‑5.4 y o4‑mini la tarifa cacheada de Flex supera la mitad.

La tabla lleva en cada fila, **como dato y como comentario**, la URL oficial y la fecha de consulta. Solo entran modelos con fila propia en `CATALOGO` hoy. Donde la página publica contexto largo, se guardan las filas largas (estándar y tier) para probar que valorar a tarifa corta **solo puede quedarse corto**.

**D3 · Flex de OpenAI.** El cuerpo no cambia: ya se manda. Solo cambia la valoración.

**D4 · Flex de Gemini** a través del endpoint OpenAI‑compatible, porque el SDK no tiene adaptador nativo de Gemini.
- El tier servido se lee de `service_tier` del cuerpo o, en su defecto, de la cabecera `x-gemini-service-tier`, que solo se lee en el host oficial.
- Si el implementador no puede confirmar el nombre y los valores de la cabecera en una fuente oficial, **no la lee**: sin lectura no hay crédito, que es el lado seguro.
- La frase de latencia pasa a depender del proveedor.

**D5 · Bedrock: no cubierto.** No hay adaptador SigV4 ni filas de Bedrock en el catálogo. Si un cliente usa el endpoint OpenAI‑compatible de Bedrock, se sigue mandando `flex` y el informe dirá `no published price for the "flex" tier of this model` sin acreditar nada.

**D6 · DeepSeek fuera de punta: no se construye.** Cuatro motivos:
1. El catálogo no tiene filas de DeepSeek.
2. La respuesta no dice qué tarifa se aplicó, así que como mucho sería `estimated`.
3. Aprovecharlo exige retener peticiones hasta la ventana, que es la superficie asíncrona de Batch.
4. Hay dudas sin fuente: calendario de festivos chinos y si manda la hora de inicio o la de fin.

Queda escrito en el bloque de diseño de `tier-diferido.ts`.

**D7 · Batch: no se construye en esta unidad.** Queda como unidad aparte.
- **Evidencia:** en **todos** los modelos que OpenAI lista para Flex, Batch cuesta lo mismo que Flex (tablas del §2). En OpenAI, Batch solo añade precio en modelos sin Flex (4o, 4.1, o3‑mini, *‑pro).
- En Anthropic Batch es la única vía. Pero hay que partir `generate()` en pre‑ y post‑proveedor y dar durabilidad al metering: es esfuerzo L, no M.
- Se actualiza el bloque «EL ASÍNCRONO» con la regla de valoración que tendrá. Anthropic informa `usage.service_tier: "batch"` y un lote se factura siempre a tarifa batch, así que sería `measured` bajo D1.

**D8 · Modo explícito de caché (`standalone`) en GPT‑5.6+.**
- **El hueco:** en modo implícito, una petición de un solo uso escribe **todo** su prompt a 1,25× y no lo reutiliza nadie. Además, el sistema compartido no se lee, porque la entrada queda escrita al final de la pregunta.
- **Qué hace:** si el cliente declara `standalone` y el modelo cumple `primaDeEscritura(model) > 1` en el host oficial de OpenAI, el adaptador manda `prompt_cache_options: { mode: "explicit" }`.
  - Si la verja de prefijo marca, pone **un** `prompt_cache_breakpoint` en la frontera del prefijo estable.
  - Si no marca, no pone **ninguno**: ni escritura ni lectura.
  - Hoy solo aplica a `gpt-5.6-*`. Se extiende sola a GPT‑6 cuando la n.º 1 amplíe `primaDeEscritura` en `primas.ts`, que tiene un solo domicilio.
- **Por qué es declarado y no inferido:** en conversación pierde dinero. Cada mensaje de usuario pagaría 1,0 + 1,25 en lugar de 1,25 + 0,10, y el equilibrio de continuación está en p < 0,217. Solo el cliente sabe si su petición se va a continuar.
- **Basis siempre `estimated`:** cambia *qué* tokens se escriben (otro vector de uso) y el modo implícito no se ejecutó.
- **Valoración:** tokens ordinarios = `input − cached − writes`; importe = esos tokens × (tarifa de escritura − tarifa de entrada) de la fila aplicada. Es 0 si `input < 1024`.

**D9 · Respaldo de capacidad (opcional, apagado).** Con `priceLevers.onCapacityError: "standard"`, un 429 o 503 de una petición diferible se repite **una vez** sin `service_tier`, a precio estándar. El informe lo dice y el intento rechazado no cuenta como llamada facturada. Por defecto, `"throw"` deja el error tal cual, que es el comportamiento de hoy.

**D10 · Configuración por defecto.** `priceLevers.deferrable` y `priceLevers.standalone` se aplican **al entrar al pipeline**, antes de `canonicalize`, porque `deferrable` entra en la clave de caché y de singleflight (`keys.ts`). Siempre gana el valor de la petición. `standalone` **no** entra en la clave, porque no cambia la respuesta.

**D11 · Nada llega al cable ni a la comisión.**
- El ahorro va en `report.deferred.tierSaving` y en `report.cacheWrites`. Ni `cost.*` ni `UsageWire` cambian.
- Cobrar sobre él exige servidor primero: lista blanca y migración, LICENSE §5 con revisión legal, un interruptor `COMISIONAR_TIER` en `tarifa.ts` y los textos en 12 idiomas. Es **decisión del dueño** (§10).
- Por eso esta unidad no necesita ninguna decisión suya.

**D12 · Coordinación con `feat/catalogo-2026` (la n.º 1, en curso).** Esta unidad **no toca** `catalogo.ts`, `primas.ts` ni `OPENAI_CACHE_TIER`. La tabla nueva vive en un fichero nuevo. Las filas Flex de `gpt-6-*` las añade la que se fusione segunda, porque el test de integridad exige fila estándar propia.

## 4. API pública (inglés; JSDoc en inglés y sin tildes)

```ts
// src/contracts/types.ts — SavingsToggles
/**
 * Declare this request STANDALONE: nothing after its stable prefix will be sent again as
 * the start of a later request (it is not a conversation turn you will continue).
 * Defaults to false. Only acts on OpenAI models that bill prompt-cache writes above the
 * input rate, on OpenAI's own API: the provider may then write its cache only at the
 * stable prefix, or nowhere, instead of at the end of your message. Trade-off: repeats
 * and continuations of this exact prompt lose the cache reads the provider default would
 * give them. See report.cacheWrites. Never changes the answer.
 */
standalone?: boolean;

// DeferredExecutionReport (añadidos)
/** @deprecated Use `tierSaving.amount`; same value. Kept for compatibility. */
estimatedTierSaving?: number;
/** What the served tier was worth on the one call whose tier was read. Present only when credited. */
tierSaving?: PriceLeverSaving;
/** True when the cheaper tier had no capacity and the request was repeated once at the standard tier. */
capacityFallback?: boolean;
// `discountRate` pasa a ser el ratio EFECTIVO appliedCost/standardCost de esa llamada
// (0.5 cuando todos los componentes van a mitad de precio: compatible en el caso común).

export interface PriceLeverSaving {
  /** In your currency unit. Never more than the difference between the two published rate cards on this usage. */
  amount: number;
  /** "measured": the provider's own counter for this call at two published rate cards, the tier read back
   *  from the provider's official API. "estimated": anything short of that; `basisReason` says what. */
  basis: Extract<CostBasis, "measured" | "estimated">;
  /** This call's provider-reported usage at the standard rate card. */
  standardCost: number;
  /** The same usage at the rate card that applied. */
  appliedCost: number;
  /** YYYY-MM-DD: when these rate cards were last checked against the provider's published prices. */
  pricesCheckedOn: string;
  /** One sentence. Never empty. */
  basisReason: string;
}

/** Present whenever `savings.standalone` is true, including when it did nothing. */
export interface CacheWriteReport {
  mode: "explicit" | "provider-default";
  /** Cache breakpoints the layer placed: 0 or 1. With 0 in explicit mode the provider neither reads nor writes its prefix cache. */
  breakpoints: number;
  /** Always basis "estimated": the provider default was not run for this request. */
  avoidedWritePremium?: PriceLeverSaving;
  reason: string;
}
// SavingsReport: + `cacheWrites?: CacheWriteReport;`

// src/pipeline/config.ts — SavingsLayerConfig: + `priceLevers?: PriceLeverSettings;`
export interface PriceLeverSettings {
  /** Default for `savings.deferrable` on every request of this layer. A request's own value wins. Defaults to false. */
  deferrable?: boolean;
  /** Default for `savings.standalone`. A request's own value wins. Defaults to false. */
  standalone?: boolean;
  /** When a deferrable request finds no capacity on the cheaper tier (HTTP 429 or 503): "throw" (default)
   *  surfaces the error unchanged; "standard" repeats it once at the standard tier and price. */
  onCapacityError?: "throw" | "standard";
}

// src/providers/types.ts — ProviderRequest
/** Adapters with explicit prompt-cache control write the provider's cache only at `stablePrefixMessages`
 *  (nowhere when it is undefined) instead of letting the provider choose. Others ignore it. */
explicitCacheWrites?: boolean;
```

`PriceLeverSettings` se exporta igual que `ModelCascadeSettings`: compruébalo en `src/pipeline/index.ts`. Ningún nombre exportado está en español.

## 5. Cambios por fichero

1. **NUEVO `src/pricing/tarifas-de-tier.ts`** (interno, no se reexporta, comentarios en `//`):
   - Tipo `TarifaDeTier { inputPer1k; outputPer1k; cachedInputPer1k?; cacheWritePer1k?; largo?: { estandar: CostModel & {cacheWritePer1k?}; tier: … }; fuente: string; consultado: string }`.
   - `TARIFAS_DE_TIER: Record<"openai"|"google", Record<tierServidoTalCual, Record<claveDeCatalogo, TarifaDeTier>>>` con las filas del §2 (USD/1K).
   - `TARIFAS_DE_TIER_AL_DIA`.
   - `tarifaDeTier(origen, tier, model)`: primero `precioDeListaPropio(model)`, luego `claveDeCatalogo`. Si no es la fila propia, `undefined`.
   - La fila estándar de escritura es `inputPer1k * primaDeEscritura(model)`.
2. **`src/economics/tier-diferido.ts`:**
   - Nueva función pura `valorarTierServido({ modelo, uso, tierServido, origen, precioDelCliente })`. Devuelve `{ok:true, importe, basis, costeEstandar, costeAplicado, factorEfectivo, motivoBasis} | {ok:false, motivo}`, con motivos `"no-served-tier" | "standard-rate-tier" | "unknown-tier" | "no-tier-price" | "no-standard-price" | "incomplete-usage" | "no-difference"`.
   - Se borra `ahorroDelTier`, que tiene un solo llamante.
   - `latenciaDelTier(pedido, origen)`: texto de OpenAI (el de hoy), texto de Google (1–15 min, 429/503, sin paso a estándar, con cita y URL) y texto de origen desconocido. Toda frase incluye la forma del fallo por capacidad.
   - `veredictoDelTier` y `FACTOR_DIFERIDO_MINIMO` **no cambian**, porque los usan el gateway y la referencia.
   - Se actualizan los bloques de diseño: Batch (D7, con la valoración y la evidencia Flex = Batch), DeepSeek (D6) y Bedrock (D5).
3. **NUEVO `src/economics/escrituras-de-cache.ts`:**
   - `explicitaAplicable(model, origen)`: `origen === "openai" && primaDeEscritura(model) > 1`.
   - `tramoParaDecidirExplicita(model)`: `{minimumCacheTokens:1024, cacheReadMultiplier: cached/input de la fila propia, cacheWriteMultiplier: primaDeEscritura}`.
   - `valorarEscriturasEvitadas({uso, fila})`: devuelve `PriceLeverSaving` con basis `estimated`.
4. **`src/providers/atestado-del-cable.ts`:** campos nuevos:
   - `origen: "openai" | "google" | null`
   - `tierLeidoDe?: "cuerpo" | "cabecera"`
   - `cacheExplicita?: { puntos: 0 | 1 }`

   Un proveedor de terceros no atestigua, así que su ahorro queda como mucho en `estimated`.
5. **`src/providers/openai-compatible.ts`:**
   - Origen: `api.openai.com` da `openai`; `generativelanguage.googleapis.com` da `google`; cualquier otro, `null`. Azure no, porque no está documentado.
   - Leer `prompt_tokens_details.cache_write_tokens` y guardarlo en `usage.cacheWriteInputTokens`, en generate y en stream.
   - Si falta `service_tier` en el cuerpo y el origen es `google`, leer la cabecera (según D4).
   - Con `explicitCacheWrites` y `explicitaAplicable`:
     - Mandar `prompt_cache_options: {mode:"explicit"}` (sin `ttl`).
     - Si `stablePrefixMessages > 0` y el mensaje de la frontera tiene contenido de texto, convertirlo en `[{type:"text", text, prompt_cache_breakpoint:{mode:"explicit"}}]`. Si no, cero puntos.
     - Atestiguar los puntos puestos.
   - Sin la marca, **el cuerpo queda byte a byte igual que hoy**.
6. **`src/providers/types.ts`:** añadir `explicitCacheWrites?`.
7. **`src/contracts/types.ts`:** los tipos del §4.
8. **`src/pipeline/config.ts`:** añadir `priceLevers`.
9. **`src/pipeline/pipeline.ts`:**
   - (a) **Normalización de entrada (D10).** Aplicar los valores por defecto de `priceLevers` en la entrada única a la que llaman `generate` y `generateStream`, antes de `canonicalize`.
   - (b) **`informeDeDiferido(toggles, response, precio, modelo)`.** Llama a `valorarTierServido` con el atestado de **esa** respuesta y con `precioDelCliente(modelo)`. Rellena `tierSaving`, `discountRate` efectivo, `estimatedTierSaving` (el mismo importe), `credited = importe > 0` y el motivo en inglés. La latencia se toma de `latenciaDelTier(pedido, origen)`.
   - (c) **`decidirMarcadoDeCache`.** Si `standalone` está activo y el modelo es de la familia OpenAI con `primaDeEscritura > 1`, decide con `tramoParaDecidirExplicita` y con el estado de la verja en la clave `huella + "|explicit"`. Devuelve **el `cacheWriteMultiplier` de siempre** (1 en OpenAI), así que la prima que se carga en `cost.*` no cambia (D11 y D12). `explicitCacheWrites: true` viaja en `peticionAlProveedor`, que la escalada hereda con 0 puntos.
   - (d) **`report.cacheWrites`** se construye desde el atestado. Si no hay atestado, `mode:"provider-default"` y el motivo. `diferidoSinLlamada` gana su gemelo para aciertos de caché y seguidores de singleflight: sin llamada no hay nada que acreditar.
   - (e) **Respaldo D9** alrededor de la primaria. Detecta `/^provider (429|503)\b/`, reintenta una vez sin `deferrable` y no cuenta el intento rechazado en el testigo de facturación. En el informe, `capacityFallback: true`, `requestedTier: "flex"` y `credited: false`.
   - (f) Trazas `deferred-tier` (ya existe) y `cache-writes` (nueva), con motivos en inglés.
10. **Sin tocar:** `gateway/*`, `apps/web/*`, `catalogo.ts`, `primas.ts`, `cache-tier.ts`, `referencia.ts` y `emitter.ts`.

## 6. Dependencias

Ninguna. Los tests de propiedad usan el `mulberry32` en línea que ya usa `test/referencia-es-suelo.test.ts`, así que no hace falta `fast-check`. `pnpm-lock.yaml` no cambia.

## 7. Tests

**Propiedad** (500 semillas por fila, `mulberry32`), en **`test/palancas-precio-propiedad.test.ts`** (nuevo):
- **P1:** para cada fila (origen, tier, modelo) y un `usage` aleatorio (`cached ≤ input`, `writes ≤ input − cached`, salida, `complete` a veces falso):
  - `real − 1e‑10 ≤ importe ≤ real`, donde `real = Σ_c u_c·(std_c − tier_c)` se calcula en el test **directamente de las tablas**.
  - `importe ≥ 0`.
  - `measured` solo cuando se cumplen M1–M6.
  - Con `complete: false` no hay valoración.
- **P2:** ids que no son fila propia (sufijo de letra, versión, `vendor/`), tier ausente o desconocido y tiers `default`/`auto`/`priority`/`scale`: nunca hay crédito `measured`, y con tier estándar o desconocido no hay ninguno.
- **P3 (la referencia sigue siendo suelo):** `FACTOR_DIFERIDO_MINIMO ≤` todo ratio `tier_c/std_c` de la tabla.
- **P4:** toda fila de tier cumple `tier_c ≤ std_c`, `cached ≤ input` y `escritura ≥ input`. Si hay contexto largo, `(std_largo_c − tier_largo_c) ≥ (std_c − tier_c)`: valorar a tarifa corta nunca se pasa.
- **P5 (explícito):** `avoidedWritePremium.amount == ordinarios·(fila.escritura − fila.entrada)`, con 0 si `input < 1024`. Basis siempre `estimated`. Nunca aparece sin origen `openai` ni con `primaDeEscritura == 1`.

**Integridad**, en **`test/tarifas-de-tier.test.ts`** (nuevo):
- Toda fila tiene fila estándar propia (`precioDeListaPropio`).
- `fuente` apunta a `developers.openai.com/api/docs/pricing` o `ai.google.dev/gemini-api/docs/pricing`.
- `consultado` tiene formato `YYYY-MM-DD` y es `≤ TARIFAS_DE_TIER_AL_DIA`.

**`test/tier-diferible.test.ts`** (se actualiza):
- Los casos del pipeline pasan de `gpt-4o-mini`, que no tiene fila Flex, a `openai/gpt-5-mini`, con `baseUrl` `https://api.openai.com/v1`.
- Casos nuevos:
  - `gpt-4o-mini` servido como flex: sin crédito y con motivo `no-tier-price`.
  - **Regresión:** `gemini-2.5-pro` servido como flex con tokens cacheados. El componente cacheado da 0: antes se acreditaba la mitad.
  - Cabecera de Gemini en el host oficial, y la misma cabecera ignorada en otro host.
  - `costModels` declarado: `estimated`.
  - `baseUrl` no oficial: `estimated`.
  - `estimatedTierSaving === tierSaving.amount`.

**`test/cache-explicita-openai.test.ts`** (nuevo):
- Cuerpo con `mode:"explicit"` y el breakpoint en el índice `stablePrefixMessages−1` cuando la verja marca; cero breakpoints cuando no marca o no hay prefijo.
- Sin `standalone`, **el cuerpo es idéntico al de hoy** (comparación exacta).
- `gpt-5.4`, Gemini, Anthropic o un host no oficial: cuerpo sin cambios y `report.cacheWrites.mode === "provider-default"` con su motivo.
- La lectura de `cache_write_tokens`.

**`test/respaldo-de-capacidad.test.ts`** (nuevo):
- 429 y luego 200 con `"standard"`: dos fetch, `capacityFallback: true`, sin crédito y el segundo cuerpo sin `service_tier`.
- Con `"throw"` o sin configurar: el error de hoy.
- 400: nunca hay respaldo.

**Configuración:**
- `priceLevers.deferrable` hace que el cuerpo lleve `flex` y cambia la clave de caché igual que el valor por petición.
- `savings.deferrable:false` le gana a la configuración.
- `standalone` no parte la caché exacta.

**Cable:** con `tierSaving` y `cacheWrites` presentes, las claves de `toWire` son las mismas de siempre. `cost.baselineEstimate`, `actual`, `netSavings` y `basis` son idénticos con y sin las palancas (el test existente de `netSavings` se amplía).

**Verjas que tienen que seguir en verde:**
- `superficie-publica-limpia`: no sube el techo de 81 líneas con tildes, no aparecen rutas ni nombres de terceros.
- `dx-empaquetado`, `licencia-alineada` (el cable no cambia), `referencia-es-suelo`, `banco-propio-nunca-factura`.
- `readme-alineado`: nada de «≥ N %».
- `parity`, `cifra-del-heroe` y `tarifa-en-parametros` siguen igual porque `apps/web` no se toca.

## 8. Documentación

- **README**: nuevo bloque `<details>` **«Provider price levers (opt-in, off by default)»**, en inglés, sin cifras de ahorro ni «≥». Tiene que decir:
  - `deferrable` pide el tier Flex en OpenAI y en Gemini a través de su endpoint OpenAI‑compatible. Anthropic no tiene tier síncrono barato: su descuento vive solo en Message Batches, que la capa aún no soporta. Bedrock y DeepSeek fuera de punta no están soportados.
  - **Latencia:** OpenAI no publica compromiso de latencia; Google publica un objetivo de minutos. No va en caminos que ve el usuario.
  - **Riesgo:** sin capacidad, 429/503. OpenAI documenta que no se cobra. `priceLevers.onCapacityError: "standard"` repite una vez a precio estándar.
  - **Qué vale:** el contador del proveedor de esa llamada a las dos tarifas publicadas, con su fecha. Es `measured` solo si el tier se leyó de la API oficial y los precios son los de catálogo; si no, `estimated`. **No entra en `cost.*` ni en la comisión.**
  - `standalone` en GPT‑5.6+: dónde puede escribir la caché el proveedor, el coste en repeticiones y continuaciones, y que siempre es `estimated`.
  - Un ejemplo corto con `report.deferred.tierSaving` y `report.cacheWrites`.
- **`src/economics/tier-diferido.ts`**: los bloques de diseño de D5–D7.
- **Informe por petición:** `deferred.latency` y `cacheWrites.reason` llevan latencia y riesgo, porque así lo pide la tarea.

## 9. Commits (`git commit -F <fichero> --only -- <rutas>`, en español, con `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`)

1. `feat(precios): la tabla de tarifas por tier — cada precio con su página oficial y su fecha`: `tarifas-de-tier.ts` y su test.
2. `fix(diferido): el tier se tarifa por modelo y por componente — la lectura cacheada de Gemini dejaba de estar a mitad de precio y se acreditaba igual`: `tier-diferido.ts`, atestado, adaptador (origen, cabecera, `cache_write_tokens`), tipos, pipeline (b) y tests P1–P4.
3. `feat(openai): peticiones standalone — el proveedor escribe su caché solo en el prefijo estable, o en ninguna parte`: `escrituras-de-cache.ts`, adaptador, pipeline (c, d), tipos y tests P5.
4. `feat(diferido): respaldo opcional al tier estándar cuando Flex no tiene capacidad`.
5. `feat(config): las palancas de precio por configuración, sin tocar la clave de caché de quien no las pide`.
6. `docs(readme): las palancas de precio del proveedor, con su latencia y su riesgo`.

**Verificación:** `pnpm -s build:all && git checkout -- apps/web/public/vendor/bv-sala.js`; `pnpm -s run typecheck:all`; `pnpm --dir apps/web run typecheck`; `pnpm -s exec vitest run --reporter=dot`. `apps/web` no se toca. No se sube la versión. `bv-sala.js` no se commitea.

## 10. Pasos del dueño

1. Revisar y fusionar el PR. Solo tú fusionas.
2. **Decidir si el carril de tier (`measured`) entra en la comisión.** Es una unidad aparte y va servidor primero:
   - campo opcional en la lista blanca del ingest y migración;
   - LICENSE §5 con revisión legal;
   - `COMISIONAR_TIER` en `tarifa.ts` y su test;
   - carril en `extracto.ts` y en el cierre;
   - textos en 12 idiomas;
   - y solo después, el emisor del SDK.

   Sin esto no se puede medir la señal de éxito de la n.º 9 («ahorro `measured` por encima del 1 % de la factura»), porque el carril no llega al servidor.
3. **Comprobación en vivo con credenciales del banco** (el implementador no las toca):
   - una llamada Flex con `gpt-5-mini` y otra con `gemini-2.5-flash`, para confirmar el tier servido, la cabecera de Gemini y la línea de factura;
   - una llamada `standalone` con `gpt-5.6-luna`, para confirmar `prompt_tokens_details.cache_write_tokens` en Chat Completions;
   - qué contesta OpenAI a `flex` en un modelo no listado (`gpt-4o-mini`). Si es un 400, el adaptador debería dejar de pedirlo.
4. **Orden de fusión con `feat/catalogo-2026`.** La que se fusione segunda añade las filas Flex de `gpt-6-*`. La n.º 1 extiende `primaDeEscritura` a GPT‑6, y con eso `standalone` pasa a actuar también en GPT‑6.
5. Programar o descartar Batch (sobre todo Anthropic), DeepSeek y Bedrock (D5–D7).
6. Publicar en la próxima release.

## 11. Hallazgos fuera de alcance (para otras unidades)

- **H1 (n.º 1):** el SDK no carga la prima de escritura de 1,25× de GPT‑5.6+ en `cost.actual`. `OPENAI_CACHE_TIER` (lectura 0,5, escritura 1) está desfasado para gpt‑5+, que lee a 0,1, y para 5.6+, que escribe a 1,25. Esto también sesga la política de compresión.
- **H2 (n.º 1):** `gemini-3.5-flash-lite` tiene `cachedInputPer1k: 0.00003` en el catálogo, pero la página de precios dice «Context Caching Not available».
- **H3 (gateway):** `costeMedido` tarifa a precio estándar las respuestas servidas en Flex. El gasto que ve el panel sale ×2 para ese tráfico. La comisión no se ve afectada, porque ahí el baseline es igual al actual.
- **H4:** el adaptador manda `service_tier: "flex"` a cualquier endpoint (DeepSeek, Bedrock, modelos sin Flex) y no sabemos cómo responde cada uno. Queda cubierto en el paso 3 del dueño.

## 12. Fuentes (consultadas el 2026‑09‑27)

- OpenAI, precios: https://developers.openai.com/api/docs/pricing
- OpenAI, prompt caching: https://developers.openai.com/api/docs/guides/prompt-caching
- OpenAI, Flex: https://developers.openai.com/api/docs/guides/flex-processing
- OpenAI, changelog (9‑jul, 8‑sep y 22‑sep‑2026): https://developers.openai.com/api/docs/changelog
- openai‑node, tipos de Chat Completions: https://github.com/openai/openai-node/blob/master/src/resources/chat/completions/completions.ts
- Gemini, Flex: https://ai.google.dev/gemini-api/docs/flex-inference
- Gemini, precios: https://ai.google.dev/gemini-api/docs/pricing
- Gemini, compatibilidad OpenAI: https://ai.google.dev/gemini-api/docs/openai
- Google, anuncio de Flex y Priority (2‑abr‑2026): https://blog.google/innovation-and-ai/technology/developers-tools/introducing-flex-and-priority-inference/
- AWS Bedrock, service tiers: https://docs.aws.amazon.com/bedrock/latest/userguide/service-tiers-inference.html
- DeepSeek, precios: https://api-docs.deepseek.com/quick_start/pricing
- Informe de competencia: `origin/docs/bitacora-2026-09-26:docs/COMPETENCIA-2026-09-26.md`, §3 (fila «Descuento por diferir» y caché de prefijo), §4.1 (Batch y Flex) y §8 n.º 9.

Las cifras de precio del §2 llegaron a través de un resumidor web. El implementador las vuelve a leer en la página oficial antes de teclearlas, y si hay discrepancia manda la página.