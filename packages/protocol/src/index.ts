/**
 * @bivelio/protocol — shared wire types for BV-SALA.
 * PROPRIETARY AND CONFIDENTIAL — © 2026 BiVelio Inc. All Rights Reserved.
 *
 * These types are the contract between the SDK (data plane), the license-client,
 * and the control plane (licensing / metering / billing). Keeping them in one
 * dependency-free package guarantees both sides agree on the shape.
 */

/**
 * Commercial plans. `free` is the self-hosted, locally-capped tier.
 *
 * `measure` («Medir») es la licencia GRATUITA y PERMANENTE, sin tarjeta: el SDK
 * y la pasarela funcionan EN SOMBRA —calculan lo que habrían ahorrado— y NINGUNA
 * palanca se aplica: la petición del cliente sale intacta al proveedor y nada se
 * sirve de caché. Sigue siendo una licencia firmada y verificada offline, así que
 * el fail-closed no cambia: sin clave, no hay capa. Se pasa a pago para activar
 * palancas. Ver {@link MEASURE_PLAN} y {@link MEASURE_LIMITS}.
 */
export type Plan = "free" | "measure" | "pro" | "team" | "enterprise";

/** El literal del plan Medir, para no teclearlo en cada comprobación. */
export const MEASURE_PLAN = "measure" as const satisfies Plan;

/**
 * Los límites anti-abuso de la licencia Medir, ACEPTADOS por el dueño el
 * 2026-09-29. Espejo de `apps/web/lib/license/medir.ts` (un test fija que los
 * dos coinciden).
 *
 *  · `seats`: asientos (máquinas o identidades de servicio) que la ingesta
 *    acepta por mes natural. 5 = un equipo piloto real (un responsable y unos
 *    pocos desarrolladores o servicios), suficiente para una medición
 *    representativa y por debajo de cualquier despliegue de producción de más
 *    de un equipo. Pasado el tope, la capa sigue funcionando (en sombra no hay
 *    nada que quitarle) y lo que deja de pasar es la MEDICIÓN de esos asientos.
 *  · `orgsPerAccount`: organizaciones con licencia Medir por cuenta verificada.
 *  · `dailyRequests`: peticiones ingeridas por organización y día (UTC). Acota
 *    el coste de servir un panel gratis a quien lo use como observabilidad de
 *    producción; ~600 000 al mes caben de sobra en un piloto.
 *  · `termDays` / `graceDays`: el token es «permanente» en la práctica (diez
 *    años); la revocación sigue funcionando por la lista firmada y la ingesta.
 */
export const MEASURE_LIMITS = {
  seats: 5,
  orgsPerAccount: 1,
  dailyRequests: 20_000,
  termDays: 3650,
  graceDays: 30,
} as const;

/** ¿Es este el plan Medir? Acepta cualquier cadena: el plan llega de un token. */
export function isMeasurePlan(plan: unknown): boolean {
  return plan === MEASURE_PLAN;
}

/**
 * Gated capabilities. Local wins (exact cache, resolvers, format selector,
 * strict output) are NOT gated — they work on the free tier. These are the
 * managed / high-value features that require a paid entitlement.
 */
export type Feature =
  | "semantic_cache"
  | "learned_thresholds"
  | "dashboards"
  | "cross_tenant_optimization"
  | "long_context_compression"
  | "priority_support"
  | "context_elision"
  | "tool_result_elision"
  /**
   * Rebaja del TTL de escritura de caché (1h → 5m) cuando la sesión está
   * CALIENTE. No toca un solo token que el modelo lea: cambia la TARIFA de la
   * misma escritura (2× → 1,25× el precio de entrada). Por eso su ahorro es
   * aritmética sobre el usage que el proveedor ya declaró — `measured`, sin
   * necesidad de A/B.
   */
  | "cache_ttl_tuning"
  /**
   * Palanca C · el MODELO HERMANO: servir `claude-fable-5` con `claude-fable-5-1`.
   * Misma familia, capacidad ≥ y precio base IDÉNTICO (entrada, salida y
   * primas de escritura); solo la LECTURA de caché es más barata (0,00025
   * frente a 0,001 por 1K, catálogo). El ahorro es el mismo usage a dos
   * precios de catálogo — `measured`, sin A/B. Opt-in del cliente en el
   * gateway (BVSALA_GATEWAY_MODELO_HERMANO=1) además de este feature.
   */
  | "sibling_model_routing"
  | "per_turn_effort";

