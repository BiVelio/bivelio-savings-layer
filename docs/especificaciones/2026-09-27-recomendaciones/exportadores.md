# Especificación: unidad «exportadores» (recomendación n.º 11)

**Base:** `origin/main` `f157462` (26‑sep‑2026). Rama `feat/exportar-libros`, worktree `/Users/fisagol/bsl-exportadores`. Todavía no existe; lo crea el implementador según las reglas duras. Todas las fuentes externas se consultaron el **27‑sep‑2026**.
**Motivo (informe §8 n.º 11, fuentes [84][85][86]):** Langfuse, Datadog y Vantage miden el gasto, pero no tienen dónde apuntar el ahorro. Esta unidad lo exporta desde el propio proceso del cliente. No envía nada a BiVelio, no toca el cable (`UsageWire`), no añade precios y no necesita ninguna decisión del dueño antes de hacer merge.

---

## 0. Alcance e invariantes

**Entra**
- (a) Atributos OpenTelemetry. Las convenciones GenAI publicadas más un espacio propio `com.bivelio.*`, en un span que crea un envoltorio o en un span que ya tenga el cliente.
- (b) Langfuse por OTel, más una función para `@langfuse/tracing`. Guía para Datadog LLM Observability por OTLP.
- (c) Filas FOCUS 1.4 y una serie diaria de ahorro (para Vantage, Finout y CloudZero), con un escritor CSV.
- Tests, README y dos ejemplos.

**No entra:** exportadores de red, métricas OTel, integración con el gateway `bvsala`, cambios en `SavingsReport`, en `UsageWire` o en la LICENSE, gating por licencia, web y 12 idiomas.

**Invariantes, cada una con su test:**
1. **Cero red.** Las funciones son puras. El envoltorio solo llama al tracer que le pasa el cliente.
2. **Cero contenido.** Solo salen ids, contadores, dinero y enumerados. Nunca `traces`, mensajes, respuestas, argumentos de herramientas, errores de validación ni `error.message`.
3. **Nunca se mezclan bases.** El dinero ahorrado va en una clave por basis (`…measured`, `…reference`, `…estimated`). No existe ningún campo que sume bases. `shadow` nunca se exporta. `unmeasured` sale con contadores y con el dinero a null o ausente.
4. **El signo se conserva.** Un ahorro negativo sale negativo.
5. **Fail‑open en el camino de la petición.** Un fallo de telemetría nunca cambia el resultado ni el error de `generate()`.
6. **FOCUS no suma gasto.** `BilledCost`, `EffectiveCost`, `ListCost` y `ContractedCost` valen 0 en todas las filas.

---

## 1. Hechos verificados que condicionan el diseño

| # | Hecho | Fuente |
|---|---|---|
| H1 | **`report.cost.netSavings` es una PROPORCIÓN, no dinero**: `1 − actual/baseline`, redondeada a 1e‑6. El dinero es `baselineEstimate − actual`, en USD y redondeado a 1e‑10 (`roundUsd`). El README ya dice «0..1 ratio». | `src/tokenizer/accounting.ts` (`estimateCost`, `roundUsd`, `roundRatio`); README §«Wrap the call» |
| H2 | El catálogo está en USD. Si `costModels` usa otra unidad, el informe no lo dice. | `src/pricing/catalogo.ts` («Prices are USD per 1,000 tokens») |
| H3 | `SavingsReport` no lleva marca de tiempo; el emisor pone `at` al registrar. El informe no desglosa las escrituras de caché (solo `providerCachedInput`, que son lecturas). | `contracts/types.ts`, `metering/emitter.ts` (`UsageWire.at`) |
| H4 | `tokens.actualInput` es el contador del proveedor e incluye las lecturas y escrituras de caché. El adaptador de Anthropic suma `input + cache_creation + cache_read`. | `providers/anthropic.ts` l. 282 y 802 |
| H5 | Las GenAI semconv **publicadas** más recientes son las de `semantic-conventions` **v1.41.1 (2026‑05‑11)**. La v1.42.0 (2026‑06‑12) las marca como obsoletas en el núcleo y las traslada a `open-telemetry/semantic-conventions-genai`, que **aún no tiene releases** (manifest `1.42.0-dev`). Diferencia relevante: en v1.41.1 existe `gen_ai.usage.cache_creation.input_tokens`, que en el main del repo nuevo se llama `cache_write.input_tokens`. Los dos coinciden en `cache_read.input_tokens`, `input_tokens`, `output_tokens`, `provider.name` (que sustituye a `gen_ai.system`), `request.stream` y `response.time_to_first_chunk`. `input_tokens` «SHOULD include … cached tokens». | API de GitHub (releases); `v1.41.1/model/gen-ai/registry.yaml`; `semantic-conventions-genai/model/{manifest,gen-ai/registry}.yaml` |
| H6 | **No hay atributo de coste en GenAI.** `gen_ai.usage.cost.*` está en la PR abierta #443 y en la issue #484. | semantic-conventions-genai #443 y #484 |
| H7 | Para atributos de una empresa, OTel recomienda el dominio inverso (`com.acme.*`) y no reutilizar espacios de nombres de semconv. | `semantic-conventions/v1.44.0/docs/general/naming.md` |
| H8 | Langfuse: `langfuse.observation.metadata.*` se convierte en metadata de primer nivel y filtrable. Lo demás cae en `metadata.attributes`, que no es filtrable. `langfuse.observation.cost_details` es un JSON. Resta las lecturas y escrituras de caché de `gen_ai.usage.input_tokens`. **Por defecto el procesador de TS solo exporta spans con algún `gen_ai.*`** (o scopes conocidos). El SDK serializa la metadata como `langfuse.observation.metadata.<clave>` con valor string. La generación acepta `model`, `usageDetails: Record<string,number>`, `costDetails: Record<string,number>` y `metadata`. Los precios por defecto aceptan el prefijo `openai/` y `anthropic/`, y tienen la clave `cache_read_input_tokens`. Si llega un coste ingerido, tiene prioridad sobre el inferido. | langfuse.com/integrations/native/opentelemetry; /docs/observability/sdk/advanced-features; /docs/observability/features/token-and-cost-tracking; npm `@langfuse/tracing` y `@langfuse/core` 5.11.1 (2026‑09‑09); `langfuse/langfuse` `worker/src/constants/default-model-prices.json` |
| H9 | Datadog LLM Obs acepta OTLP con la cabecera `dd-otlp-source=llmobs` y semconv GenAI ≥1.37. Clasifica el span por `gen_ai.operation.name` (`chat` → `llm`). Mapea `gen_ai.conversation.id` a `session_id`, `provider.name` a `meta.model_provider` y `response.model` a `meta.model_name`. **Los atributos que no son `gen_ai.*` se convierten en tags** (valores de hasta 256 caracteres). `_dd.ml_obs.metadata` (un objeto JSON en string) se fusiona en `meta.metadata`. **Descarta los spans sin ningún `gen_ai.*`.** El coste lo estima con precios públicos. | docs.datadoghq.com/llm_observability/instrumentation/otel_instrumentation/; …/monitoring/cost/ |
| H10 | **FOCUS vigente: v1.4 (2026‑06‑04).** Todo lo siguiente es literal de la especificación. `BilledCost` «MUST reflect amounts as invoiced … not estimated or inferred» y «MUST be 0 for charges generated by entities that are not responsible or authorized for invoicing, to avoid double‑counting». `EffectiveCost` «MUST be 0 for charges generated by entities that do not originate the cost». `ListCost` y `ContractedCost` son iguales a `BilledCost` si no hay precio unitario. Con `ChargeCategory="Usage"` son obligatorios `SkuId`, `SkuPriceId` y `PricingQuantity`, cosa que no es posible sin inventar SKU. Con `"Adjustment"` pueden ser null. `ConsumedQuantity` debe ser null cuando la categoría no es `Usage`. Las columnas propias llevan prefijo `x_`, PascalCase, solo alfanuméricos, un máximo de 50 caracteres y ninguna abreviatura salvo `Id`. Fechas en `YYYY-MM-DDTHH:mm:ssZ`. Monedas ISO 4217. Null en vez de placeholder. `ProviderName` y `PublisherName` ya no existen en 1.4 (`ServiceProviderName`, `HostProviderName` e `InvoiceIssuerName` existen desde 1.3 o antes). | GitHub `FOCUS_Spec` tag `v1.4`, `specification/datasets/cost_and_usage/columns/*.md`, `attributes/*.md` |
| H11 | **Vantage** Custom Providers: acepta columnas de FOCUS 1.1–1.3 y obliga solo a `ChargeCategory`, `ChargePeriodStart`, `BilledCost` y `ServiceName`. Admite las demás columnas FOCUS pero **no las usa**, y las `x_` no las menciona. Tags en JSON. Límite de 10.000 filas o 2 MB por fichero. **Business Metrics:** CSV `date,amount,<labels…>` con agregación diaria. | docs.vantage.sh/connecting_custom_providers; /per_unit_costs |
| H12 | **Finout**: acepta «any FOCUS file … as a custom cost center», enviándolo a soporte. Tiene además «S3 CSV Telemetry» (fecha, dimensiones, métrica). | docs.finout.io …/focus-in-finout.md; …/s3-csv-telemetry.md |
| H13 | **CloudZero**: AnyCost ingiere **CBF**. Su referencia (actualizada el 2026‑07‑16) no menciona FOCUS y acepta ceros explícitos. Tiene además Telemetry Streams por CSV o API (actualizado el 2026‑05‑27). | docs.cloudzero.com/docs/anycost-common-bill-format-cbf; /telemetry-streams |
| H14 | npm: `@opentelemetry/api` 1.9.1 (2026‑03‑25). `@opentelemetry/sdk-trace-base` 2.11.0 (2026‑08‑31), con peer `@opentelemetry/api >=1.3.0 <1.10.0` y engines `^18.19.0 \|\| >=20.6.0`; hoy reexporta `@opentelemetry/sdk-trace`. CI usa Node 20. | registry.npmjs.org |

