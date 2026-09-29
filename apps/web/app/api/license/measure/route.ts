import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient, type AdminClient } from "@/lib/supabase/admin";
import { resolverOrgDelUsuario } from "@/lib/org/resolver";
import { puede, NO_AUTORIZADO } from "@/lib/org/permisos";
import { hasActiveSubscription, hasValidLicense, type LicenseRow, type SubscriptionRow } from "@/lib/metering/entitlement";
import {
  dominioDelCorreo,
  emitirLicenciaMedir,
  esCorreoDesechable,
  LIMITES_MEDIR,
  medirViva,
  PLAN_MEDIR,
} from "@/lib/license/medir";
import { alertar } from "@/lib/observabilidad/alerta";

/**
 * POST /api/license/measure — EL ALTA SIN TARJETA de la licencia «Medir».
 *
 * alta (cuenta verificada) → organización (la del usuario, creada si no tiene)
 * → licencia Medir firmada, persistida y devuelta. Sin Stripe, sin checkout.
 *
 * Los candados anti-abuso, en este orden:
 *  1. SESIÓN y CORREO VERIFICADO (`email_confirmed_at`): una cuenta sin
 *     verificar no reclama nada (402 no, 403: no es cuestión de pagar). Y un
 *     correo DESECHABLE tampoco (403 `disposable_email`): la lista pública
 *     incrustada en lib/license/dominios-desechables.ts, dominio y padres.
 *  2. EL ROL: reclamar entrega la credencial, así que exige lo mismo que
 *     descargarla (`descargar_licencia`).
 *  3. UNA ORGANIZACIÓN POR CUENTA: `bvsala.medir_altas` tiene al usuario como
 *     clave primaria. La cuenta que ya reclamó Medir para OTRA organización
 *     recibe 409 `one_org_per_account`.
 *  4. UNA MEDIR POR ORGANIZACIÓN: el índice único de 0033 sobre `licenses`
 *     (plan measure, no revocada). Reclamar dos veces devuelve la misma.
 *  5. LA ORGANIZACIÓN QUE YA PAGA no recibe una Medir: su licencia está en
 *     /api/license/current (409 `already_licensed`).
 *  6. EL BLOQUEO DEL OPERADOR: una fila de `medir_altas` con `bloqueada` (abuso
 *     detectado) no se reactiva nunca desde aquí (403 `measure_blocked`).
 *
 * Los códigos se devuelven SIN texto: el panel los traduce a los 12 idiomas.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SIN_CACHE = { "Cache-Control": "no-store" } as const;
const json = (cuerpo: unknown, status: number) => NextResponse.json(cuerpo, { status, headers: SIN_CACHE });

interface FilaDeAlta {
  user_id: string;
  org_id: string;
  bloqueada?: boolean | null;
}

async function licenciasYSuscripciones(
  admin: AdminClient,
  orgId: string,
): Promise<{ licencias: LicenseRow[]; subs: SubscriptionRow[] }> {
  const [{ data: lic, error: licErr }, { data: subs, error: subErr }] = await Promise.all([
    admin.from("licenses").select("revoked, expires_at, grace_days, plan").eq("org_id", orgId),
    admin.from("subscriptions").select("status, current_period_end").eq("org_id", orgId),
  ]);
  if (licErr) throw licErr;
  if (subErr) throw subErr;
  return { licencias: (lic ?? []) as LicenseRow[], subs: (subs ?? []) as SubscriptionRow[] };
}

function entrega(l: { token: string; expiresAt: number }) {
  return json(
    {
      token: l.token,
      plan: PLAN_MEDIR,
      seats: LIMITES_MEDIR.asientos,
      expiresAt: new Date(l.expiresAt * 1000).toISOString(),
    },
    200,
  );
}

export async function POST(): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return json({ error: "Sign in first.", code: "sign_in" }, 401);
  if (!(user as { email_confirmed_at?: string | null }).email_confirmed_at) {
    return json({ code: "email_not_verified" }, 403);
  }
  // 1b · CORREO DESECHABLE: la cuenta verificada con un buzón de usar y tirar es
  // la granja de cuentas más barata. Antes de tocar la base: no deja rastro.
  if (esCorreoDesechable(user.email)) return json({ code: "disposable_email" }, 403);

  let admin: AdminClient;
  try {
    admin = createAdminClient();
  } catch {
    return json({ error: "License service isn't configured." }, 501);
  }

  try {
    // 3 · la cuenta que ya reclamó Medir para OTRA organización.
    const { data: alta, error: altaErr } = await admin
      .from("medir_altas")
      .select("user_id, org_id, bloqueada")
      .eq("user_id", user.id)
      .maybeSingle();
    if (altaErr) throw altaErr;

    const org = await resolverOrgDelUsuario(admin, user.id);
    if (!puede(org.role, "descargar_licencia")) return json({ error: NO_AUTORIZADO, code: "role" }, 403);

    const miAlta = alta as FilaDeAlta | null;
    if (miAlta && miAlta.org_id !== org.orgId) return json({ code: "one_org_per_account" }, 409);

    // 6 · el bloqueo del operador sobre ESTA organización (la haya reclamado quien sea).
    const { data: altaDeLaOrg, error: orgAltaErr } = await admin
      .from("medir_altas")
      .select("user_id, org_id, bloqueada")
      .eq("org_id", org.orgId)
      .maybeSingle();
    if (orgAltaErr) throw orgAltaErr;
    if ((altaDeLaOrg as FilaDeAlta | null)?.bloqueada === true) return json({ code: "measure_blocked" }, 403);

    // 5 · la organización que ya paga tiene su licencia en /api/license/current.
    const ahora = Date.now();
    const { licencias, subs } = await licenciasYSuscripciones(admin, org.orgId);
    if (hasValidLicense(licencias, ahora) || hasActiveSubscription(subs, ahora)) {
      return json({ code: "already_licensed" }, 409);
    }

    // 4 · idempotente: la Medir viva de esta organización, si ya la tiene.
    const viva = await medirViva(admin, org.orgId);
    if (viva && viva.expiresAt * 1000 > ahora) return entrega(viva);

    // El alta, ANTES de firmar: si la fila no se puede escribir, no hay licencia.
    if (!altaDeLaOrg) {
      const { error: insErr } = await admin.from("medir_altas").insert({
        user_id: user.id,
        org_id: org.orgId,
        email_dominio: dominioDelCorreo(user.email),
      });
      if (insErr) {
        // 23505: la cuenta u otra pestaña ganó la carrera. Si fue por el usuario
        // con otra organización, el paso 3 lo dirá en el siguiente intento.
        if ((insErr as { code?: string }).code !== "23505") throw insErr;
      }
    }

    return entrega(await emitirLicenciaMedir(admin, org.orgId, ahora));
  } catch (err) {
    console.error("[license/measure] alta Medir falló:", err);
    await alertar({
      nivel: "aviso",
      asunto: "No se pudo emitir una licencia Medir (alta sin tarjeta)",
      detalle: { motivo: err instanceof Error ? err.message : String(err) },
    });
    return json({ error: "Could not issue the Measure license." }, 503);
  }
}
