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
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  /** Provider-reported prefix/KV-cached input tokens (ledger 4), if any. */
  cachedInputTokens?: number;
}

export interface ProviderResponse {
  text: string;
  usage: ProviderUsage;
  /** Whether the provider enforced the schema natively. */
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
   * Faltaba, y el adaptador hacía `content ?? ""`: cuando el modelo invoca una
   * herramienta devuelve `content: null` + `tool_calls`, así que la capa entregaba
   * CADENA VACÍA y la petición del modelo se perdía por completo. El pipeline
   * transmite herramientas por diseño y son una palanca que el README vende, de
   * modo que el caso no es exótico: es el camino normal en cuanto hay tools.
   * Mismo tipo que expone `SavingsResult.toolCalls`: el pipeline lo transmite
   * tal cual hasta el llamante (no solo hasta aquí).
   */
  toolCalls?: ToolCallRequest[];
  raw?: unknown;
}

export interface Provider {
  readonly id: string;
  generate(req: ProviderRequest): Promise<ProviderResponse>;
}
