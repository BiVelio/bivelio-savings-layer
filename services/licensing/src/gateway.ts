/**
 * Auth for the licensing control-plane surface — fail-closed by construction.
 *
 * Issue/revoke are privileged. With an ADMIN_TOKEN configured, the caller must
 * present it. With NO admin token AND no explicit dev-open flag, the operation is
 * REFUSED (closed), never silently allowed — the opposite of the old
 * `if (!ADMIN_TOKEN) return true` posture. `devOpen` is a local-development
 * escape hatch that must never be set in production.
 *
 * NOTE: this gates the CP-0 admin surface. Production license issuance must be
 * driven by signature-verified Stripe events + an org-owner check (see the
 * public-launch plan, Phase 1/2), not by a shared admin bearer.
 */
export interface LicensingAuthConfig {
  adminToken?: string;
  devOpen?: boolean;
}

function bearer(authorization: string | undefined): string | null {
  if (!authorization || !authorization.startsWith("Bearer ")) return null;
  const t = authorization.slice(7).trim();
  return t.length > 0 ? t : null;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** True only when the caller is genuinely authorized. Fail-closed. */
export function authorizeAdmin(
  authorization: string | undefined,
  cfg: LicensingAuthConfig,
): boolean {
  if (cfg.adminToken) {
    const tok = bearer(authorization);
    return tok !== null && timingSafeEqualStr(tok, cfg.adminToken);
  }
  // No admin token configured: allow ONLY in explicit dev-open mode.
  return cfg.devOpen === true;
}

export function loadAuthConfig(env: NodeJS.ProcessEnv): LicensingAuthConfig {
  return {
    ...(env["ADMIN_TOKEN"] ? { adminToken: env["ADMIN_TOKEN"] } : {}),
    devOpen: env["BVSALA_DEV_OPEN"] === "1",
  };
}
