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

// ── LA LICENCIA GRATUITA «MEDIR» NUNCA LLEVA COMISIÓN ────────────────────────
//
// Hasta la 1.2.3 una organización que solo tenía Medir no podía generar comisión
// por una única razón: la ingesta ponía su ahorro a cero antes de guardarlo
// (`neutralizarParaMedir`). Desde la 1.2.4 Medir ahorra de verdad y ese ahorro
// se GUARDA para su panel, así que el candado ya no puede ser «no hay ahorro»:
// pasa a ser «esta organización no paga comisión», dicho en las dos verjas del
// cobro (el cargo 0 del cierre y la segunda pasada de la facturación).
//
// La comisión es de UNA modalidad cerrada a clientes nuevos desde el 2026-09-29
// (lib/billing/planes.ts), el mismo día que nació Medir. Una organización lleva
// comisión solo si tiene o tuvo una suscripción de esa modalidad; a esas no se
// les toca nada (ni el cierre, ni el extracto, ni la ingesta: ver
// `tieneHistoriaDeComision`). El resto de organizaciones con licencia Medir
// quedan exentas, ahorren lo que ahorren.

/** Una fila de `subscriptions`, en CUALQUIER estado (también canceladas). */
export interface SuscripcionConPrecio {
  org_id?: string;
  price_id?: string | null;
}

/**
 * ¿Tiene o TUVO esta organización la modalidad con comisión? Mira TODAS sus
 * suscripciones, vivas o no: una cancelada sigue contando (su último mes pagado
 * se cierra con comisión, como siempre).
 *
 * Conservador a propósito, como `planDelPrecio`: lo que no es un Price de Pro o
 * de Equipo configurado en este despliegue (un price id desconocido, uno nulo, o
 * un despliegue sin esos Prices) cuenta como comisión. Equivocarse hacia este
 * lado deja a la organización exactamente como estaba antes de la 1.2.4.
 */
export function tieneHistoriaDeComision(
  suscripciones: readonly SuscripcionConPrecio[],
  precios: PreciosConfigurados,
): boolean {
  return suscripciones.some((s) => llevaComision(planDelPrecio(s.price_id, precios)));
}

/** Una licencia Medir (plan `measure`), viva o no. */
export interface LicenciaMedirDeOrg {
  org_id: string;
  issued_at?: string | null;
}

/**
 * Las organizaciones EXENTAS de comisión por la licencia gratuita Medir en un
 * período: tienen una licencia Medir emitida antes del fin del período y NO
 * tienen ni tuvieron la modalidad con comisión.
 *
 * `finDelPeriodo` es el primer día del período siguiente (YYYY-MM-DD, exclusivo).
 * `suscripciones` son TODAS las filas (cualquier estado), no solo las vivas.
 */
export function orgsExentasPorMedir(
  licenciasMedir: readonly LicenciaMedirDeOrg[],
  suscripciones: readonly SuscripcionConPrecio[],
  precios: PreciosConfigurados,
  finDelPeriodo: string,
): Set<string> {
  const limite = Date.parse(`${finDelPeriodo}T00:00:00Z`);
  const conComision = new Set<string>();
  for (const s of suscripciones) {
    if (s.org_id && tieneHistoriaDeComision([s], precios)) conComision.add(String(s.org_id));
  }
  const exentas = new Set<string>();
  for (const l of licenciasMedir) {
    const emitida = Date.parse(l.issued_at ?? "");
    // Sin fecha legible no se puede situar en el período: no exime (falla hacia «como antes»).
    if (Number.isNaN(emitida) || Number.isNaN(limite) || emitida >= limite) continue;
    const org = String(l.org_id);
    if (!conComision.has(org)) exentas.add(org);
  }
  return exentas;
}
