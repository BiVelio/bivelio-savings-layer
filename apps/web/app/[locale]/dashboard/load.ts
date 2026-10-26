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
import {
  getOrgContext,
  getShadowByModel,
  getUsageRollups,
  getUsageByModel,
  type OrgContext,
  type UsageRollup,
  type ModelDia,
  type ShadowModelDia,
  type ShadowReadStatus,
} from "./data";

export interface DashboardData {
  user: { id: string; email: string | null } | null;
  ctx: OrgContext;
  usage: UsageRollup[];
  usageFailed: boolean;
  porModelo: ModelDia[];
  porModeloFailed: boolean;
  sombraPorModelo: ShadowModelDia[];
  sombraStatus: ShadowReadStatus;
  sombraFailed: boolean;
  /** `oculto` significa que las filas existen y este usuario no las ve. */
  visibilidad: Visibilidad;
  asientos: MedidaDeAsientos;
  orgId: string | null;
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

/** Load the signed-in user + org context + usage once per request. */
export const loadDashboard = cache(async (): Promise<DashboardData> => {
  const SIN_MEDIDA = { usados: null, rotacionEsteMes: false };
  const VACIO = {
    usage: [],
    usageFailed: false,
    porModelo: [],
    porModeloFailed: false,
    sombraPorModelo: [],
    sombraStatus: "empty" as ShadowReadStatus,
    sombraFailed: false,
    visibilidad: "desconocido" as Visibilidad,
    asientos: SIN_MEDIDA,
    orgId: null,
    orgFallo: false,
  };
  if (!authConfigured) return { user: null, ctx: EMPTY_CTX, ...VACIO };
  const supabase = await createReadOnlyClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { user: null, ctx: EMPTY_CTX, ...VACIO };
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
  const [ctx, usage, porModelo, sombra, asientos] = await Promise.all([
    getOrgContext(supabase, orgId, user.id),
    getUsageRollups(supabase, orgId),
    getUsageByModel(supabase, orgId),
    getShadowByModel(supabase, orgId, createAdminClient()),
    medirAsientos(orgId),
  ]);
  let visibilidad: Visibilidad = "con_datos";
  if (!usage.failed && usage.rows.length === 0) {
    const desde = new Date(Date.now() - 120 * 86_400_000).toISOString().slice(0, 10);
    const reales = await contarFilasReales(createAdminClient(), orgId, desde);
    visibilidad = diagnosticar(0, reales);
    if (visibilidad === "oculto") {
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
    porModeloFailed: porModelo.failed,
    sombraPorModelo: sombra.rows,
    sombraStatus: sombra.status,
    sombraFailed: sombra.failed,
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
