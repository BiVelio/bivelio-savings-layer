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
   * {@link ToolCallRequest} the model asked for.
   *
   * Anthropic's Messages API needs it too: with it, the Anthropic adapter sends
   * the result as a `tool_result` block paired with the call's `tool_use` block.
   * Without it (or without the ids in the assistant turn's `toolCalls`), the
   * exchange is sent as plain text and the adapter warns once.
   */
  toolCallId?: string;
  /**
   * For `role: "tool"`: the tool failed, and `content` says how.
   *
   * The Anthropic adapter sends it as `is_error: true` on the `tool_result`, so
   * the model reads the content as an error rather than as data. Providers
   * without such a flag (OpenAI's Chat Completions) send the content unchanged,
   * so write the error into `content` either way.
   */
  isError?: boolean;
  /**
   * For `role: "assistant"`: the tool calls the model requested on that turn.
   *
   * Send it back with the assistant turn when you continue a tool conversation,
   * so the following `role: "tool"` messages are valid. These are the same
   * {@link ToolCallRequest}s that came back in {@link SavingsResult.toolCalls},
   * ids included.
   */
  toolCalls?: ToolCallRequest[];
  /**
   * Opaque provider metadata; never used for the exact-cache key. The one
   * exception is `tool_call_id` on a `role: "tool"` message: the OpenAI
   * adapter still sends it as the call id when `toolCallId` is absent,
   * so the key reads it as that same field.
   */
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
  /**
   * Hard ceiling on generated tokens for this contract. A free-text request (no
   * schema) sets its ceiling with {@link SavingsRequest.maxOutputTokens}; when
   * both are set, the smaller one is sent.
   */
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

/**
 * How a request chooses between the provider's native tool search and the layer's
 * tool selector. See {@link SavingsToggles.toolSearch}.
 *
 * - `"off"` (default): the layer's tool selector runs, as without this option.
 * - `"auto"`: native tool search when the adapter talks to the provider's own API host,
 *   the catalogue reaches the provider's documented size threshold, and deferring it
 *   pays for one search on every request even with a warm prompt cache. Otherwise the
 *   selector runs.
 * - `"always"`: native tool search whenever the adapter and model support it, with no
 *   size or cost check. Use it when a proxy in front of the provider forwards the
 *   search blocks, or when you have measured it on your own traffic.
 */
export type ToolSearchMode = "off" | "auto" | "always";

/** The long form of {@link SavingsToggles.toolSearch}. */
export interface ToolSearchOptions {
  mode: ToolSearchMode;
  /**
   * Tool ids sent without deferred loading, so the model can call them without
   * searching first. They are part of the cached prefix: keep the list short and the
   * same on every request. Ids that are not in the request's tools are ignored.
   */
  alwaysLoaded?: string[];
  /**
   * The provider's search: `"bm25"` (the model writes natural-language queries; the
   * default) or `"regex"` (the model writes regular expressions).
   */
  variant?: "bm25" | "regex";
}

export interface SavingsToggles {
  exactCache?: boolean;
  /**
   * OPT-IN. Reuse the answer to an earlier, reworded version of this request.
   * Needs a semantic cache on the layer (`createSavingsLayer({ semanticCache })`)
   * and a license that includes it.
   *
   * - `true` and `"safe-only"` are the same setting: single-shot requests only.
   * - `"include-agentic"` also admits agentic requests: those that declare tools
   *   (read-only ones included), carry tool calls or tool results, or hold more
   *   than one user turn.
   *
   * WHY AGENTIC TRAFFIC IS LEFT OUT BY DEFAULT. Two runs of an agent loop can
   * differ only in what a tool returned. The deterministic guard under the
   * similarity score compares figures and dates, negation and word overlap; it
   * cannot tell that a tool said something else in words. Measure it on your own
   * traffic before you include it.
   *
   * Whatever you set, requests with write or destructive tools, freshness-sensitive
   * requests (including any freshness bucket other than `any`), personalized
   * requests and stochastic sampling never use this cache. A hit is reported as
   * `cache.result: "semantic"` and `qualityStatus: "task_equivalent"`.
   */
  semanticCache?: boolean | "safe-only" | "include-agentic";
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
  /**
   * OPT-IN. Compact the text of `role: "tool"` messages before the request is
   * sent: terminal escape sequences and superseded progress-bar states are
   * removed, whitespace between JSON tokens is removed when the whole output is
   * JSON, and runs of identical consecutive lines are folded into one line plus
   * a count. Nothing is summarised and no word is dropped.
   *
   * IT NEVER REWRITES WHAT THE PROVIDER HAS ALREADY CACHED. The decision for each
   * tool output depends only on its own text and on the call that produced it,
   * so an output compacted on the turn it arrives is re-sent with the same bytes
   * on every later turn and the prefix cache keeps matching. Turn it on for a
   * whole conversation (or layer-wide with `toolOutputCompaction` in
   * `createSavingsLayer`), not halfway through one: the first compacted request
   * of a conversation that started without it rewrites the history once.
   *
   * Outputs of calls whose arguments name a file are left verbatim by default,
   * because an agent that edits files by exact string match copies what it read.
   * `false` switches it off for this request even when the layer enables it.
   *
   * What it removes is a COUNT in `report.tokens.compressedInput`; it is never
   * priced into `cost.netSavingsRatio` or your commission — your provider's invoice
   * shows the effect.
   */
  toolOutputCompaction?: boolean;
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
   * the report says so (`cost.netSavingsRatio` goes negative). The margin required is
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
   * OPT-IN. Let the PROVIDER search your tool catalogue instead of the layer's tool
   * selector. Defaults to `"off"`. Read {@link ToolSearchMode} for the three modes.
   *
   * With it applied, every tool you pass travels on every request, marked for deferred
   * loading, next to the provider's search tool. The provider keeps deferred definitions
   * out of the prompt prefix; the model searches the catalogue when it needs a tool, and
   * the definitions it finds are added after the prefix. No tool you declared becomes
   * unreachable, and the cached prefix stays the same when the question changes or the
   * catalogue grows.
   *
   * WHERE IT APPLIES. The Anthropic adapter of this package, on a model listed in the
   * provider's tool search compatibility table, with at least one tool to defer.
   * Requests with an output contract, or with the model cascade on, keep the selector.
   * OpenAI documents its tool search for the Responses and Agents APIs, not for Chat
   * Completions, which the OpenAI-compatible adapter speaks, so it keeps the selector too.
   * `report.traces` says which path ran and why (entry `tool-search`).
   *
   * WHAT IT IS WORTH BELONGS TO THE PROVIDER. Your provider's usage counter reflects it
   * directly. The layer credits nothing for it, adds nothing to any ledger for it and
   * charges no commission on it, and a request served this way is never used as the
   * reference to value a later repeat.
   *
   * WHAT CHANGES FOR YOU. Relevance pruning of read tools is off: the model chooses.
   * When your catalogue declares `risk`, write and destructive tools are still withheld
   * from requests the router does not classify as actions, as with the selector. Each
   * search is a short extra step inside the same call, and the definitions it loads are
   * billed as normal input. Across turns, append the assistant turn with its
   * `toolCalls` (ids as returned) before the tool results: the adapter then sends that
   * turn's search results back with it, so the model calls the tools it already found
   * without searching again. It remembers them in memory, per adapter instance and
   * bounded; a turn it no longer remembers (another process, say) goes out without them
   * and the model searches again.
   */
  toolSearch?: ToolSearchMode | ToolSearchOptions;
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
  /**
   * Set to `false` to keep this request out of verification sampling: it is
   * counted as excluded and never sent twice. No effect when verification is off.
   */
  verification?: boolean;
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
   * The effective fraction of the standard rate card this call was billed at:
   * `tierSaving.appliedCost / tierSaving.standardCost` on the one call whose tier
   * was read. `0.5` when every component of the call bills at half price; higher
   * when some component (typically cached input) is discounted less or not at
   * all. Present only when {@link credited}.
   */
  discountRate?: number;
  /**
   * What the served tier was worth on the one call whose tier was read: that call's
   * provider-reported usage at the standard rate card minus the same usage at the rate
   * card of the tier that served it, component by component. Present only when credited.
   *
   * It is NOT `cost.actual` times a discount. `cost.actual` is the whole request and
   * can also carry a repair retry, a tool-discovery probe or a model-cascade attempt;
   * no tier was read back for those, so none of them is credited here. And
   * `cost.actual` prices the request at the STANDARD rate card, so when this is
   * present your invoice line is lower than `cost.actual` by at least this amount.
   */
  tierSaving?: PriceLeverSaving;
  /**
   * True when the cheaper tier had no capacity and the request was repeated once at
   * the standard tier (layer setting `priceLevers.onCapacityError: "standard"`).
   * Nothing is credited then, and the refused attempt is not counted as a call.
   */
  capacityFallback?: boolean;
  /**
   * Which of the four ledgers this credits: none, and that is the honest answer.
   * Deferring avoids no call (ledger 1), removes no tokens (2), re-encodes
   * nothing (3) and is not provider caching (4). It changes the PRICE of the
   * tokens, exactly as the model cascade does, and there is no ledger for that.
   *
   * `cost.netSavingsRatio` therefore does not move: it is a ratio of baseline to
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
 * What a provider price lever was worth on one call, in your currency unit.
 *
 * It never enters `cost.*` and is never billed: it is reported next to the four
 * ledgers, with its own basis.
 */
export interface PriceLeverSaving {
  /** In your currency unit. Never more than the difference between the two published rate cards on this usage. */
  amount: number;
  /**
   * "measured": the provider's own counter for this call at two published rate cards,
   * the tier read back from the provider's official API, and the counter reporting how
   * much of the input was read from (or, where billed apart, written to) the prompt
   * cache. "estimated": anything short of that; `basisReason` says what.
   */
  basis: Extract<import("../tokenizer/accounting.js").CostBasis, "measured" | "estimated">;
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
  /**
   * Cache breakpoints the layer placed: 0 or 1. With 0 in explicit mode the provider
   * neither reads nor writes its prefix cache.
   */
  breakpoints: number;
  /** Always basis "estimated": the provider default was not run for this request. */
  avoidedWritePremium?: PriceLeverSaving;
  /** Why, in one sentence, including what it costs you. Never empty. */
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
   * `cost.netSavingsRatio` — that number stays a comparison at a single price, and
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
  /**
   * How hard a reasoning model should think, sent as OpenAI's `reasoning_effort`
   * by the OpenAI-compatible adapter (`"none"`, `"minimal"`, `"low"`,
   * `"medium"`, `"high"`, `"xhigh"`; the value travels as written). Nothing is
   * sent when absent: the layer never picks an effort for you.
   *
   * Required for the gpt-5.6 family with tools on Chat Completions: OpenAI
   * rejects function tools there unless it is `"none"` («Function tools with
   * reasoning_effort are not supported for gpt-5.6-sol in
   * /v1/chat/completions … set reasoning_effort to 'none'»). Gemini's
   * OpenAI-compatible endpoint maps it to its thinking level. A compatible
   * endpoint that rejects the field by name gets the request once more without
   * it (OpenAI's own API never: there its 400 is the answer). It is part of the
   * cache identity, like `temperature` and `seed`. The Anthropic adapter
   * ignores it.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Hard ceiling on generated tokens for this request, with or without an
   * output contract. It travels to every adapter: Anthropic `max_tokens`,
   * Chat Completions `max_completion_tokens` on OpenAI's own API and
   * `max_tokens` on any other OpenAI-compatible endpoint (see
   * `OpenAICompatibleOptions.maxTokensParam`). When `response.maxOutputTokens`
   * is also set, the smaller of the two is sent. Unset, nothing changes.
   *
   * It is a limit you set, not a saving: it never raises the estimated output
   * of an avoided call and is never credited as output avoided. An answer cut
   * by it (`finishReason: "length"`) is not cached. Must be a positive integer.
   */
  maxOutputTokens?: number;
  /** Tokenizer id to cost against; defaults to a model-derived estimate. */
  tokenizer?: string;
  /** Arbitrary structured payload to be serialized into the prompt. */
  structuredData?: unknown;
}

/** A tool invocation the model requested (the provider-neutral shape). */
/** OpenAI's `reasoning_effort` values; any other string travels as written. */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | (string & {});

export interface ToolCallRequest {
  id?: string;
  name: string;
  /** Argumentos tal cual los serializó el modelo (JSON en crudo). */
  arguments: string;
  /**
   * Provider data attached to this call that must travel back, untouched, when
   * the conversation returns it: Gemini 3's
   * `extra_content.google.thought_signature` through its OpenAI-compatible
   * endpoint, without which the next turn is rejected with a 400 («Function
   * call is missing a thought_signature»). Opaque: pass it back as received in
   * the assistant message's `toolCalls`. It is not part of any cache key.
   */
  extraContent?: Record<string, unknown>;
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
   * Why the model stopped generating, the same five values for every provider:
   *
   * - `"stop"`: a complete answer (Anthropic `end_turn` / `stop_sequence`,
   *   Gemini `STOP`).
   * - `"length"`: cut off by the output limit (Anthropic `max_tokens`, Gemini
   *   `MAX_TOKENS`). A truncated answer is never cached.
   * - `"tool_calls"`: the model asked to call tools (`toolCalls`).
   * - `"content_filter"`: the provider refused or filtered the answer.
   * - `"other"`: anything else (for example Anthropic `pause_turn`, Gemini
   *   `MALFORMED_FUNCTION_CALL`); the provider's value is in
   *   {@link finishReasonDetail}.
   *
   * Present when the answer came from the provider; absent on shortcuts (cache,
   * local resolver), which only serve complete final answers.
   */
  finishReason?: "stop" | "length" | "tool_calls" | "content_filter" | "other";
  /**
   * The provider's own reason behind `finishReason`, when it adds something.
   * Present only on answers the provider returned:
   *
   * - A refusal or filter: the finer reason. Gemini's `SAFETY`, `OTHER`,
   *   `PROHIBITED_CONTENT`… (native or `finish_reason: "content_filter: OTHER"`
   *   on the OpenAI-compatible endpoint), its `promptFeedback.blockReason`, or
   *   Anthropic's `stop_details.category` (for example `"cyber"` or `"bio"`).
   * - A stop reason that is not the provider's plain spelling of one of the
   *   five values: the provider's literal (`"stop_sequence"`, `"pause_turn"`,
   *   `"MALFORMED_FUNCTION_CALL"`…).
   *
   * Absent for the plain spellings (`stop`, `end_turn`, `STOP`, `length`,
   * `max_tokens`, `MAX_TOKENS`, `tool_calls`, `tool_use`, `content_filter`).
   * OpenAI's Structured Outputs refusal message travels in `refusal` instead.
   * Informational: it changes neither what is billed nor what is credited.
   */
  finishReasonDetail?: string;
  /**
   * The refusal message the model returned instead of an answer (OpenAI
   * Structured Outputs: `message.refusal`, with `finish_reason: "stop"` and no
   * content). When present, the request was refused: `text` is empty and no
   * output contract was met. It is measured like any call, and it is never
   * repaired, cached or replayed.
   */
  refusal?: string;
  report: SavingsReport;
}

/** One event of a streamed answer. */
export type SavingsStreamEvent<T = unknown> =
  /** A piece of the answer text, as the provider wrote it. Never empty. */
  | { type: "text"; delta: string }
  /** One complete tool call the model requested, in the order of `result.toolCalls`. */
  | { type: "tool_call"; call: ToolCallRequest }
  /** Always the last event, exactly once. `result` is the same object `SavingsStream.result` resolves to. */
  | { type: "done"; result: SavingsResult<T> };

/** Optional cancellation and total-deadline controls for one request. */
export interface SavingsRequestOptions {
  /** Cancels this request without cancelling other users of the same layer. */
  signal?: AbortSignal;
  /**
   * Total budget from the public entry point until the answer is delivered, in
   * milliseconds. It must be a positive finite integer no greater than
   * 2,147,483,647 (about 24.8 days), the largest portable `setTimeout` delay.
   *
   * Expiry aborts the provider signal and throws `RequestTimeoutError`. A custom
   * provider that ignores that signal is awaited until its work stops; if it never
   * stops, rejection is delayed indefinitely too. No late cache or learning write
   * is started after the provider finally settles.
   */
  requestTimeoutMs?: number;
}

/** Options for `generateStream`. */
export interface SavingsStreamOptions extends SavingsRequestOptions {
  /** Aborting it has the same effect as calling `abort()` on the stream. */
  signal?: AbortSignal;
  /** Total budget for this stream; see `SavingsRequestOptions.requestTimeoutMs`. */
  requestTimeoutMs?: number;
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

/** Where the answer you received came from on this request. */
export type AnswerSource =
  /** Your provider generated it for this request. */
  | "provider"
  /** A replay of the answer already produced for this very request. */
  | "exact_cache"
  /** A reuse of the answer to a reworded version of this request. */
  | "semantic_cache"
  /** Shared with an identical request that was running at the same time. */
  | "coalesced"
  /** Computed locally; no model was involved. */
  | "deterministic"
  /** A direct provider call after an internal error; nothing was optimized. */
  | "fail_open";

/** The output-contract check on the answer that was served. */
export interface QualitySchemaCheck {
  /**
   * `passed` or `failed`: the served answer was validated against
   * `response.schema`. `not_applicable`: the model asked to run tools, so there
   * is no final answer yet.
   */
  outcome: "passed" | "failed" | "not_applicable";
  /**
   * Whether the layer relied on a decode-time constraint for this answer (the
   * backend named in `constraints.backend`). The answer is validated either way.
   * Always false on cache and resolver answers. A coalesced answer carries the
   * value of the request it joined, which is the one that generated it.
   */
  decodeTimeConstraint: boolean;
  /** Validation errors in the served answer. 0 when it passed. */
  errorCount: number;
  /**
   * The model wrapped valid JSON in prose or a code fence, and it was extracted
   * locally instead of paying for a repair call.
   */
  unwrapped?: true;
}

/** What happened when the first answer failed its output contract. */
export interface QualityRepairCheck {
  /**
   * `repaired`: one repair call was made and its answer passed. `still_invalid`:
   * one repair call was made and its answer failed too. `skipped`: no repair
   * call was made; `skipReason` says why.
   */
  outcome: "repaired" | "still_invalid" | "skipped";
  /**
   * - `output_truncated`: the answer hit the output limit, and the same limit
   *   would cut the repair off again.
   * - `schema_defect`: no answer can satisfy the schema (for example, a pattern
   *   that is not a valid regular expression).
   * - `would_cost_more_than_no_layer`: repairing would have cost more than
   *   sending the request without the layer (opt-in, `skipRepairAboveBaseline`).
   * - `decode_time_constraint`: generation was already constrained, so a retry
   *   would not change the outcome.
   * - `provider_refusal`: the provider refused the request (`finishReason:
   *   "content_filter"`, Anthropic's `stop_reason: "refusal"`, or OpenAI's
   *   `message.refusal`); a repair on the same model would be refused, and may
   *   be billed, again.
   */
  skipReason?:
    | "output_truncated"
    | "schema_defect"
    | "would_cost_more_than_no_layer"
    | "decode_time_constraint"
    | "provider_refusal";
}

/** Whether the provider stopped because it reached the output limit. */
export interface QualityTruncationCheck {
  /** True when the provider reported `finishReason: "length"`. A truncated answer is never cached. */
  truncated: boolean;
  /**
   * Why the provider stopped, as `SavingsResult.finishReason` reports it (the
   * same five values); absent when it reported none. The provider's own value
   * is in {@link finishReasonDetail}.
   */
  finishReason?: "stop" | "length" | "tool_calls" | "content_filter" | "other";
  /**
   * The provider's own reason behind `finishReason`, when it gave one: the same
   * value as `SavingsResult.finishReasonDetail` for the answer that was served.
   */
  finishReasonDetail?: string;
  /**
   * Whether you set the limit (`maxOutputTokens` on the request or on
   * `response`). When false, any
   * limit that applied was a provider or adapter default.
   */
  capSetByCaller: boolean;
  /** The limit that was sent (the smaller of the two when both were set). Present only when `capSetByCaller`. */
  outputLimit?: number;
}

/** How a cache hit matched this request. */
export type QualityCacheMatch =
  | {
      kind: "exact";
      /** Age of the replayed answer, in milliseconds. */
      ageMs?: number;
    }
  | {
      kind: "semantic";
      /** Age of the reused answer, in milliseconds. */
      ageMs?: number;
      /**
       * Similarity between this request and the stored one. It is not evidence
       * of equivalence: see {@link QualityStatus}.
       */
      similarity: number;
      /** The similarity a candidate had to reach to be considered at all. */
      similarityFloor: number;
      /**
       * The confidence the hit had to reach to be served. Confidence is the
       * lower of `similarity` and `verifierScore` (`cache.confidence`).
       */
      acceptFloor: number;
      /** Your verifier's score, present only when you configured one. */
      verifierScore?: number;
      /** `built_in`: the lexical embedder shipped with the SDK. `custom`: yours. */
      embedder: "built_in" | "custom";
      /**
       * The deterministic guard passed, turn by turn: figures and dates,
       * negation parity and content-word overlap. A hit is never served without it.
       */
      factGuard: "passed";
      /**
       * Present when the cache runs with `calibration`: the bound this reuse was
       * served under, and the labels behind it.
       */
      calibration?: SemanticCalibrationBound;
    };

/**
 * The bound a calibrated semantic reuse was served under: with probability at
 * least `confidence`, at most `maxErrorRate` of the reuses served at or above
 * `floor` are wrong, where "wrong" is what the calibration's judge rejects.
 * It rests on the labels counted here, which your own traffic produced.
 */
export interface SemanticCalibrationBound {
  maxErrorRate: number;
  confidence: number;
  /** The certified floor this reuse's score cleared. */
  floor: number;
  /** Held-out labels at or above the floor that certified it, and how many were wrong reuses. */
  heldOutAtFloor: number;
  wrongHeldOutAtFloor: number;
  /** Labels collected in this traffic segment. */
  labeled: number;
  /** Calibrations are kept apart for single-shot and agentic traffic. */
  segment: "single_shot" | "agentic";
}

/** What the model cascade decided on this request. See {@link ModelCascadeReport}. */
export interface QualityCascadeCheck {
  mode: "shadow" | "on";
  /** What the deterministic gate was able to check (`modelCascade.verifier`). */
  gate: "none" | "structural" | "value-constrained";
  /**
   * - `accepted`: a cheaper model answered and its answer cleared the gate.
   * - `escalated`: the gate rejected the cheaper answer and the model you asked for answered.
   * - `not_routed`: the cascade is on but this request was not routed (see `modelCascade.reason`).
   * - `not_applied`: shadow mode. The cascade only evaluated this request and
   *   the model you asked for answered. On a sampled request
   *   (`modelCascade.sampled`) the cheaper model also ran, and its answer was
   *   not served.
   */
  outcome: "accepted" | "escalated" | "not_routed" | "not_applied";
  /**
   * Shadow sampling only: both answers satisfied the contract and disagreed on
   * a hard value. A hint, never proof.
   */
  sampleDiverged?: boolean;
}

/**
 * What the layer checked on the answer it served, and what came of it.
 *
 * It holds no money and no token counts. It is never added to the four savings
 * ledgers or to `cost`, and it never leaves your process: usage reporting does
 * not carry it. `qualityStatus` is the one-word verdict; this is the evidence
 * behind it. A block is present only when its check applies to this request.
 * With `source: "coalesced"`, the blocks describe the shared answer as the
 * request it joined produced it: nothing was run again. An absent ledger means
 * unknown (an older SDK, or a report built elsewhere).
 */
export interface QualityLedger {
  source: AnswerSource;
  /** Only with `source: "coalesced"`: where the shared answer came from for the request it joined. */
  sharedFrom?: Exclude<AnswerSource, "coalesced">;
  /** Present when the request carried `response.schema`. */
  schema?: QualitySchemaCheck;
  /** Present when a provider answer on this request failed its first validation. */
  repair?: QualityRepairCheck;
  /** Present when a provider generated the served answer. */
  truncation?: QualityTruncationCheck;
  /** Present when the answer came from the exact or the semantic cache. */
  cacheMatch?: QualityCacheMatch;
  /** Present when `savings.modelCascade` is not `"off"`. */
  cascade?: QualityCascadeCheck;
}

/**
 * The provider's native prompt-cache saving on the call that produced the
 * answer: what the provider's own cache took off the invoice, net of the
 * cache-write premium the provider billed on that same call.
 *
 * `netUsd = readDiscountUsd − writePremiumUsd`, where
 * `readDiscountUsd = cacheReadTokens / 1000 × (inputPer1k − cachedInputPer1k)` and
 * `writePremiumUsd` is the write tokens at `inputPer1k × (multiplier − 1)`
 * (Anthropic 1.25× for 5 minutes and 2× for one hour; OpenAI 1.25× from
 * gpt-5.6 on, 1× before; Gemini 1×). Every input is in this block, so it can be
 * recomputed without trusting the layer. `netUsd` can be negative: a cold
 * write pays the premium before any read.
 *
 * It is SEPARATE on purpose. The layer can place the breakpoint (Anthropic
 * `cache_control`), route (OpenAI `prompt_cache_key`) or keep the prefix
 * stable, but the discount is billed by the provider and much of it would be
 * there without the layer, so it is never credited as the layer's saving:
 * it is not in `cost.netSavingsRatio`, not in `cost.baselineEstimate`, and not in
 * any commission base.
 */
export interface NativeSavingsReport {
  /** Who billed the cache, inferred from the model id. */
  provider: "anthropic" | "openai" | "google" | "unknown";
  /**
   * How that provider caches: `explicit` (Anthropic, `cache_control`
   * breakpoints), `automatic` (OpenAI, prefix cache with no marking) or
   * `implicit` (Gemini implicit caching).
   */
  mechanism: "explicit" | "automatic" | "implicit" | "unknown";
  /** True when the layer placed the cache breakpoint on the call that ran. Absent where the layer does not know. */
  layerMarked?: boolean;
  /** Input tokens the provider served from its cache on this call (its own counter). */
  cacheReadTokens: number;
  /** Input tokens the provider billed as cache writes on this call (its own counter, every TTL). */
  cacheWriteTokens: number;
  /** The part of `cacheWriteTokens` written with a one-hour TTL. */
  cacheWrite1hTokens: number;
  /** Input rate applied, per 1K tokens. */
  inputPer1k: number;
  /** Cache-read rate applied, per 1K tokens. */
  cachedInputPer1k: number;
  /** Write multiplier applied to five-minute (or untyped) writes. */
  writeMultiplier: number;
  /** Write multiplier applied to one-hour writes. */
  write1hMultiplier: number;
  /** What the cache reads saved against the input rate, USD. */
  readDiscountUsd: number;
  /** The premium the provider billed for the cache writes, USD. */
  writePremiumUsd: number;
  /** `readDiscountUsd − writePremiumUsd`, USD. Can be negative. */
  netUsd: number;
  /**
   * `measured`: the provider's own counter at list price. `unmeasured`: the
   * counter was incomplete or there is no cache-read price for the model, and
   * every USD figure is 0.
   */
  basis: "measured" | "unmeasured";
}

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
    /** Present when this avoided call is valued by reference; see ReferenceCredit. */
    reference?: import("../tokenizer/accounting.js").ReferenceCredit;
    /** Present on an exact-cache or coalesced hit that stays estimated: why no reference applied. Semantic-cache hits never carry it. */
    referenceRejected?: import("../tokenizer/accounting.js").ReferenceRejection;
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

  /**
   * Present only when tool-output compaction ran with `profile:
   * "lossless-data"`: one explained decision per tool output in the request,
   * applied or bypassed, in message order. Token counts come from the
   * estimator named in `estimator` and are estimates, never a verified saving.
   */
  toolOutputCompaction?: {
    profile: "lossless-data";
    /** Always `"estimated"`: these counts are not the provider's. */
    tokenBasis: "estimated";
    /** Id of the token estimator that counted, and whether it uses the provider's rule. */
    estimator: { id: string; exact: boolean };
    decisions: Array<{
      /** The tool call this output answers, unchanged. Absent when the message had none. */
      toolCallId?: string;
      status: "applied" | "bypassed";
      reason:
        | "applied"
        | "not_json"
        | "invalid_json"
        | "duplicate_keys"
        | "invalid_unicode"
        | "not_smaller"
        | "below_threshold"
        | "protected";
      transformId: string;
      version: string;
      tokensBefore: number;
      /** What is sent: the compacted text when applied, the original otherwise. */
      tokensAfter: number;
      candidateTokens?: number;
    }>;
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
   * The evidence behind `qualityStatus`: where the answer came from and which
   * checks it went through, with no money in it. See {@link QualityLedger}.
   * Optional and additive: absent means unknown.
   */
  qualityLedger?: QualityLedger;

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

  /**
   * Where the provider was allowed to write its prompt cache. Present whenever
   * `savings.standalone` is `true`, including when it changed nothing, and when
   * `cacheBreakpoints: "auto"` switched this request to explicit mode.
   */
  cacheWrites?: CacheWriteReport;

  /**
   * The provider's OWN prompt-cache discount on this call, shown apart. Present
   * only when a call ran and the provider reported cache reads or writes.
   *
   * It is not the layer's saving and it is never part of `cost.netSavingsRatio`,
   * `cost.baselineEstimate`, `basis: "reference"` or the commission base: the
   * discount is the provider's, and `cost` prices cached tokens at the cached
   * rate on both sides for exactly that reason. It exists so the report adds up
   * to your invoice. See {@link NativeSavingsReport}.
   */
  nativeSavings?: NativeSavingsReport;

  /** How a streamed request was delivered. Present only on results of `generateStream`. */
  streaming?: StreamingReport;

  /**
   * Whether this request was drawn for verification sampling, and how it counts.
   * Present only when `verification` is enabled on the layer.
   */
  verification?: import("./verification.js").VerificationReport;

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
    /**
     * Present, and `true`, only when a billed call of this request reached the
     * layer without its full provider counter (a stream cut before its final
     * usage event, an endpoint that omitted a counter). `actual` then prices
     * only the counters that did arrive, with the missing ones at 0: it is a
     * FLOOR of what the provider billed, possibly 0, never the spend. The
     * request is also `basis: "unmeasured"`. Do not add such an `actual` to
     * measured spend. Absent whenever every counter arrived.
     */
    actualIsLowerBound?: true;
    /**
     * The saving as a RATIO of the baseline: `1 - actual / baselineEstimate`,
     * rounded to six decimals (0 when nothing was saved or there is no baseline,
     * negative when the request cost more). Do not sum it across requests: sum
     * {@link netSavingsUsd}.
     */
    netSavingsRatio: number;
    /**
     * The saving in USD: `baselineEstimate - actual` (negative when the request
     * cost more). Sum it only within one `basis`: measured and estimated money
     * are never added together.
     */
    netSavingsUsd: number;
    /**
     * Where the baseline comes from. It is what separates measured money from
     * estimated money.
     *
     * - `measured`   — reconstructed from THIS request's provider counter. Real
     *                  money, checkable against the provider invoice.
     * - `reference`  — MEASURED BY REFERENCE: the call was avoided (a repeat
     *                  served without calling the provider) and a byte-identical
     *                  request had already run through the layer untouched. The
     *                  baseline is the provider's own counter for that request,
     *                  valued at the provider's cached-input rate. Output is
     *                  credited only under deterministic sampling, on a model
     *                  with a list price in the catalog that does not reason and
     *                  honors that setting, when the call that ran carried no
     *                  hidden reasoning (zero reasoning tokens reported, or no
     *                  reasoning block where the provider does not break them
     *                  out), and then at 95% of its counter. With an output
     *                  schema, only when the schema traveled exactly as sent, in
     *                  strict mode, in the provider's native response-format
     *                  parameter. Valued low on purpose.
     *                  Enters the commission base; `cache.reference` carries the
     *                  arithmetic and the id of the request that ran.
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

  /**
   * Present only when the layer runs on the free «Measure» license (shadow
   * mode): what the levers would have saved on this request. Nothing was
   * applied — `cost` is this call's measured spend with no saving claimed.
   */
  measure?: MeasureReport;

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
  // Fue opcional "por compatibilidad", y esa opcionalidad era el bypass: un gate
  // al que le faltara el método dejaba pasar todas las peticiones con solo un
  // aviso por consola. (Esto no va en el JSDoc, que sí viaja en los tipos
  // publicados: citaba `devUnlicensed`, que la 0.5 quita de la configuración.)
  /**
   * Whether there is an overall active (or in-grace) license. The pipeline's
   * fail-closed entry check reads it.
   *
   * Required: a gate without it would let every request through.
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
  /**
   * Why the key does not open, when it does not; `undefined` when it does. It
   * only refines the MESSAGE, never the verdict: an `"invalid"` whose reason is
   * `"malformed"` (not even the shape of a token: the `bvk_` pasted where the
   * license goes) gets different advice from an `"invalid"` that has the shape
   * but no valid signature. Optional because a gate is implemented by the
   * caller; without it, the generic message for that status.
   */
  reason?(): string | undefined;
  /**
   * The plan of the license in force, when there is one. `"measure"` (the free
   * «Measure» license) puts the layer in SHADOW MODE: the request goes to the
   * provider exactly as you built it, nothing is served from any cache, and
   * `report.measure` says what the levers would have saved. Optional because a
   * gate is implemented by the caller; without it, the layer is not in shadow.
   */
  plan?(): string | undefined;
}

/**
 * What a layer running on the free «Measure» license would have saved on this
 * request. Present ONLY in shadow mode. Nothing here was applied: the request
 * went to your provider untouched and nothing was served from a cache.
 *
 * Every figure is HYPOTHETICAL (`basis: "shadow"`): it is never part of
 * `cost.baselineEstimate`, `cost.actual` or `cost.netSavingsRatio`, never in any
 * commission base, and never added to measured money.
 */
export interface MeasureReport {
  mode: "shadow";
  /** Always false: in shadow mode no lever changes the request or avoids a call. */
  applied: false;
  wouldHaveSaved: {
    /** USD this request would not have cost with the simulated levers on. */
    usd: number;
    basis: "shadow";
    /**
     * Which lever would have avoided the call entirely, valued with THIS call's
     * provider counter (`cost.actual`):
     *   · `exact-repeat`       — a byte-identical, cacheable request already ran
     *                            in this process within the exact-cache TTL;
     *   · `in-flight-duplicate`— an identical request was in flight at the same
     *                            time and would have been coalesced.
     * `null` when no simulated lever would have avoided it.
     */
    avoidedCall: "exact-repeat" | "in-flight-duplicate" | null;
  };
  /**
   * Levers this shadow does NOT simulate, so `wouldHaveSaved` is a LOWER bound:
   * they need a model call, an embedding, or a paid entitlement to estimate.
   */
  notSimulated: string[];
  /** Where to turn the levers on. */
  upgradeUrl: string;
}

export interface TraceEvent {
  stage: string;
  outcome: string;
  detail?: Record<string, unknown>;
  /** Monotonic elapsed ms from the start of the request. */
  atMs: number;
}
