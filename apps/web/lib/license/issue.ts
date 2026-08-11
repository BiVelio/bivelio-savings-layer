import { randomUUID } from "node:crypto";

import type { AdminClient } from "@/lib/supabase/admin";
import { diasDeGracia } from "@/lib/billing/gracia";
import { loadPrivateKey, signCompact } from "./sign";

/**
 * Stripe-driven license issuance. Unlike the internal trial route (which only
 * signs a token), this MINTS the signed token AND persists it to
 * `bvsala.licenses`, so the revocation ledger and the dashboard have a real
 * backing row. The jti is a bare UUID so it fits `licenses.id` (uuid PK == jti).
 *
 * Signing is server-only (LICENSE_PRIVATE_KEY_B64); the SDK verifies offline.
 */
const LICENSE_HEADER = { alg: "EdDSA", typ: "BVL", v: 1 } as const;

/** Features unlocked by the paid PRO plan (subset of the SDK's Feature enum). */
export const PRO_FEATURES = [
  "semantic_cache",
  "learned_thresholds",
  "dashboards",
  "long_context_compression",
  "priority_support",
] as const;

export type Plan = "free" | "pro" | "team" | "enterprise";

export interface IssueInput {
  orgId: string;
  seats: number;
  /** Subscription current_period_end (unix seconds) — the token's hard expiry. */
  periodEndUnix: number;
  /** Extra days the SDK keeps working past expiry. */
  graceDays?: number;
  plan?: Plan;
  features?: readonly string[];
  /** bvsala.subscriptions.id (uuid) this license is billed by. */
  subscriptionId?: string | null;
  stripeInvoiceId?: string | null;
}

export interface IssuedLicense {
  jti: string;
  token: string;
  /** Unix seconds. */
  expiresAt: number;
}

/**
 * Mint + persist a license. Throws if the signing key is missing or the DB
 * insert fails (the webhook maps that to a 503 so Stripe retries).
 */
export async function issueLicense(
  admin: AdminClient,
  input: IssueInput,
): Promise<IssuedLicense> {
  const privateKey = loadPrivateKey();
  if (!privateKey) throw new Error("LICENSE_PRIVATE_KEY missing");

  const now = Math.floor(Date.now() / 1000);
  // La gracia sale de la constante única del producto, no de un literal. Estaba
  // escrita a mano aquí (14) y otra vez en `0001_init.sql`, sin derivarse de nada;
  // el número tiene que cubrir la ventana de reintentos de Stripe o apagamos a
  // clientes cuyo cobro todavía puede prosperar. Ver `lib/billing/gracia.ts`.
  const graceDays = input.graceDays ?? diasDeGracia();
  const plan: Plan = input.plan ?? "pro";
  const features = [...(input.features ?? PRO_FEATURES)];
  const jti = randomUUID(); // bare uuid == licenses.id
  const expiresAt = input.periodEndUnix;

  const payload = {
    jti,
    org_id: input.orgId,
    plan,
    seats: input.seats,
    features,
    issued_at: now,
    expires_at: expiresAt,
    grace_days: graceDays,
    iss: "bivelio-stripe",
  };
  const token = signCompact(LICENSE_HEADER, payload, privateKey);

  const { error } = await admin.from("licenses").insert({
    id: jti,
    org_id: input.orgId,
    plan,
    seats: input.seats,
    features,
    issued_at: new Date(now * 1000).toISOString(),
    expires_at: new Date(expiresAt * 1000).toISOString(),
    grace_days: graceDays,
    revoked: false,
    token,
    subscription_id: input.subscriptionId ?? null,
    stripe_invoice_id: input.stripeInvoiceId ?? null,
  });
  if (error) throw error;

  return { jti, token, expiresAt };
}

/**
 * The org's current (newest, non-revoked) license jti — used to supersede the
 * old license when re-issuing after a seat change / renewal.
 */
export async function currentLicenseJti(
  admin: AdminClient,
  orgId: string,
): Promise<string | null> {
  const { data } = await admin
    .from("licenses")
    .select("id")
    .eq("org_id", orgId)
    .eq("revoked", false)
    .order("issued_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { id?: string } | null)?.id ?? null;
}

/**
 * Revoke a license: mark the row + append to the append-only revocation ledger
 * the SDK polls (idempotent on jti). Never un-revokes — a re-issue always mints
 * a NEW jti.
 */
export async function revokeLicense(
  admin: AdminClient,
  jti: string,
  reason: string,
): Promise<void> {
  // Ledger FIRST — the SDK enforces the revocation ledger, not licenses.revoked.
  // If this throws, the license row stays revoked=false, so a retry re-selects it
  // (revokeAllLicenses filters on revoked=false) and re-ledgers it: fail-CLOSED and
  // self-healing. Only after the ledger is durable do we reflect it on the row.
  const { error } = await admin
    .from("revocations")
    .upsert({ jti, reason }, { onConflict: "jti", ignoreDuplicates: true });
  if (error) throw error;
  const { error: updErr } = await admin
    .from("licenses")
    .update({ revoked: true, superseded_at: new Date().toISOString() })
    .eq("id", jti);
  if (updErr) {
    // Enforcement is already correct (jti is in the ledger); this only affects the
    // dashboard's revoked flag. A later revoke/reconcile pass fixes the row.
    console.error("[license] revoke: ledgered but licenses.update failed for", jti, updErr);
  }
}

/** Mark a license superseded WITHOUT revoking it (seat increase → old token
 *  keeps working until pickup; we never brick a running fleet on a change). */
export async function supersedeLicense(admin: AdminClient, jti: string): Promise<void> {
  await admin
    .from("licenses")
    .update({ superseded_at: new Date().toISOString() })
    .eq("id", jti);
}

/** The org's current (newest, non-revoked) license — id + the seat count it was
 *  minted with. Used to decide whether a seat change actually needs a re-issue
 *  (comparing against the license, not a subscription row this handler may have
 *  already overwritten, so a retry after a failed issue still re-issues). */
export async function currentLicense(
  admin: AdminClient,
  orgId: string,
): Promise<{ jti: string; seats: number } | null> {
  const { data } = await admin
    .from("licenses")
    .select("id, seats")
    .eq("org_id", orgId)
    .eq("revoked", false)
    .order("issued_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const row = data as { id?: string; seats?: number } | null;
  return row?.id ? { jti: row.id, seats: row.seats ?? 0 } : null;
}

/**
 * Revoke EVERY non-revoked license for an org — used on cancellation, where no
 * live token may survive. Re-issues leave the superseded predecessor unrevoked
 * (so a running fleet keeps working mid-period), so an org can hold several
 * valid tokens; cancellation must ledger them all, not just the newest.
 */
export async function revokeAllLicenses(
  admin: AdminClient,
  orgId: string,
  reason: string,
): Promise<string[]> {
  const { data } = await admin.from("licenses").select("id").eq("org_id", orgId).eq("revoked", false);
  const ids = ((data as { id?: string }[] | null) ?? [])
    .map((r) => r.id)
    .filter((x): x is string => Boolean(x));
  for (const jti of ids) await revokeLicense(admin, jti, reason);
  return ids;
}