/**
 * Runtime mirror of the `Feature` union, for gates and parity tests. The
 * `_exhaustiva` check makes forgetting a literal here a COMPILE error, so the
 * union and this array cannot drift apart.
 */
export const FEATURES = [
  "semantic_cache",
  "learned_thresholds",
  "dashboards",
  "cross_tenant_optimization",
  "long_context_compression",
  "priority_support",
  "context_elision",
  "tool_result_elision",
  "cache_ttl_tuning",
  "sibling_model_routing",
  "per_turn_effort",
] as const satisfies readonly Feature[];
const _exhaustiva: [Exclude<Feature, (typeof FEATURES)[number]>] extends [never] ? true : never = true;
void _exhaustiva;

/** The signed payload embedded in a license token. */
export interface LicensePayload {
  /** License id (for revocation lists / audit). */
  jti: string;
  /** Tenant / organization this license belongs to. */
  org_id: string;
  plan: Plan;
  /** Purchased seats (per-seat billing). */
  seats: number;
  /** Entitled features. */
  features: Feature[];
  /** Unix seconds. */
  issued_at: number;
  /** Unix seconds; hard expiry (before grace). */
  expires_at: number;
  /** Extra days the SDK keeps working past expiry (graceful degrade window). */
  grace_days: number;
  /** Optional issuer identifier. */
  iss?: string;
  /**
   * Only on a `measure` license: its REAL expiry and grace. A measure token is
   * signed with `expires_at = issued_at` and `grace_days = 0`, so a verifier that
   * predates shadow mode (and would run the un-gated levers) sees it EXPIRED and
   * fails closed. Verifiers that know the plan read these instead
   * ({@link effectiveTerm}).
   */
  measure_expires_at?: number;
  measure_grace_days?: number;
}

/** The term a verifier must apply: a measure license's real term, else the token's own. */
export function effectiveTerm<P extends { plan?: string; expires_at: number; grace_days: number; measure_expires_at?: number; measure_grace_days?: number }>(
  p: P,
): P {
  if (p.plan !== MEASURE_PLAN || typeof p.measure_expires_at !== "number" || !Number.isFinite(p.measure_expires_at)) return p;
  const grace = typeof p.measure_grace_days === "number" && Number.isFinite(p.measure_grace_days) ? p.measure_grace_days : 0;
  return { ...p, expires_at: p.measure_expires_at, grace_days: Math.max(0, grace) };
}

/** Current license status resolved by the license-client. */
export type LicenseStatus =
  | "active" // valid, within term
  | "grace" // expired but inside grace window; still entitled, should warn
  | "expired" // past grace; drop to free tier
  | "invalid" // bad signature / malformed
  | "revoked"; // present on a revocation list

/** Snapshot of what a license currently grants. */
export interface Entitlements {
  orgId: string;
  plan: Plan;
  seats: number;
  features: Feature[];
  status: LicenseStatus;
  /** Unix seconds when this snapshot should be re-checked online. */
  refreshAfter?: number;
}

/**
 * The signed payload of a revocation list — the control plane's published set of
 * revoked license ids (`jti`). It is distributed as a compact Ed25519 token with
 * the SAME wire shape as a license token, so the SDK verifies it offline with the
 * SAME embedded public key (no new key management). `seq` is a monotonic,
 * non-decreasing revision that lets a client reject a rolled-back/stale list;
 * `asOf` is when the list was minted (unix seconds), for future-skew rejection.
 */
export interface RevocationListPayload {
  /** Payload schema version. */
  v: 1;
  /** Unix seconds when this list was signed. */
  asOf: number;
  /** Monotonic, non-decreasing revision of the revocation set. */
  seq: number;
  /** Revoked license ids (jti). Grows over time; clients treat it as sticky. */
  revoked: string[];
  /** Optional issuer identifier. */
  iss?: string;
}

/**
 * Header of a signed revocation-list token. `typ` differs from a license token's
 * `"BVL"` for DOMAIN SEPARATION: a license token can never be replayed as a
 * revocation list (or vice-versa), even though both share the compact
 * `base64url(header).base64url(body).base64url(sig)` Ed25519 wire format.
 */
