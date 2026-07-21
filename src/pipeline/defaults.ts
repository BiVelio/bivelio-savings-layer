import { InMemoryExactCache, type ExactCache } from "../cache/exact.js";
import { Singleflight } from "../cache/singleflight.js";
import type { InMemorySemanticCache } from "../cache/semantic.js";
import {
  createDefaultResolvers,
  type ResolverRegistry,
} from "../resolvers/resolvers.js";
import { ExecutionRouter } from "../router/router.js";
import { ToolSelector } from "../router/tool-selector.js";
import { FormatSelector } from "../serialization/format-selector.js";
import { SchemaRegistry } from "../constraints/schema-registry.js";
import type { ConstraintBackend } from "../constraints/backends.js";
import type { SavingsLayerConfig } from "./config.js";

/** Fully-resolved, non-optional dependency set the pipeline runs against. */
export interface ResolvedDeps {
  exactCache: ExactCache;
  semanticCache: InMemorySemanticCache | undefined;
  singleflight: Singleflight;
  resolvers: ResolverRegistry;
  router: ExecutionRouter;
  toolSelector: ToolSelector;
  formatSelector: FormatSelector;
  schemaRegistry: SchemaRegistry;
  constraintBackends: ConstraintBackend[];
}

/**
 * Wire defaults for anything the caller did not supply. Every default is an
 * in-memory, dependency-free implementation, so `createSavingsLayer({ provider,
 * tokenizer })` is a working layer, and each piece can be replaced à la carte.
 */
export function resolveDependencies(config: SavingsLayerConfig): ResolvedDeps {
  return {
    exactCache: config.exactCache ?? new InMemoryExactCache(),
    semanticCache: config.semanticCache,
    singleflight: config.singleflight ?? new Singleflight(),
    resolvers: config.resolvers ?? createDefaultResolvers(),
    router: config.router ?? new ExecutionRouter(),
    toolSelector: config.toolSelector ?? new ToolSelector(),
    formatSelector:
      config.formatSelector ?? new FormatSelector({ tokenizer: config.tokenizer }),
    schemaRegistry: config.schemaRegistry ?? new SchemaRegistry(),
    // Honest default: assume NO decode-time constraint backend. resolveConstraintBackend
    // then reports backend:"none" ("will validate + repair") instead of over-claiming
    // "provider-native" enforcement for endpoints/models we haven't verified — and this
    // re-activates the structural-repair fallback (dead when a backend is always claimed).
    // Callers whose endpoint truly enforces strict JSON schema can pass
    // [providerNativeBackend(capabilityCheck)] to opt back in.
    constraintBackends: config.constraintBackends ?? [],
  };
}
