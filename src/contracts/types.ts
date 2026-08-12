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
 * A cache hit eliminates a whole call. TOON re-encodes a structured payload.
 * LLMLingua removes redundant words. A provider prefix cache makes tokens
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
export type SerializationFormat = "json-compact" | "toon" | "csv";

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
   * Faltaba: el adaptador ya propagaba `tool_calls` (content:null + tool_calls es
   * el camino NORMAL en cuanto hay herramientas), pero el pipeline construía la
   * respuesta solo con `{text, data, rendered}` y este contrato ni declaraba el
   * campo — el cliente recibía "" como si fuera la respuesta buena y la
   * invocación se perdía entera. La palanca de herramientas que vende el README
   * era inservible en el paquete publicado.
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

export interface SavingsReport {
  requestId: string;
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

  quality: {
    taskPassed?: boolean;
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
