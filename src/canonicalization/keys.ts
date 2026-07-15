import type { CanonicalRequest } from "./canonicalize.js";
import { sha256, stableStringify } from "./canonicalize.js";

/**
 * Exact-cache key.
 *
 * A hash of the user text alone is NOT a safe cache key. Two requests may share
 * text but differ in tenant, permission scope, model version, system prompt,
 * schema, toolset, locale, sampling, knowledge epoch or safety policy — any of
 * which can change the correct answer. The exact key includes all of them.
 */
export function buildExactKey(c: CanonicalRequest): string {
  const material = stableStringify({
    tenant: c.tenantId,
    scope: c.authorizationScope,
    text: c.normalizedText,
    modelFamily: c.modelFamily,
    model: c.model,
    system: c.systemPromptHash,
    contract: c.contractId,
    schema: c.schemaVersion,
    tools: c.toolsetHash,
    locale: c.locale,
    temperature: c.temperature,
    seed: c.seed,
    knowledgeEpoch: c.knowledgeEpoch,
    freshness: c.freshnessBucket,
    safety: c.safetyPolicyVersion,
  });
  return `bvsala:exact:${sha256(material)}`;
}

/**
 * In-flight (singleflight) key. Coalesces concurrent, equivalent requests onto
 * a single execution. It can be slightly looser than the exact key (it does not
 * need freshness bucketing, since the work is happening *now*), but must still
 * isolate tenants and permissions.
 */
export function buildInflightKey(c: CanonicalRequest): string {
  const material = stableStringify({
    tenant: c.tenantId,
    scope: c.authorizationScope,
    text: c.normalizedText,
    model: c.model,
    system: c.systemPromptHash,
    contract: c.contractId,
    tools: c.toolsetHash,
    temperature: c.temperature,
    seed: c.seed,
  });
  return `bvsala:inflight:${sha256(material)}`;
}
