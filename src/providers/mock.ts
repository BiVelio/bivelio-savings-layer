import type { JsonSchema } from "../contracts/types.js";
import { marcarDemo } from "./demo-brand.js";
import { heuristicEstimator } from "../tokenizer/estimator.js";
import type { Provider, ProviderRequest, ProviderResponse } from "./types.js";

/**
 * Deterministic mock provider.
 *
 * Lets the whole layer run — and be tested — with no network and no
 * credentials. When a schema is supplied it fabricates a schema-valid object,
 * demonstrating the constrained-decoding contract end to end. Token usage is
 * derived from the heuristic estimator so SavingsReport numbers are meaningful
 * in examples and tests.
 */
export interface MockProviderOptions {
  /** Fixed text to return when no schema is present. */
  answer?: string;
  /** Override the fabricated structured object. */
  data?: unknown;
  /** Simulated provider-cached input tokens (ledger 4). */
  cachedInputTokens?: number;
}

export class MockProvider implements Provider {
  readonly id = "mock";
  private readonly options: MockProviderOptions;

  constructor(options: MockProviderOptions = {}) {
    this.options = options;
    marcarDemo(this);
  }

  async generate(req: ProviderRequest): Promise<ProviderResponse> {
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
