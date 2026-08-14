/**
 * Core contracts for BV-SALA (bivelio-savings-layer).
 *
 * The layer keeps FOUR separate ledgers of savings. They must never be summed
 * into a single "tokens saved" number, because each one means something
 * different:
 *
 *  - avoided_calls          LLM / RAG / tool calls that never executed.
 *  - eliminated_tokens      information dropped because it was not needed.
 *  - compressed_tokens      information kept, but encoded with fewer tokens.
 *  - provider_cached_tokens tokens still in the prompt that the provider may
 *                           bill or process differently (prefix/KV caching).
 *
 * A cache hit eliminates a whole call. A compact encoding re-encodes a structured payload.
 * A context compressor removes redundant words. A provider prefix cache makes tokens
 * cheaper without removing them. Mixing these produces misleading metrics.
 */

/** Roles understood by the provider-neutral chat interface. */
export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: MessageRole;
  content: string;
  /** Optional name (e.g. tool name for role: "tool"). */
  name?: string;
  /** Opaque provider metadata; never used for the exact-cache key. */
  metadata?: Record<string, unknown>;
}

/** How a request is classified by the execution router. */
export type ExecutionClass =
  | "NO_RETRIEVAL"
  | "SINGLE_RETRIEVAL"
  | "MULTI_HOP_RETRIEVAL"
  | "TOOL_ACTION"
  | "NON_CACHEABLE";

/** Risk profile of a tool. Write/destructive tools are never cached. */
export type ToolRisk = "read" | "write" | "destructive";

export interface ToolDescriptor {
  id: string;
  /** Human/agent intents this tool can satisfy — used by the tool selector. */
  intents: string[];
  risk: ToolRisk;
  /** JSON-schema-like description of the tool's arguments. */
  parameters?: JsonSchema;
  description?: string;
  /** Whether the tool's result is stable enough to cache. */
  freshness?: "static" | "dynamic";
  /** Estimated schema token cost per tokenizer id (optional, filled lazily). */
  schemaTokens?: Record<string, number>;
}

/** Minimal structural JSON-Schema subset the layer reasons about. */
export interface JsonSchema {
  type?:
    | "object"
    | "array"
    | "string"
    | "number"
    | "integer"
    | "boolean"
    | "null";
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  additionalProperties?: boolean | JsonSchema;
  maxItems?: number;
  minItems?: number;
  maxLength?: number;
  minLength?: number;
  maximum?: number;
  minimum?: number;
  pattern?: string;
  format?: string;
  description?: string;
  /** Non-standard: opaque identifier used to reference a registered contract. */
  $id?: string;
}

export interface OutputContract {
  /** Stable identifier, e.g. "research-answer:v3". */
  contractId: string;
  schema: JsonSchema;
  /** Hard ceiling on generated tokens. */
  maxOutputTokens?: number;
  /** Version marker included in the exact-cache key. */
  version?: string;
}

/** Serialization formats the format-selector can choose between. */
export type SerializationFormat = "json-compact" | "compact-rows" | "csv";

export interface RetrievalOptions {
  mode: "off" | "auto" | "single" | "multi";
  maxRounds?: number;
  maxDocuments?: number;
}

