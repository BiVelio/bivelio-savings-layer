import { NextResponse } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import { hashDeToken, sePuedeAceptar, normalizarCorreo, type Invitacion } from "@/lib/org/invitaciones";
import { unirseAOrganizacion } from "@/lib/org/unirse";

/**
 * CREAR LA CUENTA DESDE UNA INVITACIÓN.
 *
 * EL AGUJERO QUE CIERRA. A quien se invita normalmente NO tiene cuenta en
 * BiVelio: es un compañero de la empresa del cliente. El enlace del correo le
 * llevaba a una pantalla que le pedía iniciar sesión, y ahí se acababa el camino
 * — no tiene contraseña, y «he olvidado mi contraseña» no le sirve porque su
 * dirección no está en la base. La invitación llegaba, se veía bien, y no se
 * podía aceptar. El producto entero de equipos quedaba inservible.
 *
 * ⚠️ EL CORREO SALE DE LA INVITACIÓN, NUNCA DEL CUERPO DE LA PETICIÓN. Es la
 * línea que sostiene toda la seguridad de esta ruta: si se aceptara un correo del
 * cliente, cualquiera con un enlace válido podría crear una cuenta a nombre de
 * otra persona —incluida una del dominio del cliente— y entrar con ella.
 *
 * Lo que autoriza a crear la cuenta es la POSESIÓN del enlace, que se mandó por
 * correo a esa dirección exacta: es la misma prueba que usa cualquier enlace de
 * confirmación. Por eso el usuario nace con el correo ya verificado — pedirle
 * después que confirme un correo que acaba de demostrar que controla sería un
 * paso de más que solo sirve para perder gente por el camino.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Ocho, no seis. Supabase acepta seis por defecto; seis es una fecha de nacimiento. */
const MINIMO = 8;

export async function POST(req: Request): Promise<NextResponse> {
  let body: { token?: string; password?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* cuerpo vacío */
  }
  const token = typeof body.token === "string" ? body.token.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!token) {
    return NextResponse.json({ error: "This invitation isn't valid.", code: "invalida" }, { status: 400 });
  }
  if (password.length < MINIMO) {
    return NextResponse.json({ error: "Password too short.", code: "corta", minimo: MINIMO }, { status: 400 });
  }

  const admin = createAdminClient();

  const { data, error } = await admin
    .from("org_invitations")
    .select("id, org_id, email, role, expires_at, accepted_at")
    .eq("token_hash", hashDeToken(token))
    .maybeSingle();
  if (error) {
    console.error("[org/registrar] lectura falló:", error);
    return NextResponse.json({ error: "Could not create your account.", code: "error" }, { status: 503 });
  }

  const inv = data as Invitacion | null;
  // Se valida con el MISMO juez que la otra puerta, pasándole el correo de la
  // propia invitación: aquí no hay sesión con la que comparar, y el resto de
  // comprobaciones (caducada, ya aceptada, existe) son idénticas.
  const veredicto = sePuedeAceptar(inv, inv?.email);
  if (!veredicto.ok) {
    const status = veredicto.motivo === "invalida" ? 404 : 410;
    return NextResponse.json({ error: "This invitation isn't valid.", code: veredicto.motivo }, { status });
  }
  const email = normalizarCorreo(inv!.email);

  // La cuenta. `email_confirm: true` porque la posesión del enlace YA prueba el
  // control de la dirección.
  const { data: creado, error: crearErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { invitado_por_org: inv!.org_id },
  });

  if (crearErr) {
    // YA TIENE CUENTA. No es un error del que pide: es alguien que ya está
    // registrado y tiene que entrar con su contraseña. Decírselo no filtra nada
    // —sostiene en la mano un enlace que se mandó a ESA dirección— y callárselo
    // le deja sin salida, que es el problema que esta ruta viene a arreglar.
    const yaExiste =
      /already|registered|exists/i.test(crearErr.message ?? "") ||
      (crearErr as { status?: number }).status === 422;
    if (yaExiste) {
      return NextResponse.json(
        { error: "You already have an account. Sign in to accept.", code: "ya_registrado", email },
        { status: 409 },
      );
    }
    console.error("[org/registrar] no se pudo crear la cuenta:", crearErr);
    return NextResponse.json({ error: "Could not create your account.", code: "error" }, { status: 503 });
  }

  const userId = creado?.user?.id;
  if (!userId) {
    console.error("[org/registrar] createUser no devolvió id");
    return NextResponse.json({ error: "Could not create your account.", code: "error" }, { status: 503 });
  }

  const unido = await unirseAOrganizacion(admin, inv!, userId);
  if (!unido.ok) {
    // La cuenta EXISTE y la pertenencia no. No se borra la cuenta: el siguiente
    // intento devolverá `ya_registrado`, la persona iniciará sesión y la ruta de
    // aceptar —que la invitación sigue viva— la meterá en la organización.
    console.error("[org/registrar] alta de pertenencia falló:", unido.error);
    return NextResponse.json(
      { error: "Your account was created, but joining failed. Sign in and open the link again.", code: "medio_hecho", email },
      { status: 503 },
    );
  }

  // Se devuelve el correo para que el cliente pueda iniciar sesión con él y la
  // contraseña que acaba de elegir. NO se crea aquí la sesión: eso lo hace el
  // cliente con `signInWithPassword`, que es lo que deja la cookie bien puesta.
  return NextResponse.json({ ok: true, email, orgId: inv!.org_id, role: inv!.role }, { status: 201 });
}
