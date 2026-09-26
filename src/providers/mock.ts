import type { JsonSchema } from "../contracts/types.js";
import { marcarDemo } from "./demo-brand.js";
import { heuristicEstimator } from "../tokenizer/estimator.js";
import type {
  Provider,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
  ProviderStreamOptions,
} from "./types.js";

/**
 * Deterministic mock provider.
 *
 * Lets the whole layer run — and be tested — with no network and no
 * credentials. When a schema is supplied it fabricates a schema-valid object,
 * demonstrating the constrained-decoding contract end to end. Token usage is
 * derived from the heuristic estimator so SavingsReport numbers are meaningful
 * in examples and tests.
 *
 * ⚠️ WHAT THIS PROVIDER CANNOT MEASURE, and it has already cost money once.
 * It fabricates the answer FROM THE SCHEMA it receives, so a smaller schema
 * always produces a smaller answer. Any lever that shrinks the contract sent to
 * the provider therefore appears to shrink the OUTPUT too — automatically, on
 * every run, whatever model id is being simulated. That is a property of this
 * file, not of any model.
 *
 * The output codebook is exactly that shape of lever, and against this provider
 * the benchmark reported it saving 24.8%. Measured live it saves 8.0% on
 * `gpt-4o` and COSTS 8.2% on `gpt-4o-mini`, because a real model decides how
 * much to WRITE and a smaller model writes more when the field names carry less
 * meaning. So: never take an output-token saving measured here as evidence of
 * anything. Prove those with the paired A/B in `benchmarks/ab-live.ts`, and
 * write tests for output-side effects against a provider that models the
 * behaviour you are claiming — see `test/codebook-de-salida.test.ts`.
 */
export interface MockProviderOptions {
  /** Fixed text to return when no schema is present. */
  answer?: string;
  /** Override the fabricated structured object. */
  data?: unknown;
  /** Simulated provider-cached input tokens (ledger 4). */
  cachedInputTokens?: number;
  /** Characters per text event in generateStream (default 8). */
  streamChunkChars?: number;
}

export class MockProvider implements Provider {
  readonly id = "mock";
  private readonly options: MockProviderOptions;

  constructor(options: MockProviderOptions = {}) {
    this.options = options;
    marcarDemo(this);
  }

  // `_options` (la señal de aborto) se acepta y se ignora: aquí no hay red.
  async generate(req: ProviderRequest, _options?: ProviderStreamOptions): Promise<ProviderResponse> {
    const inputText = req.messages.map((m) => m.content).join("\n");
    let inputTokens = heuristicEstimator.count(inputText);
    // Tool schemas travel in the real prompt, so a real provider bills them as
    // input tokens. Count them here too, so mock usage faithfully tracks the
    // tool-selection lever (fewer tools transmitted → fewer input tokens).
    if (req.tools && req.tools.length > 0) {
      const toolSchemaText = JSON.stringify(
        req.tools.map((t) => ({ name: t.id, description: t.description, parameters: t.parameters ?? {} })),
      );
      inputTokens += heuristicEstimator.count(toolSchemaText);
    }

    let text: string;
    let structuredNatively = false;
    if (req.schema) {
      const obj = this.options.data ?? fabricate(req.schema);
      text = JSON.stringify(obj);
      structuredNatively = true;
    } else {
      text = this.options.answer ?? `mock-response(${req.model})`;
    }

    const outputTokens = Math.min(
      req.maxOutputTokens ?? Number.MAX_SAFE_INTEGER,
      heuristicEstimator.count(text),
    );

    return {
      text,
      usage: {
        inputTokens,
        outputTokens,
        ...(this.options.cachedInputTokens != null
          ? { cachedInputTokens: this.options.cachedInputTokens }
          : {}),
      },
      structuredNatively,
    };
  }

  /**
   * Streaming variant of generate(): the same answer, cut into text events of
   * `streamChunkChars` characters, then one `done` with the generate() response.
   */
  async *generateStream(req: ProviderRequest): AsyncGenerator<ProviderStreamEvent, void, undefined> {
    const r = await this.generate(req);
    const n = Math.max(1, this.options.streamChunkChars ?? 8);
    for (let i = 0; i < r.text.length; i += n) yield { type: "text", delta: r.text.slice(i, i + n) };
    yield { type: "done", response: r };
  }
}

/** Build a minimal object that satisfies the schema subset. */
function fabricate(schema: JsonSchema): unknown {
  if (schema.enum && schema.enum.length > 0) return schema.enum[0];
  switch (schema.type) {
    case "object": {
      const obj: Record<string, unknown> = {};
      for (const key of schema.required ?? []) {
        const sub = schema.properties?.[key];
        obj[key] = sub ? fabricate(sub) : null;
      }
      // Include non-required properties that exist, to be helpful.
      for (const [key, sub] of Object.entries(schema.properties ?? {})) {
        if (!(key in obj)) obj[key] = fabricate(sub);
      }
      return obj;
    }
    case "array":
      return schema.items ? [fabricate(schema.items)] : [];
    case "string":
      return "mock";
    case "number":
    case "integer":
      return schema.minimum ?? 0;
    case "boolean":
      return true;
    case "null":
      return null;
    default:
      return null;
  }
}

export function createMockProvider(options?: MockProviderOptions): Provider {
  return new MockProvider(options);
}