export const REVOCATION_HEADER = { alg: "EdDSA", typ: "BVSALA-REVOC", v: 1 } as const;

/** Current revocation-list payload schema version. */
export const REVOCATION_LIST_VERSION = 1 as const;

/**
 * A usage record derived from the SDK's SavingsReport and sent to the metering
 * service. Carries ONLY counts/metadata — never prompts or completions.
 */
export interface UsageRecord {
  orgId: string;
  /** Machine identity (service account) that produced the request. */
  seatId?: string;
  /** True when produced by a CI / ephemeral runner (excluded from billable seats). */
  ci?: boolean;
  requestId: string;
  model: string;
  /** Unix ms. */
  at: number;
  avoidedLlm: number;
  actualLlm: number;
  baselineInputTokens: number;
  actualInputTokens: number;
  eliminatedInputTokens: number;
  compressedInputTokens: number;
  baselineOutputTokens: number;
  actualOutputTokens: number;
  providerCachedInputTokens: number;
  cacheResult: string;
  baselineCost: number;
  actualCost: number;
  netSavings: number;
  /** Optional (0025): provider-cleared input tokens valued at the cache READ floor price. Capped server-side; never part of measured. */
  eliminatedInputFloorCost?: number;
  /** Optional (0032): the provider's own prompt-cache read discount on this request, USD. Never commissioned. */
  nativeCacheReadSavings?: number;
  /** Optional (0032): the cache-write premium the provider billed on this request, USD. Never commissioned. */
  nativeCacheWritePremium?: number;
  /** Optional (0029), only with basis "reference": the requestId of the identical request that ran. */
  referenceRequestId?: string;
  /** Optional (0029), only with basis "reference": epoch ms when that request's provider counter was read. */
  referenceAt?: number;
  /**
   * De dónde sale el baseline de ESTE registro: "measured" (contador del
   * proveedor), "reference" (llamada evitada valorada con el contador del
   * proveedor de la petición idéntica que sí corrió — 0029), "estimated"
   * (llamada evitada, sin contador), "unmeasured" o
   * "shadow" (el carril hipotético de S2: qué HABRÍA pasado con la elisión
   * encendida — jamás en la base de comisión, jamás sumado a measured).
   * Viaja hasta el panel para que el dinero medido y el estimado se puedan
   * agregar POR SEPARADO — sumarlos en una sola cifra de "ahorrado" es lo que
   * este producto promete no hacer.
   */
  basis?: string;
}

/** Response from the licensing service when validating/refreshing online. */
export interface LicenseValidationResponse {
  status: LicenseStatus;
  entitlements?: Entitlements;
  /** New token if the service rotated/renewed it. */
  token?: string;
  reason?: string;
}

/**
 * Minimal structural view of the SDK's SavingsReport — just the fields metering
 * needs. Declared here (not imported from the SDK) so protocol stays free of any
 * dependency on the SDK, while remaining structurally compatible with it.
 */
export interface SavingsReportLike {
  requestId: string;
  model: string;
  calls: { avoidedLlm: number; actualLlm: number };
  tokens: {
    baselineInput: number;
    actualInput: number;
    eliminatedInput: number;
    compressedInput: number;
    baselineOutput: number;
    actualOutput: number;
    providerCachedInput?: number;
  };
  cache: {
    result: string;
    /** Present when this avoided call is valued by reference (the SDK's ReferenceCredit, reduced to what travels). */
    reference?: { requestId: string; at: number };
  };
  cost: { baselineEstimate: number; actual: number; netSavings: number; basis?: string };
}

/**
 * Map a SavingsReport into a metering UsageRecord. Carries ONLY counts and
 * cost — never prompts or completions — matching the data-minimization
 * invariant of the control plane.
 */
