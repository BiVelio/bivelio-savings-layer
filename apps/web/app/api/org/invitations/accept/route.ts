import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolverOrgSiExiste } from "@/lib/org/resolver";
import { hashDeToken, sePuedeAceptar, type Invitacion } from "@/lib/org/invitaciones";

/**
 * ACEPTAR UNA INVITACIÓN. La única ruta de este producto en la que alguien de
 * fuera entra en la organización de un cliente, así que es la que más despacio hay
 * que leer.
 *
 * DOS LLAVES, NO UNA. El token demuestra que tienes el enlace; el correo de la
 * sesión demuestra que eres el destinatario. Con solo la primera, un enlace
 * reenviado por error —a una lista de distribución, a un compañero, a quien
 * pregunta «¿me lo pasas?»— mete en la organización a quien lo pille primero, y
 * según el rol se lleva la licencia firmada de la empresa.
 *
 * Los errores se responden con un mensaje GENÉRICO y el motivo en un código
 * aparte. No se dice «esa invitación es de otra persona» ante un token inventado:
 * eso convertiría la ruta en un oráculo para averiguar qué direcciones tienen
 * invitación pendiente.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in first.", code: "sin_sesion" }, { status: 401 });

  let body: { token?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* cuerpo vacío */
  }
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) return NextResponse.json({ error: "Invalid invitation.", code: "invalida" }, { status: 400 });

  const admin = createAdminClient();

  const { data, error } = await admin
    .from("org_invitations")
    .select("id, org_id, email, role, expires_at, accepted_at")
    .eq("token_hash", hashDeToken(token))
    .maybeSingle();
  if (error) {
    console.error("[org/invitations/accept] lectura falló:", error);
    return NextResponse.json({ error: "Could not accept the invitation.", code: "error" }, { status: 503 });
  }

  const veredicto = sePuedeAceptar(data as Invitacion | null, user.email);
  if (!veredicto.ok) {
    // 410 para lo que existió y ya no sirve; 404 para lo que nunca existió.
    const status = veredicto.motivo === "invalida" ? 404 : 410;
    return NextResponse.json({ error: "This invitation isn't valid.", code: veredicto.motivo }, { status });
  }
  const inv = data as Invitacion;

  // ¿YA ESTÁ EN OTRA ORGANIZACIÓN? Se bloquea, y es una decisión, no una
  // limitación olvidada. Pertenecer a varias es la fase 9 (hace falta un selector
  // en el panel); sin él, aceptar una segunda invitación NO enseñaría la
  // organización nueva —el resolvedor prefiere la que paga— y quien acepta se
  // quedaría mirando un panel que no ha cambiado, sin saber por qué. Un 409 que
  // explica el motivo es mejor que un éxito que no hace nada visible.
  let yaTiene;
  try {
    yaTiene = await resolverOrgSiExiste(admin, user.id);
  } catch (err) {
    console.error("[org/invitations/accept] no se pudo comprobar la pertenencia:", err);
    return NextResponse.json({ error: "Could not accept the invitation.", code: "error" }, { status: 503 });
  }
  if (yaTiene && yaTiene.orgId !== inv.org_id) {
    return NextResponse.json(
      {
        error: "You already belong to another organization. Ask to be removed from it first, or use a different account.",
        code: "ya_en_otra",
      },
      { status: 409 },
    );
  }
  if (yaTiene && yaTiene.orgId === inv.org_id) {
    // Ya estaba dentro: se marca la invitación como consumida y se responde bien.
    // Reintentar el mismo enlace (doble clic, recarga) no puede dar error.
    await admin
      .from("org_invitations")
      .update({ accepted_at: new Date().toISOString() })
      .eq("id", inv.id)
      .is("accepted_at", null);
    return NextResponse.json({ ok: true, orgId: inv.org_id, role: yaTiene.role, yaEstaba: true });
  }

  // LA PERTENENCIA PRIMERO, LA MARCA DESPUÉS, y ese orden importa. Al revés, si el
  // alta de la pertenencia fallara después de marcar la invitación como aceptada,
  // el enlace quedaría quemado y la persona FUERA, sin forma de reintentar. Así, el
  // peor caso es que la invitación siga viva para alguien que ya está dentro — que
  // se resuelve solo en el reintento, por la rama de arriba.
  const { error: altaErr } = await admin
    .from("org_members")
    .upsert(
      { org_id: inv.org_id, user_id: user.id, role: inv.role },
      { onConflict: "org_id,user_id", ignoreDuplicates: true },
    );
  if (altaErr) {
    console.error("[org/invitations/accept] alta de pertenencia falló:", altaErr);
    return NextResponse.json({ error: "Could not accept the invitation.", code: "error" }, { status: 503 });
  }

  // `.is("accepted_at", null)` hace la marca de un solo uso: dos peticiones
  // simultáneas con el mismo enlace, solo una escribe.
  const { error: marcaErr } = await admin
    .from("org_invitations")
    .update({ accepted_at: new Date().toISOString() })
    .eq("id", inv.id)
    .is("accepted_at", null);
  if (marcaErr) {
    // La persona YA está dentro; no se le devuelve un error por no haber podido
    // anotar. La invitación caduca sola en su fecha.
    console.error("[org/invitations/accept] no se pudo marcar como aceptada:", marcaErr);
  }

  await admin.from("billing_audit").insert({
    org_id: inv.org_id,
    event_id: `invitacion_${inv.id}`,
    kind: "org_member_joined",
    detail: { userId: user.id, role: inv.role, invitacion: inv.id },
  });

  return NextResponse.json({ ok: true, orgId: inv.org_id, role: inv.role });
}