---

## 2. Decisiones y su porqué

- **D1. Tipos estructurales; ningún `import` de `@opentelemetry/api` en `src/`.** Es el mismo patrón que `gpt-tokenizer` («Tipado aquí para no depender de sus tipos», `tokenizer/exact.ts`). Hay cuatro razones:
  - Un `import type` del peer opcional acabaría en el `.d.ts` público y rompería el typecheck de quien no lo tenga instalado.
  - El bundle web `bv-sala.js` se construye con el mismo `src/index.ts`.
  - No hay coste en tiempo de ejecución.
  - La compatibilidad con los tipos reales la demuestra un test que compila contra `@opentelemetry/api`, instalado como devDependency.

  `@opentelemetry/api` se declara **peer opcional `^1.9.0`**, que es lo que prueba la CI. Ensanchar el rango más adelante no rompe nada.
- **D2. El espacio propio es `com.bivelio.*`,** porque OTel recomienda el dominio inverso para atributos que un proveedor distribuye (H7).
- **D3. Solo se usan claves GenAI de v1.41.1 que siguen vigentes en el main del repo nuevo** (H5). `cache_creation` o `cache_write` no se emiten porque el informe no desglosa las escrituras (H3). Así el cambio de nombre pendiente no afecta. No se emite coste GenAI (H6): el coste va en `com.bivelio.cost.*`.
- **D4. El dinero ahorrado es `baselineEstimate − actual`, con una clave por basis. `netSavings` se exporta como proporción y nunca se agrega** (H1). La proporción de un grupo se deriva de las sumas; no se publica.
- **D5. El envoltorio emite siempre `gen_ai.*`,** también en las llamadas evitadas: `usage` a 0, que es verdad porque no se facturaron tokens. Si faltaran, Langfuse no exportaría el span y Datadog lo descartaría (H8, H9). Con basis `unmeasured` **no** se ponen atributos de uso, porque ausente no es lo mismo que 0 (doctrina de `ProviderUsage`).
- **D6. `recordSavingsOnSpan` no pone `gen_ai.*` por defecto.** El span activo del cliente puede ser un span HTTP, y marcarlo como LLM falsearía Datadog. Con `genAi: true` pone solo el uso y `response.model`.
- **D7. `gen_ai.*.model` va sin el prefijo de proveedor cuando ese prefijo es conocido.** Es el id que recibe OpenAI (ver `quitarPrefijoDeProveedor`) y el que casa con las tablas de precio de Langfuse. El id completo va en `com.bivelio.model.id`.
- **D8. `gen_ai.provider.name` sale de una tabla de prefijos** con los valores bien conocidos de v1.41.1: `openai`, `anthropic`, `google`→`gcp.gen_ai` («Any Google generative AI endpoint … when specific backend is unknown»), `mistral`→`mistral_ai`, `deepseek`, `groq`, `xai`→`x_ai`, `cohere`, `perplexity`. Un prefijo desconocido sale tal cual. Sin prefijo, el atributo se omite y se documenta `providerName`.
- **D9. Nombre del span:** `chat {gen_ai.request.model}`, kind `CLIENT` (=2) y `startActiveSpan`, para que los spans HTTP del proveedor cuelguen de él. Los atributos de la petición van al arrancar el span, porque influyen en el muestreo. En caso de error: estado `ERROR` (=2) y `error.type = err.name ?? "_OTHER"`, **sin mensaje y sin `recordException`**, porque un error del proveedor puede repetir el contenido. Si el stream se aborta, se añade `com.bivelio.stream.request_sent` (el proveedor puede facturar tokens que no aparecen en ningún informe).
- **D10. El envoltorio devuelve los mismos objetos** (el `result` y el `SavingsStream`, con identidad `toBe`) y relanza el mismo error. Si `startActiveSpan` lanza antes de ejecutar la función, se llama a la capa sin span. Si el tracer no es válido, `TypeError` al llamar a `instrumentSavingsLayer()`: es un error de configuración y aparece al arrancar, no en cada petición.
- **D11. Langfuse y Datadog van como opciones de la misma función de atributos:**
  - `langfuse.metadata` genera `langfuse.observation.metadata.bivelio_*` (valores string, como hace su SDK).
  - `langfuse.cost` genera `langfuse.observation.cost_details={"total":actual}`.
  - `datadog.metadata` genera `_dd.ml_obs.metadata`.

  Todas están **apagadas por defecto**. Sin ellas, Langfuse calcula el coste con su tabla y la configuración del cliente no cambia. Además, `toLangfuseGeneration()` sirve a quien use `@langfuse/tracing` a mano. Sus `usageDetails` son cubos exclusivos, `input = actualInput − providerCachedInput` (H8), y `costDetails` solo sale con `includeCost`.
