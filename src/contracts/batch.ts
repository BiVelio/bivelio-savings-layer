import type { ProviderUsage } from "../providers/types.js";
import type { JsonSchema, PriceLeverSaving, SavingsRequest, ToolCallRequest } from "./types.js";

// LOS TIPOS PÚBLICOS DE `layer.batches` (src/batch/lotes.ts).
//
// Viajan a `dist/index.d.ts`, así que TODO JSDoc de este fichero está en inglés
// y sin tildes (la verja `superficie-publica-limpia` tiene el techo de líneas con
// acentos en su valor exacto). El razonamiento interno va en `//`.

/** One request of a batch: your id for it, and the same request you would pass to `generate()`. */
export interface BatchRequest {
  /**
   * Your id for this request, unique within one `submit()`: 1 to 64 letters, digits,
   * `_` or `-`. Results come back in any order and are matched by this id.
   */
  customId: string;
  /**
   * The request, as for `generate()`. It is sent as written, translated by the same
   * provider adapter: the layer's per-request savings (caching, compression, model
   * cascade, retrieval) do not run on batches, so `retrieval` and `structuredData`
   * are rejected and `savings` is ignored.
   */
  request: SavingsRequest;
}

/** Options for `layer.batches.submit()`. */
export interface BatchSubmitOptions {
  /**
   * Anthropic only. Mark the leading system messages of each request as a prompt-cache
   * prefix, so requests that share them can read it at the cache rate. A cache write
   * costs more than plain input and, in a batch, hits are best-effort, so this pays
   * only when many requests share a long system prompt. Defaults to false. OpenAI
   * caches on its own and ignores it.
   */
  cacheSharedPrefix?: boolean;
  /**
   * Upper bound on requests per provider batch, below the provider's own limit, to get
   * partial results sooner. The layer always splits at the provider limits (and, on
   * OpenAI, by model).
   */
  maxRequestsPerBatch?: number;
  /** Cancels the HTTP calls of this submission. Batches already created stay created. */
  signal?: AbortSignal;
}

/**
 * A submitted batch job. Plain JSON: store it and pass it back to `status()`,
 * `results()` or `cancel()`, from this process or another one. It holds batch ids,
 * your request ids, model ids and output schemas; never prompts or answers.
 */
export interface BatchJob {
  kind: "bvsala.batch";
  version: 1;
  /** Which batch API holds the job. */
  provider: "anthropic" | "openai";
  /** The provider base URL the job was submitted to, without credentials. */
  endpoint: string;
  /** One provider batch id per chunk, in submission order. */
  batchIds: string[];
  /** ISO 8601. */
  submittedAt: string;
  /**
   * Every submitted request: your id, its model, the index in `batchIds` of the provider
   * batch that carries it, and its output schema as an index into `schemas`.
   */
  requests: { customId: string; model: string; batch: number; schema?: number }[];
  /** The distinct output schemas of the job, stored once each. */
  schemas: JsonSchema[];
}

/** Request counts of a job, summed over its provider batches. */
export interface BatchCounts {
  processing: number;
  succeeded: number;
  errored: number;
  canceled: number;
  expired: number;
}

/** Where a job stands, as its provider reports it. */
export interface BatchJobStatus {
  /** `"ended"` once every provider batch of the job has finished, expired, failed or been canceled. */
  state: "in_progress" | "canceling" | "ended";
  requestCount: number;
  /**
   * As the provider reports them. OpenAI reports only completed and failed while a
   * batch runs; its canceled and expired requests are counted once it has ended.
   */
  counts: BatchCounts;
  /** Each provider batch with the status its provider gave, verbatim. */
  batches: { id: string; status: string }[];
}

/** One request's outcome. */
export interface BatchItemResult<T = unknown> {
  customId: string;
  /** The model you asked for. */
  model: string;
  /**
   * `"succeeded"` ran and is billed by the provider. `"errored"`, `"canceled"` and
   * `"expired"` returned no answer and no usage (Anthropic documents that it does not
   * bill them). `"missing"` means the provider returned no line for a request of an
   * ended batch, which should not happen: nothing is assumed about it.
   */
  outcome: "succeeded" | "errored" | "canceled" | "expired" | "missing";
  text?: string;
  /** Present when the request had an output contract and the answer met it. */
  data?: T;
  /** Whether the answer met the output contract, when the request had one and no tool was called. */
  contract?: "met" | "missed";
  toolCalls?: ToolCallRequest[];
  finishReason?: string;
  /** The provider's own counter for this request. */
  usage?: ProviderUsage;
  /** The processing tier this result was billed at, as read from the provider. */
  servedTier?: string;
  /**
   * What the batch tier was worth on this request: its usage at the standard rate card
   * minus the same usage at the published batch rate card, component by component.
   * Present only when credited. It is reported, never metered or billed.
   */
  tierSaving?: PriceLeverSaving;
  /** Why it was or was not credited, or what failed. One sentence, never empty. */
  reason: string;
  /** The provider's error, for `"errored"` results. */
  error?: { type: string; message: string };
}

/** The whole job, added up. */
export interface BatchSummary {
  requestCount: number;
  succeeded: number;
  errored: number;
  canceled: number;
  expired: number;
  missing: number;
  /** Requests whose provider batch has not ended yet: not in `items`. */
  pending: number;
  /** Succeeded requests with a `tierSaving`. */
  credited: number;
  /** Sum of every `tierSaving.amount`. Never more than the sum of each request's published difference. */
  tierSaving: number;
  /** The credited requests' usage at the standard rate card. */
  standardCost: number;
  /** The same usage at the batch rate card. */
  appliedCost: number;
  /** `"measured"` only when every credited request is; `"none"` when nothing was credited. */
  basis: "measured" | "estimated" | "none";
  /** YYYY-MM-DD: the oldest check date of the rate cards used. */
  pricesCheckedOn?: string;
  /** Always `"none"`: a batch saving is reported next to the ledgers, never folded into them. */
  creditedLedger: "none";
  /** One sentence. Never empty. */
  reason: string;
}

/** What `layer.batches.results()` returns. */
export interface BatchResults<T = unknown> {
  /** False while any provider batch of the job is still running; results then cover only the ones that ended. */
  ended: boolean;
  items: BatchItemResult<T>[];
  summary: BatchSummary;
}

/**
 * The provider's asynchronous batch API: requests that can wait hours, billed at the
 * provider's batch rate card. Anthropic's Message Batches and OpenAI's Batch API
 * (Chat Completions) through the built-in providers; other providers throw.
 */
export interface SavingsBatches {
  /**
   * Send requests to the provider's batch API. Returns as soon as the provider has
   * accepted them, with nothing priced: a batch is valued only when its results are
   * read. Throws before sending anything when a request cannot be batched. If a later
   * chunk fails after earlier ones were created, the thrown error carries the partial
   * job as `error.job`, so no created batch is lost.
   */
  submit(requests: BatchRequest[], options?: BatchSubmitOptions): Promise<BatchJob>;
  /** Where the job stands. */
  status(job: BatchJob, options?: { signal?: AbortSignal }): Promise<BatchJobStatus>;
  /**
   * The results of every provider batch of the job that has ended, one per request,
   * each valued at the two published rate cards, and the total.
   */
  results<T = unknown>(job: BatchJob, options?: { signal?: AbortSignal }): Promise<BatchResults<T>>;
  /** Ask the provider to stop the job. Requests it already processed are still billed. */
  cancel(job: BatchJob, options?: { signal?: AbortSignal }): Promise<BatchJobStatus>;
}
