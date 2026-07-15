import type { CostModel } from "../tokenizer/accounting.js";
import type { TokenizerRegistry } from "../tokenizer/registry.js";
import type { ExactCache } from "../cache/exact.js";
import type { InMemorySemanticCache } from "../cache/semantic.js";
import type { Singleflight } from "../cache/singleflight.js";
import type { ResolverRegistry } from "../resolvers/resolvers.js";
import type { ExecutionRouter } from "../router/router.js";
import type { ToolSelector } from "../router/tool-selector.js";
import type { FormatSelector } from "../serialization/format-selector.js";
import type { SchemaRegistry } from "../constraints/schema-registry.js";
import type { ConstraintBackend } from "../constraints/backends.js";
import type { Compressor } from "../compression/compression.js";
import type { Retriever, Reranker } from "../retrieval/retrieval.js";
import type { Provider } from "../providers/types.js";
import type { LicenseGate } from "../contracts/types.js";

/**
 * Everything the pipeline depends on. All fields except `provider` and
 * `tokenizer` are optional; sensible in-memory defaults are wired by
 * {@link createSavingsLayer} so the layer works out of the box and every
 * component is independently swappable.
 */
export interface SavingsLayerConfig {
  provider: Provider;
  tokenizer: TokenizerRegistry;

  exactCache?: ExactCache;
  semanticCache?: InMemorySemanticCache;
  singleflight?: Singleflight;
  resolvers?: ResolverRegistry;
  router?: ExecutionRouter;
  toolSelector?: ToolSelector;
  formatSelector?: FormatSelector;
  schemaRegistry?: SchemaRegistry;
  constraintBackends?: ConstraintBackend[];
  compressor?: Compressor;
  retriever?: Retriever;
  reranker?: Reranker;

  /**
   * Optional license gate. When present, managed features (semantic cache,
   * long-context compression, …) are only enabled if the gate grants them —
   * otherwise the request degrades gracefully to the free/local tier. When
   * absent, all features are available (self-managed / development mode).
   */
  licenseGate?: LicenseGate;

  /** Per-model cost models; falls back to `defaultCostModel`. */
  costModels?: Record<string, CostModel>;
  defaultCostModel?: CostModel;

  /** TTL for exact-cache writes, in ms. */
  exactCacheTtlMs?: number;

  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Injectable id generator for deterministic tests. */
  generateId?: () => string;
}

export const DEFAULT_COST_MODEL: CostModel = {
  // Illustrative default (USD per 1K tokens); override per model in production.
  inputPer1k: 0.0005,
  outputPer1k: 0.0015,
  cachedInputPer1k: 0.00005,
};