- **D12. FOCUS: `ChargeCategory = "Adjustment"`** y los cuatro costes a 0 (H10).
  - `Usage` obligaría a inventar `SkuId`, `SkuPriceId` y `PricingQuantity`, cosa que prohíbe el principio de «ninguna cifra sin fuente».
  - `Adjustment` es la única categoría en la que esas columnas pueden ser null.
  - Con los costes a 0, al unir estos datos con la factura del proveedor no se duplica nada, que es exactamente para lo que FOCUS pide ceros.

  El ahorro va en columnas `x_BiVelio*`, una por basis, y en `Tags`. Es reversible: la exportación la genera el cliente.
- **D13. `ServiceProviderName` es el proveedor LLM** (`"OpenAI"`, `"Anthropic"`…) para que estas filas se agrupen junto a su gasto. Por defecto, `InvoiceIssuerName` y `HostProviderName` son el mismo proveedor y se pueden cambiar (Bedrock, Azure, pasarelas). `ServiceName` por defecto es `"BV-SALA savings ledger"`. Con un prefijo desconocido y sin opción, **`TypeError`**, porque FOCUS no admite placeholders (H10). `BillingAccountId` es **obligatorio** en las opciones: sirve de clave para cruzar con la factura y el SDK no lo conoce.
- **D14. Serie diaria `toSavingsSeries`,** porque Vantage ignora las columnas `x_` (H11) y en Finout y CloudZero el ahorro encaja como telemetría o métrica, no como coste (H12, H13). Es el mismo agregado que FOCUS. En Vantage el ejemplo genera **un fichero por basis**, así que una Business Metric nunca mezcla bases.
- **D15. Sin gating por licencia ni `Feature` nueva.** Son datos del propio cliente, los informes ya salen de un `generate()` con licencia, y un literal nuevo tocaría protocolo, Stripe y trial (`features-en-paridad`), que son decisiones del dueño.
- **D16. Fechas y números.** UTC; `ChargePeriod` por hora o día (día por defecto). `BillingPeriod` por defecto es el mes natural UTC, con opción de cambiarlo y documentado como supuesto. Los números en CSV van en decimal plano, sin exponente, con hasta 10 decimales (la misma precisión que `roundUsd`), `-0` se escribe `0`, y null se escribe como campo vacío sin comillas. CSV según RFC 4180, con CRLF.

---

## 3. API pública (inglés; va entera al `.d.ts`)

