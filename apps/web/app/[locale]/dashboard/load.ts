import { cache } from "react";

import { authConfigured } from "@/lib/supabase/env";
// Server Component: cliente de SOLO LECTURA. No puede persistir un token
// rotado, asi que tampoco debe provocar la rotacion — ver server.ts.
import { createReadOnlyClient } from "@/lib/supabase/server";
import { medirAsientos, type MedidaDeAsientos } from "@/lib/billing/asientos-usados";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolverOrgSiExiste, orgParaElPanel } from "@/lib/org/resolver";
import { contarFilasReales, diagnosticar, type Visibilidad } from "@/lib/org/visibilidad";
import { alertar } from "@/lib/observabilidad/alerta";
import { getOrgContext, getUsageRollups, getUsageByModel, type OrgContext, type UsageRollup, type ModelDia } from "./data";

export interface DashboardData {
  user: { id: string; email: string | null } | null;
  ctx: OrgContext;
  usage: UsageRollup[];
  /** La lectura de uso falló (503/RLS/columna ausente), distinto de "sin tráfico". */
  usageFailed: boolean;
  /**
   * Uso por modelo (0022). Vacío hasta que la migración esté en prod y entre
   * tráfico nuevo — sin historial, el modelo nunca se guardó antes. El
   * explorador degrada honesto: "acumulando por modelo", nunca filas inventadas.
   */
  porModelo: ModelDia[];
  /**
   * POR QUÉ está vacío, cuando lo está. `sin_trafico` es normal el primer día;
   * `oculto` significa que las filas EXISTEN y este usuario no las ve, que es un
   * fallo nuestro y no se puede pintar como «aún no has enviado peticiones».
   */
  visibilidad: Visibilidad;
  /**
   * Asientos USADOS este mes (`billable_seats`), frente a los PAGADOS que ya
   * vivían en `ctx.seats`, más si hubo rotación de clave (que infla el recuento).
   */
  asientos: MedidaDeAsientos;
  /**
   * La organización del panel, para las páginas que consultan tablas con RLS
   * de miembro (extractos, cargos): un usuario en varias organizaciones vería
   * mezcladas las filas de todas sin este filtro explícito.
   */
  orgId: string | null;
  /**
   * La resolución de la organización FALLÓ (no es «no estás en ninguna»). El
   * raíl lo dice: el menú que se ve entonces es el de ningún rol, y sin esta
   * distinción se encogía en silencio.
   */
  orgFallo: boolean;
}

const EMPTY_CTX: OrgContext = {
  org: null,
  role: null,
  seats: null,
  subscription: null,
  license: null,
  serviceAccount: null,
};

/**
 * Load the signed-in user + org context + usage once per request. `cache()` dedupes
 * across the dashboard layout and every sub-page so they don't each re-fetch.
 */
export const loadDashboard = cache(async (): Promise<DashboardData> => {
  // Without Supabase env (e.g. local without .env), createClient() would throw —
  // degrade to a signed-out shell instead of a 500.
  const SIN_MEDIDA = { usados: null, rotacionEsteMes: false };
  const VACIO = { usage: [], usageFailed: false, porModelo: [], visibilidad: "desconocido" as Visibilidad, asientos: SIN_MEDIDA, orgId: null, orgFallo: false };
  if (!authConfigured) return { user: null, ctx: EMPTY_CTX, ...VACIO };
  const supabase = await createReadOnlyClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { user: null, ctx: EMPTY_CTX, ...VACIO };
  // LA ORGANIZACIÓN SE RESUELVE UNA VEZ, AQUÍ. Antes este bloque pasaba `user.id`
  // tres veces donde se espera el id del INQUILINO — una suposición que solo se
  // sostenía mientras la organización fuese una persona. Para cualquier miembro
  // cuyo user_id no sea el org_id, las tres devolvían vacío SIN error: panel sin
  // plan, sin licencia, sin clave y con cero peticiones, mientras sus datos
  // seguían intactos en la base.
  //
  // Si no se puede resolver NO se cae a `user.id`: se devuelve el contexto vacío.
  // Un respaldo silencioso ahí es lo que reabre el defecto por la puerta de atrás.
  let orgId: string | null = null;
  let orgFallo = false;
  try {
    orgId = orgParaElPanel(await resolverOrgSiExiste(createAdminClient(), user.id));
  } catch (err) {
    console.error("[dashboard] no se pudo resolver la organización:", err);
    orgFallo = true;
  }
  if (!orgId) {
    return { user: { id: user.id, email: user.email ?? null }, ctx: EMPTY_CTX, ...VACIO, orgFallo };
  }
  const [ctx, usage, porModelo, asientos] = await Promise.all([
    getOrgContext(supabase, orgId, user.id),
    getUsageRollups(supabase, orgId),
    getUsageByModel(supabase, orgId),
    medirAsientos(orgId),
  ]);
  // POR QUÉ ESTÁ VACÍO. Solo se pregunta cuando el usuario ha visto CERO filas y
  // la lectura no dio error — el caso raro. En el camino normal no cuesta nada.
  let visibilidad: Visibilidad = "con_datos";
  if (!usage.failed && usage.rows.length === 0) {
    const desde = new Date(Date.now() - 120 * 86_400_000).toISOString().slice(0, 10);
    const reales = await contarFilasReales(createAdminClient(), orgId, desde);
    visibilidad = diagnosticar(0, reales);
    if (visibilidad === "oculto") {
      // Un cliente que paga mirando un panel vacío mientras sus datos están en la
      // base es de los fallos más caros que tiene este producto, y de los más
      // silenciosos: no hay error en ningún registro, solo un cliente que se va.
      await alertar({
        nivel: "critico",
        asunto: "El panel de un cliente está VACÍO pero sus filas de uso existen (RLS)",
        detalle: { orgId, userId: user.id, filasReales: reales },
      });
    }
  } else if (usage.failed) {
    visibilidad = "desconocido";
  }

  return {
    user: { id: user.id, email: user.email ?? null },
    ctx,
    usage: usage.rows,
    usageFailed: usage.failed,
    porModelo: porModelo.rows,
    visibilidad,
    asientos,
    orgId,
    orgFallo: false,
  };
});

/** Display label for the account plan pill (no active plan → "free"). */
export function planLabel(ctx: OrgContext): string {
  const p = ctx.org?.plan;
  return p === "pro" || p === "enterprise" ? p : "free";
}
