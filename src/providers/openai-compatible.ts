import type { Provider, ProviderRequest, ProviderResponse } from "./types.js";

/**
 * OpenAI-compatible provider adapter (chat/completions shape).
 *
 * Works with any endpoint that speaks the OpenAI Chat Completions API — OpenAI,
 * Azure, vLLM, SGLang, TGI, a local gateway, or Vercel AI Gateway with a
 * "provider/model" string. Structured output is requested via `response_format`
 * with a JSON schema when a contract is present, which is the provider-native
 * constrained-decoding path preferred by the layer.
 *
 * Network calls use global `fetch` (Node >= 18) so there is no SDK dependency.
 */
export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey?: string;
  /** Strip the "provider/" prefix from model ids before sending. */
  stripProviderPrefix?: boolean;
  /** Extra headers (e.g. for a gateway). */
  headers?: Record<string, string>;
  /** Injectable fetch for testing. */
  fetchImpl?: typeof fetch;
  /**
   * When true (recommended for measurement), a response whose `usage` block is
   * missing or reports zero prompt/completion tokens for a call that actually
   * ran is treated as a HARD ERROR instead of being silently coerced to
   * 0 tokens. This closes the single most dishonest failure mode: an absent
   * usage payload otherwise becomes `actual cost = 0` → a fabricated 100%
   * saving. Benchmarks that make real cost claims must set this.
   */
  requireUsage?: boolean;
}

export class OpenAICompatibleProvider implements Provider {
  readonly id: string;
  private readonly opts: OpenAICompatibleOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAICompatibleOptions) {
    this.opts = opts;
    this.id = `openai-compatible:${opts.baseUrl}`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async generate(req: ProviderRequest): Promise<ProviderResponse> {
    const model = this.opts.stripProviderPrefix
      ? req.model.replace(/^[^/]+\//, "")
      : req.model;

    const body: Record<string, unknown> = {
      model,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (req.maxOutputTokens != null) body["max_tokens"] = req.maxOutputTokens;
    if (req.temperature != null) body["temperature"] = req.temperature;
    if (req.seed != null) body["seed"] = req.seed;
    if (req.schema) {
      body["response_format"] = {
        type: "json_schema",
        json_schema: { name: "bvsala_contract", schema: req.schema, strict: true },
      };
    }
    // Transmit tools in the provider-native `tools` field so their JSON schema
    // is metered inside the real prompt_tokens. Without this the tool-selection
    // lever's savings can never be MEASURED (dropped-tool tokens would never
    // have been on the wire in the first place).
    if (req.tools && req.tools.length > 0) {
      body["tools"] = req.tools.map((t) => ({
        type: "function",
        function: {
          name: t.id,
          ...(t.description ? { description: t.description } : {}),
          parameters: t.parameters ?? { type: "object", properties: {} },
        },
      }));
    }

    const response = await this.fetchImpl(
      `${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
          ...this.opts.headers,
        },
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      const detail = await safeText(response);
      throw new Error(`provider ${response.status}: ${detail}`);
    }

    const json = (await response.json()) as OpenAIChatResponse;
    const text = json.choices?.[0]?.message?.content ?? "";
    const usage = json.usage ?? {};
    const inputTokens = usage.prompt_tokens ?? 0;
    const outputTokens = usage.completion_tokens ?? 0;

    // Una llamada que devolvió contenido pero no su contabilidad de tokens no se
    // puede tarifar con honestidad: 0 tokens medidos frente a un baseline
    // modelado da un ahorro fabricado cercano al 100%.
    //
    // La guardia comprueba AUSENCIA, no valor cero, y por separado en cada
    // contador. Antes era `inputTokens <= 0 && outputTokens <= 0`, con dos
    // fallos: (1) el `&&` sólo saltaba si faltaban AMBOS, así que un bloque
    // `usage` parcial —prompt_tokens presente, completion_tokens ausente, algo
    // habitual en gateways y en streaming— se colaba como 0 y fabricaba ahorro;
    // (2) `<= 0` confundía "no lo sé" con "de verdad fueron 0", y un cero
    // legítimo (respuesta vacía, parada inmediata) es medible y no debe fallar.
    const inputAbsent = typeof usage.prompt_tokens !== "number";
    const outputAbsent = typeof usage.completion_tokens !== "number";
    if (this.opts.requireUsage && (inputAbsent || outputAbsent)) {
      throw new Error(
        `provider returned incomplete usage (prompt=${usage.prompt_tokens ?? "absent"}, ` +
          `completion=${usage.completion_tokens ?? "absent"}); cannot measure cost. ` +
          `For gateways/streaming, ensure usage reporting is enabled.`,
      );
    }

    return {
      text,
      usage: {
        inputTokens,
        outputTokens,
        ...(usage.prompt_tokens_details?.cached_tokens != null
          ? { cachedInputTokens: usage.prompt_tokens_details.cached_tokens }
          : {}),
      },
      structuredNatively: req.schema != null,
      raw: json,
    };
  }
}

interface OpenAIChatResponse {
  choices?: { message?: { content?: string } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "<no body>";
  }
}
