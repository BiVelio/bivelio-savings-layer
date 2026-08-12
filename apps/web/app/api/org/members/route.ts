import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { contextoDeLaOrg } from "@/lib/org/guardia";
import { esRolInvitable } from "@/lib/org/invitaciones";

/**
 * LOS MIEMBROS DE LA ORGANIZACIÓN: verlos, cambiarles el rol y sacarlos.
 *
 * La regla que gobierna las tres operaciones es una sola y conviene tenerla
 * delante: **una organización no puede quedarse sin dueño**. Sin dueño no se puede
 * cambiar la tarjeta ni cancelar, y la suscripción sigue cobrando todos los meses
 * sin que nadie pueda pararla. Por eso al dueño no se le degrada ni se le expulsa:
 * primero se transfiere la propiedad (`/api/org/transfer`), que lo hace en una
 * sola transacción.
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

/** GET — la lista, con el correo de cada uno para poder identificarlos. */
export async function GET(): Promise<NextResponse> {
  const user = await sesion();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const admin = createAdminClient();
  const g = await contextoDeLaOrg(admin, user.id, "gestionar_miembros");
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });

  const { data, error } = await admin
    .from("org_members")
    .select("user_id, role, created_at")
    .eq("org_id", g.orgId)
    .order("created_at", { ascending: true });
  if (error) {
    console.error("[org/members] listado falló:", error);
    return NextResponse.json({ error: "Could not list members." }, { status: 503 });
  }

  const filas = (data ?? []) as { user_id: string; role: string; created_at: string }[];
  // EL CORREO SE PIDE UNO A UNO, a propósito. `listUsers` pagina sobre TODOS los
  // usuarios del proyecto, que es COMPARTIDO con los demás productos de BiVelio:
  // traería a gente que no tiene nada que ver con esta organización. Pedir por id
  // solo devuelve a quien ya sabemos que es miembro.
  const miembros = await Promise.all(
    filas.map(async (f) => {
      let email: string | null = null;
      try {
        const { data: u } = await admin.auth.admin.getUserById(f.user_id);
        email = u?.user?.email ?? null;
      } catch {
        /* un correo que no se puede leer no impide enseñar la fila */
      }
      return {
        userId: f.user_id,
        email,
        role: f.role,
        desde: f.created_at,
        soyYo: f.user_id === user.id,
      };
    }),
  );

  return NextResponse.json({ miembros, miRol: g.role });
}

/** PATCH — cambiar el rol de alguien. */
export async function PATCH(req: Request): Promise<NextResponse> {
  const user = await sesion();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  let body: { userId?: string; role?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* cuerpo vacío */
  }
  const destino = typeof body.userId === "string" ? body.userId.trim() : "";
  if (!destino) return NextResponse.json({ error: "Which member?" }, { status: 400 });
  // `owner` NO está entre los invitables, y por eso tampoco se puede asignar aquí:
  // promover a dueño por esta vía dejaría DOS dueños y la restricción de 0013 lo
  // rechazaría con un error de Postgres crudo. La promoción va por transferencia.
  if (!esRolInvitable(body.role)) {
    return NextResponse.json({ error: "Role must be admin, member or billing." }, { status: 400 });
  }

  const admin = createAdminClient();
  const g = await contextoDeLaOrg(admin, user.id, "gestionar_miembros");
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });

  const { data: fila, error: leerErr } = await admin
    .from("org_members")
    .select("role")
    .eq("org_id", g.orgId)
    .eq("user_id", destino)
    .maybeSingle();
  if (leerErr) {
    console.error("[org/members] lectura falló:", leerErr);
    return NextResponse.json({ error: "Could not update the member." }, { status: 503 });
  }
  // 404 y no 403: el `.eq("org_id", …)` es lo que impide tocar al miembro de otra
  // empresa, y un id ajeno tiene que responder lo mismo que un id inexistente.
  if (!fila) return NextResponse.json({ error: "No such member." }, { status: 404 });

  if ((fila as { role: string }).role === "owner") {
    return NextResponse.json(
      { error: "The owner's role can't be changed here. Transfer ownership first." },
      { status: 409 },
    );
  }

  const { error } = await admin
    .from("org_members")
    .update({ role: body.role })
    .eq("org_id", g.orgId)
    .eq("user_id", destino);
  if (error) {
    console.error("[org/members] cambio de rol falló:", error);
    return NextResponse.json({ error: "Could not update the member." }, { status: 503 });
  }

  await admin.from("billing_audit").insert({
    org_id: g.orgId,
    event_id: `rol_${destino}_${Date.now()}`,
    kind: "org_member_role_changed",
    detail: { userId: destino, role: body.role, por: user.id },
  });

  return NextResponse.json({ ok: true, userId: destino, role: body.role });
}

/** DELETE — sacar a alguien de la organización. */
export async function DELETE(req: Request): Promise<NextResponse> {
  const user = await sesion();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  let body: { userId?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* cuerpo vacío */
  }
  const destino = typeof body.userId === "string" ? body.userId.trim() : "";
  if (!destino) return NextResponse.json({ error: "Which member?" }, { status: 400 });

  const admin = createAdminClient();
  const g = await contextoDeLaOrg(admin, user.id, "gestionar_miembros");
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });

  const { data: fila, error: leerErr } = await admin
    .from("org_members")
    .select("role")
    .eq("org_id", g.orgId)
    .eq("user_id", destino)
    .maybeSingle();
  if (leerErr) {
    console.error("[org/members] lectura falló:", leerErr);
    return NextResponse.json({ error: "Could not remove the member." }, { status: 503 });
  }
  if (!fila) return NextResponse.json({ error: "No such member." }, { status: 404 });

  if ((fila as { role: string }).role === "owner") {
    // La comprobación que impide dejar la organización sin dueño con una
    // suscripción viva cobrando.
    return NextResponse.json(
      { error: "The owner can't be removed. Transfer ownership first." },
      { status: 409 },
    );
  }

  const { error } = await admin
    .from("org_members")
    .delete()
    .eq("org_id", g.orgId)
    .eq("user_id", destino);
  if (error) {
    console.error("[org/members] expulsión falló:", error);
    return NextResponse.json({ error: "Could not remove the member." }, { status: 503 });
  }

  // ⚠️ SACAR A ALGUIEN NO REVOCA LAS CLAVES `bvk_` QUE HAYA ACUÑADO. Es
  // deliberado: esas claves son de la ORGANIZACIÓN y están en máquinas que siguen
  // trabajando; revocarlas al expulsar a quien las creó apagaría producción sin
  // avisar. La revocación es una acción aparte y explícita, en su pantalla.
  await admin.from("billing_audit").insert({
    org_id: g.orgId,
    event_id: `expulsion_${destino}_${Date.now()}`,
    kind: "org_member_removed",
    detail: { userId: destino, por: user.id },
  });

  return NextResponse.json({ ok: true, userId: destino });
}