export interface SavingsToggles {
  exactCache?: boolean;
  semanticCache?: boolean | "safe-only";
  compression?: boolean | "auto";
  serialization?: boolean | "auto";
  singleflight?: boolean;
  deterministicResolvers?: boolean;
  router?: boolean;
  /**
   * OPT-IN. Send the provider a compacted form of your output contract — short
   * property keys, short enum codes — so the model spends fewer tokens saying
   * the same thing, and expand the reply back to YOUR shape before it is
   * validated, cached or returned. What you receive in `data`, `text` and
   * `rendered` is identical either way.
   *
   * It is applied only when the layer can prove the expansion is exact for that
   * schema and only when it counts as a net token win on both sides (the
   * compact contract itself travels as input). Otherwise your schema is sent
   * unchanged. Off by default because it changes what the provider sees, and
   * whether a model answers as WELL from a compact contract is a question only
   * an A/B on your own traffic can settle. Check `report.traces` for what it
   * decided and why.
   */
  outputCodebook?: boolean;
  /**
   * OPT-IN, and it changes the latency contract: where it applies, one request
   * becomes TWO provider calls, one after the other.
   *
   * With a large tool catalogue the full JSON schema of every candidate travels
   * on every request, even though the model will use one tool or none. With this
   * on, the layer may first send lightweight descriptors (name + one line, no
   * `parameters`), read which tools the model asks for, and only then send those
   * full schemas.
   *
   * It is applied only when the token arithmetic for THIS request, priced with
   * your cost model, says the second call pays for itself with margin — so a
   * small catalogue silently keeps the single-call path.
   *
   * THE MARGIN IS NOT A GUARANTEE THAT EVERY REQUEST GETS CHEAPER. When the
   * model names no tool in the first call, the request still goes out with every
   * schema and the first call is pure added cost: that request costs MORE, and
   * the report says so (`cost.netSavings` goes negative). The margin required is
   * exactly the cost of that outcome, so the pattern breaks even while it
   * happens on at most one request in two. If your traffic asks for a tool less
   * often than that — a chat assistant with a big catalogue answers most turns
   * directly — leave this off. Only an A/B against your own traffic settles it.
   *
   * IT ALSO GIVES UP THE PROVIDER'S PREFIX CACHE, on every request, not just the
   * ones where it applies. Tools render FIRST in a provider request, and with
   * this on, which schemas travel is decided by a probe whose answer is not
   * deterministic — so the front of the prompt varies between requests that
   * would otherwise share a cacheable prefix. Marking one would pay the write
   * premium (1.25x on Anthropic) for a prefix that cannot hit. If your prompts
   * carry a long fixed system header and your traffic repeats it, that discount
   * is very likely worth more than this lever: measure both before choosing.
   * `report.traces` says which one is off and why.
   *
   * When the second call happened, `report.calls.actualLlm` is 2. The extra
   * call's tokens are counted as spend and never credited to your baseline.
   * Write and destructive tools always travel with their full schema, so no
   * action can be lost to a discovery step.
   */
  toolDiscovery?: boolean;
  /**
   * Send the request to a CHEAPER model of the same family, check the answer
   * with a deterministic gate, and fall back to the model you asked for only
   * when that gate rejects it. Defaults to `"off"`.
   *
   * It is the only lever here that changes the price of the WHOLE bill — input
   * and output — instead of one axis of it. Read {@link ModelCascadeMode} for
   * what each mode does, and {@link ModelCascadeReport} for the failure this
   * cannot protect you from. Start at `"shadow"`.
   */
  modelCascade?: ModelCascadeMode;
}

/**
 * How much authority the model cascade has over your requests.
 *
 * - `"off"`     (default) it neither measures nor decides. Nothing changes.
 * - `"shadow"`  it MEASURES and reports, and never changes your model. Every
 *               request still goes to the model you asked for. The report gains
 *               a {@link ModelCascadeReport} saying which cheaper model was
 *               eligible, what the arithmetic says about it, and what the swap
 *               would have been worth on THIS request. Costs nothing extra
 *               unless you also set `modelCascade.shadowSampleRate` on the
 *               layer, which is a separate, priced opt-in.
 * - `"on"`      it routes for real. Opt-in, never silent: the report always
 *               declares the model that served the answer, and a request served
 *               by a cheaper model is labelled `bounded_degradation`.
 *
 * `"on"` carries a gate: when a workload's measured escalation rate reaches the
 * break-even, the cascade turns ITSELF off for that workload and says so. That
 * gate protects your BILL. It cannot protect quality — see
 * {@link ModelCascadeReport}.
 */
export type ModelCascadeMode = "off" | "shadow" | "on";

/**
 * What the model cascade did, or would have done, on this request.
 *
 * Present whenever `savings.modelCascade` is not `"off"` — including when the
 * request was not eligible, because "we did not route this and here is why" is
 * the answer you need most often.
 *
 * ⚠️ READ THIS BEFORE YOU TURN THE CASCADE ON.
 *
 * The gate that decides whether a cheap answer is good enough is DETERMINISTIC,
 * which is what makes the saving real: an LLM judge would cost the very money
 * this lever exists to save. But a deterministic gate measures FORM, not
 * MEANING. An answer with impeccable JSON and the wrong content passes it.
 *
 * That failure is invisible by construction. It lowers the escalation rate, it
 * raises the reported saving, and the automatic shut-off never fires — because
 * the shut-off watches the escalation rate, and the escalation rate looks
 * excellent. It has the same signature as success, and it surfaces weeks later
 * as customer complaints.
 *
 * So: `escalationRate` is a MONEY figure. Its complement is not a quality score,
 * and this report deliberately does not publish one. If you need evidence about
 * quality, run an A/B on your own traffic. `divergedOnSample` (from shadow
 * sampling) is a hint that something is wrong, never proof that nothing is.
 */
