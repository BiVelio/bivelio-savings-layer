import { cache } from "react";

import { activationSteps } from "@/app/[locale]/dashboard/data";
import { loadDashboard } from "@/app/[locale]/dashboard/load";
import { puede } from "@/lib/org/permisos";
import { createAdminClient } from "@/lib/supabase/admin";

import { setupProgress, type Progress } from "./progress";

/**
 * LO QUE EL RAÍL NECESITA SABER PARA DECIR LA VERDAD A SU DERECHA.
 *
 * La barra dejó de ser una lista de enlaces (mismo patrón que el panel de
 * privacy, `lib/dashboard/sidebar-state.ts`): cada entrada lleva la cifra que
 * responde a la pregunta que abre esa página («2/5» pasos, «3 de 5» asientos,
 * «2 miembros») y arriba va el bloque de puesta en marcha. Todo eso son
 * lecturas, y una lectura en el raíl se hace en TODAS las pantallas del panel
 * — así que se hacen aquí, una vez, envueltas en `cache()` de React para que
 * compartir petición con la página de debajo no cueste una segunda consulta.
 * `loadDashboard` ya es `cache()`, así que el raíl reutiliza SU lectura.
 *
 * TRES DECISIONES:
 *
 * 1. LAS CIFRAS DE LA ORGANIZACIÓN NO SE PREGUNTAN PARA QUIEN NO PUEDE
 *    VERLAS. El recuento de miembros es de quien puede gestionar miembros
 *    (la misma puerta que `GET /api/org/members`); la puesta en marcha es de
 *    quien puede acuñar claves, porque es un bloque sobre el despliegue y un
 *    `member` no despliega nada.
 *
 * 2. EL PLAN VUELVE COMO ETIQUETA, NUNCA COMO FILTRO. Ninguna entrada del raíl
 *    se esconde por plan: una organización en impago sigue leyendo `pro` y
 *    esconderle el Extracto es castigarla justo cuando más lo necesita.
 *
 * 3. «NO SE PUDO LEER» NUNCA SE PINTA COMO UN CERO. Cada campo es opcional y
 *    `undefined` significa «no lo sé»: la entrada se pinta sin cifra.
 */
export type SidebarState = {
  role: string | null;
  plan: string | null;
  orgName: string;
  /** Asientos USADOS este mes y PAGADOS, para «N de M». */
  seats?: { used: number; seats: number };
  /** Personas en la organización. */
  members?: number;
  /** Los cinco pasos. Ausente cuando este rol no los pregunta. */
  progress?: Progress;
};

/** Cuántas personas hay en la organización. `undefined` = no se pudo contar. */
async function countMembers(orgId: string): Promise<number | undefined> {
  try {
    const admin = createAdminClient();
    const { count, error } = await admin
      .from("org_members")
      .select("user_id", { count: "exact", head: true })
      .eq("org_id", orgId);
    if (error || typeof count !== "number") return undefined;
    return count;
  } catch {
    return undefined;
  }
}

async function load(): Promise<SidebarState> {
  const { user, ctx, usage, usageFailed, visibilidad, asientos, orgId, orgFallo } = await loadDashboard();
  const role = ctx.role;
  const plan = ctx.org?.plan ?? null;
  const orgName = ctx.org?.name ?? "";
  if (!user || !orgId) return { role, plan, orgName };

  const seats =
    typeof asientos.usados === "number" && typeof ctx.seats === "number"
      ? { used: asientos.usados, seats: ctx.seats }
      : undefined;
  const unreadable = usageFailed || orgFallo || visibilidad === "oculto";

  const [members, progress] = await Promise.all([
    puede(role, "gestionar_miembros") ? countMembers(orgId) : Promise.resolve(undefined),
    puede(role, "gestionar_claves")
      ? activationSteps(true, ctx, usage, {
          usageFailed: usageFailed || orgFallo,
          usageHidden: visibilidad === "oculto",
        }).then((steps) => setupProgress(steps, unreadable))
      : Promise.resolve(undefined),
  ]);

  return { role, plan, orgName, seats, members, progress };
}

/**
 * `cache()` de React: una sola resolución por petición aunque el raíl y la
 * página pregunten los dos. No es un caché entre peticiones — el panel es
 * `force-dynamic` y estas cifras cambian en cuanto alguien activa una máquina.
 */
export const getSidebarState = cache(load);