```ts
// ── Shared ──────────────────────────────────────────────────────────────────
/** The parts of a SavingsReport the exporters read. A full SavingsReport satisfies it,
 *  and so does a stored copy without `traces`. */
export type SavingsReportForExport =
  Pick<SavingsReport, "requestId" | "model" | "calls" | "tokens" | "cache" | "cost"> &
  Partial<Pick<SavingsReport, "qualityStatus" | "modelCascade" | "latencyMs" | "streaming">>;

/** One report and when its request was made (ISO 8601 string, epoch ms or Date). */
export interface SavingsRecord { at: string | number | Date; report: SavingsReportForExport; }

// ── OpenTelemetry (structural: no dependency on @opentelemetry/api) ────────
export type SpanAttributeValue = string | number | boolean | string[];
export type SavingsSpanAttributes = Record<string, SpanAttributeValue>;
export interface SpanLike {
  setAttributes(attributes: SavingsSpanAttributes): unknown;
  setStatus?(status: { code: number; message?: string }): unknown;
  end(): void;
  isRecording?(): boolean;
}
export interface SpanStartOptionsLike { kind?: number; attributes?: SavingsSpanAttributes; }
export interface TracerLike {
  startActiveSpan<T>(name: string, options: SpanStartOptionsLike, fn: (span: SpanLike) => T): T;
}
/** `trace` from @opentelemetry/api, or any TracerProvider. */
export interface TracerProviderLike { getTracer(name: string, version?: string): TracerLike; }

export interface SavingsAttributeOptions {
  /** ISO 4217 code of the report's money. Default "USD" (the built-in price catalog). */
  currency?: string;
  /** Mirror the figures as filterable Langfuse metadata; `cost` also sets cost_details. */
  langfuse?: { metadata?: boolean; cost?: boolean };
  /** Mirror the figures in `_dd.ml_obs.metadata` for Datadog LLM Observability. */
  datadog?: { metadata?: boolean };
}
export interface SavingsSpanOptions extends SavingsAttributeOptions {
  /** Also write GenAI usage and response.model. Default false: your span may not be an LLM span. */
  genAi?: boolean;
}
export interface SavingsTracingOptions extends SavingsAttributeOptions {
  tracer: TracerLike | TracerProviderLike;
  /** gen_ai.provider.name. Default: derived from the model id prefix. */
  providerName?: string;
}

export function savingsSpanAttributes(report: SavingsReportForExport, options?: SavingsAttributeOptions): SavingsSpanAttributes;
export function recordSavingsOnSpan(span: SpanLike, report: SavingsReportForExport, options?: SavingsSpanOptions): void;
/** Returns a SavingsLayer that opens one span per request. Same results, same errors. */
export function instrumentSavingsLayer(layer: SavingsLayer, options: SavingsTracingOptions): SavingsLayer;

// ── Langfuse (@langfuse/tracing users) ──────────────────────────────────────
export interface LangfuseGenerationUpdate {
  model: string;
  usageDetails?: Record<string, number>;
  costDetails?: Record<string, number>;
  metadata: Record<string, string | number>;
}
export function toLangfuseGeneration(
  report: SavingsReportForExport,
  options?: { currency?: string; includeCost?: boolean },
): LangfuseGenerationUpdate;

// ── FinOps ──────────────────────────────────────────────────────────────────
export interface SavingsSeriesOptions {
  granularity?: "hour" | "day";            // default "day"
  currency?: string;                       // default "USD"
  dimensions?: (record: SavingsRecord) => Record<string, string> | undefined;
}
export type SavingsSeriesRow = {
  periodStart: string; periodEnd: string; date: string;    // ISO UTC; date = YYYY-MM-DD
  model: string; basis: CostBasis; currency: string;
  requests: number; providerCalls: number; avoidedCalls: number;
  baselineCost: number | null; actualCost: number | null;  // null when basis is "unmeasured"
  measuredSavings: number | null; referenceSavings: number | null; estimatedSavings: number | null;
  eliminatedInputFloorCost: number | null;
  baselineInputTokens: number; actualInputTokens: number; eliminatedInputTokens: number;
  compressedInputTokens: number; providerCachedInputTokens: number;
  baselineOutputTokens: number; actualOutputTokens: number; eliminatedOutputTokens: number;
  dimensions: Readonly<Record<string, string>>;
};
export function toSavingsSeries(records: Iterable<SavingsRecord>, options?: SavingsSeriesOptions): SavingsSeriesRow[];

export interface FocusExportOptions {
  billingAccountId: string | ((record: SavingsRecord) => string);          // required
  billingAccountName?: string | ((record: SavingsRecord) => string | undefined);
  subAccount?: (record: SavingsRecord) => { id: string; name: string } | undefined;
  serviceProviderName?: string | ((model: string) => string);
  invoiceIssuerName?: string | ((model: string) => string);
  hostProviderName?: string | ((model: string) => string);
  serviceName?: string;                                                    // default "BV-SALA savings ledger"
  billingPeriod?: (chargePeriodStart: Date) => { start: Date; end: Date }; // default: calendar month, UTC
  tags?: (record: SavingsRecord) => Record<string, string> | undefined;    // "bivelio/" prefix is reserved
  granularity?: "hour" | "day";
  currency?: string;
}
/** A FOCUS 1.4 Cost and Usage row. Never a charge: every cost column is 0. */
export type FocusRow = { BilledCost: 0; EffectiveCost: 0; ListCost: 0; ContractedCost: 0; /* … §4.3 */ };
export function toFocusRows(records: Iterable<SavingsRecord>, options: FocusExportOptions): FocusRow[];

export type CsvValue = string | number | boolean | null | undefined;
export function toCsv(rows: readonly Readonly<Record<string, CsvValue>>[], options?: { columns?: readonly string[] }): string;
```

- `FocusRow` y `SavingsSeriesRow` son alias `type` y no `interface`, para que se puedan asignar a `Record<string, CsvValue>`.
- Los mensajes de error van en inglés, con el prefijo `[bvsala]`, y nunca incluyen contenido; como mucho un `requestId`.
- Validaciones que lanzan `TypeError` (solo en las funciones por lotes):
  - `currency` distinto de `/^[A-Z]{3}$/`;
  - `billingAccountId` vacío;
  - `at` que no es una fecha válida;
  - una clave de tag que empieza por `bivelio/`;
  - una dimensión que coincide con una clave fija de la serie;
  - un proveedor FOCUS que no se puede inferir.

---

## 4. Catálogos

### 4.1 Atributos OTel

**GenAI (v1.41.1).** Los emite el envoltorio; `recordSavingsOnSpan` solo con `genAi: true`, y entonces solo los marcados con *.

| Atributo | Valor | Cuándo |
|---|---|---|
| `gen_ai.operation.name` | `"chat"` | siempre |
| `gen_ai.provider.name` | `providerName` o la tabla D8 | si se puede determinar |
| `gen_ai.request.model` | `request.model` sin prefijo conocido | siempre |
| `gen_ai.request.temperature` / `.seed` / `.max_tokens` | `request.temperature` / `seed` / `response.maxOutputTokens` | si vienen |
| `gen_ai.request.stream` | `true` | `generateStream` |
| `gen_ai.conversation.id` | `request.context.sessionId` | si viene |
| `gen_ai.response.model`* | `report.model` sin prefijo | con resultado |
| `gen_ai.response.finish_reasons` | `[result.finishReason]` | si viene |
| `gen_ai.response.time_to_first_chunk` | `streaming.firstEventMs / 1000` | stream `live` |
| `gen_ai.usage.input_tokens`* / `.output_tokens`* | `tokens.actualInput` / `actualOutput` | basis ≠ `unmeasured` (0 si la llamada se evitó) |
| `gen_ai.usage.cache_read.input_tokens`* | `tokens.providerCachedInput` | definido y basis ≠ `unmeasured` |
| `error.type` | `err.name` o `"_OTHER"` | rechazo |

**Propios (siempre).** El dinero va en `currency`.

