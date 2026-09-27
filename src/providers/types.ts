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
