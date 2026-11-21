import { safeNextPath } from "@/app/auth/safe-next";
import { PLANES_EN_VENTA, type PlanDePago } from "@/lib/billing/planes";

/** Un plan que se vende y que se puede elegir en la portada o en /pricing. */
export type PlanDeAlta = Extract<PlanDePago, "pro" | "equipo">;

/** Solo el panel lee `?plan=` (Resumen y Cuenta): otro destino no lo recoge. */
const DESTINO_DEL_PANEL = /^(?:\/[a-z]{2})?\/dashboard(?:\/|$)/;

/**
 * EL PLAN QUE TRAE EL ALTA, LEÍDO DE SU `next`.
 *
 * «Elegir Pro» y «Elegir Team» mandan a `/signup?next=/<idioma>/dashboard?plan=…`
 * (contrato de `app/[locale]/plan-elegido.test.ts`). Aquí se recupera ese plan
 * para decirlo en el alta. Recibe la query entera (`window.location.search`).
 *
 * El `next` pasa por el mismo guardián que el resto del acceso (`safeNextPath`);
 * si no sobrevive intacto, no hay plan. Nunca se refleja el valor recibido: lo
 * que sale es uno de los planes en venta o `null`.
 */
export function planDelDestino(query: string): PlanDeAlta | null {
  const pedido = new URLSearchParams(query).get("next");
  if (!pedido || safeNextPath(pedido) !== pedido) return null;
  const destino = new URL(pedido, "https://x.invalid");
  if (!DESTINO_DEL_PANEL.test(destino.pathname)) return null;
  const plan = destino.searchParams.get("plan");
  return plan !== null && (PLANES_EN_VENTA as readonly string[]).includes(plan) ? (plan as PlanDeAlta) : null;
}