| Atributo | Valor |
|---|---|
| `com.bivelio.request_id` | `report.requestId`, el mismo id que lleva el registro de uso (LICENSE §5) |
| `com.bivelio.sdk.version` | `BV_SALA_VERSION` |
| `com.bivelio.model.id` / `.requested_id` | `report.model` / `modelCascade.requestedModel` (si existe) |
| `com.bivelio.cost.basis` / `.currency` | basis / moneda |
| `com.bivelio.cost.baseline` / `.actual` | `baselineEstimate` / `actual` (se omiten si es `unmeasured`) |
| `com.bivelio.cost.saved.measured` \| `.reference` \| `.estimated` | `round1e-10(baseline − actual)`; **solo la clave de su basis**; ninguna con `unmeasured` o `shadow` |
| `com.bivelio.cost.net_savings_ratio` | `cost.netSavings` (no con `unmeasured` ni `shadow`) |
| `com.bivelio.cost.eliminated_input_floor` | `eliminatedInputFloorCost` si existe (carril aparte) |
| `com.bivelio.calls.baseline` / `.actual` / `.avoided` / `.retries` | `calls.*` |
| `com.bivelio.tokens.{baseline_input, actual_input, eliminated_input, compressed_input, provider_cached_input, baseline_output, actual_output, eliminated_output}` | los libros; `provider_cached_input` solo si está definido |
| `com.bivelio.cache.result` / `.reference_request_id` / `.reference_rejected` | `cache.result` / `cache.reference.requestId` / `cache.referenceRejected` |
| `com.bivelio.quality.status` | `qualityStatus` si existe |
| `com.bivelio.latency.preprocessing_ms` / `.provider_ms` | `latencyMs.*` |
| `com.bivelio.stream.request_sent` | `StreamAbortedError.requestSent` (solo si se aborta) |

- Ninguna clave es a la vez hoja y espacio de nombres; por eso `model.id` y no `model`.
- `langfuse.metadata` añade `langfuse.observation.metadata.bivelio_{request_id, basis, currency, baseline_cost, actual_cost, saved_<basis>, net_savings_ratio, avoided_calls, eliminated_input_tokens, compressed_input_tokens, provider_cached_input_tokens, cache_result, quality_status}`, con valores string.
- `datadog.metadata` pone el mismo subconjunto como números bajo `{"bivelio":{…}}` en `_dd.ml_obs.metadata`.
- El scope de instrumentación con `TracerProviderLike` es `getTracer("@bivelio/savings-layer", BV_SALA_VERSION)`.

### 4.2 `toLangfuseGeneration`

- `model`: sin prefijo conocido.
- `usageDetails`, que no se incluye con `unmeasured`:
  - `input`: `actualInput − (providerCachedInput ?? 0)`, con suelo en 0;
  - `output`: `actualOutput`;
  - `cache_read_input_tokens`: si está definido.
- `costDetails`: `{ total: actual }` solo con `includeCost` y basis ∉ {unmeasured, shadow}.
- `metadata`: el subconjunto `bivelio_*` como números.
- Documentar que Langfuse no ve las escrituras de caché, porque el informe no las desglosa; `includeCost` usa el coste del informe, que sí incluye la prima.

### 4.3 Filas FOCUS 1.4 (este orden es la cabecera CSV)

**Columnas estándar:**
`BilledCost=0`, `EffectiveCost=0`, `ListCost=0`, `ContractedCost=0`, `BillingCurrency`, `BillingAccountId`, `BillingAccountName|null`, `BillingPeriodStart`, `BillingPeriodEnd`, `ChargePeriodStart`, `ChargePeriodEnd`, `ChargeCategory="Adjustment"`, `ChargeClass=null`, `ChargeDescription="BV-SALA savings ledger for <model> (basis: <basis>). Not a charge: cost columns are 0 by design."`, `ChargeFrequency="Usage-Based"`, `InvoiceIssuerName`, `ServiceProviderName`, `HostProviderName`, `ServiceName`, `ServiceCategory="AI and Machine Learning"`, `ServiceSubcategory="Generative AI"`, `PricingQuantity=null`, `PricingUnit=null`, `SubAccountId|null`, `SubAccountName|null`, `Tags`.

- `Tags` es un JSON con `bivelio/basis`, `bivelio/model` y los tags del usuario.
- No se emiten `SkuId`, `ConsumedQuantity` ni las columnas condicionales cuya condición no se cumple (`BillingAccountType`, `PricingCurrency`…).

**Columnas propias:**
`x_BiVelioBasis`, `x_BiVelioModelId`, `x_BiVelioRequestCount`, `x_BiVelioProviderCallCount`, `x_BiVelioAvoidedCallCount`, `x_BiVelioBaselineCost`, `x_BiVelioActualCost`, `x_BiVelioMeasuredSavings`, `x_BiVelioReferenceSavings`, `x_BiVelioEstimatedSavings`, `x_BiVelioEliminatedInputFloorCost`, `x_BiVelioBaselineInputTokens`, `x_BiVelioActualInputTokens`, `x_BiVelioEliminatedInputTokens`, `x_BiVelioCompressedInputTokens`, `x_BiVelioProviderCachedInputTokens`, `x_BiVelioBaselineOutputTokens`, `x_BiVelioActualOutputTokens`, `x_BiVelioEliminatedOutputTokens`.

**Agrupación:**
- La clave es periodo × modelo × basis × cuenta × subcuenta × tags. `shadow` queda fuera.
- En cada fila, solo la columna de ahorro de su basis tiene valor.
- Con `unmeasured`, el dinero es null.
- El orden es determinista: periodo, modelo, basis (measured, reference, estimated, unmeasured) y resto de la clave.
- Las sumas se hacen en bruto y se redondean a 1e‑10 al salir.

---

## 5. Cambios por fichero