export interface ModelCascadeReport {
  mode: ModelCascadeMode;
  /** The model the caller asked for. */
  requestedModel: string;
  /**
   * The model that actually produced the answer. In `"shadow"` this always
   * equals {@link requestedModel}; in `"on"` it is the cheap model when its
   * answer was accepted, and the requested one when it was escalated.
   */
  servedModel: string;
  /** The cheaper model this request was (or would have been) routed to. */
  candidateModel?: string;
  /** Whether the cascade was allowed to consider this request at all. */
  eligible: boolean;
  /** Why it did what it did, in one sentence. Never empty. */
  reason: string;
  /** What the deterministic gate is able to check here. */
  verifier: "none" | "structural" | "value-constrained";
  /**
   * cost(cheap) / cost(strong), worst case over any token mix. The saving on
   * routed traffic is `1 - r - escalationRate`.
   */
  costRatio?: number;
  /** Escalation rate above which routing costs MORE than not routing (`1 - r`). */
  breakEvenEscalationRate?: number;
  /** Escalation rate above which routing stops hitting the target capture. */
  targetEscalationRate?: number;
  /** Opaque, stable id of the workload these rates are measured over. */
  workload?: string;
  /** Measured escalation rate for this workload, or absent if nothing measured yet. */
  escalationRate?: number;
  /** How many requests that rate is measured over. */
  escalationSamples?: number;
  /** Whether THIS request was escalated to the requested model after the gate rejected it. */
  escalated?: boolean;
  /**
   * What swapping the model was worth on this request, in your currency unit.
   *
   * A COUNTERFACTUAL: the strong model was not run, so this is priced from the
   * measured token counts at both list prices. It is deliberately NOT part of
   * `cost.netSavings` — that number stays a comparison at a single price, and
   * this one would inflate it with a call nobody made. Negative on an escalated
   * request, which is exactly what an escalation costs you.
   */
  estimatedSwapSaving?: number;
  /**
   * Which of the four ledgers this credits: none, and that is the honest answer.
   * Routing avoids no call (ledger 1), removes no tokens (2), re-encodes nothing
   * (3) and is not provider caching (4). It changes the PRICE of the tokens, and
   * there is no ledger for that.
   */
  creditedLedger: "none";
  /** Whether this shadow request paid for an extra cheap call to measure the rate. */
  sampled?: boolean;
  /** What that extra call cost, in your currency unit. */
  sampleCost?: number;
  /**
   * On a sampled request where BOTH answers satisfied the contract: whether they
   * disagree on a hard value (a number, a boolean, a short code).
   *
   * A hint about false valids, and nothing more. It only covers sampled traffic,
   * disagreement is not proof the cheap answer is the wrong one, and agreement
   * is not proof either answer is right.
   */
  divergedOnSample?: boolean;
}

export interface RequestContext {
  tenantId?: string;
  authorizationScope?: string;
  locale?: string;
  /** Epoch marker of the knowledge base; part of cache keys / freshness. */
  knowledgeEpoch?: string;
  /** Session identifier for conversational memory. */
  sessionId?: string;
  /** Bucket describing how fresh the answer must be. */
  freshnessBucket?: "any" | "day" | "hour" | "live";
  safetyPolicyVersion?: string;
}

export interface SavingsRequest {
  /** Provider-qualified model id, e.g. "openai/gpt-4o-mini". */
  model: string;
  messages: ChatMessage[];
  tools?: ToolDescriptor[];
  response?: OutputContract;
  retrieval?: RetrievalOptions;
  savings?: SavingsToggles;
  context?: RequestContext;
  /** Sampling controls that participate in the exact-cache key. */
  temperature?: number;
  seed?: number;
  /** Tokenizer id to cost against; defaults to a model-derived estimate. */
  tokenizer?: string;
  /** Arbitrary structured payload to be serialized into the prompt. */
  structuredData?: unknown;
}

/** A tool invocation the model requested (the provider-neutral shape). */
export interface ToolCallRequest {
  id?: string;
  name: string;
  /** Argumentos tal cual los serializó el modelo (JSON en crudo). */
  arguments: string;
}

/** Result returned to the caller. */
export interface SavingsResult<T = unknown> {
  requestId: string;
  /** Validated, structured output (when a contract was supplied). */
  data: T;
  /** Raw text output from the provider (or the resolver). */
  text: string;
  /** Locally-rendered, human-facing representation, when produced. */
  rendered?: string;
  /**
   * Llamadas a herramienta que pidió el modelo. Cuando está presente, `text` y
   * `data` NO son la respuesta final: el modelo devolvió `content` vacío y pide
   * ejecutar la acción (`finishReason === "tool_calls"`).
   *
   * `content: null` + `tool_calls` is the NORMAL shape as soon as tools are in
   * play, so treat an empty `text` together with a populated `toolCalls` as a
   * tool invocation to execute — not as an empty answer.
   */
  toolCalls?: ToolCallRequest[];
  /**
   * Por qué paró de generar el modelo (`"stop"`, `"length"`, `"tool_calls"`, …).
   * Presente cuando la respuesta viene del proveedor; ausente en los atajos
   * (caché/resolver), que solo sirven respuestas finales completas.
   */
  finishReason?: string;
  report: SavingsReport;
}

