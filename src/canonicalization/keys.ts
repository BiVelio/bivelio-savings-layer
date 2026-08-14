import type { CanonicalRequest } from "./canonicalize.js";
import { sha256, stableStringify } from "./canonicalize.js";

/**
 * GENERACIÓN DE LA CLAVE. Súbela cada vez que cambie `normalizeText` o el
 * conjunto de campos que entran en el material.
 *
 * El hash no dice CÓMO se normalizó el texto que lleva dentro, así que al
 * cambiar la normalización toda clave escrita por una versión anterior deja de
 * poder recalcularse. En una caché viva (Redis, KV) esas entradas no se vuelven
 * a leer nunca y ocupan sitio hasta que expira su TTL.
 *
 * Corrección no había en juego —dos materiales distintos nunca dan el mismo
 * sha256, así que nadie puede leer una entrada vieja creyendo que es suya— pero
 * sin marca de generación no hay forma de distinguir «entrada de antes del
 * cambio» de «entrada que nadie ha pedido», ni de vaciar solo las primeras. Con
 * la marca, un `SCAN bvsala:exact:n2:*` acota la generación viva, y un despliegue
 * escalonado —dos versiones del SDK contra el mismo Redis— escribe en dos
 * espacios separados en vez de mezclarse. `n1` es, por convenio, la generación
 * sin marca: la que publicaron las versiones hasta la 0.2.3.
 */
const GENERACION = "n2";

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
    principal: c.principal,
    text: c.normalizedText,
    modelFamily: c.modelFamily,
    model: c.model,
    system: c.systemPromptHash,
    contract: c.contractId,
    schema: c.schemaVersion,
    tools: c.toolsetHash,
    data: c.structuredDataHash,
    locale: c.locale,
    temperature: c.temperature,
    seed: c.seed,
    knowledgeEpoch: c.knowledgeEpoch,
    freshness: c.freshnessBucket,
    safety: c.safetyPolicyVersion,
  });
  return `bvsala:exact:${GENERACION}:${sha256(material)}`;
}

/**
 * In-flight (singleflight) key. Coalesces concurrent, equivalent requests onto
 * a single execution. It can be slightly looser than the exact key (it does not
 * need freshness bucketing, since the work is happening *now*), but must still
 * isolate tenants and permissions.
 *
 * `schema` is REQUIRED here, even though `contract` is already part of the key:
 * two concurrent calls that differ only in `schemaVersion` are different
 * requests and must never coalesce. All three doors — exact key, in-flight key
 * and semantic filter — key on the same identity, by design.
 */
export function buildInflightKey(c: CanonicalRequest): string {
  const material = stableStringify({
    tenant: c.tenantId,
    scope: c.authorizationScope,
    principal: c.principal,
    text: c.normalizedText,
    model: c.model,
    system: c.systemPromptHash,
    contract: c.contractId,
    schema: c.schemaVersion,
    tools: c.toolsetHash,
    data: c.structuredDataHash,
    temperature: c.temperature,
    seed: c.seed,
  });
  return `bvsala:inflight:${GENERACION}:${sha256(material)}`;
}
