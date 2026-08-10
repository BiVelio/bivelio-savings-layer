import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

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

interface LicenseRow {
  id: string;
  org_id: string;
  plan: string;
  seats: number;
  token: string | null;
  expires_at: string;
  grace_days: number;
}

export async function GET(): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json({ error: "License service isn't configured." }, { status: 501 });
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

  // La vigente = la más nueva sin revocar. `issued_at` se guarda truncado a
  // segundos, así que dos emisiones del mismo segundo empatarían; se desempata
  // por `created_at`, que tiene resolución de microsegundos.
  const { data, error } = await admin
    .from("licenses")
    .select("id, org_id, plan, seats, token, expires_at, grace_days")
    .in("org_id", [...orgIds])
    .eq("revoked", false)
    .order("issued_at", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[license/current] lookup failed:", error);
    return NextResponse.json({ error: "Could not read your license." }, { status: 503 });
  }

  const lic = data as LicenseRow | null;
  if (!lic?.token) {
    // 404 y no 402: aquí no se juzga si puede comprar, solo si hay algo que
    // entregar. Quien no tenga licencia pasa por el checkout.
    return NextResponse.json({ error: "No active license for this account." }, { status: 404 });
  }

  return NextResponse.json(
    {
      token: lic.token,
      jti: lic.id,
      plan: lic.plan,
      seats: lic.seats,
      expiresAt: lic.expires_at,
      graceDays: lic.grace_days,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
