/**
 * bivelio-savings-layer (BV-SALA)
 * ---------------------------------------------------------------------------
 * PROPRIETARY AND CONFIDENTIAL. Copyright (c) 2026 BiVelio Inc.
 * All Rights Reserved. Unauthorized copying, distribution, or use of this
 * software, in whole or in part, is strictly prohibited. See LICENSE.
 * ---------------------------------------------------------------------------
 *
 * A provider-neutral LLM execution optimizer. For every request it answers, in
 * order: Can I avoid this call? Can I avoid retrieval? Can I send fewer tools?
 * What context is actually needed? Should I compress it? Which format costs
 * least for this tokenizer? What is the minimal output contract? Is the saving
 * still positive after all infrastructure is counted?
 *
 * It keeps FOUR separate ledgers — avoided_calls, eliminated_tokens,
 * compressed_tokens, provider_cached_tokens — because mixing them produces
 * misleading metrics.
 */

// El catálogo de precios de lista, exportado para que un cliente pueda
// inspeccionarlo, extenderlo o comprobar qué modelos cubre. Desde la 0.5 solo
// con los nombres ingleses (los españoles, alias @deprecated en la 0.4.33 y la
// 0.4.34, ya no existen). Se declaran AQUÍ y no en pricing/catalogo.ts para que
// el JSDoc viaje en el `.d.ts` sin tocar el fichero del catálogo.
import {
  CATALOGO as catalogoDePrecios,
  precioDeLista as precioDeListaDelCatalogo,
  PRECIOS_AL_DIA as preciosAlDia,
} from "./pricing/catalogo.js";

/**
 * The list-price catalogue: model id (without vendor prefix) → USD per 1K
 * tokens. `costModels` on the layer config always wins over it.
 */
export const PRICE_CATALOG: typeof catalogoDePrecios = catalogoDePrecios;
/**
 * The list price for a model on the day of the request, or `undefined` when the
 * catalogue has no price for it in force that day.
 */
export const listPrice: typeof precioDeListaDelCatalogo = precioDeListaDelCatalogo;
/** When the catalogue prices were last checked against the providers' public rates (YYYY-MM-DD). */
export const PRICES_AS_OF: typeof preciosAlDia = preciosAlDia;

// La versión vive en src/version.ts junto a las constantes INTERNAS del canal
// de versión (cabecera y mínima de la palanca), que NO se reexportan: nada
// nuevo sale a la superficie pública por aquí.
export { BV_SALA_VERSION } from "./version.js";

// LA 0.5 CONGELA LA API (docs/CAMINO-A-0.5.md, criterio 6): la raíz exporta una
// lista CERRADA, nombre a nombre, y ni un `export *`. Hasta la 0.4.34 los
// barriles se reexportaban enteros y por ahí se colaron 68 piezas internas
// (pipeline, licencia, medición) que nadie había decidido publicar. Ahora un
// `export` nuevo en un módulo interno no sale a la cara del producto hasta que
// alguien lo añade aquí Y a docs/INVENTARIO-API-0.5.json, y
// test/api-publica-congelada.test.ts falla si las dos listas no casan.