export function usageRecordFromReport(
  report: SavingsReportLike,
  ctx: { orgId: string; seatId?: string; ci?: boolean; at: number },
): UsageRecord {
  return {
    orgId: ctx.orgId,
    ...(ctx.seatId ? { seatId: ctx.seatId } : {}),
    ...(ctx.ci ? { ci: ctx.ci } : {}),
    requestId: report.requestId,
    model: report.model,
    at: ctx.at,
    avoidedLlm: report.calls.avoidedLlm,
    actualLlm: report.calls.actualLlm,
    baselineInputTokens: report.tokens.baselineInput,
    actualInputTokens: report.tokens.actualInput,
    eliminatedInputTokens: report.tokens.eliminatedInput,
    compressedInputTokens: report.tokens.compressedInput,
    baselineOutputTokens: report.tokens.baselineOutput,
    actualOutputTokens: report.tokens.actualOutput,
    providerCachedInputTokens: report.tokens.providerCachedInput ?? 0,
    cacheResult: report.cache.result,
    baselineCost: report.cost.baselineEstimate,
    actualCost: report.cost.actual,
    netSavings: report.cost.netSavings,
    ...(report.cost.basis ? { basis: report.cost.basis } : {}),
    // 0029 · the two reference fields travel ONLY with basis "reference" and only
    // in the exact shape the ingest keeps (it would drop anything else anyway).
    ...(report.cost.basis === "reference" &&
    report.cache.reference &&
    USAGE_ID_PATTERN.test(report.cache.reference.requestId) &&
    Number.isInteger(report.cache.reference.at)
      ? { referenceRequestId: report.cache.reference.requestId, referenceAt: report.cache.reference.at }
      : {}),
  };
}

/**
 * The EXACT set of fields the control plane accepts on a usage record. This is a
 * privacy backstop, not a convenience: the metering ingest must build records
 * ONLY from these keys and REJECT any payload carrying a field outside the set,
 * so a buggy or hostile client can never smuggle a `prompt`, `completion`,
 * `messages`, or any other content field across the data-plane / control-plane
 * boundary. The type guarantee (`body as UsageRecord[]`) is erased at runtime;
 * this is the runtime enforcement.
 */
/** Identity/label string fields — constrained to a strict charset + length so
 * they cannot be used as a value channel to smuggle prompt/completion content. */
const USAGE_ID_FIELDS = ["requestId", "model"] as const;
const USAGE_ID_PATTERN = /^[A-Za-z0-9._:/-]{1,128}$/;
// Umbral de unidad de `at`: la frontera segundos/milisegundos. Espejo de
// apps/web/lib/metering/usage.ts — mantener los dos valores en sincronía.
const AT_MIN_MS = 1e12;
const AT_MAX_SKEW_MS = 48 * 60 * 60 * 1000;
/** cacheResult is a closed enum (mirrors the SDK's CacheOutcome), never free text. */
const USAGE_CACHE_RESULTS: ReadonlySet<string> = new Set<string>([
  "miss",
  "exact",
  "semantic",
  "singleflight",
  "deterministic",
]);
const USAGE_NUMBER_FIELDS = [
  "at",
  "avoidedLlm",
  "actualLlm",
  "baselineInputTokens",
  "actualInputTokens",
  "eliminatedInputTokens",
  "compressedInputTokens",
  "baselineOutputTokens",
  "actualOutputTokens",
  "providerCachedInputTokens",
  "baselineCost",
  "actualCost",
  "netSavings",
] as const;
/** `orgId` is intentionally NOT accepted from the client — the server derives it
 * from the authenticated service account. `seatId` and `ci` are the optional fields. */
/** Valores admitidos en `basis` (espejo de CostBasis del SDK). "shadow" es el
 *  carril hipotético de S2 — solo columnas shadow_*, jamás comisión.
 *  "reference" es el carril medido por referencia (0029) — columnas reference_*,
 *  jamás measured_*. Espejo de apps/web/lib/metering/usage.ts. */
const USAGE_BASIS = new Set(["measured", "reference", "estimated", "unmeasured", "shadow"]);

/**
 * Optional money field of the provider-clearing lane (migration 0025):
 * `eliminatedInputFloorCost` = the tokens the provider cleared, valued at the
 * model's cache-READ price (the floor). Optional on purpose and NEVER part of
 * USAGE_NUMBER_FIELDS (those are mandatory: making it one would turn every
 * batch from a gateway <= 0.4.16 into a 400). Mirror of apps/web/lib/metering/usage.ts.
 */