export type CacheOutcome =
  | "miss"
  | "exact"
  | "semantic"
  | "singleflight"
  | "deterministic";

/**
 * The quality claims this layer is able to DEMONSTRATE for the answer it served.
 *
 * A boolean cannot carry this. `constraints.structurallyValid` puts an answer
 * computed by a deterministic resolver — exact by construction — in the same box
 * as one the model wrote while nobody checked anything but its shape. Those two
 * are the difference between "this is the result" and "this is what the model
 * said", and a product that claims savings owes the reader that distinction.
 *
 * THE RULE BEHIND THIS VOCABULARY: never report "no loss" on the strength of
 * cosine similarity, BLEU, ROUGE or another model's judgement. Those scores stay
 * high while a figure, a negation or an exception quietly disappears — precisely
 * the fields that decide a legal or financial document. A claim of equivalence
 * rests on a deterministic gate, or it is not made.
 *
 * - `exact`            exact by construction: a deterministic resolver computed
 *                      the answer, or an exact-cache hit replayed the answer
 *                      already produced for this very same request.
 * - `task_equivalent`  not byte-identical, but it cleared a deterministic gate
 *                      before being served — numbers and dates as a multiset,
 *                      negation parity and a key-entity floor all had to agree,
 *                      on top of any similarity score.
 * - `not_verified`     the model was called and nothing beyond the shape of the
 *                      answer was checked. The honest default, and the common case.
 * - `bounded_degradation`
 *                      the answer was produced by a model CHEAPER than the one
 *                      you asked for, and it cleared the deterministic gate for
 *                      its output contract before being served. The bound is
 *                      exactly what that gate checks — shape, and whatever value
 *                      constraints your contract declares. NOT meaning: a
 *                      well-formed answer with wrong content earns this label
 *                      too. See {@link ModelCascadeReport}.
 * - `rejected`         what was served does not satisfy its output contract, and
 *                      a repair either failed or would have been a wasted call.
 *                      The answer is still returned: this is the layer's verdict
 *                      on it, not a refusal to hand it over.
 *
 * The list is deliberately short. A status nobody produces is a promise the
 * reader cannot check, so levers that do not exist yet bring their own status
 * the day they can demonstrate it. Read this as an OPEN set — keep a default
 * branch, exactly as with a licence status.
 */
export const QUALITY_STATUSES = [
  "exact",
  "task_equivalent",
  "not_verified",
  "bounded_degradation",
  "rejected",
] as const;

export type QualityStatus = (typeof QUALITY_STATUSES)[number];

export interface SavingsReport {
  requestId: string;
  /**
   * The model that produced this answer.
   *
   * Equal to the model you asked for, EXCEPT when `savings.modelCascade` is
   * `"on"` and a cheaper model's answer cleared the deterministic gate — then
   * this names the cheaper model, because that is what ran and what your bill
   * will show. `report.modelCascade.requestedModel` always holds what you asked
   * for. Changing your model is never silent.
   */
  model: string;

  calls: {
    baselineLlm: number;
    actualLlm: number;
    avoidedLlm: number;
    baselineRetrieval: number;
    actualRetrieval: number;
    baselineTools: number;
    actualTools: number;
    retries: number;
  };

  tokens: {
    baselineInput: number;
    actualInput: number;
    /** Ledger 2: dropped because unnecessary. */
    eliminatedInput: number;
    /** Ledger 3: kept but re-encoded with fewer tokens. */
    compressedInput: number;
    baselineOutput: number;
    actualOutput: number;
    eliminatedOutput: number;
    /** Ledger 4: still present, but provider-cached (cheaper, not removed). */
    providerCachedInput?: number;
  };

  cache: {
    result: CacheOutcome;
    confidence?: number;
    ageMs?: number;
  };

  routing: {
    executionClass: ExecutionClass;
    confidence: number;
    rounds: number;
    reason?: string;
  };

  serialization: {
    chosen: SerializationFormat;
    candidateTokens: Partial<Record<SerializationFormat, number>>;
    instructionOverheadTokens: number;
  };

  compression?: {
    originalTokens: number;
    compressedTokens: number;
    protectedSpans: number;
    fidelityPassed: boolean;
  };

