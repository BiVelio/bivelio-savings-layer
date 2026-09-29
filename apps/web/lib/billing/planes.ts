/**
 * LOS PLANES DE PAGO — el ingreso sale de ASIENTOS y de un PLAN DE EQUIPO; la
 * comisión sobre el ahorro queda CERRADA a clientes nuevos.
 *
 * Decisiones del dueño (2026-09-29), tras docs/COMPETENCIA-2026-09-26.md §1
 * («el negocio no cierra») y §6.3: la base comisionable real es casi nula
 * (~12 € al mes por cada 10.000 $ de gasto en una mezcla típica), así que la
 * comisión no puede ser el modelo. Se venden Pro y Equipo (`PLANES_EN_VENTA`);
 * la modalidad con comisión la conserva SIN CAMBIOS quien ya la tiene (su
 * suscripción, su cierre, su extracto y su comisión: ver `planDelPrecio`), y
 * el checkout ya no la ofrece.
 *
 * Las cifras (`PRECIOS_DE_LOS_PLANES`) las CONFIRMÓ el dueño el 2026-09-29.
 * Cobra SIEMPRE el Price de Stripe: estas constantes son el respaldo que pinta
 * /pricing si Stripe no contesta, igual que `PRECIO_RESPALDO` en
 * lib/stripe/pricing.ts, y la referencia contra la que el lector de Stripe
 * comprueba que el Price creado es el que se decidió.
 *
 * Los planes:
 *   · «medir»    — la licencia gratuita (otro PR); aquí solo tiene su hueco.
 *   · «pro»      — cuota plana por asiento, SIN comisión.
 *   · «equipo»   — N asientos incluidos por una cuota fija, y cada asiento más
 *                  a un precio unitario; SIN comisión. En Stripe es UN Price
 *                  escalonado («graduated»): primer tramo `up_to = N` con
 *                  `flat_amount` y `unit_amount = 0`, segundo tramo `inf` con el
 *                  precio del asiento extra. Así la cantidad de la suscripción
 *                  SIGUE siendo el número de asientos, que es lo que el webhook
 *                  firma en la licencia (subFacts → quantity).
 *   · «comision» — la modalidad anterior: cuota por asiento más la comisión
 *                  por tramos de tarifa.ts sobre el ahorro medido. Es el Price
 *                  de STRIPE_PRICE_ID_MONTHLY/YEARLY de siempre. CERRADA a
 *                  clientes nuevos: quien la tiene la conserva tal cual.
 *   · Enterprise — contrato; sin Price, se contacta.
 */

import { calcularComision, redondearCentimos, type ComisionCalculada } from "./tarifa";

export type PlanDePago = "pro" | "equipo" | "comision";
export type PeriodoDePago = "monthly" | "yearly";

/**
 * TODOS los planes de pago que existen (también el cerrado): la guardia
 * anti-doble-compra y la atribución tienen que reconocer cualquier suscripción
 * viva, incluida la de quien conserva la modalidad con comisión.
 */
export const PLANES_DE_PAGO: readonly PlanDePago[] = ["pro", "equipo", "comision"];

/**
 * Los planes que se VENDEN a un cliente nuevo, en el orden en que los enseñan
 * /pricing y el panel. «comision» no está: cerrada a clientes nuevos
 * (decisión del dueño, 2026-09-29).
 */
export const PLANES_EN_VENTA: readonly PlanDePago[] = ["pro", "equipo"];

/** El plan que compra un checkout que no dice cuál. */
export const PLAN_POR_DEFECTO: PlanDePago = "pro";

/**
 * ¿Lleva este plan la comisión sobre el ahorro medido? SOLO la modalidad
 * «comision». Pro y Equipo no la llevan nunca: el cierre y la facturación los
 * tratan como exentos (lib/billing/plan-de-la-org.ts).
 */
export function llevaComision(plan: PlanDePago): boolean {
  return plan === "comision";
}

/** Un importe en la unidad mínima de la moneda (céntimos), como lo da Stripe. */
export interface ImporteEnCentimos {
  amount: number;
  currency: string;
}

/** La tarifa de un plan por período: lo que se lee del Price de Stripe. */
export interface TarifaDePlan {
  /**
   * Cuota fija del período (el `flat_amount` del primer tramo). 0 en los
   * planes por asiento puro (Pro, comisión).
   */
  fijaCentimos: number;
  /** Asientos que cubre la cuota fija. 0 en los planes por asiento puro. */
  asientosIncluidos: number;
  /** Precio de cada asiento POR ENCIMA de los incluidos (o de cada asiento, si no hay incluidos). */
  asientoCentimos: number;
  currency: string;
}