const USAGE_OPTIONAL_MONEY_FIELDS = ["eliminatedInputFloorCost"] as const;
/**
 * Ceiling for that floor, USD per 1k tokens: >= the largest `cachedInputPer1k`
 * in the catalog. A floor priced at INPUT rate (x10-x40) is clipped, never
 * rejected — a throw here drops the client's whole batch. Mirror of
 * apps/web/lib/metering/techo-precio-lectura.ts (a test pins both equal).
 */
const TECHO_PRECIO_LECTURA_PER_1K = 0.002;
/**
 * Output ceiling of the reference lane (0029), USD per 1k tokens: >= the largest
 * `outputPer1k` in the catalog. With the read ceiling it bounds the baselineCost
 * of a basis "reference" record; above it the record is DOWNGRADED to
 * "estimated", never rejected. Mirror of apps/web/lib/metering/techo-precio-lectura.ts
 * (a test pins both equal).
 */
const TECHO_PRECIO_SALIDA_PER_1K = 0.08;
/**
 * Input ceiling of the NATIVE-savings lane (0032), USD per 1k tokens: >= the
 * largest `inputPer1k` in the catalog. It clips the two native figures (cache
 * read discount <= cached tokens x ceiling; write premium <= input tokens x
 * ceiling), never rejects. Mirror of apps/web/lib/metering/techo-precio-lectura.ts
 * (a test pins both equal).
 */
const TECHO_PRECIO_ENTRADA_PER_1K = 0.04;
/**
 * Optional fields of the NATIVE-savings lane (0032): the provider's own prompt
 * cache discount on the request (read) and the cache-write premium it billed,
 * both USD and >= 0. Their own columns; never measured_*, never the commission
 * base. Mirror of apps/web/lib/metering/usage.ts.
 */
const USAGE_OPTIONAL_NATIVE_FIELDS = ["nativeCacheReadSavings", "nativeCacheWritePremium"] as const;

/**
 * Optional fields of the reference lane (0029). Clip, never reject: a malformed
 * value is dropped (a throw here drops the client's whole batch).
 */
const USAGE_OPTIONAL_REFERENCE_FIELDS = ["referenceRequestId", "referenceAt"] as const;
const REFERENCE_CACHE_RESULTS: ReadonlySet<string> = new Set<string>(["exact", "singleflight"]);
/** The SDK rounds USD to 1e-10 (roundUsd): the ceiling tolerates that granularity. */
const REFERENCE_ROUNDING_TOLERANCE_USD = 1e-10;
/**
 * Maximum age of the reference counter (`at - referenceAt`), the one the
 * statement publishes: 30 days. Mirror of EDAD_MAXIMA_REFERENCIA_MS in
 * apps/web/lib/metering/usage.ts (a test pins both equal).
 */
const REFERENCE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Clock skew tolerated on both sides of that age check: 5 minutes, as the SDK's read check. */
const REFERENCE_CLOCK_SKEW_MS = 5 * 60 * 1000;

const USAGE_ALLOWED_FIELDS: ReadonlySet<string> = new Set<string>([
  "orgId",
  "seatId",
  "ci",
  "cacheResult",
  "basis",
  "sessionId",
  "agentId",
  ...USAGE_ID_FIELDS,
  ...USAGE_NUMBER_FIELDS,
  ...USAGE_OPTIONAL_MONEY_FIELDS,
  ...USAGE_OPTIONAL_REFERENCE_FIELDS,
  ...USAGE_OPTIONAL_NATIVE_FIELDS,
]);

export class UsageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageValidationError";
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Is a basis "reference" record coherent? An avoided call (exact hit or
 * coalesced follower) with no cost and no removed, compressed or
 * provider-cached tokens of its own, a positive baseline at or under the
 * ceiling, and a POINTER to the identical request that ran
 * (`referenceRequestId` and `referenceAt`, both kept) no older than the
 * published rule allows. Mirror of `referenciaCoherente` in
 * apps/web/lib/metering/usage.ts.
 */
