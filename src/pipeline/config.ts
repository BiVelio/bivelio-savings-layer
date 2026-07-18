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
   * Signed BiVelio license token (from your paid subscription). This is the
   * primary way to license the SDK: `createSavingsLayer` verifies it offline
   * against the embedded public key and builds a {@link licenseGate} from it.
   * Without a valid, active license (and without {@link devUnlicensed}), the
   * pipeline refuses to run — get a key at https://savings.bivelio.com.
   */
  licenseKey?: string;

  /**
   * Override the public key used to verify {@link licenseKey} (SPKI PEM). For
   * self-hosting and self-testing; defaults to the build-embedded BiVelio key.
   */
  licensePublicKey?: string;

  /**
   * Pre-built license gate. Usually you pass {@link licenseKey} instead and let
   * the SDK construct this. Advanced/self-managed callers can inject their own
   * gate (e.g. `@bivelio/license-client`'s `createLicenseGate()`). When both are
   * given, `licenseGate` wins.
   */
  licenseGate?: LicenseGate;

  /**
   * Explicit escape hatch: run **ungated** (all managed features on, no license
   * required) for local development, CI, and benchmarks. Also honored via the
   * `BVSALA_DEV_OPEN=1` environment variable. Never set this in production — it
   * disables the paid licensing check entirely.
   */
  devUnlicensed?: boolean;

  /** Per-model cost models; falls back to `defaultCostModel`. */
  costModels?: Record<string, CostModel>;
  defaultCostModel?: CostModel;

  /** TTL for exact-cache writes, in ms. */
  exactCacheTtlMs?: number;

  /**
   * Reliability contract. When true (the default), ANY internal optimizer error
   * (a resolver, cache, format selector, compressor, or accounting bug) is
   * caught and the request falls open to a plain provider call — BV-SALA must
   * never add a crash point to the customer's request path. Set to `false` only
   * in tests/benchmarks that want internal errors to surface.
   */
  failOpen?: boolean;

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
