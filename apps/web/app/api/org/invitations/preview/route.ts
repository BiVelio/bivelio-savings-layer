import { NextResponse } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import { hashDeToken, sePuedeAceptar, type Invitacion } from "@/lib/org/invitaciones";

/**
 * QUÉ DICE ESTA INVITACIÓN, ANTES DE ACEPTARLA.
 *
 * La pantalla necesita poder decir «te han invitado a **Acme** como **miembro**»
 * en vez de un genérico «te han invitado a una organización». Sin eso, a quien no
 * conoce BiVelio le llega un enlace de un remitente desconocido que le pide una
 * contraseña sin contarle a qué — que es exactamente la forma de un correo de
 * phishing, y la razón por la que no lo pincharía.
 *
 * QUÉ DEVUELVE Y QUÉ NO. Devuelve el correo invitado, el nombre de la
 * organización y el rol: nada que quien tiene el enlace no supiera ya, porque el
 * enlace se le mandó a ESA dirección y el correo llevaba esos mismos datos.
 *
 * NO dice si esa dirección tiene ya cuenta en BiVelio. Ese dato no hace falta —la
 * pantalla ofrece las dos salidas— y responderlo convertiría cualquier invitación
 * caducada en un oráculo para saber quién está registrado.
 *
 * Es POST y no GET a propósito: los antivirus de correo y los «link scanners»
 * corporativos precargan los enlaces, y aunque esto no consuma la invitación,
 * mantener toda la superficie del token fuera de los GET evita tener que razonar
 * cada vez sobre cuál de ellos sí tiene efectos.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  let body: { token?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* cuerpo vacío */
  }
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) return NextResponse.json({ code: "invalida" }, { status: 400 });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("org_invitations")
    .select("id, org_id, email, role, expires_at, accepted_at")
    .eq("token_hash", hashDeToken(token))
    .maybeSingle();
  if (error) {
    console.error("[org/preview] lectura falló:", error);
    return NextResponse.json({ code: "error" }, { status: 503 });
  }

  const inv = data as Invitacion | null;
  const veredicto = sePuedeAceptar(inv, inv?.email);
  if (!veredicto.ok) {
    return NextResponse.json({ code: veredicto.motivo }, { status: veredicto.motivo === "invalida" ? 404 : 410 });
  }

  const { data: org } = await admin
    .from("organizations")
    .select("name")
    .eq("id", inv!.org_id)
    .maybeSingle();

  return NextResponse.json({
    ok: true,
    email: inv!.email,
    role: inv!.role,
    org: (org as { name?: string } | null)?.name || "BiVelio",
  });
}