function referenceIsCoherent(rec: Record<string, unknown>): boolean {
  const n = (k: string) => rec[k] as number;
  if (!REFERENCE_CACHE_RESULTS.has(rec["cacheResult"] as string)) return false;
  if (n("avoidedLlm") !== 1 || n("actualLlm") !== 0) return false;
  if (n("actualInputTokens") !== 0 || n("actualOutputTokens") !== 0 || n("actualCost") !== 0) return false;
  if (n("eliminatedInputTokens") !== 0 || n("compressedInputTokens") !== 0 || n("providerCachedInputTokens") !== 0) {
    return false;
  }
  if (rec["eliminatedInputFloorCost"] !== undefined && rec["eliminatedInputFloorCost"] !== 0) return false;
  if (n("netSavings") !== 1) return false;
  if (!(n("baselineInputTokens") > 0) || !(n("baselineCost") > 0)) return false;
  if (typeof rec["referenceRequestId"] !== "string" || typeof rec["referenceAt"] !== "number") return false;
  const age = n("at") - n("referenceAt");
  if (age < -REFERENCE_CLOCK_SKEW_MS || age > REFERENCE_MAX_AGE_MS + REFERENCE_CLOCK_SKEW_MS) return false;
  const ceiling =
    (n("baselineInputTokens") / 1_000) * TECHO_PRECIO_LECTURA_PER_1K +
    (n("baselineOutputTokens") / 1_000) * TECHO_PRECIO_SALIDA_PER_1K;
  return n("baselineCost") <= ceiling + REFERENCE_ROUNDING_TOLERANCE_USD;
}

/**
 * Parse and validate one untrusted usage record. Throws {@link UsageValidationError}
 * on any unknown field (content-leak backstop) or type mismatch. `orgId` is
 * taken from `authorizedOrgId` (server-derived), never from the client body.
 */