| Fichero | Cambio |
|---|---|
| `src/exporters/index.ts` (nuevo) | Reexporta **por nombre** solo lo del §3. Los ayudantes internos no salen. |
| `src/exporters/tipos.ts` (nuevo) | Tipos públicos del §3, con JSDoc en inglés. |
| `src/exporters/proveedor.ts` (nuevo, interno) | Tabla prefijo → `{ otel, nombre }` (D8), con la URL del registry v1.41.1 y la fecha en un comentario `//`; también `sinPrefijoConocido()`. |
| `src/exporters/atributos.ts` (nuevo) | `savingsSpanAttributes` y las claves (`com.bivelio.*`, `gen_ai.*` como constantes internas, con fuente y fecha). Aquí vive la regla de una clave por basis. |
| `src/exporters/otel.ts` (nuevo) | `recordSavingsOnSpan`, `instrumentSavingsLayer` (D5, D9, D10). Todo el acceso al span va en `try/catch`. Si `isRecording?.() === false`, no hace nada. |
| `src/exporters/langfuse.ts` (nuevo) | `toLangfuseGeneration` (§4.2). |
| `src/exporters/agregado.ts` (nuevo, interno) | Un único agregador, que usan la serie y FOCUS; periodos UTC; validación de `at`. |
| `src/exporters/serie.ts` y `src/exporters/focus.ts` (nuevos) | `toSavingsSeries` y `toFocusRows` (§4.3, D12–D14, D16). |
| `src/exporters/csv.ts` (nuevo) | `toCsv` y el `formatearDecimal` interno (D16). |
| `src/index.ts` | `export * from "./exporters/index.js";`, con un comentario `//` en español que explique por qué no hay dependencia de OTel. |
| `package.json` | `devDependencies`: `"@opentelemetry/api": "^1.9.1"` y `"@opentelemetry/sdk-trace-base": "^2.11.0"`. `peerDependencies`: `"@opentelemetry/api": "^1.9.0"`. `peerDependenciesMeta`: `{"@opentelemetry/api": {"optional": true}}`. `scripts`: `"example:otel": "BVSALA_DEV_OPEN=1 tsx examples/exporters/otel.ts"` y `"example:focus": "BVSALA_DEV_OPEN=1 tsx examples/exporters/focus.ts"`. **La versión no se toca.** |
| `pnpm-lock.yaml` | Se regenera con `pnpm install`; solo cambia el importer raíz. |
| `examples/exporters/otel.ts` (nuevo) | `BasicTracerProvider` + `SimpleSpanProcessor(new ConsoleSpanExporter())`, `trace.setGlobalTracerProvider`, `createMockProvider`, dos peticiones idénticas con `temperature: 0` (la segunda evitada) y `provider.shutdown()`. Imprime: «MockProvider: figures are illustrative, not a measurement». |
| `examples/exporters/focus.ts` (nuevo) | Registra `{ at, report }`, escribe en `os.tmpdir()` `bv-sala-focus.csv` y `vantage-measured-savings.csv` (`date,amount,model`, solo las filas con `measuredSavings ≠ null`), e imprime las rutas y el mismo aviso. |
| `README.md` | Dos `<details>` nuevos tras «Tool calls» (§8). |
| `test/fragmento-instalacion.test.ts` | En `compila()`, `paths` añade `"@opentelemetry/api": [join(RAIZ, "node_modules/@opentelemetry/api")]`, con un comentario que lo justifica. No afloja nada: se siguen compilando todos los bloques. |
| `test/sala-limpia-del-tarball.test.ts` | Solo se corrige el comentario «su único peerDependency es OPCIONAL» por «todos sus peerDependencies son OPCIONALES». |
| Tests nuevos | §7. |

---

## 6. Dependencias

- **En tiempo de ejecución: ninguna.** El paquete sigue sin `dependencies`.
- **Peer opcional** `@opentelemetry/api ^1.9.0`, con el porqué de D1. Solo documenta el rango probado; no se importa nunca.
- **devDependencies:**
  - `@opentelemetry/api@^1.9.1`: tipos reales para el test de compatibilidad, ejemplo y README.
  - `@opentelemetry/sdk-trace-base@^2.11.0`: `InMemorySpanExporter`, `SimpleSpanProcessor`, `BasicTracerProvider` y `ConsoleSpanExporter`, para tests y ejemplo. Arrastra `@opentelemetry/sdk-trace`, `core`, `resources` y `semantic-conventions`. Su engine (≥20.6) es compatible con Node 20 de la CI.
- **No** se añaden `@langfuse/*` ni `@opentelemetry/semantic-conventions`. La forma de Langfuse queda fijada en un comentario con su fuente (npm 5.11.1, 2026‑09‑09), y las claves semconv son constantes con URL.

---

## 7. Tests (vitest; ficheros en español, como en el repo)

**`test/exportador-otel.test.ts`.** Capa real (`createSavingsLayer` + `createMockProvider`) y `InMemorySpanExporter`.
1. Un span por `generate()`: nombre `chat gpt-4o-mini`, kind 2, `gen_ai.operation.name="chat"`, `provider.name="openai"`, `request.model` sin prefijo, y el uso igual a `report.tokens.actualInput` / `actualOutput`.
2. La segunda petición idéntica (llamada evitada) sale con `usage` 0 y `com.bivelio.calls.avoided=1`.
3. Una sola clave `com.bivelio.cost.saved.*`, la de su basis. Con informes sintéticos:
   - measured, con `baseline=1` y `actual=1.5`, da `saved.measured=-0.5` (el signo se conserva);
   - reference lleva `cache.reference_request_id`;
   - `unmeasured` sale sin `saved.*`, sin `cost.baseline`/`actual` y sin `gen_ai.usage.*`;
   - `shadow` sale sin `saved.*`.
4. `net_savings_ratio` es igual a `cost.netSavings`, y `saved` es igual a `baselineEstimate − actual`: prueba H1, la proporción no se confunde con dinero.
5. **Sin contenido:**
   - un mensaje con `SECRETO-PROMPT-123`, una respuesta mock con `SECRETO-RESP-456` y un proveedor que lanza `SECRETO-ERR-789`: ninguna aparece en `JSON.stringify` de atributos, estado ni eventos;
   - ninguna clave contiene `traces`, `input.messages` ni `output.messages`.
6. Identidad: `toBe` en `result` y en el stream, y el mismo error relanzado; con error, estado 2, `error.type` igual al nombre y sin mensaje.
7. Fail‑open:
   - si `startActiveSpan` lanza, `generate` responde igual;
   - si `setAttributes` lanza, igual;
   - con un tracer sin métodos, `TypeError` en `instrumentSavingsLayer`.
8. `generateStream`:
   - el span termina tras `result`;
   - `request.stream=true`;
   - `time_to_first_chunk` es `firstEventMs/1000` en `live`;
   - al abortar, `error.type="StreamAbortedError"` y `com.bivelio.stream.request_sent` definido.
9. Opciones: `langfuse.metadata` genera claves `langfuse.observation.metadata.bivelio_*` con valor string; `langfuse.cost` genera un JSON `{"total":…}`; `datadog.metadata` genera JSON válido. Las tres están apagadas por defecto.
10. Higiene:
    - toda clave propia cumple `/^com\.bivelio\.[a-z0-9_.]+$/`;
    - toda clave `gen_ai.*` emitida está en una lista blanca copiada del registry v1.41.1 (con URL y fecha), y **no** hay `cache_creation`, `cache_write` ni `gen_ai.usage.cost`.