export type TarifasDelPlan = Record<PeriodoDePago, TarifaDePlan>;

/**
 * CONFIRMADO por el dueño (2026-09-29). Todo en céntimos de euro, sin IVA. El
 * razonamiento va en la descripción del PR #411:
 *
 *   · Pro 15 €/asiento/mes: en la franja baja del mercado por asiento (Dash0
 *     10 $, Opik Pro 19 $, context-mode 20 $, Tokenade 24,90 $, TrueFoundry
 *     25 $, LangSmith 39 $, Weave 50 $ — informe §6.1). Con el ~31 % medido en
 *     tráfico con repeticiones (GSM8K 0.4.31, gpt-4o-mini y gpt-5.4-mini,
 *     caché exacta) el asiento se paga solo a partir de ~50 € de gasto de LLM
 *     por asiento y mes; con tráfico SIN repeticiones (MT-Bench) el ahorro de
 *     la capa es indistinguible de 0, y eso hay que decirlo en la venta.
 *   · Anual = 10 meses (dos gratis), la costumbre del sector.
 *   · Equipo 129 €/mes con 10 asientos (12,90 €/asiento, −14 %) y 12 € cada
 *     asiento extra: el paquete abarata el asiento al que compra flota sin
 *     bajar de lo que vale un asiento suelto de la competencia.
 */
export const PRECIOS_DE_LOS_PLANES = {
  pro: {
    monthly: { fijaCentimos: 0, asientosIncluidos: 0, asientoCentimos: 1_500, currency: "eur" },
    yearly: { fijaCentimos: 0, asientosIncluidos: 0, asientoCentimos: 15_000, currency: "eur" },
  },
  equipo: {
    monthly: { fijaCentimos: 12_900, asientosIncluidos: 10, asientoCentimos: 1_200, currency: "eur" },
    yearly: { fijaCentimos: 129_000, asientosIncluidos: 10, asientoCentimos: 12_000, currency: "eur" },
  },
} as const satisfies Record<"pro" | "equipo", TarifasDelPlan>;

/**
 * Los asientos que incluye el plan de equipo. El checkout lo usa como MÍNIMO de
 * la cantidad (menos asientos no abaratan una cuota fija) y el lector de Stripe
 * avisa si el `up_to` del primer tramo del Price no coincide.
 */
export const ASIENTOS_INCLUIDOS_EQUIPO = PRECIOS_DE_LOS_PLANES.equipo.monthly.asientosIncluidos;

/** La tarifa de un plan por asiento puro, a partir del importe unitario de su Price. */
export function tarifaPorAsiento(importe: ImporteEnCentimos): TarifaDePlan {
  return { fijaCentimos: 0, asientosIncluidos: 0, asientoCentimos: importe.amount, currency: importe.currency };
}

/** El subconjunto de un Price de Stripe escalonado que hace falta leer. */
export interface TramoDeStripe {
  up_to: number | null;
  flat_amount: number | null;
  unit_amount: number | null;
}

/**
 * La tarifa del plan de equipo leída de su Price de Stripe («graduated», dos
 * tramos). Devuelve `null` si el Price no tiene la forma esperada: quien llama
 * cae al respaldo y AVISA, en vez de pintar una cifra inventada.
 */
export function tarifaDeEquipoDesdeTramos(
  tramos: readonly TramoDeStripe[] | null | undefined,
  currency: string,
): TarifaDePlan | null {
  if (!tramos || tramos.length !== 2) return null;
  const [incluidos, extra] = tramos as [TramoDeStripe, TramoDeStripe];
  if (typeof incluidos.up_to !== "number" || incluidos.up_to < 1 || extra.up_to !== null) return null;
  if (typeof extra.unit_amount !== "number") return null;
  // Lo que cuesta el primer tramo entero: su fija más su unitario por cada asiento incluido.
  const fija = (incluidos.flat_amount ?? 0) + (incluidos.unit_amount ?? 0) * incluidos.up_to;
  return { fijaCentimos: fija, asientosIncluidos: incluidos.up_to, asientoCentimos: extra.unit_amount, currency };
}

// ─────────────────────────────────────────────────────────────────────────────
// EL CÁLCULO DE LO QUE SE COBRA
// ─────────────────────────────────────────────────────────────────────────────

export interface LineaDeCuota {
  concepto: "cuota_fija" | "asientos";
  cantidad: number;
  unitarioCentimos: number;
  importeCentimos: number;
}

export interface CuotaCalculada {
  /** Asientos que cubre la suscripción (los incluidos como mínimo en Equipo). */
  asientosCubiertos: number;
  /** Asientos que se pagan a precio unitario (todos en Pro/comisión; los extra en Equipo). */
  asientosAPrecioUnitario: number;
  lineas: LineaDeCuota[];
  totalCentimos: number;
  currency: string;
}

