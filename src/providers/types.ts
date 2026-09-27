import type {
  ChatMessage,
  JsonSchema,
  ToolCallRequest,
  ToolDescriptor,
} from "../contracts/types.js";

/**
 * Provider-neutral generation interface. Every provider (OpenAI-compatible,
 * Anthropic-compatible, Google-compatible, self-hosted) is adapted to this
 * shape so the pipeline never depends on a specific vendor SDK.
 */
export interface ProviderRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDescriptor[];
  /** Output contract to enforce via constrained decoding, when available. */
  schema?: JsonSchema;
  maxOutputTokens?: number;
  temperature?: number;
  seed?: number;
  /** Backend id selected by the constraints layer, for observability. */
  constraintBackend?: string;
  /**
   * How many LEADING messages form the stable, cacheable prefix — the part the
   * provider may reuse across requests. `undefined` claims nothing and adapters
   * mark no cache breakpoint.
   *
   * Adapters that need EXPLICIT breakpoints (Anthropic) place them at this
   * boundary; adapters that cache automatically (OpenAI) may ignore it. The
   * count is a claim about byte-for-byte stability, so a caller that rewrites an
   * earlier turn must lower it.
   */
  stablePrefixMessages?: number;
  /**
   * Routing hint so requests sharing a prefix land on the same cache shard
   * (OpenAI `prompt_cache_key`). It is a hint, never an identity: it must not
   * carry tenant or user data, because it does not isolate anything.
   */
  promptCacheKey?: string;
  /**
   * The caller declares this answer is not needed immediately, so the adapter
   * may ask for a cheaper, slower processing tier.
   *
   * It is DECLARED, never inferred: whether a request can wait is a property of
   * the business, not of the text. An adapter whose provider has no cheaper
   * synchronous tier leaves the request unchanged.
   *
   * Asking is not getting. A provider may serve a downgraded tier and bill it at
   * the standard rate, so the discount is only ever read back from
   * {@link ProviderResponse.servedServiceTier}.
   */
  deferrable?: boolean;
  /**
   * Adapters with explicit prompt-cache control write the provider's cache only
   * at `stablePrefixMessages` (nowhere when it is undefined) instead of
   * letting the provider choose. Others ignore it.
   */
  explicitCacheWrites?: boolean;
  /**
   * Provider-native tool search, decided by the layer for this request. An adapter that
   * supports it sends every tool with deferred loading except `alwaysLoaded`, plus the
   * provider's search tool. The layer sets it only for adapters of this package that
   * declared the capability; other providers never receive it.
   */
  toolSearch?: ProviderToolSearch;
  /**
   * Where the layer's breakpoint placer (`cacheBreakpoints: "auto"`) wants the
   * provider's prompt cache written, on top of `stablePrefixMessages`. Only
   * adapters with explicit breakpoints (Anthropic) act on it; others ignore it.
   * Absent: the adapter's fixed placement.
   */
  cachePlacement?: CachePlacement;
  /**
   * Ask the provider to compare this request's prompt prefix with the one of
   * an earlier response and report where they diverged (Anthropic cache
   * diagnostics, Claude API only). `previousMessageId: null` opts in without a
   * comparison, so that a later request can be compared with this one.
   * Adapters without the feature, or talking to another host, ignore it.
   */
  cacheDiagnostics?: { previousMessageId: string | null };
}

/** See {@link ProviderRequest.toolSearch}. */
export interface ProviderToolSearch {
  /** The provider's search: natural-language queries (`"bm25"`) or regular expressions. */
  variant: "bm25" | "regex";
  /** Tool ids sent without deferred loading. */
  alwaysLoaded: string[];
}

/** What the provider's native tool search did in one call, as its response shows it. */
export interface ProviderToolSearchUsage {
  /** Searches the model ran. */
  searches: number;
  /** Tool names the searches loaded, in order, without repeats. */
  loaded: string[];
  /** Searches that came back as an error result instead of references. */
  errors: number;
  /**
   * Search results from earlier turns that the adapter sent back in this request's history,
   * so the model could call the tools they loaded without searching again: how many results,
   * and which tools. Absent when none were sent back.
   */
  resent?: { results: number; tools: string[] };
}

/**
 * Breakpoint placement decided by the layer from the reuse it measured on your
 * traffic. See `cacheBreakpoints` in the layer configuration.
 */
export interface CachePlacement {
  /**
   * Also mark the last block of the request, so that a continuation of this
   * exact prompt (the next turn of a conversation or an agent loop) reads all
   * of it from cache instead of writing it again.
   */
  tail: boolean;
  /**
   * Cache lifetime for every breakpoint of this request. On Anthropic a
   * one-hour write is billed at 2x the input rate, a five-minute one at 1.25x.
   */
  ttl: "5m" | "1h";
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  /** Provider-reported prefix/KV-cached input tokens (ledger 4), if any. */
  cachedInputTokens?: number;
  /**
   * Input tokens billed at a PREMIUM to WRITE the provider's prefix cache
   * (Anthropic `cache_creation_input_tokens`, and OpenAI
   * `prompt_tokens_details.cache_write_tokens` on GPT-5.6 and later: 1.25x the
   * normal rate).
   *
   * This is a COST, not a discount, and it is reported separately for exactly
   * that reason: `cachedInputTokens` is a saving to publish in ledger 4, this
   * is the price paid to obtain it. Folding the two together would report a
   * bill INCREASE as a saving.
   */
  cacheWriteInputTokens?: number;
  /**
   * The part of `cacheWriteInputTokens` written with a ONE-HOUR lifetime
   * (Anthropic `cache_creation.ephemeral_1h_input_tokens`), billed at 2x the
   * input rate instead of 1.25x. Absent when the provider did not break the
   * writes down by lifetime.
   */
  cacheWrite1hInputTokens?: number;
  /**
   * Output tokens the provider billed for hidden reasoning, already included in
   * `outputTokens` (OpenAI `completion_tokens_details.reasoning_tokens`).
   *
   * `0` states that the answer carried no hidden reasoning. Where the provider
   * does not break reasoning out (Anthropic's Messages API), the built-in
   * adapter reports `0` only when the answer has no `thinking` or
   * `redacted_thinking` block, and leaves this absent otherwise. Absent means
   * nobody said, which is NOT the same as 0: a repeat served by reference only
   * credits output when the call that ran reported exactly 0, because reasoning
   * tokens are neither visible nor deterministic. A custom provider should set
   * it only from its provider's own counter or an equally direct signal.
   */
  reasoningTokens?: number;
  /**
   * False when the provider did not report both counters for this call (for a
   * stream: its final usage event never arrived), so the adapter filled the
   * missing ones with 0. Absent means complete. A request with any such call is
   * reported as `unmeasured`.
   */
  complete?: boolean;
}

