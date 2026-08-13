import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolverOrgSiExiste } from "@/lib/org/resolver";
import { hashDeToken, sePuedeAceptar, type Invitacion } from "@/lib/org/invitaciones";
import { unirseAOrganizacion } from "@/lib/org/unirse";

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
    // CON QUÉ CUENTA ESTÁ MIRANDO. Solo cuando el motivo es `otro_correo`, y solo
    // su PROPIO correo: es el de la sesión que hace la petición, así que no
    // revela nada que quien pregunta no supiera.
    //
    // Sin este dato la pantalla decía «esta invitación es para otra dirección» y
    // se quedaba ahí: quien abre el enlace en el navegador donde ya tenía sesión
    // —que es el caso NORMAL, no el raro— no tiene forma de saber por qué le
    // rechaza ni con qué cuenta está entrando.
    return NextResponse.json(
      {
        error: "This invitation isn't valid.",
        code: veredicto.motivo,
        ...(veredicto.motivo === "otro_correo" ? { sesion: user.email ?? null } : {}),
      },
      { status },
    );
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

  // La escritura la hace el helper COMPARTIDO con `registrar`: son la misma
  // operación por dos puertas distintas (quien ya tiene cuenta y quien la acaba
  // de crear), y duplicarla es cómo se separan.
  const unido = await unirseAOrganizacion(admin, inv, user.id);
  if (!unido.ok) {
    console.error("[org/invitations/accept] no se pudo entrar:", unido.error);
    return NextResponse.json({ error: "Could not accept the invitation.", code: "error" }, { status: 503 });
  }

  return NextResponse.json({ ok: true, orgId: inv.org_id, role: inv.role });
}
