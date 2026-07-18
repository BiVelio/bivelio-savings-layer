import { createHash } from "node:crypto";
import { parseUsageRecords, UsageValidationError } from "@bivelio/protocol";
import type { MeteringService } from "./service.js";

/**
 * Transport-agnostic gateway for the metering control-plane surface.
 *
 * This is where the security posture lives, unit-testable without a socket:
 *  - **Fail closed.** With no service account configured (and not explicitly in
 *    dev-open mode) every protected operation is refused — never silently open.
 *  - **Server-derived tenant.** The org a record is booked to comes from the
 *    AUTHENTICATED service account, never from the client body — a caller cannot
 *    write into (or read) another tenant by claiming its orgId.
 *  - **Content backstop.** Ingest runs `parseUsageRecords`, which rejects any
 *    field outside the counts/metadata allowlist — a prompt/completion can never
 *    be stored.
 */
export interface Caller {
  orgId: string;
  admin: boolean;
}

export interface GatewayResult {
  status: number;
  body: unknown;
}

export interface MeteringAuthConfig {
  /** sha256(token hex) -> orgId, for machine-to-machine service accounts. */
  serviceAccounts: Map<string, string>;
  /** Optional admin token that may read any org. */
  adminToken?: string;
  /** Dev escape hatch — only honored when explicitly enabled. */
  devOpen?: boolean;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function bearer(authorization: string | undefined): string | null {
  if (!authorization || !authorization.startsWith("Bearer ")) return null;
  const t = authorization.slice(7).trim();
  return t.length > 0 ? t : null;
}

/**
 * Resolve the caller from the Authorization header. Returns null (→ 401) unless a
 * real credential resolves. `devOpen` yields a synthetic admin caller for local
 * development ONLY, and must never be set in production.
 */
export function resolveCaller(
  authorization: string | undefined,
  cfg: MeteringAuthConfig,
): Caller | null {
  const token = bearer(authorization);
  if (token && cfg.adminToken && timingSafeEqualStr(token, cfg.adminToken)) {
    return { orgId: "*", admin: true };
  }
  if (token) {
    const org = cfg.serviceAccounts.get(sha256(token));
    if (org) return { orgId: org, admin: false };
  }
  if (cfg.devOpen) return { orgId: "dev-org", admin: true };
  return null;
}

/** Constant-time-ish string compare to avoid trivial token timing oracles. */
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function ingest(caller: Caller | null, body: unknown, service: MeteringService): GatewayResult {
  if (!caller) return { status: 401, body: { error: "unauthorized" } };
  // Admin has no home org to book usage to; require a concrete tenant.
  if (caller.orgId === "*") return { status: 400, body: { error: "ingest requires a tenant service account, not an admin token" } };
  let records;
  try {
    // Server-derived orgId; content-field backstop enforced here.
    records = parseUsageRecords(body, caller.orgId);
  } catch (err) {
    if (err instanceof UsageValidationError) return { status: 400, body: { error: err.message } };
    throw err;
  }
  const ingested = service.ingest(records);
  return { status: 202, body: { ingested } };
}

export function summary(
  caller: Caller | null,
  requestedOrgId: string,
  service: MeteringService,
): GatewayResult {
  if (!caller) return { status: 401, body: { error: "unauthorized" } };
  if (!caller.admin && caller.orgId !== requestedOrgId) {
    return { status: 403, body: { error: "forbidden — you may only read your own organization" } };
  }
  return { status: 200, body: service.summary(requestedOrgId) };
}

/** Build the auth config from environment (used by the HTTP server). */
export function loadAuthConfig(env: NodeJS.ProcessEnv): MeteringAuthConfig {
  const serviceAccounts = new Map<string, string>();
  // BVSALA_SERVICE_ACCOUNTS: JSON { "<sha256(token) hex>": "orgId" }
  if (env["BVSALA_SERVICE_ACCOUNTS"]) {
    const parsed = JSON.parse(env["BVSALA_SERVICE_ACCOUNTS"]) as Record<string, string>;
    for (const [hash, org] of Object.entries(parsed)) serviceAccounts.set(hash.toLowerCase(), String(org));
  }
  // Convenience: a single INGEST_TOKEN bound to INGEST_ORG_ID.
  if (env["INGEST_TOKEN"] && env["INGEST_ORG_ID"]) {
    serviceAccounts.set(sha256(env["INGEST_TOKEN"]), env["INGEST_ORG_ID"]);
  }
  return {
    serviceAccounts,
    ...(env["ADMIN_TOKEN"] ? { adminToken: env["ADMIN_TOKEN"] } : {}),
    devOpen: env["BVSALA_DEV_OPEN"] === "1",
  };
}
