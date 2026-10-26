import type { CachedAnswer } from "../../src/cache/exact.js";
import type { SemanticCacheStore } from "../../src/cache/semantic.js";
import { canonicalize, type CanonicalRequest } from "../../src/canonicalization/canonicalize.js";
import type { SavingsRequest } from "../../src/contracts/types.js";

type SemanticCacheUnderTest = SemanticCacheStore & { settled(): Promise<void> };

export const CALIBRACION_DE_PRUEBA = {
  maxErrorRate: 0.5,
  confidence: 0.9,
  auditRate: 0,
} as const;

export async function certificarCacheSemantica(
  cache: SemanticCacheUnderTest,
  request: CanonicalRequest,
  answer: CachedAnswer,
  opts: { agentic?: boolean; query?: CanonicalRequest } = {},
): Promise<void> {
  const { query = request, ...lookupOpts } = opts;
  await cache.store(request, answer);
  for (let i = 0; i < 40; i++) {
    const { hit, probe } = await cache.lookup(query, lookupOpts);
    if (hit) return;
    if (!probe) throw new Error("la calibración de prueba no produjo una sonda");
    await cache.observe(probe, answer);
  }
  await cache.settled();
  if (!(await cache.lookup(query, lookupOpts)).hit) {
    throw new Error("la calibración de prueba no certificó un suelo");
  }
}

export async function certificarRespuestaSemantica(
  cache: SemanticCacheUnderTest,
  request: SavingsRequest,
  answer: { text: string; data?: unknown },
  opts: { agentic?: boolean; query?: SavingsRequest } = {},
): Promise<void> {
  await certificarCacheSemantica(
    cache,
    canonicalize(request),
    { text: answer.text, data: answer.data, storedAtMs: 0 },
    { agentic: opts.agentic, ...(opts.query ? { query: canonicalize(opts.query) } : {}) },
  );
}