export {
  createHandoff,
  QUALITY_STATUSES,
} from "./contracts/index.js";
export type {
  AnswerSource,
  BatchCounts,
  BatchItemResult,
  BatchJob,
  BatchJobStatus,
  BatchRequest,
  BatchResults,
  BatchSubmitOptions,
  BatchSummary,
  BivelioHandoff,
  CacheOutcome,
  CacheWriteReport,
  ChatMessage,
  DeferredExecutionReport,
  ExecutionClass,
  HandoffFact,
  JsonSchema,
  LicenseGate,
  MeasureReport,
  MessageRole,
  ModelCascadeMode,
  ModelCascadeReport,
  NativeSavingsReport,
  OutputContract,
  PriceLeverSaving,
  QualityCacheMatch,
  QualityCascadeCheck,
  QualityLedger,
  QualityRepairCheck,
  QualitySchemaCheck,
  QualityStatus,
  QualityTruncationCheck,
  ReasoningEffort,
  RequestContext,
  RetrievalOptions,
  SavingsAdapterLevers,
  SavingsAdapterOptions,
  SavingsBatches,
  SavingsCallOptions,
  SavingsReport,
  SavingsRequest,
  SavingsRequestOptions,
  SavingsResult,
  SavingsStream,
  SavingsStreamEvent,
  SavingsStreamOptions,
  SavingsToggles,
  SemanticCalibrationBound,
  SerializationFormat,
  StreamingReport,
  ToolCallRequest,
  ToolDescriptor,
  ToolRisk,
  ToolSearchMode,
  ToolSearchOptions,
  TraceEvent,
  VerificationCheck,
  VerificationExclusion,
  VerificationOutcome,
  VerificationReport,
  VerificationSettings,
  VerificationSide,
  VerificationStratum,
} from "./contracts/index.js";
export {
  defaultTokenizerRegistry,
  ExactTokenizer,
  HeuristicEstimator,
  heuristicEstimator,
  MODELS_BY_ENCODING,
  registerExactTokenizer,
  TokenizerRegistry,
} from "./tokenizer/index.js";
export type {
  CostBasis,
  CostModel,
  ReferenceCredit,
  ReferenceRejection,
  TokenEstimator,
} from "./tokenizer/index.js";
export type {
  Policy,
} from "./policy/index.js";
export {
  calibrateSemanticFloor,
  CalibrationStateError,
  InMemoryCacheBreakpointStore,
  InMemoryExactCache,
  InMemorySemanticCache,
  SemanticCacheSafety,
  SemanticCalibrationJournal,
  LOCAL_EMBEDDING_THRESHOLD,
  localEmbedding,
  Singleflight,
} from "./cache/index.js";
export type {
  AnswerJudge,
  CacheBreakpointStore,
  CachedAnswer,
  CalibrationObservation,
  EmbeddingFn,
  ExactCache,
  SemanticCacheOptions,
  SemanticCacheStore,
  SemanticCalibrationIdentity,
  SemanticCalibrationOptions,
  SemanticCalibrationSegmentState,
  SemanticCalibrationState,
  SemanticCalibrationStatus,
  SemanticHit,
  SemanticLookup,
  SemanticProbe,
  SemanticRecord,
  SemanticVerifier,
} from "./cache/index.js";
export {
  arithmeticResolver,
  createDefaultResolvers,
  ResolverRegistry,
} from "./resolvers/index.js";
export type {
  DeterministicResolver,
  ResolverResult,
} from "./resolvers/index.js";
export {
  ExecutionRouter,
  InMemoryToolSetFreezer,
  ToolSelector,
} from "./router/index.js";
export type {
  LocalClassifier,
  RouteDecision,
  ToolSelection,
  ToolSelectorOptions,
  ToolSetFreezer,
} from "./router/index.js";
export type {
  EvidenceDoc,
  Reranker,
  RetrievalOutcome,
  RetrievalPlan,
  Retriever,
} from "./retrieval/index.js";
export {
  emptyState,
  mergeDelta,
  renderState,
} from "./memory/index.js";
export type {
  ConversationState,
  MemoryDelta,
} from "./memory/index.js";
export {
  COMPACT_ROWS_INSTRUCTION,
  compactRowsSerializer,
  createCompactRowsSerializer,
  csvSerializer,
  decodeCompactRows,
  encodeCompactRows,
  FormatSelector,
  jsonCompactSerializer,
} from "./serialization/index.js";
export type {
  CompactRowsDecodeOptions,
  CompactRowsOptions,
  FormatChoice,
  FormatSelectorOptions,
  Serializer,
} from "./serialization/index.js";
export {
  providerNativeBackend,
  SchemaRegistry,
  validateAgainstSchema,
} from "./constraints/index.js";
export type {
  ConstraintBackend,
  ConstraintBackendId,
  ConstraintPlan,
  ValidationError,
  ValidationResult,
} from "./constraints/index.js";
export {
  COMPACTION_TRANSFORMS,
  compactToolOutput,
  DEFAULT_MIN_SAVED_CHARS,
  noopCompressor,
} from "./compression/index.js";
export type {
  CompactionTransform,
  CompressionPolicyInput,
  CompressionRequest,
  CompressionResult,
  Compressor,
  ProtectedSpan,
  ToolOutputCompaction,
  ToolOutputCompactionSettings,
} from "./compression/index.js";
// De la verja económica de la compresión se exportan los DOS TIPOS y nada más.
//
// Los tipos, porque la decisión depende de datos que solo tiene el cliente —el
// mínimo de tramo de SU modelo, la tasa de aciertos de prefijo de SU tráfico— y
// sin poder nombrarlos no puede escribir el objeto que `compressionEconomics`
// acepta ni guardarlo en una constante compartida. No cuestan superficie: la
// configuración ya los arrastra al `.d.ts` publicado.
//
// Y nada más, porque las funciones que deciden se llaman `decidirCompresion`,
// `costeEsperado` o `tramoDeCache`: exportarlas pondría identificadores en
// español en la cara del producto (la verja de `superficie-publica-limpia`), y
// su único llamante legítimo es el pipeline. Un cliente que las invocara a mano
// estaría reimplementando la capa que compró.
export type { CacheTier, CompressionEconomics } from "./economics/index.js";
export {
  AnthropicProvider,
  createMockProvider,
  GoogleProvider,
  MockProvider,
  OpenAICompatibleProvider,
} from "./providers/index.js";
export type {
  AnthropicOptions,
  CachePlacement,
  GoogleOptions,
  GoogleThinkingConfig,
  MockProviderOptions,
  OpenAICompatibleOptions,
  Provider,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
  ProviderStreamOptions,
  ProviderToolSearch,
  ProviderToolSearchUsage,
  ProviderUsage,
} from "./providers/index.js";
export {
  LicenseError,
} from "./license/index.js";
export type {
  LicenseKeyset,
} from "./license/index.js";
export {
  BatchSubmitError,
  createSavingsLayer,
  DEFAULT_COST_MODEL,
  RequestTimeoutError,
  StreamAbortedError,
} from "./pipeline/index.js";
export type {
  ModelCascadeSettings,
  PriceLeverSettings,
  SavingsLayer,
  SavingsLayerConfig,
} from "./pipeline/index.js";
// Los exportadores: los libros hacia OpenTelemetry, Langfuse, Datadog y FOCUS,
// desde el proceso del cliente y sin enviar nada a BiVelio. NO importan
// `@opentelemetry/api`: sus tipos son estructurales (como `gpt-tokenizer` en
// tokenizer/exact.ts), porque un `import type` del peer opcional acabaría en el
// `.d.ts` y rompería el typecheck de quien no lo tenga instalado.
export {
  instrumentSavingsLayer,
  recordSavingsOnSpan,
  savingsSpanAttributes,
  toCsv,
  toFocusRows,
  toLangfuseGeneration,
  toSavingsSeries,
} from "./exporters/index.js";
export type {
  CsvValue,
  FocusExportOptions,
  FocusRow,
  LangfuseGenerationUpdate,
  SavingsAttributeOptions,
  SavingsRecord,
  SavingsReportForExport,
  SavingsSeriesOptions,
  SavingsSeriesRow,
  SavingsSpanAttributes,
  SavingsSpanOptions,
  SavingsTracingOptions,
  SpanAttributeValue,
  SpanLike,
  SpanStartOptionsLike,
  TracerLike,
  TracerProviderLike,
} from "./exporters/index.js";
export type { ConstraintMemoryStore } from "./constraints/memory.js";
