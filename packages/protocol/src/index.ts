/**
 * @bivelio/protocol — shared wire types for BV-SALA.
 * PROPRIETARY AND CONFIDENTIAL — © 2026 BiVelio Inc. All Rights Reserved.
 *
 * These types are the contract between the SDK (data plane), the license-client,
 * and the control plane (licensing / metering / billing). Keeping them in one
 * dependency-free package guarantees both sides agree on the shape.
 */

/** Commercial plans. `free` is the self-hosted, locally-capped tier. */
export type Plan = "free" | "pro" | "team" | "enterprise";

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
  | "cache_ttl_tuning";

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
  /**
   * De dónde sale el baseline de ESTE registro: "measured" (contador del
   * proveedor), "estimated" (llamada evitada, sin contador), "unmeasured" o
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
  cache: { result: string };
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
 *  carril hipotético de S2 — solo columnas shadow_*, jamás comisión. */
const USAGE_BASIS = new Set(["measured", "estimated", "unmeasured", "shadow"]);

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
  return rec as unknown as UsageRecord;
}

/** Parse a batch (single object or array) of untrusted usage records. */
export function parseUsageRecords(input: unknown, authorizedOrgId: string): UsageRecord[] {
  const arr = Array.isArray(input) ? input : [input];
  return arr.map((r) => parseUsageRecord(r, authorizedOrgId));
}

export const PROTOCOL_VERSION = 1 as const;
