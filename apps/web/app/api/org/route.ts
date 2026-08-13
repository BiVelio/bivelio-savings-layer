import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { contextoDeLaOrg } from "@/lib/org/guardia";

/**
 * EL NOMBRE DE LA ORGANIZACIÓN.
 *
 * POR QUÉ HACÍA FALTA. La organización se creaba con el CORREO de quien pagó
 * (`ensureOrg` usa `name: email`), y ese nombre no se quedaba en la base: sale en
 * el correo de invitación. El resultado era un mensaje que decía «jmfisagol@gmail.com
 * le ha invitado a unirse a jmfisagol@gmail.com», que a alguien que no conoce
 * BiVelio le parece —con razón— un correo automático roto, o directamente una
 * suplantación. Es el primer contacto de un desconocido con el producto de un
 * cliente, y estaba mal.
 *
 * El correo sigue valiendo como valor por defecto: es mejor que "BiVelio account"
 * y no obliga a nadie a rellenar un campo antes de poder comprar. Pero ahora se
 * puede cambiar, y quien invita puede hacerlo antes de mandar nada.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Suficiente para «Acme Corporation, S.L. — División Norte» y poco para pegar un
 *  texto entero. El nombre acaba dentro de un correo que mandamos nosotros. */
const MAX = 80;

export async function PATCH(req: Request): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  let body: { name?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* cuerpo vacío */
  }
  const crudo = typeof body.name === "string" ? body.name : "";

  // LOS CARACTERES DE CONTROL SE MIRAN EN EL VALOR CRUDO, ANTES DE NORMALIZAR, y
  // ese orden es el arreglo. Al revés no protegía de nada: `\s+ -> " "` convierte
  // un salto de línea en un espacio, así que "Acme\nBcc: otro@sitio.com" pasaba
  // el filtro transformado en "Acme Bcc: otro@sitio.com" — sin salto, sí, pero
  // habiendo aceptado en silencio una entrada que nadie escribe por error.
  //
  // Comparación por CÓDIGO y no por regex, igual que en `app/auth/safe-next.ts`:
  // escritos como literales dentro de una clase de caracteres, estos bytes son
  // invisibles en el fuente y cualquier herramienta que "limpie" el fichero los
  // borra sin que nadie lo note.
  for (let i = 0; i < crudo.length; i++) {
    const code = crudo.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return NextResponse.json({ error: "The name can't contain control characters." }, { status: 400 });
    }
  }

  const nombre = crudo.trim().replace(/\s+/g, " ");
  if (!nombre || nombre.length > MAX) {
    return NextResponse.json({ error: `The name must be 1-${MAX} characters.` }, { status: 400 });
  }

  const admin = createAdminClient();
  // Mismo permiso que gestionar el equipo: quien puede invitar es quien decide
  // con qué nombre llega esa invitación.
  const g = await contextoDeLaOrg(admin, user.id, "gestionar_miembros");
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });

  const { error } = await admin.from("organizations").update({ name: nombre }).eq("id", g.orgId);
  if (error) {
    console.error("[org] no se pudo renombrar:", error);
    return NextResponse.json({ error: "Could not rename the organization." }, { status: 503 });
  }

  return NextResponse.json({ ok: true, name: nombre });
}