export interface ProviderResponse {
  text: string;
  usage: ProviderUsage;
  /**
   * Whether the provider enforced the schema natively.
   *
   * An explicit `false` is a claim about the guarantee that was obtained, not a
   * detail: the pipeline reads it and reports `constraints.backend: "none"`, so
   * an adapter that had to ask for JSON in the prompt (for instance because the
   * model rejects `response_format`) must set it. Leaving it undefined asserts
   * nothing and keeps the planned backend.
   */
  structuredNatively?: boolean;
  /**
   * Por qué paró de generar el modelo. `"length"` significa que se quedó sin
   * presupuesto de salida, no que terminara.
   *
   * No es un dato decorativo: distingue una respuesta MALA de una respuesta
   * CORTADA, y esas dos no se arreglan igual. Un JSON truncado a media cadena no
   * valida, y reintentar con el MISMO tope vuelve a truncarlo — se paga una
   * segunda llamada para obtener el mismo fallo. Sin este campo el layer no
   * podía distinguirlo y hacía exactamente eso.
   */
  finishReason?: "stop" | "length" | "content_filter" | "tool_calls" | (string & {});
  /**
   * Llamadas a herramienta que pidió el modelo, tal cual las devolvió el
   * proveedor.
   *
   * When the model invokes a tool it returns `content: null` + `tool_calls`, so
   * this is the normal shape as soon as tools are in play — not an edge case.
   * Same type as `SavingsResult.toolCalls`: the pipeline forwards it unchanged
   * all the way to the caller.
   */
  toolCalls?: ToolCallRequest[];
  /**
   * The processing tier the provider reports having SERVED this request, exactly
   * as it named it (OpenAI `service_tier`, Anthropic `usage.service_tier`).
   *
   * This is the only field a discount may be credited from, and the reason is
   * that it is not always what was asked for: a provider short on capacity may
   * serve the standard tier and bill the standard rate while the request said
   * otherwise. Crediting the REQUESTED tier would publish a saving the invoice
   * does not carry.
   *
   * Absent means the provider said nothing, which is NOT the same as "standard":
   * it means the tier cannot be known, so nothing is credited.
   */
  servedServiceTier?: string;
  /**
   * The processing tier this adapter ASKED the provider for, when it asked for
   * one. Absent means it asked for nothing — which is the honest answer for a
   * provider that has no cheaper synchronous tier to ask for.
   *
   * Reported by the adapter rather than assumed by the caller: only the adapter
   * knows its provider's vocabulary, and a caller that hardcoded a tier name
   * would be describing a request some other adapter never made.
   */
  requestedServiceTier?: string;
  /**
   * Whether this answer can be handed to a later identical request (exact cache) or to a
   * concurrent identical request. `false` when it carries content the layer keeps no copy of,
   * such as generated files, cited sources, results of tools the provider ran itself, or
   * reasoning the provider expects back: it is served to this caller only, it is not written
   * to the exact cache, and a concurrent identical request makes its own call. Absent means
   * replayable.
   */
  replayable?: boolean;
  /**
   * Present when the request carried {@link ProviderRequest.toolSearch} and the adapter can
   * read what the search did. The layer only reports it; it credits nothing for it.
   */
  toolSearch?: ProviderToolSearchUsage;
  /** The provider's own id for this response (Anthropic `id`), when it gave one. */
  providerMessageId?: string;
  /**
   * The provider's answer to {@link ProviderRequest.cacheDiagnostics}, when the
   * request asked for a comparison. `missReason` is the provider's
   * `cache_miss_reason.type` (`model_changed`, `system_changed`,
   * `tools_changed`, `messages_changed`, `previous_message_not_found`,
   * `unavailable`), `"none"` when it compared and found no divergence, or
   * `"pending"` when the comparison had not finished. `missedInputTokens` is the
   * provider's estimate of the input after the divergence: a magnitude, not a
   * billing number.
   */
  cacheDiagnostics?: { missReason: string; missedInputTokens?: number };
  raw?: unknown;
}

/** One event of a provider-level stream. */
export type ProviderStreamEvent =
  | { type: "text"; delta: string }
  | { type: "done"; response: ProviderResponse };

/** Options for {@link Provider.generate} and {@link Provider.generateStream}. */
export interface ProviderStreamOptions {
  /** Cancels the HTTP request. */
  signal?: AbortSignal;
}

export interface Provider {
  readonly id: string;
  generate(req: ProviderRequest, options?: ProviderStreamOptions): Promise<ProviderResponse>;
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
