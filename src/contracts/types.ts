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
  /**
   * For `role: "tool"`: the id of the tool call this message answers.
   *
   * The provider tool loop needs it: OpenAI's Chat Completions rejects a
   * `role: "tool"` message that does not carry `tool_call_id` and does not follow
   * an assistant turn with `tool_calls` (a 400). Pass the `id` from the
   * {@link ToolCallRequest} the model asked for. Ignored by providers that model
   * tool results differently.
   */
  toolCallId?: string;
  /**
   * For `role: "assistant"`: the tool calls the model requested on that turn.
   *
   * Send it back with the assistant turn when you continue a tool conversation,
   * so the following `role: "tool"` messages are valid. These are the same
   * {@link ToolCallRequest}s that came back in {@link SavingsResult.toolCalls}.
   */
  toolCalls?: ToolCallRequest[];
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
  /**
   * OPT-IN. Elide old, large tool_results from a multi-turn context before the
   * request is sent, replacing each one's body with a short stable stub while
   * keeping its `role:"tool"`, `toolCallId` and position. This is the v0
   * (age × size) policy the shadow lane measures — productionized to actually
   * shorten the outgoing prompt, on the generic tool_result segment nothing else
   * in the pipeline touches.
   *
   * IT ONLY RUNS WHEN THE POLICY ALLOWS IT. Like the semantic cache, elision is
   * disabled for write/destructive tools, freshness-sensitive, personalized or
   * stochastic requests, and for `freshnessBucket: "day"` — dropping the output
   * of a past action, or old context a fresh answer still needs, is exactly the
   * degradation the layer must not cause.
   *
   * FIDELITY FLOOR. The newest tool_results are never elided (a keep-floor of at
   * least 8, imported from the provider dial S4a); v0's own age≥2 rule is weaker
   * than that floor, so the floor wins. What it removes is a COUNT on the panel
   * (`eliminated_tokens`); its money value is estimated only in the shadow lane
   * and never enters your commission — your invoice stays the source of truth.
   */
  elision?: boolean;
  serialization?: boolean | "auto";
  singleflight?: boolean;
  deterministicResolvers?: boolean;
  router?: boolean;
  /**
   * OPT-IN, AND WHETHER IT SAVES OR COSTS DEPENDS ON THE MODEL. Read this whole
   * entry before switching it on.
   *
   * It sends the provider a compacted form of your output contract — short
   * property keys, short enum codes — and expands the reply back to YOUR shape
   * before it is validated, cached or returned. What you receive in `data`,
   * `text` and `rendered` is identical either way, and the layer proves that
   * round trip is exact before it applies anything.
   *
   * WHAT LIVE A/Bs MEASURED, same triage contract, same prompts, 8 paired
   * repetitions each. Input fell identically on both models, from 184 to 158
   * tokens — that part is deterministic, it is the smaller contract. Output did
   * not: `gpt-4o` wrote 3 tokens FEWER and the request came out 8.0% cheaper,
   * while `gpt-4o-mini` wrote 16 tokens MORE and the request came out 8.2% more
   * expensive. Short field names appear to give a smaller model less to go on,
   * so it fills in more, and output is billed around 4x input on that family.
   *
   * SO THE LEVER APPLIES ONLY WHERE THAT DELTA HAS BEEN MEASURED. It cannot be
   * read off a schema — the schema was identical in both runs — so the layer
   * does not guess. It uses, in order: the delta you measured and passed in
   * {@link SavingsToggles.outputCodebookMeasuredOutputDeltaTokens}; the same
   * delta remembered from an earlier request for that contract and model; the
   * delta BiVelio has published for that model. With none of those it skips and
   * says so in `report.traces`, including the exact break-even for your contract
   * so you know what a measurement would have to beat.
   */
  outputCodebook?: boolean;
  /**
   * The output-token delta you MEASURED for the contract on this request, with
   * {@link SavingsToggles.outputCodebook} on versus off, against the model you
   * are sending it to. POSITIVE means the compact contract made the model write
   * FEWER output tokens; negative means it wrote more.
   *
   * This is what lets the layer apply the codebook on a model it has not
   * published a figure for, and it overrides the published one when it has —
   * your traffic beats our benchmark. A negative delta switches the lever off
   * for that model: the input win is capped by the size of your schema while the
   * output loss grows with the answer, so no schema is large enough to buy it
   * back.
   *
   * It belongs to ONE contract against ONE model, which is why it travels on the
   * request rather than the layer config: a delta measured on your triage
   * contract says nothing about your extraction contract, and one measured on
   * `gpt-4o` says nothing about `gpt-4o-mini` — those two came out with opposite
   * signs. Measure it with a paired A/B over the same prompts, which is what
   * `benchmarks/ab-live.ts` in this package does, and measure it again when you
   * change model, contract or prompt.
   */
  outputCodebookMeasuredOutputDeltaTokens?: number;
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
  /**
   * Declare that this answer is NOT needed immediately, so the layer may ask the
   * provider for a cheaper, slower processing tier. Defaults to `false`.
   *
   * YOU DECLARE IT; THE LAYER NEVER GUESSES. Whether a request can wait is a
   * property of your business, not of the text: the same prompt is deferrable in
   * a nightly enrichment job and not deferrable behind a user's cursor. There is
   * no heuristic that can tell those apart, so there is no default that could be
   * right.
   *
   * IT CHANGES YOUR LATENCY, AND THAT IS THE WHOLE POINT. Where a cheaper tier
   * exists it is slower and its latency is variable, so a request on a
   * user-facing path must not carry this. `report.deferred.latency` states what
   * the provider documents. Nothing else about the request changes: same model,
   * same prompt, same sampling controls, so the answer is the answer you would
   * have got.
   *
   * WHAT IT IS WORTH IS READ BACK, NEVER ASSUMED. A provider short on capacity
   * may serve the standard tier and bill the standard rate without saying so in
   * the response body's shape. The layer therefore reads the tier the provider
   * reports having SERVED and credits only that — see
   * {@link DeferredExecutionReport}. On a provider with no cheaper synchronous
   * tier the request is sent unchanged and the report says so.
   */
  deferrable?: boolean;
}