  constraints: {
    backend: string;
    schemaVersion: string;
    /**
     * Si lo servido cumple el contrato de salida.
     *
     * SE OMITE cuando no hay respuesta final que validar — hoy, un turno en el
     * que el modelo pidió ejecutar herramientas (`toolCalls`): ahí la respuesta
     * llegará en el turno siguiente, así que afirmar `true` sería certificar un
     * contrato que nadie miró, y afirmar `false` sería acusar de incumplimiento
     * a algo que ni pretende ser la respuesta.
     */
    structurallyValid?: boolean;
  };

  /**
   * How the served answer earned its place, in one word. Optional and additive:
   * a report built by an older SDK simply does not carry it, so treat an absent
   * value as "unknown", never as a pass.
   *
   * It only ever DEGRADES what the rest of the report claims. An answer that
   * fails its output contract is `rejected` however it was produced — a resolver
   * that computes the right number for the wrong contract does not get to keep
   * the `exact` label.
   */
  qualityStatus?: QualityStatus;

  /**
   * What the model cascade did, or would have done. Present whenever
   * `savings.modelCascade` is not `"off"`. Read its docstring before turning the
   * cascade on: it documents a failure mode no gate in this layer can catch.
   */
  modelCascade?: ModelCascadeReport;

  quality: {
    taskPassed?: boolean;
    /**
     * Similarity score of the retained answer, when one was computed.
     *
     * A number here is NOT evidence of equivalence: see {@link QualityStatus}.
     * Cosine (and BLEU, ROUGE, or an LLM judge) can sit above 0.95 across a
     * changed figure or a dropped negation, so it informs a decision — it never
     * licenses a "no loss" claim.
     */
    semanticScore?: number;
    freshnessPassed?: boolean;
  };

  cost: {
    baselineEstimate: number;
    actual: number;
    netSavings: number;
    /**
     * De dónde sale el baseline. Es lo que separa el dinero medido del estimado.
     *
     * - `measured`   — reconstruido desde el contador del proveedor de ESTA
     *                  petición. Es dinero, y se puede contrastar con la factura.
     * - `estimated`  — la llamada se EVITÓ, así que nunca hubo contador del
     *                  proveedor y el baseline sale del estimador local. Es la
     *                  mejor cifra disponible, pero no está medida.
     * - `unmeasured` — el proveedor no reportó uso. No se reclama nada.
     *
     * Un panel que sume `measured` y `estimated` en una sola cifra de "dinero
     * ahorrado" está haciendo justo lo que este producto promete no hacer.
     */
    basis: import("../tokenizer/accounting.js").CostBasis;
  };

  latencyMs: {
    total: number;
    preprocessing: number;
    provider: number;
  };

  /** Ordered pipeline decision breadcrumbs, for debugging and audit. */
  traces: TraceEvent[];
}

/**
 * Structural license gate the pipeline consults before enabling a managed
 * feature (semantic cache, learned thresholds, long-context compression, …).
 *
 * It is intentionally a bare shape — the SDK never imports the license package.
 * `@bivelio/license-client`'s `createLicenseGate()` returns a compatible object,
 * but any implementation of this interface works. When no gate is configured the
 * pipeline behaves as an ungated self-managed deployment (backwards compatible).
 */
export interface LicenseGate {
  isEntitled(feature: string): boolean;
  /**
   * Whether there is an overall active (or in-grace) license. La consulta la
   * puerta de entrada fail-closed del pipeline.
   *
   * OBLIGATORIO. Fue opcional "por compatibilidad", y esa opcionalidad era el
   * bypass: un gate al que le faltara el método dejaba pasar todas las
   * peticiones con solo un aviso por consola. Para desarrollo local está
   * `devUnlicensed: true`, que es explícito y no se cuela sin querer.
   */
  isActive(): boolean;
  /**
   * Resolved status (active|grace|expired|invalid|revoked|stale), for error messages.
   *
   * `stale` es una licencia PAGADA Y VIGENTE que no ha podido confirmarse contra
   * el control plane — un problema de red, no de dinero. Se distingue de
   * `expired` porque el mensaje que se le da al cliente NO puede mandarle a
   * renovar algo que ya tiene pagado.
   *
   * El tipo es `string` y no el union a propósito: un gate lo implementa el
   * llamante y puede devolver cualquier cosa, así que `mensajeDeLicencia` tiene
   * que tener una rama por defecto de todas formas.
   */
  status?(): string;
}

export interface TraceEvent {
  stage: string;
  outcome: string;
  detail?: Record<string, unknown>;
  /** Monotonic elapsed ms from the start of the request. */
  atMs: number;
}
