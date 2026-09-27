// Tipos PÚBLICOS de los exportadores: todo lo que hay aquí viaja al `.d.ts`, así
// que el JSDoc va en inglés y los comentarios internos, como este, en `//`.
//
// Ningún tipo de `@opentelemetry/api` se importa: son formas ESTRUCTURALES (el
// mismo patrón que `gpt-tokenizer` en tokenizer/exact.ts). Un `import type` del
// peer opcional acabaría en el `.d.ts` y rompería el typecheck de quien no lo
// tenga instalado. Que los tipos reales encajan lo demuestra
// test/exportador-otel-tipos.test.ts, que compila contra ellos.

import type { SavingsReport } from "../contracts/types.js";
import type { CostBasis } from "../tokenizer/accounting.js";

// ── Shared ──────────────────────────────────────────────────────────────────

/**
 * The parts of a SavingsReport the exporters read. A full SavingsReport
 * satisfies it, and so does a stored copy without `traces`: the exporters never
 * read `traces`, messages, answers or tool arguments.
 */
export type SavingsReportForExport = Pick<
  SavingsReport,
  "requestId" | "model" | "calls" | "tokens" | "cache" | "cost"
> &
  Partial<Pick<SavingsReport, "qualityStatus" | "modelCascade" | "latencyMs" | "streaming">>;

/**
 * One report and when its request was made: an ISO 8601 string, epoch
 * milliseconds or a Date. A SavingsReport carries no timestamp of its own, so
 * record `at` when the report comes back (`Date.now()` is fine).
 */
export interface SavingsRecord {
  at: string | number | Date;
  report: SavingsReportForExport;
}

// ── OpenTelemetry (structural: no dependency on @opentelemetry/api) ────────

/** An attribute value these exporters write: never null, never an object. */
export type SpanAttributeValue = string | number | boolean | string[];

/** The attributes these exporters write on a span. */
export type SavingsSpanAttributes = Record<string, SpanAttributeValue>;

/**
 * The part of an OpenTelemetry `Span` these exporters use. A `Span` from
 * `@opentelemetry/api` satisfies it.
 */
export interface SpanLike {
  setAttributes(attributes: SavingsSpanAttributes): unknown;
  setStatus?(status: { code: number; message?: string }): unknown;
  end(): void;
  isRecording?(): boolean;
}

/** The part of OpenTelemetry's `SpanOptions` these exporters pass. */
export interface SpanStartOptionsLike {
  kind?: number;
  attributes?: SavingsSpanAttributes;
}

/** The part of an OpenTelemetry `Tracer` these exporters use. */
export interface TracerLike {
  startActiveSpan<T>(name: string, options: SpanStartOptionsLike, fn: (span: SpanLike) => T): T;
}

/** `trace` from @opentelemetry/api, or any TracerProvider. */
export interface TracerProviderLike {
  getTracer(name: string, version?: string): TracerLike;
}

/** Options shared by every function that writes span attributes. */
export interface SavingsAttributeOptions {
  /**
   * ISO 4217 code of the report's money. Default "USD", the unit of the
   * built-in price catalog. If you configured `costModels` in another unit, say
   * so here: the report itself does not carry a currency.
   */
  currency?: string;
  /**
   * Mirror the figures as filterable Langfuse metadata
   * (`langfuse.observation.metadata.bivelio_*`, string values). `cost` also sets
   * `langfuse.observation.cost_details` to the report's actual cost, which
   * Langfuse then prefers over its own estimate; Langfuse reads that figure as
   * USD, so it is only written when `currency` is "USD". Both off by default.
   */
  langfuse?: { metadata?: boolean; cost?: boolean };
  /**
   * Mirror the figures in `_dd.ml_obs.metadata` for Datadog LLM Observability,
   * as a JSON object under the key `bivelio`. Off by default: without it the
   * `com.bivelio.*` attributes still arrive in Datadog as tags.
   */
  datadog?: { metadata?: boolean };
}

