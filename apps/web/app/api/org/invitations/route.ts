import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { contextoDeLaOrg } from "@/lib/org/guardia";
import {
  acunarToken,
  esRolInvitable,
  normalizarCorreo,
  enlaceDeInvitacion,
  DIAS_DE_VIGENCIA,
} from "@/lib/org/invitaciones";
import { enviarInvitacion, idiomaValido } from "@/lib/correo/invitacion";

/**
 * INVITAR A ALGUIEN. Crear la invitación, mandarle el correo, listarlas y
 * revocarlas.
 *
 * EL CORREO SALE SOLO. Era la condición: nada de generar un enlace para que
 * alguien lo copie y lo pegue en su cliente de correo. La cuenta de Resend y el
 * dominio verificado ya existían para las alertas internas, así que no hay
 * infraestructura nueva — solo un remitente distinto y doce plantillas.
 *
 * ⚠️ INVITAR NO CONSUME ASIENTO. Un asiento es una MÁQUINA (`deriveSeatId` es un
 * HMAC de la huella del equipo), no una persona. Diez compañeros con un portátil
 * cada uno son diez asientos porque son diez máquinas, no porque sean diez
 * personas; y una sola persona con tres equipos son tres. Esta ruta no toca la
 * facturación, y no debe empezar a hacerlo por descuido.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function sesion() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

/** GET — las invitaciones VIVAS. Nunca el token ni su hash. */
export async function GET(): Promise<NextResponse> {
  const user = await sesion();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const admin = createAdminClient();
  const g = await contextoDeLaOrg(admin, user.id, "gestionar_miembros");
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });

  const { data, error } = await admin
    .from("org_invitations")
    // `token_hash` NO se selecciona. No sirve para nada en el panel y todo lo que
    // no se pide no se puede filtrar por accidente en una respuesta.
    .select("id, email, role, expires_at, created_at")
    .eq("org_id", g.orgId)
    .is("accepted_at", null)
    .order("created_at", { ascending: false });
  if (error) {
    console.error("[org/invitations] listado falló:", error);
    return NextResponse.json({ error: "Could not list invitations." }, { status: 503 });
  }

  const ahora = Date.now();
  const invitaciones = ((data ?? []) as { id: string; email: string; role: string; expires_at: string; created_at: string }[]).map(
    (i) => ({ ...i, caducada: Date.parse(i.expires_at) <= ahora }),
  );
  return NextResponse.json({ invitaciones, dias: DIAS_DE_VIGENCIA });
}

