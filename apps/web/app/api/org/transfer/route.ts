import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { contextoDeLaOrg } from "@/lib/org/guardia";

/**
 * TRANSFERIR LA PROPIEDAD.
 *
 * Es la operación que da sentido a todo el trabajo de organizaciones: si el que
 * compró se va de la empresa, hasta ahora se iba con la facturación. La
 * organización era su usuario.
 *
 * TODO EL TRABAJO LO HACE POSTGRES, en `bvsala.transferir_propiedad` (0014). No es
 * una preferencia de estilo: degradar al dueño viejo y promover al nuevo son dos
 * escrituras, y hechas desde aquí hay una ventana entre las dos en la que la
 * organización tiene dos dueños o ninguno. Si el proceso muere justo ahí —un
 * despliegue, un timeout de Vercel— se queda así para siempre, y sin dueño nadie
 * puede cambiar la tarjeta ni cancelar mientras la suscripción sigue cobrando.
 *
 * La autorización se decide AQUÍ y no dentro de la función: con `service_role`,
 * `auth.uid()` es NULL, así que una comprobación en plpgsql no vería a nadie.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  let body: { userId?: string; miRolDespues?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* cuerpo vacío */
  }
  const nuevo = typeof body.userId === "string" ? body.userId.trim() : "";
  if (!nuevo) return NextResponse.json({ error: "Who should own it?" }, { status: 400 });

  // Con qué rol se queda quien la entrega. Por defecto `admin`: quien acaba de
  // ceder la propiedad de su organización casi nunca quiere quedarse sin poder
  // hacer nada dentro de ella, y si lo quiere puede degradarse después.
  const rolViejo = ["admin", "member", "billing"].includes(body.miRolDespues ?? "")
    ? body.miRolDespues
    : "admin";

  const admin = createAdminClient();
  // `transferir_propiedad` solo la tiene el `owner` en la tabla de permisos, así
  // que un `admin` no puede quedarse con la organización de su empresa.
  const g = await contextoDeLaOrg(admin, user.id, "transferir_propiedad");
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });

  if (nuevo === user.id) {
    return NextResponse.json({ error: "It's already yours." }, { status: 409 });
  }

  const { error } = await admin.rpc("transferir_propiedad", {
    p_org: g.orgId,
    p_nuevo: nuevo,
    p_rol_viejo: rolViejo,
  });
  if (error) {
    // La función lanza `P0002` cuando el destinatario no es miembro. Es un error
    // del que pide, no del servidor, y merece un 404 con su motivo — no un 500.
    const noEsMiembro = error.code === "P0002" || /no es miembro/i.test(error.message ?? "");
    if (noEsMiembro) {
      return NextResponse.json(
        { error: "That person isn't a member of this organization yet. Invite them first." },
        { status: 404 },
      );
    }
    console.error("[org/transfer] la transferencia falló:", error);
    return NextResponse.json({ error: "Could not transfer ownership." }, { status: 503 });
  }

  await admin.from("billing_audit").insert({
    org_id: g.orgId,
    event_id: `transferencia_${g.orgId}_${Date.now()}`,
    kind: "org_ownership_transferred",
    detail: { de: user.id, a: nuevo, rolAnterior: rolViejo },
  });

  return NextResponse.json({ ok: true, orgId: g.orgId, nuevoDueno: nuevo, miRol: rolViejo });
}
