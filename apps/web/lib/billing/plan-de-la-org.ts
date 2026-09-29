import { planDelPrecio, llevaComision, type PreciosConfigurados } from "./planes";

/**
 * ¿QUÉ ORGANIZACIONES NO LLEVAN COMISIÓN POR SU PLAN?
 *
 * Pro y Equipo (lib/billing/planes.ts) no llevan comisión. El cierre y la
 * facturación ya saben no cobrarla a una organización EXENTA
 * (`organizations.comision_exenta`); esta pieza añade las que están en un plan
 * sin comisión, para que las dos verjas —el cargo 0 del cierre de las 05:00 y
 * la segunda pasada de las 07:00— las traten igual. El extracto sigue
 * enseñando la comisión que habría aplicado en la modalidad con comisión.
 *
 * Se decide por el PRICE ID de la suscripción (el catálogo de Stripe), no por
 * un metadato: la misma doctrina que lib/stripe/atribucion.ts. Y por defecto
 * NADA cambia: sin Prices de Pro/Equipo configurados, o con un price id que no
 * es de ellos, la organización sigue en la modalidad con comisión — quien la
 * tiene hoy no nota nada.
 */

/** Estados en los que una suscripción da derecho al plan (los de `planForStatus` del webhook). */
export const ESTADOS_CON_PLAN: readonly string[] = ["active", "trialing", "past_due"];

export interface SuscripcionDeOrg {
  org_id: string;
  price_id: string | null;
  status: string;
}

/** Las organizaciones con una suscripción viva en un plan SIN comisión. */
export function orgsSinComisionPorPlan(
  suscripciones: readonly SuscripcionDeOrg[],
  precios: PreciosConfigurados,
): Set<string> {
  const fuera = new Set<string>();
  for (const s of suscripciones) {
    if (!ESTADOS_CON_PLAN.includes(s.status)) continue;
    if (!llevaComision(planDelPrecio(s.price_id, precios))) fuera.add(String(s.org_id));
  }
  return fuera;
}

/** Todos los price ids de planes sin comisión (vacío = no hay nada que consultar). */
export function idsSinComision(precios: PreciosConfigurados): string[] {
  return [...precios.pro, ...precios.equipo];
}