/** Options for {@link recordSavingsOnSpan}. */
export interface SavingsSpanOptions extends SavingsAttributeOptions {
  /**
   * Also write the GenAI usage attributes and `gen_ai.response.model`.
   * Default false: the span you pass may be an HTTP or job span, and marking it
   * as an LLM call would misclassify it in tools that key on `gen_ai.*`.
   */
  genAi?: boolean;
}

/** Options for {@link instrumentSavingsLayer}. */
export interface SavingsTracingOptions extends SavingsAttributeOptions {
  /** `trace` from @opentelemetry/api, a TracerProvider, or a Tracer. */
  tracer: TracerLike | TracerProviderLike;
  /**
   * The `gen_ai.provider.name` value. Default: derived from the model id prefix
   * (`openai/` gives "openai"); omitted when the model id has no prefix.
   */
  providerName?: string;
}

// ── Langfuse (@langfuse/tracing users) ──────────────────────────────────────

/**
 * What to pass to a Langfuse generation's `update()`. `usageDetails` uses
 * Langfuse's exclusive buckets: `input` does not include
 * `cache_read_input_tokens`.
 */
export interface LangfuseGenerationUpdate {
  model: string;
  usageDetails?: Record<string, number>;
  costDetails?: Record<string, number>;
  metadata: Record<string, string | number>;
}

// ── FinOps ──────────────────────────────────────────────────────────────────

/** Options for {@link toSavingsSeries}. */
export interface SavingsSeriesOptions {
  /** Length of each period, in UTC. Default "day". */
  granularity?: "hour" | "day";
  /** ISO 4217 code of the reports' money. Default "USD". */
  currency?: string;
  /**
   * Extra grouping labels for each record (team, feature, environment). Keys
   * must not repeat a column of {@link SavingsSeriesRow}.
   */
  dimensions?: (record: SavingsRecord) => Record<string, string> | undefined;
}

/**
 * One period, model and basis of the savings series. Money is in `currency`;
 * each saving column holds money of its own basis only, so summing one column
 * never mixes measured and estimated figures.
 */
export type SavingsSeriesRow = {
  /** Start of the period, inclusive (`YYYY-MM-DDTHH:mm:ssZ`, UTC). */
  periodStart: string;
  /** End of the period, exclusive (`YYYY-MM-DDTHH:mm:ssZ`, UTC). */
  periodEnd: string;
  /** The UTC date of `periodStart` (`YYYY-MM-DD`). */
  date: string;
  /** The model id as the report names it (the model that served the answer). */
  model: string;
  /** Where the money in this row comes from. `shadow` reports are never exported. */
  basis: Exclude<CostBasis, "shadow">;
  currency: string;
  /** Reports in this row. */
  requests: number;
  /** LLM calls that reached the provider. */
  providerCalls: number;
  /** LLM calls that never executed. */
  avoidedCalls: number;
  /** Sum of `cost.baselineEstimate`; null when basis is "unmeasured". */
  baselineCost: number | null;
  /** Sum of `cost.actual`; null when basis is "unmeasured". */
  actualCost: number | null;
  /** Sum of `baselineEstimate - actual` on "measured" rows; null on every other row. */
  measuredSavings: number | null;
  /** Sum of `baselineEstimate - actual` on "reference" rows; null on every other row. */
  referenceSavings: number | null;
  /** Sum of `baselineEstimate - actual` on "estimated" rows; null on every other row. */
  estimatedSavings: number | null;
  /** Sum of `cost.eliminatedInputFloorCost`, a separate lane; null when no report carried it or basis is "unmeasured". */
  eliminatedInputFloorCost: number | null;
  baselineInputTokens: number;
  actualInputTokens: number;
  eliminatedInputTokens: number;
  compressedInputTokens: number;
  /** Sum of `tokens.providerCachedInput`; null when no report in the row carried it. */
  providerCachedInputTokens: number | null;
  baselineOutputTokens: number;
  actualOutputTokens: number;
  eliminatedOutputTokens: number;
  /** The labels returned by `options.dimensions`, empty without it. */
  dimensions: Readonly<Record<string, string>>;
};

