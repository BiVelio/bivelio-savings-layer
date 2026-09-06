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

/**
 * Features unlocked by the paid PRO plan (subset of the SDK's Feature enum).
 *
 * `context_elision` NACIÓ FUERA de esta lista a propósito: en S4a era el dial
 * del gateway recién montado y solo el anillo interno (la allow-list del trial)
 * lo llevaba. La consecuencia era una trampa silenciosa — el canal de
 * entitlements es FAIL-CLOSED, así que el cliente que PAGA veía la palanca
 * apagada sin un solo error en ningún log: `tiene("context_elision")` devolvía
 * false y el gateway reenviaba el cuerpo intacto. Aquí se cierra: la palanca de
 * elisión es producto de pago y entra en el plan PRO.
 *
 * Ojo al carril: el gateway NO lee el token firmado, lee la fila —
 * `/api/org/entitlements` sirve `licenses.features` en vivo. Añadir el literal
 * aquí solo cubre las licencias NUEVAS; las ya emitidas llevan el array viejo
 * congelado en su columna y necesitan el relleno de `0023_features_pro_palancas.sql`.
 */
export const PRO_FEATURES = [
  "semantic_cache",
  "learned_thresholds",
  "dashboards",
  "long_context_compression",
  "context_elision",
  "cache_ttl_tuning",
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
  if (error) {
    // EL CANDADO DE 0018 (única viva por org+caducidad+asientos) convierte la
    // carrera de webhooks —varios manejadores emitiendo la primera licencia a
    // la vez— en un conflicto de unicidad. El perdedor NO falla: devuelve la
    // licencia que ganó, que otorga exactamente lo mismo. Así la emisión es
    // idempotente y el reintento de Stripe tras un 5xx tampoco duplica.
    if ((error as { code?: string }).code === "23505") {
      const existente = await licenciaViva(admin, input.orgId, expiresAt, input.seats);
      if (existente) return existente;
    }
    throw error;
  }

  return { jti, token, expiresAt };
}

/** La licencia viva que ya cubre (org, caducidad, asientos) — la que ganó la carrera. */
async function licenciaViva(
  admin: AdminClient,
  orgId: string,
  expiresAtUnix: number,
  seats: number,
): Promise<IssuedLicense | null> {
  const { data } = await admin
    .from("licenses")
    .select("id, token")
    .eq("org_id", orgId)
    .eq("expires_at", new Date(expiresAtUnix * 1000).toISOString())
    .eq("seats", seats)
    .eq("revoked", false)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const fila = data as { id?: string; token?: string } | null;
  if (!fila?.id || !fila.token) return null;
  return { jti: fila.id, token: fila.token, expiresAt: expiresAtUnix };
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
  // LA COLUMNA NO ES SOLO COSMÉTICA, y por eso su fallo NO se traga. El SDK del
  // cliente se para por el LEDGER (ya escrito arriba), sí; pero los DOS candados
  // de SERVIDOR leen esta columna, no el ledger: `/api/license/current` filtra
  // `.eq("revoked", false)` (re-entregaría la credencial revocada) y la ingesta
  // de metering la lee para bloquear (`decideEntitlement`). Si el UPDATE falla y
  // se traga, el operador recibe un 200 mientras el servidor SIGUE sirviendo, y
  // no hay ningún pase que sane la fila. Se reintenta y, si persiste, se LANZA:
  // la ruta manual devuelve 500 (el operador reintenta) y el webhook 5xx (Stripe
  // reintenta). El ledger es idempotente, así que reintentar todo es inocuo.
  let updErr: unknown = null;
  for (let intento = 0; intento < 3; intento++) {
    const { error } = await admin
      .from("licenses")
      .update({ revoked: true, superseded_at: new Date().toISOString() })
      .eq("id", jti);
    if (!error) return;
    updErr = error;
  }
  console.error("[license] revoke: ledgered pero licenses.update falló tras reintentos para", jti, updErr);
  throw new Error(`revoke: no se pudo marcar revoked=true en la fila ${jti}`);
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
): Promise<{ jti: string; seats: number; expiresAt: string | null } | null> {
  const { data } = await admin
    // `expires_at` NO se leía, y por eso el webhook no podía comparar la
    // caducidad de la licencia contra el periodo de la suscripción: solo sabía
    // mirar los asientos. Ver la condición de re-emisión en el webhook.
    .from("licenses")
    .select("id, seats, expires_at")
    .eq("org_id", orgId)
    .eq("revoked", false)
    .order("issued_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const row = data as { id?: string; seats?: number; expires_at?: string | null } | null;
  return row?.id ? { jti: row.id, seats: row.seats ?? 0, expiresAt: row.expires_at ?? null } : null;
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
