import type { CanonicalRequest } from "./canonicalize.js";
import { modelFamilyOf, sha256, stableStringify } from "./canonicalize.js";

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
 *
 * `servedModel` CARRIES THE MODEL THAT WILL ACTUALLY ANSWER, not the one the
 * caller named, and that distinction is what stops the model cascade from
 * poisoning the cache. Routing to a cheap model and storing its answer under the
 * STRONG model's key would hand that answer to the next request — one with the
 * cascade off, or from another process entirely — while the report claims the
 * requested model served it. That is a silent model swap, deferred, which is the
 * worst kind of silent model swap.
 *
 * `modelFamily` is derived from whichever id is used, for the same reason: it is
 * part of the identity of whoever answers.
 */
export function buildExactKey(
  c: CanonicalRequest,
  opciones: { servedModel?: string } = {},
): string {
  const model = opciones.servedModel ?? c.model;
  const material = stableStringify({
    tenant: c.tenantId,
    scope: c.authorizationScope,
    principal: c.principal,
    text: c.normalizedText,
    modelFamily: model === c.model ? c.modelFamily : modelFamilyOf(model),
    model,
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
 *
 * `servedModel` CARRIES THE MODEL THAT WILL ACTUALLY ANSWER, for the same reason
 * {@link buildExactKey} does, and this door is the one that leaks FIRST. The
 * exact key protects the answer AFTER it is stored; this one protects it while
 * it is still being written, and a follower does not re-run anything — it is
 * handed the leader's text verbatim.
 *
 * The leak it closes, measured: two concurrent requests for the same text, one
 * with `savings.modelCascade: "on"` and one with the cascade OFF, coalesced onto
 * one execution. The routed leader called the cheap model, and the caller who
 * never opted in — whose own decision was "do not route" — was served the cheap
 * model's answer. Same shape inside a single uniformly-configured deployment:
 * the automatic shut-off can latch between two concurrent requests, so one is
 * routed and the other is not, and coalescing hands one of them the other's
 * model. Whoever the layer decided must go to the strong model has to actually
 * go there.
 */
export function buildInflightKey(
  c: CanonicalRequest,
  opciones: { servedModel?: string } = {},
): string {
  const material = stableStringify({
    tenant: c.tenantId,
    scope: c.authorizationScope,
    principal: c.principal,
    text: c.normalizedText,
    model: opciones.servedModel ?? c.model,
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
