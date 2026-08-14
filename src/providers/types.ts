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
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  /** Provider-reported prefix/KV-cached input tokens (ledger 4), if any. */
  cachedInputTokens?: number;
  /**
   * Input tokens billed at a PREMIUM to WRITE the provider's prefix cache
   * (Anthropic `cache_creation_input_tokens`: 1.25x the normal rate).
   *
   * This is a COST, not a discount, and it is reported separately for exactly
   * that reason: `cachedInputTokens` is a saving to publish in ledger 4, this
   * is the price paid to obtain it. Folding the two together would report a
   * bill INCREASE as a saving.
   */
  cacheWriteInputTokens?: number;
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
  raw?: unknown;
}

export interface Provider {
  readonly id: string;
  generate(req: ProviderRequest): Promise<ProviderResponse>;
}