11. Las constantes 2 (CLIENT) y 2 (ERROR) coinciden con `SpanKind.CLIENT` y `SpanStatusCode.ERROR` del paquete real.

**`test/exportador-otel-tipos.test.ts`.** Compila con `typecheck` porque `tsconfig` incluye `test/**`, y lleva un `it` trivial.
- `instrumentSavingsLayer(layer, { tracer: trace })` y `{ tracer: trace.getTracer("x") }`;
- `recordSavingsOnSpan(trace.getActiveSpan()!, report)`.

Todo compila contra los tipos de `@opentelemetry/api` 1.9. Es la prueba de D1: la asignabilidad de las sobrecargas genéricas de `startActiveSpan` no se da por supuesta.

**`test/exportador-langfuse.test.ts`.** Cubos exclusivos (`input` sin lecturas de caché), sin `usageDetails` con `unmeasured`, ceros en una llamada evitada, `costDetails` solo con `includeCost`, metadata separada por basis y modelo sin prefijo.

**`test/exportador-focus.test.ts`**
1. Toda fila tiene todas las columnas *Mandatory* de FOCUS 1.4, en una lista fija con la URL del tag v1.4, y ninguna es null donde la especificación lo prohíbe.
2. **Nunca suma gasto:** los cuatro costes valen 0 en cualquier informe, incluidos informes generados en bucle con ahorros enormes o negativos.
3. `Adjustment`, `ChargeClass` null, `Usage-Based`, la categoría y la subcategoría, y `PricingQuantity`/`PricingUnit` null.
4. Un solo basis por fila; solo la columna de ahorro de su basis tiene valor; `unmeasured` con dinero null; `shadow` excluido.
5. Invariante de dinero: Σ `x_BiVelioMeasuredSavings` = Σ(baseline−actual) de los informes measured (±1e‑9), y lo mismo para reference y estimated. La exportación no crea ni pierde dinero.
6. Fechas:
   - `2026-09-27T23:59:59.999Z` cae en el día `2026-09-27T00:00:00Z`–`2026-09-28T00:00:00Z`;
   - granularidad por hora;
   - en diciembre, `BillingPeriod` pasa a enero del año siguiente;
   - `at` admite Date, número e ISO; un valor inválido da `TypeError`.
7. Columnas propias: prefijo `x_`, PascalCase alfanumérico y ≤50 caracteres (FOCUS 1.4 CustomColumnHandling).
8. `Tags` es un JSON objeto con valores string; un tag de usuario con prefijo `bivelio/` da `TypeError`.
9. Proveedor: `openai` da `OpenAI`; un prefijo desconocido sin opción da `TypeError` con el modelo en el mensaje; las opciones de función cambian el emisor, el host y la subcuenta.

**`test/exportador-serie-y-csv.test.ts`**
- La serie: `date` en `YYYY-MM-DD`, columnas por basis, y una dimensión que choca con una clave fija da `TypeError`.
- El CSV:
  - comillas RFC 4180 (comas, comillas y saltos);
  - CRLF;
  - null sale como vacío sin comillas;
  - `5e-7` se escribe `0.0000005`, `-0` se escribe `0`, el signo negativo se conserva;
  - la cabecera sigue el orden de §4.3;
  - ida y vuelta con un analizador mínimo dentro del test;
  - `toCsv([])` da `""`, y con `columns` da solo la cabecera.

**`test/exportadores-sin-red.test.ts`**
- Con `globalThis.fetch` sustituido por un stub que lanza, `generate` y `generateStream` instrumentados funcionan (MockProvider y sin `serviceAccountKey`).
- `dist/index.js` no contiene `@opentelemetry/`: no hay import en tiempo de ejecución.
- Todo `peerDependencies` es `optional: true`.
- No hay `dependencies`.
- `UsageWire` no cambia; eso ya lo vigila `licencia-alineada`.

---

## 8. Documentación: README (inglés; ambos bloques `ts` compilan con `fragmento-instalacion`)

Dos `<details>` después de «Tool calls». Borrador:

**`<summary><b>Your ledgers in your tracing — OpenTelemetry, Langfuse, Datadog</b></summary>`**

```ts
import { trace } from "@opentelemetry/api";
import { instrumentSavingsLayer } from "@bivelio/savings-layer";

// One span per request, on the OpenTelemetry pipeline you already run.
const traced = instrumentSavingsLayer(layer, { tracer: trace });
const { report: tracedReport } = await traced.generate({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "What is 2 + 2 * 3?" }],
});
console.log(tracedReport.cost.basis); // the span carries the same figures
```

Texto:
- Los spans siguen las GenAI semantic conventions en la última versión publicada (OpenTelemetry semantic‑conventions v1.41.1). Llevan además `com.bivelio.*`: el libro, `basis`, el coste y los ids. `com.bivelio.request_id` es el mismo id que el registro de uso.
- **El dinero va separado por basis:** `com.bivelio.cost.saved.measured`, `.reference` y `.estimated`. Una suma sobre una sola clave nunca mezcla lo medido con lo estimado. `report.cost.netSavings` es una proporción; el dinero es `baselineEstimate − actual`, y eso es lo que se exporta.
- **Nada de esto habla con BiVelio.** Los spans van a tu exportador y los ficheros se quedan donde los escribas. Tus prompts, respuestas y claves de proveedor nunca llegan a BiVelio.
- **Langfuse:** añade el `LangfuseSpanProcessor` de `@langfuse/otel` a tu tracer provider. Estos spans llevan `gen_ai.*`, así que su filtro por defecto los exporta. `langfuse: { metadata: true }` los hace filtrables. Con `@langfuse/tracing` a mano, pasa `toLangfuseGeneration(report)` a `generation.update()`.
- **Datadog LLM Observability**, por OTLP:
  ```bash
  OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/protobuf
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=<your Datadog site's OTLP traces endpoint>
  OTEL_EXPORTER_OTLP_TRACES_HEADERS=dd-api-key=<your Datadog API key>,dd-otlp-source=llmobs
  ```
  Los atributos `com.bivelio.*` llegan como tags; con `datadog: { metadata: true }` llegan además como metadata. Datadog descarta los spans sin `gen_ai.*`, así que en ese caso usa `instrumentSavingsLayer` y no `recordSavingsOnSpan`.