/**
 * La cuota de un período: lo que Stripe cobra por la suscripción. Espejo del
 * Price — el cobro lo hace Stripe; esto sirve para enseñar, para cuadrar y
 * para los tests.
 *
 * En Equipo, por debajo de los incluidos se cobra igual la cuota fija (y el
 * checkout no deja comprar menos): los asientos cubiertos son los incluidos.
 */
export function calcularCuota(tarifa: TarifaDePlan, asientosPedidos: number): CuotaCalculada {
  const asientos = Math.max(1, Math.floor(Number.isFinite(asientosPedidos) ? asientosPedidos : 1));
  const cubiertos = Math.max(asientos, tarifa.asientosIncluidos);
  const unitarios = cubiertos - tarifa.asientosIncluidos;
  const lineas: LineaDeCuota[] = [];
  if (tarifa.asientosIncluidos > 0) {
    lineas.push({
      concepto: "cuota_fija",
      cantidad: tarifa.asientosIncluidos,
      unitarioCentimos: 0,
      importeCentimos: tarifa.fijaCentimos,
    });
  }
  if (unitarios > 0) {
    lineas.push({
      concepto: "asientos",
      cantidad: unitarios,
      unitarioCentimos: tarifa.asientoCentimos,
      importeCentimos: unitarios * tarifa.asientoCentimos,
    });
  }
  return {
    asientosCubiertos: cubiertos,
    asientosAPrecioUnitario: unitarios,
    lineas,
    totalCentimos: lineas.reduce((s, l) => s + l.importeCentimos, 0),
    currency: tarifa.currency,
  };
}

export interface CobroDelPeriodo {
  plan: PlanDePago;
  cuota: CuotaCalculada;
  /**
   * La comisión del período, SOLO en la modalidad «comision»: la de tarifa.ts,
   * sin tocar. `null` en Pro y Equipo — no «0»: no es que salga cero, es que
   * el plan no la lleva.
   */
  comision: ComisionCalculada | null;
  /** La comisión en EUR (0 si el plan no la lleva). Va en una factura aparte. */
  comisionEur: number;
}

/**
 * Lo que se cobra en un período: la cuota del plan y, solo si el plan la
 * lleva, la comisión sobre el ahorro medido. La comisión se calcula con
 * `calcularComision` de tarifa.ts — la misma función que el cierre — así que
 * quien la tiene hoy no nota nada.
 *
 * `ahorro` es la base y el ahorro medidos del período YA EN EUR, como los
 * deja el cierre (cierre.ts convierte con fx.ts). Calibración y exención las
 * resuelve el cierre antes: aquí no se repiten.
 */
export function calcularCobroDelPeriodo(entrada: {
  plan: PlanDePago;
  tarifa: TarifaDePlan;
  asientos: number;
  ahorro?: { baseMedidaEur: number; ahorroMedidoEur: number } | null;
}): CobroDelPeriodo {
  const cuota = calcularCuota(entrada.tarifa, entrada.asientos);
  if (!llevaComision(entrada.plan)) return { plan: entrada.plan, cuota, comision: null, comisionEur: 0 };
  const comision = calcularComision(entrada.ahorro?.baseMedidaEur ?? 0, entrada.ahorro?.ahorroMedidoEur ?? 0);
  return { plan: entrada.plan, cuota, comision, comisionEur: redondearCentimos(comision.comisionEur) };
}

// ─────────────────────────────────────────────────────────────────────────────
// DE QUÉ PLAN ES UN PRICE
// ─────────────────────────────────────────────────────────────────────────────

/** Los price ids configurados de cada plan (vacíos si el despliegue no los tiene). */
export interface PreciosConfigurados {
  pro: readonly string[];
  equipo: readonly string[];
}

/**
 * El plan de una suscripción, por el price id de su primer item.
 *
 * ⛔ Lo que NO es Pro ni Equipo es «comision», A PROPÓSITO: los Prices de
 * siempre (STRIPE_PRICE_ID_MONTHLY/YEARLY), los de STRIPE_PRICE_IDS_EXTRA y un
 * price id desconocido siguen llevando la comisión exactamente como hoy. Solo
 * se deja de cobrar comisión a una suscripción cuyo Price está en la lista
 * explícita de los planes planos — nunca por un metadato o por omisión.
 */
export function planDelPrecio(priceId: string | null | undefined, precios: PreciosConfigurados): PlanDePago {
  if (priceId && precios.pro.includes(priceId)) return "pro";
  if (priceId && precios.equipo.includes(priceId)) return "equipo";
  return "comision";
}
