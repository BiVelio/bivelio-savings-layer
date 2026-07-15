import { defaultTokenizerRegistry } from "../tokenizer/registry.js";
import type { SavingsRequest, SavingsResult } from "../contracts/types.js";
import { SavingsPipeline } from "./pipeline.js";
import type { SavingsLayerConfig } from "./config.js";

/** The public handle returned by {@link createSavingsLayer}. */
export interface SavingsLayer {
  generate<T = unknown>(request: SavingsRequest): Promise<SavingsResult<T>>;
  readonly pipeline: SavingsPipeline;
}

/**
 * Create a savings layer. The only hard requirement is a `provider`; a default
 * heuristic tokenizer and in-memory implementations of every other component
 * are wired automatically. Replace any of them for production (Redis exact
 * cache, pgvector/Qdrant semantic cache, a real tokenizer, an LLMLingua sidecar,
 * XGrammar/llguidance backends, etc.).
 *
 * @example
 * const layer = createSavingsLayer({ provider: createMockProvider() });
 * const { data, report } = await layer.generate({
 *   model: "openai/gpt-4o-mini",
 *   messages: [{ role: "user", content: "What is 2 + 2 * 3?" }],
 * });
 */
export function createSavingsLayer(
  config: Omit<SavingsLayerConfig, "tokenizer"> &
    Partial<Pick<SavingsLayerConfig, "tokenizer">>,
): SavingsLayer {
  const resolved: SavingsLayerConfig = {
    ...config,
    tokenizer: config.tokenizer ?? defaultTokenizerRegistry,
  };
  const pipeline = new SavingsPipeline(resolved);
  return {
    pipeline,
    generate: (request) => pipeline.generate(request),
  };
}