/** Options for {@link toFocusRows}. */
export interface FocusExportOptions {
  /**
   * Your billing account id with the LLM provider (for example your OpenAI
   * organization id), so these rows join the provider's own cost rows.
   * Required: the SDK does not know it.
   */
  billingAccountId: string | ((record: SavingsRecord) => string);
  /** Display name of that billing account, when the provider has one. */
  billingAccountName?: string | ((record: SavingsRecord) => string | undefined);
  /** The provider sub account (project, workspace) a record belongs to. */
  subAccount?: (record: SavingsRecord) => { id: string; name: string } | undefined;
  /**
   * FOCUS `ServiceProviderName`. Default: derived from the model id prefix
   * (`openai/` gives "OpenAI"). A model id whose provider cannot be derived
   * throws, because FOCUS does not allow a placeholder here.
   */
  serviceProviderName?: string | ((model: string) => string);
  /** FOCUS `InvoiceIssuerName` (a cloud marketplace or gateway that bills you). Default: the service provider. */
  invoiceIssuerName?: string | ((model: string) => string);
  /** FOCUS `HostProviderName` (the cloud hosting the model). Default: the service provider. */
  hostProviderName?: string | ((model: string) => string);
  /** FOCUS `ServiceName`. Default "BV-SALA savings ledger". */
  serviceName?: string;
  /**
   * The billing period a charge period belongs to. Default: the calendar month
   * in UTC. Set it if your provider invoices on another cycle.
   */
  billingPeriod?: (chargePeriodStart: Date) => { start: Date; end: Date };
  /** Your own tags for a record, added to `Tags`. Keys starting with "bivelio/" are reserved. */
  tags?: (record: SavingsRecord) => Record<string, string> | undefined;
  /** Length of each charge period, in UTC. Default "day". */
  granularity?: "hour" | "day";
  /** ISO 4217 code of the reports' money. Default "USD". */
  currency?: string;
}

/**
 * A FOCUS 1.4 Cost and Usage row. Never a charge: every cost column is 0, so
 * joining these rows with your provider's bill adds savings columns and never
 * adds spend. The savings live in the `x_BiVelio*` columns, one per basis.
 */
export type FocusRow = {
  BilledCost: 0;
  EffectiveCost: 0;
  ListCost: 0;
  ContractedCost: 0;
  BillingCurrency: string;
  BillingAccountId: string;
  BillingAccountName: string | null;
  BillingPeriodStart: string;
  BillingPeriodEnd: string;
  ChargePeriodStart: string;
  ChargePeriodEnd: string;
  ChargeCategory: "Adjustment";
  ChargeClass: null;
  ChargeDescription: string;
  ChargeFrequency: "Usage-Based";
  InvoiceIssuerName: string;
  ServiceProviderName: string;
  HostProviderName: string;
  ServiceName: string;
  ServiceCategory: "AI and Machine Learning";
  ServiceSubcategory: "Generative AI";
  PricingQuantity: null;
  PricingUnit: null;
  SubAccountId: string | null;
  SubAccountName: string | null;
  /** JSON object: `bivelio/basis`, `bivelio/model` and your own tags. */
  Tags: string;
  x_BiVelioBasis: Exclude<CostBasis, "shadow">;
  x_BiVelioModelId: string;
  x_BiVelioRequestCount: number;
  x_BiVelioProviderCallCount: number;
  x_BiVelioAvoidedCallCount: number;
  x_BiVelioBaselineCost: number | null;
  x_BiVelioActualCost: number | null;
  x_BiVelioMeasuredSavings: number | null;
  x_BiVelioReferenceSavings: number | null;
  x_BiVelioEstimatedSavings: number | null;
  x_BiVelioEliminatedInputFloorCost: number | null;
  x_BiVelioBaselineInputTokens: number;
  x_BiVelioActualInputTokens: number;
  x_BiVelioEliminatedInputTokens: number;
  x_BiVelioCompressedInputTokens: number;
  x_BiVelioProviderCachedInputTokens: number | null;
  x_BiVelioBaselineOutputTokens: number;
  x_BiVelioActualOutputTokens: number;
  x_BiVelioEliminatedOutputTokens: number;
};

/** A value {@link toCsv} can write. null and undefined become an empty field. */
export type CsvValue = string | number | boolean | null | undefined;