- La tabla de atributos del §4.1, resumida. **No** se nombran los valores de `cache.result`: `singleflight` está prohibido en el README.

**`<summary><b>Your ledgers in your FinOps tool — FOCUS rows and a daily savings series</b></summary>`**

```ts
import { writeFileSync } from "node:fs";
import { toFocusRows, toCsv, type SavingsRecord } from "@bivelio/savings-layer";

const records: SavingsRecord[] = [];
const answer = await layer.generate({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "What is 2 + 2 * 3?" }],
});
records.push({ at: Date.now(), report: answer.report }); // keep reports as they come back

// FOCUS 1.4 rows, one per day, model and basis. Every cost column is 0 by design:
// your provider's bill already has the spend, so these rows add savings, never cost.
const rows = toFocusRows(records, { billingAccountId: "org-XXXXXXXX" }); // your provider billing account id
writeFileSync("bv-sala-focus.csv", toCsv(rows));
```

Texto:
- Qué ocurre con cada herramienta, con enlace a su documentación y la nota «as published in September 2026»:
  - lagos de datos FOCUS: todas las columnas;
  - **Finout:** CSV FOCUS como custom cost center, enviado a su soporte;
  - **Vantage:** Custom Providers usa columnas FOCUS 1.1–1.3 e ignora las demás, así que para el dinero sube `toSavingsSeries` como Business Metric, un fichero por basis;
  - **CloudZero:** AnyCost usa su propio formato CBF; la serie puede entrar como Telemetry Stream.
- Tabla de las columnas `x_BiVelio*`, que es la documentación de columnas propias que pide FOCUS.
- Una frase: «Sum `measured` and `reference` for what you can check against your provider invoice; `estimated` has its own column on purpose.»

**Prohibido en el texto nuevo** (lo vigilan los tests):
- `never leave your (machine|infrastructure)`, `only counts and cost`, `prompts never leave`;
- `≥ N %` y las cifras `$330`, `$160`, `$84`;
- los nombres de técnica de `superficie-publica-limpia`;
- en el `.d.ts`, cualquier cadena que contenga `toon`, rutas `src/…ts` o palabras como «was missing» o «the bug».

**Sin cambios en la web.** Una página `/docs` en 12 idiomas queda como seguimiento, sujeto a la verja `parity`.

---

## 9. Verificación (todo en verde) y verjas

```bash
pnpm -s build:all && git checkout -- apps/web/public/vendor/bv-sala.js
pnpm -s run typecheck:all
pnpm --dir apps/web run typecheck
pnpm -s exec vitest run --reporter=dot
```

(`apps/web` no se toca, así que su build no hace falta.)

Comprobaciones explícitas:
- **`superficie-publica-limpia`:** el techo de 81 líneas con acentos no sube. Todo el JSDoc nuevo va en inglés y los comentarios en español van en `//`. Ningún export con nombre en español. No aparece `toon` ni `LiteLLM` en el `.d.ts`.
- **`dx-empaquetado`:** `exports["."]` intacto. `dist/index.js` sigue por debajo de 400 KB y sin líneas de 4.000 caracteres o más; medir `wc -c` antes y después.
- **`fragmento-instalacion`** y **`sala-limpia`** siguen en verde: el primer bloque `ts` no cambia.
- **`readme-alineado`** y **`licencia-alineada`** siguen en verde: no cambian el cable, los precios ni las frases retiradas.
- `tarifa-en-parametros`, `cifra-del-heroe`, `referencia-es-suelo`, `banco-propio-nunca-factura` y `parity` no se tocan.

**Commits sugeridos,** con `git commit -F <msg> --only -- <rutas>`, en español y cerrados con `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Nunca `apps/web/public/vendor/bv-sala.js`.
1. `chore(deps): OpenTelemetry como devDependency y peer opcional — sin import en tiempo de ejecución`
2. `feat(exportadores): los libros en tu traza — OTel GenAI, Langfuse y Datadog sin enviar nada a BiVelio`
3. `feat(exportadores): los libros en FOCUS 1.4 y una serie diaria — filas que suman ahorro, nunca gasto`
4. `docs(readme): cómo llegan los libros a tu observabilidad y a tu FinOps`

PR contra `main`, sin merge.

---

## 10. Pasos del dueño (después del merge; nada bloquea la implementación)

1. **Validar en cuentas reales antes de hablar de «integración»:**
   - una subida a Vantage (Custom Provider y Business Metric);
   - un CSV a Finout por soporte;
   - un Telemetry Stream en CloudZero;
   - un proyecto de Langfuse Cloud;
   - una prueba de Datadog LLM Obs.

   Apuntar el resultado en la bitácora. Hasta entonces, el README solo afirma el formato publicado por cada proveedor.
2. **Pedir los listados** (la señal de éxito de la n.º 11): el directorio de integraciones de Langfuse y los de Vantage y Datadog, si procede.
3. **Revisar las decisiones reversibles** antes de la release que las publique. Renombrarlas después rompe dashboards:
   - el espacio `com.bivelio.*` frente a `bivelio.*` (D2);
   - `ChargeCategory="Adjustment"` (D12), consultable en la comunidad FOCUS;
   - `ServiceName="BV-SALA savings ledger"` (D13).
4. **Release** (versión, `npm publish`, CHANGELOG): la hace el dueño; fuera de esta unidad.
5. **Opcional:** keywords `opentelemetry` y `finops` en `package.json`, y la página `/docs` en 12 idiomas.
6. **Vigilar** `semantic-conventions-genai`: su primera release (con `cache_write` y la PR de coste #443) obligará a revisar la lista blanca del test 10.

---

## 11. Riesgos y fuera de alcance

- **Las GenAI semconv están en estado *Development*** y se han trasladado de repositorio. El test de lista blanca convierte cualquier deriva en una decisión explícita.
- **Datadog calcula su propio coste** con precios públicos. La cifra de BiVelio va en tags o metadata y no la sustituye. Los datos de Datadog vienen de su documentación y no se han probado todavía.
- **Vantage ignora las columnas `x_`:** sin la serie no hay dinero en Vantage. Así está documentado.
- **El `.d.ts` crece** con unos 25 símbolos, todos en inglés.
- **Fuera de alcance:** spans desde el gateway `bvsala`, métricas OTel, exportadores de red y un campo de fecha en `SavingsReport` (el llamante aporta `at`).