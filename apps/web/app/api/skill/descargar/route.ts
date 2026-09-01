import { NextResponse, type NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolverOrgSiExiste } from "@/lib/org/resolver";
import { SKILL_MD } from "@/lib/skill/contenido";
import { zipDeUnFichero } from "@/lib/skill/zip";

/**
 * GET /api/skill/descargar — el zip del skill savings-mode, DETRÁS de la
 * cuenta (gratuita).
 *
 * Decisión del dueño (01-09): la adopción del skill tiene que ser una métrica
 * medible con identidad. El skill en sí no puede «llamar a casa» (es un
 * fichero de instrucciones, y la telemetría escondida va contra la bandera de
 * privacidad de la casa), así que la exactitud viene de aquí: sin sesión no
 * hay zip, y cada descarga se registra (usuario, organización si la hay).
 * El canal `npx` queda abierto a propósito — npm no se puede cerrar y es el
 * canal viral; sus números son agregados, no identidad.
 *
 * El registro es FAIL-OPEN: si la tabla no existe aún o el insert falla, la
 * descarga sale igual — la métrica jamás secuestra al usuario. Lo contrario
 * (fail-closed) convertiría un fallo nuestro de contabilidad en un producto
 * roto, la lección de siempre del medidor: avisar, nunca romper.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ZIP = zipDeUnFichero("savings-mode/SKILL.md", SKILL_MD);

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    // El middleware de i18n antepone el locale que toque; `next` devuelve al
    // visitante aquí tras entrar (el mismo patrón que el resto del panel).
    const login = new URL("/login", req.url);
    login.searchParams.set("next", "/api/skill/descargar");
    return NextResponse.redirect(login, { status: 302 });
  }

  // Best-effort, jamás bloqueante: la descarga vale más que su contabilidad.
  try {
    const admin = createAdminClient();
    const org = await resolverOrgSiExiste(admin, user.id);
    await admin.schema("bvsala").from("skill_downloads").insert({
      user_id: user.id,
      org_id: org?.orgId ?? null,
      skill: "savings-mode",
    });
  } catch {
    // Sin tabla (deploy antes que migración) o sin permisos: se descarga igual.
  }

  return new NextResponse(Buffer.from(ZIP), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="savings-mode.zip"',
      "Cache-Control": "no-store",
    },
  });
}
