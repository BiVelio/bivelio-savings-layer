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

    return {
      text,
      usage: {
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
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
