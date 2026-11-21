import type { SupabaseClient } from "@supabase/supabase-js";

import { idsConComision, tuvoComisionDesde, type SuscripcionConFinDePeriodo } from "@/lib/billing/plan-de-la-org";
import { STRIPE_PRICE_ID_MONTHLY, STRIPE_PRICE_ID_YEARLY } from "@/lib/stripe/env";

import type { RegimenDelExtracto } from "./components/ExtractoVista";

/**
 * EL PANEL NO DICE «NUNCA SE FACTURA» SOBRE UN MES QUE SÍ SE FACTURA.
 *
 * Una organización de la modalidad con comisión que cancela a mitad de mes
 * vuelve a Measure: desde ese día el panel la veía como «solo Measure» y le
 * decía «never billed» y «Measure never bills any of it» sobre un ahorro del mes
 * que incluye los días de pago… y el día 1 le llegaba la factura de comisión.
 *
 * El criterio es EL MISMO que la tercera verja de la facturación
 * (`tuvoComisionDesde`, lib/billing/plan-de-la-org.ts): una suscripción con un
 * precio de la modalidad con comisión cuyo período llega a lo que se enseña.
 * Si eso pasa, este mes se cierra con comisión y el panel lo dice.
 */

/**
 * ¿Llega alguna suscripción de la modalidad con comisión de esta organización
 * a `desdeMs`? Lee TODAS sus suscripciones, en cualquier estado (una cancelada
 * a mitad de mes cuenta). `null` = no se pudo leer: quien llama no afirma nada.
 */
export async function comisionLlegaA(lector: SupabaseClient, orgId: string, desdeMs: number): Promise<boolean | null> {
  const ids = idsConComision(STRIPE_PRICE_ID_MONTHLY, STRIPE_PRICE_ID_YEARLY, process.env.STRIPE_PRICE_IDS_EXTRA);
  // Sin precios de comisión en este despliegue, la facturación no cobra comisión a nadie.
  if (ids.length === 0) return false;
  try {
    const { data, error } = await lector
      .schema("bvsala")
      .from("subscriptions")
      .select("price_id, current_period_end")
      .eq("org_id", orgId);
    if (error) return null;
    return tuvoComisionDesde((data ?? []) as SuscripcionConFinDePeriodo[], ids, desdeMs);
  } catch {
    return null;
  }
}

/** El primer instante (ms UTC) del mes en curso. */
export function inicioDelMes(ahora: Date): number {
  return Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), 1);
}

/**
 * Desde cuándo enseña ahorro la tarjeta de Measure: el primer día de las filas
 * que pinta o, si es anterior, el inicio del mes en curso (el que se factura el
 * día 1). Un ahorro de esos días que caiga en una comisión no se pinta como
 * «nunca se factura».
 */
export function desdeDeLaTarjeta(usage: ReadonlyArray<{ day: string }>, ahora: Date): number {
  let desde = inicioDelMes(ahora);
  for (const d of usage) {
    const t = Date.parse(`${d.day}T00:00:00Z`);
    if (!Number.isNaN(t) && t < desde) desde = t;
  }
  return desde;
}

/**
 * El régimen que enseña el extracto cuando la base no ve ningún plan vivo
 * («ninguno»): con una suscripción de comisión que llega a este mes, el mes se
 * cierra con comisión («legado-fin»), aunque la organización ya esté en Measure;
 * si no, Measure («medir») cuando solo tiene esa licencia. Sin poder leerlo,
 * «indeterminado»: ni «nunca se factura» ni una comisión supuesta.
 */
export function regimenSinPlanVivo(
  regimenBase: RegimenDelExtracto,
  comisionEsteMes: boolean | null,
  soloMedir: boolean,
): RegimenDelExtracto {
  if (regimenBase !== "ninguno") return regimenBase;
  if (comisionEsteMes === null) return "indeterminado";
  if (comisionEsteMes) return "legado-fin";
  return soloMedir ? "medir" : "ninguno";
}