/** POST — invitar. Reinvitar a la misma dirección REEMPLAZA la invitación viva. */
export async function POST(req: Request): Promise<NextResponse> {
  const user = await sesion();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  let body: { email?: string; role?: string; locale?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* cuerpo vacío */
  }
  const email = normalizarCorreo(body.email);
  // Validación deliberadamente simple: hay una dirección real al otro lado que o
  // recibe el correo o no. Una expresión regular "completa" para RFC 5322 rechaza
  // direcciones válidas y no acepta ninguna que ésta deje pasar y sea peligrosa.
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return NextResponse.json({ error: "That doesn't look like an email address." }, { status: 400 });
  }
  if (!esRolInvitable(body.role)) {
    return NextResponse.json({ error: "Role must be admin, member or billing." }, { status: 400 });
  }

  const admin = createAdminClient();
  const g = await contextoDeLaOrg(admin, user.id, "gestionar_miembros");
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });

  // ¿YA ESTÁ DENTRO? Se comprueba antes de mandar nada. Invitar a quien ya es
  // miembro genera un correo que al aceptarse no hace nada y deja a quien invita
  // creyendo que ha cambiado algo.
  if (email === normalizarCorreo(user.email)) {
    return NextResponse.json({ error: "That's you — you're already in." }, { status: 409 });
  }

  // …y el resto del equipo, no solo quien invita. El correo de un miembro vive
  // en auth, no en org_members, así que se resuelve como en GET /api/org/members:
  // una consulta por miembro — una organización es tamaño equipo, no multitud.
  // Un correo ilegible NO bloquea: fallar hacia «se pudo invitar» cuesta un
  // correo redundante; fallar hacia 503 pararía invitaciones legítimas.
  const { data: equipo, error: equipoErr } = await admin
    .from("org_members")
    .select("user_id")
    .eq("org_id", g.orgId);
  if (equipoErr) {
    console.error("[org/invitations] no se pudo leer el equipo:", equipoErr);
    return NextResponse.json({ error: "Could not create the invitation." }, { status: 503 });
  }
  for (const fila of (equipo ?? []) as { user_id: string }[]) {
    let suyo: string | null = null;
    try {
      const { data: u } = await admin.auth.admin.getUserById(fila.user_id);
      suyo = normalizarCorreo(u?.user?.email);
    } catch {
      /* ilegible → ver arriba */
    }
    if (suyo && suyo === email) {
      return NextResponse.json({ error: "Already a member of this organization." }, { status: 409 });
    }
  }

  const nuevo = acunarToken();

  // Una invitación viva por dirección (índice único parcial de 0013). Reinvitar
  // tiene que FUNCIONAR —es lo que hace cualquiera cuando el correo se pierde— así
  // que se borra la viva anterior y se crea otra. El token viejo deja de valer,
  // que es justo lo que se espera de "volver a invitar".
  const { error: limpiarErr } = await admin
    .from("org_invitations")
    .delete()
    .eq("org_id", g.orgId)
    .eq("email", email)
    .is("accepted_at", null);
  if (limpiarErr) {
    console.error("[org/invitations] no se pudo reemplazar la invitación previa:", limpiarErr);
    return NextResponse.json({ error: "Could not create the invitation." }, { status: 503 });
  }

  const { data: creada, error } = await admin
    .from("org_invitations")
    .insert({
      org_id: g.orgId,
      email,
      role: body.role,
      token_hash: nuevo.hash,
      invited_by: user.id,
      expires_at: nuevo.expiraEn,
    })
    .select("id, email, role, expires_at, created_at")
    .single();
  if (error) {
    console.error("[org/invitations] alta falló:", error);
    return NextResponse.json({ error: "Could not create the invitation." }, { status: 503 });
  }

  // El nombre de la organización, para que el correo diga a QUÉ te invitan.
  const { data: org } = await admin
    .from("organizations")
    .select("name")
    .eq("id", g.orgId)
    .maybeSingle();

  const idioma = idiomaValido(typeof body.locale === "string" ? body.locale : null);
  const envio = await enviarInvitacion(
    {
      org: (org as { name?: string } | null)?.name || "BiVelio",
      quienInvita: user.email ?? "BiVelio",
      rol: body.role,
      enlace: enlaceDeInvitacion(new URL(req.url).origin, idioma, nuevo.token),
      dias: DIAS_DE_VIGENCIA,
      idioma,
    },
    email,
  );

  // LA INVITACIÓN QUEDA CREADA AUNQUE EL CORREO NO SALGA, y se dice. Deshacerla
  // sería peor: quien invita reintentaría, y cada reintento con el correo caído
  // dejaría rastro de una invitación que se creó y se borró. Se devuelve
  // `enviado:false` para que la interfaz ofrezca reenviar.
  if (!envio.ok) {
    console.error("[org/invitations] el correo no salió:", envio.motivo);
  }

  return NextResponse.json({ invitacion: creada, enviado: envio.ok }, { status: 201 });
}

/** DELETE — revocar una invitación pendiente. */
export async function DELETE(req: Request): Promise<NextResponse> {
  const user = await sesion();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  let body: { id?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* cuerpo vacío */
  }
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) return NextResponse.json({ error: "Which invitation?" }, { status: 400 });

  const admin = createAdminClient();
  const g = await contextoDeLaOrg(admin, user.id, "gestionar_miembros");
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });

  // El `.eq("org_id", …)` es lo único que impide revocar la invitación de otra
  // empresa con un id adivinado, igual que en el DELETE de claves de servicio.
  const { data, error } = await admin
    .from("org_invitations")
    .delete()
    .eq("id", id)
    .eq("org_id", g.orgId)
    .is("accepted_at", null)
    .select("id");
  if (error) {
    console.error("[org/invitations] revocación falló:", error);
    return NextResponse.json({ error: "Could not revoke the invitation." }, { status: 503 });
  }
  if (((data ?? []) as unknown[]).length === 0) {
    return NextResponse.json({ error: "No such invitation." }, { status: 404 });
  }

  return NextResponse.json({ ok: true, id });
}
