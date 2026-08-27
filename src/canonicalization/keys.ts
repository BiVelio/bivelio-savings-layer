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
 *
 * `deferrable` CLOSES THE SAME HOLE ON THE LATENCY AXIS, which is why it belongs
 * here and NOT in {@link buildExactKey}. The two doors do not risk the same
 * thing: the exact key hands out an answer that is ALREADY WRITTEN, where the
 * processing tier only picked a queue and changes neither the text nor the wait
 * of whoever receives it. This one binds a follower to a call that HAS NOT COME
 * BACK YET, so it imposes the leader's wait on them.
 *
 * A caller who never set `savings.deferrable` must not be made to wait for one
 * who did.
 */
export function buildInflightKey(
  c: CanonicalRequest,
  opciones: {
    servedModel?: string;
    deferrable?: boolean;
    // Dos ejes MÁS que cambian la respuesta y no están en CanonicalRequest, así
    // que se pasan aquí (misma clase que `servedModel`/`deferrable`):
    //  · toolDiscovery sondea y RECORTA la vista de herramientas del líder, que
    //    puede contestar «no tengo una herramienta para eso»;
    //  · maxOutputTokens corta la respuesta del líder (finishReason "length").
    // Sin ellos en la clave, un seguidor SIN la palanca (o con otro tope) recibía
    // esa respuesta recortada del líder con 100 % de ahorro acreditado — la misma
    // fuga que ya se cerró para servedModel y deferrable (caza del 2026-08-27).
    toolDiscovery?: boolean;
    maxOutputTokens?: number;
  } = {},
): string {
  // MEDIDO, y por eso `deferrable` esta en el material. Con el proveedor
  // simulado: lider con `savings.deferrable: true` (tier `flex`, 300 ms) y
  // segunda peticion concurrente identica SIN la palanca (5 ms). La segunda
  // esperaba 293 ms -- la espera del lider, no la suya -- y su informe no decia
  // nada, porque `report.deferred` solo se publica a quien declaro la palanca:
  // el unico sitio donde eso se veia era su monitorizacion.
  //
  // Contra el proveedor real la diferencia no son 300 ms. El `timeout` por
  // defecto de flex son 10 minutos y el SDK reintenta dos veces, asi que una
  // peticion de camino de usuario podia quedarse colgada minutos por la decision
  // de otra.
  //
  // Este comentario va en `//` a proposito: el JSDoc de esta funcion SI viaja a
  // `dist/index.d.ts`, y el trinquete de `superficie-publica-limpia` cuenta las
  // lineas con acentos que se publican en npm.
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
    deferrable: opciones.deferrable === true,
    toolDiscovery: opciones.toolDiscovery === true,
    maxOut: opciones.maxOutputTokens ?? null,
  });
  return `bvsala:inflight:${GENERACION}:${sha256(material)}`;
}
