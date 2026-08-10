import { createHash } from "node:crypto";
import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient, type AdminClient } from "@/lib/supabase/admin";

/**
 * GET /api/license/current — devuelve al dueño de la organización el token de su
 * licencia PRO vigente.
 *
 * POR QUÉ EXISTE: el webhook de Stripe emitía la licencia, la persistía en
 * `bvsala.licenses` y **descartaba el token**. Nadie podía recuperarlo: la
 * migración 0007 saca `licenses.token` del `grant select` de `authenticated` (con
 * razón — es una credencial reutilizable en otra máquina), el panel solo pedía
 * columnas de estado, no hay envío de correo, y `/api/license/trial` responde 402
 * salvo a la allow-list y además emite una licencia DISTINTA. Como el SDK es
 * fail-closed, el cliente pagaba y su primera llamada moría con
 * `LicenseError: No BiVelio license configured`.
 *
 * Esta ruta es la entrega que faltaba, y NO reabre lo que 0007 cerró: la columna
 * sigue fuera del alcance del rol de usuario; se lee con el cliente admin
 * (service_role) detrás de una comprobación de sesión y de pertenencia, y solo se
 * devuelve la licencia de la propia organización de quien pregunta.
 *
 * Es repetible a propósito: perder el token no puede dejar sin producto a alguien
 * que paga. Como es una credencial, la respuesta va con `no-store`.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `no-store` en TODAS las respuestas, no solo en la que lleva el token. Ninguna
 *  de las de error contiene credencial, pero un endpoint de credencial no debería
 *  tener ni una respuesta cacheable: así no depende de qué rama se tomó. */
const SIN_CACHE = { "Cache-Control": "no-store" } as const;

const json = (cuerpo: unknown, status: number) =>
  NextResponse.json(cuerpo, { status, headers: SIN_CACHE });

interface LicenseRow {
  id: string;
  org_id: string;
  plan: string;
  seats: number;
  token: string | null;
  expires_at: string;
  grace_days: number;
}

/** La vigente = la más nueva sin revocar, servida con la forma pública de la
 *  ruta. `issued_at` se guarda truncado a segundos, así que dos emisiones del
 *  mismo segundo empatarían; se desempata por `created_at` (microsegundos). */
async function entregarLicencia(admin: AdminClient, orgIds: string[]): Promise<NextResponse> {
  const { data, error } = await admin
    .from("licenses")
    .select("id, org_id, plan, seats, token, expires_at, grace_days")
    .in("org_id", orgIds)
    .eq("revoked", false)
    .order("issued_at", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[license/current] lookup failed:", error);
    return json({ error: "Could not read your license." }, 503);
  }

  const lic = data as LicenseRow | null;
  if (!lic?.token) {
    // 404 y no 402: aquí no se juzga si puede comprar, solo si hay algo que
    // entregar. Quien no tenga licencia pasa por el checkout.
    return json({ error: "No active license for this account." }, 404);
  }

  return json(
    {
      token: lic.token,
      jti: lic.id,
      plan: lic.plan,
      seats: lic.seats,
      expiresAt: lic.expires_at,
      graceDays: lic.grace_days,
    },
    200,
  );
}

/**
 * Vía MÁQUINA: `Authorization: Bearer bvk_…` — la renovación mensual sin
 * humanos. `invoice.paid` emite un token nuevo, pero la entrega era solo de
 * sesión: una máquina en producción con su `licenseKey` estático no podía
 * recoger el renovado y se apagaba fail-closed hacia el día ~45 de cada ciclo,
 * PAGANDO. La clave de servicio ya es la credencial de la org (autentica el
 * ingest de metering, con acceso a `usage_daily` de la org); recoger el token
 * de SU PROPIA org no le concede nada de otro alcance. Misma autenticación que
 * /api/metering/usage: hash → `service_accounts` → org derivada en el servidor.
 */
async function entregarAServiceAccount(clave: string): Promise<NextResponse> {
  let admin: AdminClient;
  try {
    admin = createAdminClient();
  } catch {
    return json({ error: "License service isn't configured." }, 501);
  }
  const keyHash = createHash("sha256").update(clave).digest("hex");
  const { data: sa, error: saErr } = await admin
    .from("service_accounts")
    .select("org_id")
    .eq("key_hash", keyHash)
    .maybeSingle();
  if (saErr) {
    console.error("[license/current] service-account lookup failed:", saErr);
    return json({ error: "Could not read your license." }, 503);
  }
  if (!sa?.org_id) return json({ error: "unauthorized" }, 401);
  return entregarLicencia(admin, [sa.org_id as string]);
}

export async function GET(req: Request): Promise<NextResponse> {
  const auth = req.headers.get("authorization") ?? "";
  const portador = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (portador.startsWith("bvk_")) return entregarAServiceAccount(portador);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return json({ error: "Sign in first." }, 401);

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return json({ error: "License service isn't configured." }, 501);
  }

  // Organizaciones a las que pertenece de verdad. Se añade `user.id` porque la
  // convención CP-0 es org_id == id del usuario y es lo que el checkout mete en
  // los metadatos; sin él, una cuenta cuya fila de pertenencia aún no exista se
  // quedaría sin su propia licencia.
  const orgIds = new Set<string>([user.id]);
  const { data: miembro } = await admin.from("org_members").select("org_id").eq("user_id", user.id);
  for (const fila of (miembro as { org_id?: string }[] | null) ?? []) {
    if (fila.org_id) orgIds.add(fila.org_id);
  }

  return entregarLicencia(admin, [...orgIds]);
}