export function parseUsageRecord(input: unknown, authorizedOrgId: string): UsageRecord {
  if (!isPlainObject(input)) {
    throw new UsageValidationError("usage record must be an object");
  }
  for (const key of Object.keys(input)) {
    if (!USAGE_ALLOWED_FIELDS.has(key)) {
      throw new UsageValidationError(
        `disallowed field "${key}" on usage record — the control plane accepts only counts/metadata, never content`,
      );
    }
  }
  const rec: Record<string, unknown> = { orgId: authorizedOrgId };
  // Identity fields: strict charset + length. This closes the "value channel" —
  // a free-form string field cannot carry prompt/completion content.
  for (const f of USAGE_ID_FIELDS) {
    const v = input[f];
    if (typeof v !== "string" || !USAGE_ID_PATTERN.test(v)) {
      throw new UsageValidationError(`field "${f}" must match ${USAGE_ID_PATTERN} (identity, not free text)`);
    }
    rec[f] = v;
  }
  // cacheResult: closed enum, never free text (it is persisted as an object key).
  if (typeof input["cacheResult"] !== "string" || !USAGE_CACHE_RESULTS.has(input["cacheResult"] as string)) {
    throw new UsageValidationError(
      `field "cacheResult" must be one of ${[...USAGE_CACHE_RESULTS].join("|")}`,
    );
  }
  rec["cacheResult"] = input["cacheResult"];
  for (const f of USAGE_NUMBER_FIELDS) {
    const n = input[f];
    if (typeof n !== "number" || !Number.isFinite(n)) {
      throw new UsageValidationError(`field "${f}" must be a finite number`);
    }
    // Mismo dominio que el backstop del servidor (apps/web/lib/metering/usage.ts).
    // Los dos ficheros son espejos deliberados; si uno gana una regla, el otro
    // también, o el emisor deja pasar lo que el ingest luego rechaza con un 400.
    if (f === "at") {
      if (n < AT_MIN_MS || n > Date.now() + AT_MAX_SKEW_MS) {
        throw new UsageValidationError(
          `field "at" is out of range (${n}); expected epoch MILLISECONDS. ` +
            `A value near ${Math.floor(Date.now() / 1000)} suggests seconds instead of milliseconds.`,
        );
      }
    } else if (f === "netSavings") {
      if (n > 1 || n < -100) {
        throw new UsageValidationError(`field "netSavings" must be a ratio in [-100, 1], got ${n}`);
      }
    } else if (n < 0) {
      throw new UsageValidationError(`field "${f}" must be >= 0, got ${n}`);
    }
    rec[f] = n;
  }
  if (input["eliminatedInputFloorCost"] !== undefined) {
    const v = input["eliminatedInputFloorCost"];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new UsageValidationError(`field "eliminatedInputFloorCost" must be a finite number >= 0`);
    }
    // Clip, never reject: money without a count -> 0; above tokens x ceiling -> ceiling.
    const tokens = rec["eliminatedInputTokens"] as number;
    const techo = tokens > 0 ? (tokens / 1_000) * TECHO_PRECIO_LECTURA_PER_1K : 0;
    rec["eliminatedInputFloorCost"] = Math.min(v, techo);
  }
  // 0032 · native savings: type and sign rejected, domain clipped (no count -> 0).
  for (const [field, tokens] of [
    ["nativeCacheReadSavings", rec["providerCachedInputTokens"] as number],
    ["nativeCacheWritePremium", rec["actualInputTokens"] as number],
  ] as const) {
    if (input[field] === undefined) continue;
    const v = input[field];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new UsageValidationError(`field "${field}" must be a finite number >= 0`);
    }
    rec[field] = tokens > 0 ? Math.min(v, (tokens / 1_000) * TECHO_PRECIO_ENTRADA_PER_1K) : 0;
  }
  if (input["seatId"] !== undefined) {
    const s = input["seatId"];
    if (typeof s !== "string" || !USAGE_ID_PATTERN.test(s)) {
      throw new UsageValidationError(`field "seatId" must match ${USAGE_ID_PATTERN} (identity, not free text)`);
    }
    rec["seatId"] = s;
  }
  // Espejo de apps/web/lib/metering/usage.ts: atribución de sesión/subagente,
  // identidad opaca con charset estricto — jamás texto libre ni una persona.
  for (const f of ["sessionId", "agentId"] as const) {
    if (input[f] !== undefined) {
      const v = input[f];
      if (typeof v !== "string" || !USAGE_ID_PATTERN.test(v)) {
        throw new UsageValidationError(`field "${f}" must match ${USAGE_ID_PATTERN} (identity, not free text)`);
      }
      rec[f] = v;
    }
  }
  if (input["basis"] !== undefined) {
    const b = input["basis"];
    if (typeof b !== "string" || !USAGE_BASIS.has(b)) {
      throw new UsageValidationError(`field "basis" must be one of ${[...USAGE_BASIS].join("|")}`);
    }
    rec["basis"] = b;
  }
  if (input["ci"] !== undefined) {
    if (typeof input["ci"] !== "boolean") {
      throw new UsageValidationError(`field "ci" must be a boolean`);
    }
    rec["ci"] = input["ci"];
  }
  // 0029 · reference lane — clip, never reject (mirror of apps/web/lib/metering/usage.ts).
  if (input["referenceRequestId"] !== undefined) {
    const v = input["referenceRequestId"];
    if (typeof v === "string" && USAGE_ID_PATTERN.test(v)) rec["referenceRequestId"] = v;
  }
  if (input["referenceAt"] !== undefined) {
    const v = input["referenceAt"];
    if (typeof v === "number" && Number.isInteger(v) && v >= AT_MIN_MS && v <= Date.now() + AT_MAX_SKEW_MS) {
      rec["referenceAt"] = v;
    }
  }
  if (rec["basis"] === "reference" && !referenceIsCoherent(rec)) rec["basis"] = "estimated";
  if (rec["basis"] !== "reference") {
    delete rec["referenceRequestId"];
    delete rec["referenceAt"];
  }
  return rec as unknown as UsageRecord;
}

/** Parse a batch (single object or array) of untrusted usage records. */
export function parseUsageRecords(input: unknown, authorizedOrgId: string): UsageRecord[] {
  const arr = Array.isArray(input) ? input : [input];
  return arr.map((r) => parseUsageRecord(r, authorizedOrgId));
}

/**
 * Server-side kill switch of the reference lane: rewrites every basis
 * "reference" record to "estimated" and drops its two reference fields.
 * Returns how many it changed. Mirror of `degradarReferencias` in
 * apps/web/lib/metering/usage.ts.
 */
export function downgradeReferences(records: UsageRecord[]): number {
  let n = 0;
  for (const r of records) {
    if (r.basis !== "reference") continue;
    r.basis = "estimated";
    delete r.referenceRequestId;
    delete r.referenceAt;
    n++;
  }
  return n;
}

export const PROTOCOL_VERSION = 1 as const;