/**
 * What asking for a cheaper processing tier actually got you on this request.
 *
 * Present whenever `savings.deferrable` is `true`, INCLUDING when it earned
 * nothing — "we asked and did not get it" is the answer you need most often, and
 * it is the one a report that only spoke on success would hide.
 *
 * ⚠️ THE FAILURE THIS EXISTS TO PREVENT. Asking for a discounted tier is not
 * getting one. Providers document that a request may be served at a different
 * tier from the one it asked for and billed at that tier's rate, and the
 * downgrade is silent: the answer comes back looking exactly the same. A layer
 * that credited the tier it REQUESTED would publish a discount your invoice does
 * not carry, on every request the provider quietly downgraded.
 *
 * So {@link servedTier} is read from the provider's response and it is the only
 * thing {@link credited} is allowed to depend on. When the provider reports no
 * tier at all, nothing is credited: an absent value means "cannot be known", not
 * "standard".
 */
export interface DeferredExecutionReport {
  /** The tier the layer asked the provider for, absent if it asked for none. */
  requestedTier?: string;
  /**
   * The tier the provider reports having SERVED, exactly as it named it. Absent
   * when the provider reported none.
   */
  servedTier?: string;
  /**
   * Whether the served tier bills BELOW the standard rate card, which is the
   * only condition under which a discount is claimed here.
   */
  credited: boolean;
  /**
   * Fraction of the standard list price the served tier bills — `0.5` for a tier
   * documented at half price. Present only when {@link credited}.
   */
  discountRate?: number;
  /**
   * What the tier was worth on this request, in your currency unit.
   *
   * A COUNTERFACTUAL priced from the standard rate card: this request was not
   * also run at standard price, so it is `(1 - discountRate)` applied to the
   * standard-rate cost of THE ONE CALL whose {@link servedTier} was read.
   *
   * ⚠️ IT IS NOT `cost.actual * (1 - discountRate)`, and the difference is not
   * rounding. `cost.actual` is the whole request: it can also carry a repair
   * retry, a tool-discovery probe, or a model-cascade attempt that was tried and
   * thrown away. No tier was read back for any of those, so none of them is
   * credited here even though they very likely got the discount too. Compute the
   * product yourself and you will get a LARGER number than this field — this
   * field is the part that was actually observed.
   *
   * ⚠️ `cost.actual` prices this request at the STANDARD rate card, so when this
   * field is present your invoice line will be LOWER than `cost.actual` by at
   * least this amount. The bias is deliberate and it is the safe one: the layer
   * under-reports the saving rather than promising one it cannot prove. The
   * reason it is not folded in is {@link creditedLedger}.
   */
  estimatedTierSaving?: number;
  /**
   * Which of the four ledgers this credits: none, and that is the honest answer.
   * Deferring avoids no call (ledger 1), removes no tokens (2), re-encodes
   * nothing (3) and is not provider caching (4). It changes the PRICE of the
   * tokens, exactly as the model cascade does, and there is no ledger for that.
   *
   * `cost.netSavings` therefore does not move: it is a ratio of baseline to
   * actual priced from a SINGLE rate card, and a discount that scales both sides
   * cannot change it. Folding this in would require a baseline priced from the
   * other card — a request nobody ran.
   */
  creditedLedger: "none";
  /**
   * What the provider documents about this tier's latency, in one sentence.
   *
   * It is a quotation of what is published, not an estimate. Where a provider
   * commits to no latency figure, this says so rather than inventing one.
   */
  latency: string;
  /** Why it did what it did, in one sentence. Never empty. */
  reason: string;
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
  /**
   * Input tokens of the cheap call whose answer was NOT served — the attempt
   * discarded on an escalation, or a shadow-mode sample.
   *
   * They are deliberately absent from `tokens.actualInput`: another model billed
   * them at another price, and that block is priced with a single cost model, so
   * folding them in would price them wrong. Their MONEY is in `cost.actual`.
   * These two fields are what closes the gap, so
   * `tokens.actualInput * inputPer1k + tokens.actualOutput * outputPer1k` plus
   * the cheap model's price applied here accounts for `cost.actual` in full.
   */
  cascadeInputTokens?: number;
  /** Output tokens of that same unserved call. See {@link cascadeInputTokens}. */
  cascadeOutputTokens?: number;
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

  /**
   * Optional terminal attribution (gateway): the session and subagent that
   * originated this request, taken from the `x-claude-code-session-id` /
   * `x-claude-code-agent-id` headers Claude Code already sends. These are
   * OPAQUE session/agent identities — they must never be treated as a user
   * identifier (Anthropic's gateway docs forbid it) — and they travel under
   * the same identity charset gate as `seatId`: counts and ids only, never
   * content.
   */
  attribution?: { sessionId?: string; agentId?: string };

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

  /**
   * What asking for a cheaper processing tier got you. Present whenever
   * `savings.deferrable` is `true`, including when it got you nothing.
   */
  deferred?: DeferredExecutionReport;

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
     * Where the baseline comes from. It is what separates measured money from
     * estimated money.
     *
     * - `measured`   — reconstructed from THIS request's provider counter. Real
     *                  money, checkable against the provider invoice.
     * - `estimated`  — the call was AVOIDED, so there never was a provider
     *                  counter and the baseline comes from the local estimator.
     *                  The best figure available, but not measured.
     * - `unmeasured` — the provider reported no usage. Nothing is claimed.
     * - `shadow`     — HYPOTHETICAL: the shadow lane (what would have happened
     *                  with a lever turned on). Never in the commission base,
     *                  never added to `measured` or to totals; shadow reports
     *                  are built separately and `estimateCost` never produces
     *                  this value.
     *
     * A dashboard that sums `measured` and `estimated` into a single "money
     * saved" figure is doing exactly what this product promises not to do —
     * and adding `shadow` to either would be making the savings up.
     */
    basis: import("../tokenizer/accounting.js").CostBasis;
    /**
     * Provider-side context clearing, priced at the FLOOR: the input tokens the
     * provider itself reported as cleared, valued at this model's cached-input
     * read rate — never at the input rate. Present only when the clearing is
     * attributable to this layer's context-management settings (the request
     * did not already carry them) and the model has a cached-input price.
     *
     * A separate lane on purpose: it is not part of `baselineEstimate`,
     * `actual` or `netSavings`, it is never folded into measured money, and it
     * is not part of the commission base. It is a lower bound of what those
     * tokens would have cost to keep reading, not a claim about the net effect
     * of clearing them.
     */
    eliminatedInputFloorCost?: number;
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
 * It is intentionally a bare shape, so any object with these methods works and
 * the SDK never has to import a licensing package.
 *
 * There is no ungated mode: with no gate and no `licenseKey`, `generate()`
 * throws {@link LicenseError} on entry. In the published npm package an injected
 * gate is ignored entirely — a `licenseKey` verified against BiVelio's embedded
 * public key is the only accepted license there, and this interface is what that
 * key is turned into internally.
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
