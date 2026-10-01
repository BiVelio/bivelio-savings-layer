/**
 * EL COBRO DE LOS ASIENTOS USADOS DE MÁS — la decisión, como función pura; el
 * cron (`app/api/cron/cobrar-asientos`) solo la ejecuta.
 *
 * Decisión del dueño (2026-09-30, «(a)»): lo que seat-reconciliation.ts DETECTA
 * —un cliente que usa más asientos de los que paga— se COBRA solo, una vez por
 * mes cerrado, con la misma doctrina que la comisión (facturacion.ts, cierre.ts):
 *
 *   · Se cobra el mes CERRADO, el día 1, y una sola vez: la fila (org, período)
 *     de bvsala.ajustes_asientos (0034) se escribe ANTES de tocar Stripe, y las
 *     claves de idempotencia de Stripe son el segundo candado.
 *   · El importe es precio(usados) − precio(pagados) con la tarifa REAL del
 *     plan de esa suscripción (`PRECIOS_DE_LOS_PLANES`; la modalidad antigua,
 *     `PRECIO_RESPALDO`), llevado a UN mes: el anual, entre 12. Aquí no hay
 *     ninguna cifra escrita a mano.
 *   · Si el recuento no es de fiar (volumen implausible por asiento, o una
 *     rotación de clave que duplica los seat_id del mes) NO se cobra: revisión
 *     humana. Cobrar de más por una heurística es peor que no cobrar.
 *   · Por debajo del mínimo de Stripe (0,50 €) no se cobra ni se arrastra.
 */

import { MINIMO_FACTURABLE_EUR } from "./facturacion";
import {
  calcularCuota,
  PRECIOS_DE_LOS_PLANES,
  tarifaPorAsiento,
  type ImporteEnCentimos,
  type PeriodoDePago,
  type PlanDePago,
  type TarifaDePlan,
} from "./planes";
import { reconcileSeats } from "./seat-reconciliation";

/** Los estados de una fila de bvsala.ajustes_asientos (el CHECK de 0034). */
export const ESTADOS_DE_AJUSTE = [
  "seco",
  "pendiente",
  "cobrado",
  "fallido",
  "revision_humana",
  "omitido_bajo_minimo",
  "omitido_sin_precio",
  "omitido_no_activa",
] as const;
export type EstadoDeAjuste = (typeof ESTADOS_DE_AJUSTE)[number];

/**
 * Estados en los que el cron ya NO vuelve a tocar la fila. `pendiente` y
 * `fallido` se reintentan (con las cifras de la fila, no recalculadas); `seco`
 * se recalcula y se sustituye (es un ensayo, no un compromiso).
 */
export const ESTADOS_FINALES: readonly EstadoDeAjuste[] = [
  "cobrado",
  "revision_humana",
  "omitido_bajo_minimo",
  "omitido_sin_precio",
  "omitido_no_activa",
];

export function esEstadoFinal(estado: string): boolean {
  return (ESTADOS_FINALES as readonly string[]).includes(estado);
}

// ─────────────────────────────────────────────────────────────────────────────
// LA TARIFA DE UNA SUSCRIPCIÓN
// ─────────────────────────────────────────────────────────────────────────────

/** Los price ids configurados por plan y período (vacíos si el despliegue no los tiene). */
export type PreciosPorPeriodo = Record<PlanDePago, Record<PeriodoDePago, string>>;

/**
 * El plan y el período de pago de una suscripción, por su price id. `null` si
 * el price no es ninguno de los configurados (p. ej. uno de
 * STRIPE_PRICE_IDS_EXTRA): sin saber el período no se sabe el precio, y sin
 * precio no se cobra (`omitido_sin_precio`) — nunca se supone uno.
 */
export function planYPeriodoDelPrecio(
  priceId: string | null | undefined,
  precios: PreciosPorPeriodo,
): { plan: PlanDePago; periodoPago: PeriodoDePago } | null {
  if (!priceId) return null;
  for (const plan of ["pro", "equipo", "comision"] as const) {
    for (const periodoPago of ["monthly", "yearly"] as const) {
      if (precios[plan][periodoPago] && precios[plan][periodoPago] === priceId) return { plan, periodoPago };
    }
  }
  return null;
}

/**
 * La tarifa de un plan en un período. Pro y Equipo, de `PRECIOS_DE_LOS_PLANES`;
 * la modalidad antigua por asiento («comision»), de su precio de respaldo
 * (`PRECIO_RESPALDO` de lib/stripe/pricing.ts), que quien llama pasa: este
 * módulo es puro y no arrastra la caché de Next.
 */
export function tarifaDelPlan(
  plan: PlanDePago,
  periodoPago: PeriodoDePago,
  respaldoComision: Record<PeriodoDePago, ImporteEnCentimos>,
): TarifaDePlan {
  if (plan === "comision") return tarifaPorAsiento(respaldoComision[periodoPago]);
  return PRECIOS_DE_LOS_PLANES[plan][periodoPago];
}

/**
 * EL IMPORTE DEL EXCESO, en céntimos: precio(usados) − precio(pagados) de UN
 * mes. Con `calcularCuota`, la misma función que espeja el Price de Stripe, así
 * que en Equipo los 10 incluidos salen solos (por debajo de 10 no hay exceso;
 * por encima, cada extra a su precio). El anual se lleva a un mes dividiendo
 * entre 12 y redondeando al céntimo: el ajuste es de UN mes cerrado.
 */
export function importeDelExceso(entrada: {
  tarifa: TarifaDePlan;
  periodoPago: PeriodoDePago;
  usados: number;
  pagados: number;
}): { exceso: number; centimos: number } {
  const usados = Math.max(0, Math.floor(entrada.usados));
  const pagados = Math.max(0, Math.floor(entrada.pagados));
  const exceso = Math.max(0, usados - pagados);
  if (exceso === 0) return { exceso: 0, centimos: 0 };
  const cuota = (n: number): number => (n <= 0 ? 0 : calcularCuota(entrada.tarifa, n).totalCentimos);
  const diferencia = Math.max(0, cuota(usados) - cuota(pagados));
  const centimos = entrada.periodoPago === "yearly" ? Math.round(diferencia / 12) : diferencia;
  return { exceso, centimos };
}

// ─────────────────────────────────────────────────────────────────────────────
// LA DECISIÓN
// ─────────────────────────────────────────────────────────────────────────────

export interface EntradaDeAjuste {
  /** `bvsala.billable_seats` del mes cerrado. */
  usados: number;
  /** La `quantity` de la suscripción (espejo de Stripe en bvsala.subscriptions.seats). */
  pagados: number;
  /** Peticiones del mes (contraste de volumen de seat-reconciliation.ts). */
  requests: number;
  /** Estado de la suscripción. Solo `active` se cobra. */
  status: string;
  /** Plan y período, o `null` si el price no es uno configurado. */
  plan: { plan: PlanDePago; periodoPago: PeriodoDePago } | null;
  /** ¿Se revocó una clave de servicio en el mes? Duplica los seat_id (ver asientos.ts). */
  rotacionEnElMes: boolean;
  /** ¿Tiene la org más de una suscripción viva? No se sabe cuál paga qué. */
  variasSuscripciones: boolean;
  /**
   * `organizations.comision_exenta` (0028): probadores con cupón del 100 % y
   * cuentas de cortesía, SIN tarjeta. Un exceso suyo nunca se cobra solo.
   */
  comisionExenta: boolean;
  respaldoComision: Record<PeriodoDePago, ImporteEnCentimos>;
}

export type DecisionDeAjuste =
  /** Dentro de lo pagado y recuento fiable: ni fila ni cobro. */
  | { accion: "nada"; exceso: 0; centimos: 0; motivo: string }
  /** Se deja fila con este estado y no se cobra. */
  | {
      accion: "registrar";
      estado: "revision_humana" | "omitido_bajo_minimo" | "omitido_sin_precio" | "omitido_no_activa";
      exceso: number;
      centimos: number;
      motivo: string;
    }
  /** Cobrar exactamente estos céntimos. */
  | { accion: "cobrar"; exceso: number; centimos: number; motivo: string };

/** El motivo de la revisión de una org exenta (probador o cortesía, sin tarjeta). */
export const MOTIVO_EXENTA =
  "exempt org (organizations.comision_exenta): tester/courtesy account without a card on file; never auto-charged";

export function decidirAjuste(e: EntradaDeAjuste): DecisionDeAjuste {
  const usados = Math.max(0, Math.floor(e.usados));
  const pagados = Math.max(0, Math.floor(e.pagados));
  const exceso = Math.max(0, usados - pagados);
  const importe = (): number =>
    e.plan
      ? importeDelExceso({
          tarifa: tarifaDelPlan(e.plan.plan, e.plan.periodoPago, e.respaldoComision),
          periodoPago: e.plan.periodoPago,
          usados,
          pagados,
        }).centimos
      : 0;

  // 1) ¿Es fiable el recuento? El contraste de volumen es el de siempre
  //    (seat-reconciliation.ts): si dispara, se revisa aunque NO haya exceso —
  //    el colapso de seat_id INFRA-declara, así que el caso a cazar es justo
  //    ese, con usados ≤ pagados.
  const rec = reconcileSeats({ usedSeats: usados, paidSeats: pagados, requests: e.requests });
  if (rec.action === "review") {
    return { accion: "registrar", estado: "revision_humana", exceso, centimos: importe(), motivo: `volume: ${rec.detail}` };
  }
  if (exceso === 0) return { accion: "nada", exceso: 0, centimos: 0, motivo: rec.detail };
  // Equipo con menos de los incluidos pagados (el checkout no lo deja, pero una
  // suscripción antigua podría): los incluidos ya cubren esos asientos.
  if (e.plan && importe() === 0) {
    return { accion: "nada", exceso: 0, centimos: 0, motivo: "extra seats covered by the plan's included seats" };
  }
  // Una org EXENTA (0028) no tiene tarjeta: un invoice item de cobro automático
  // acabaría en factura impagada y recordatorios de cobro — justo lo que 0028
  // existe para evitar. Su exceso lo mira un humano; nunca se cobra solo.
  if (e.comisionExenta) {
    return { accion: "registrar", estado: "revision_humana", exceso, centimos: importe(), motivo: MOTIVO_EXENTA };
  }
  // Rotar una clave estrena el seat_id de TODAS las máquinas, que dentro del
  // mes cuentan dos veces. Cobrarle a alguien por protegerse es la peor factura.
  if (e.rotacionEnElMes) {
    return {
      accion: "registrar",
      estado: "revision_humana",
      exceso,
      centimos: importe(),
      motivo: "rotation: a service-account key was revoked this month; seat ids were re-minted and count twice",
    };
  }
  if (e.variasSuscripciones) {
    return { accion: "registrar", estado: "revision_humana", exceso, centimos: importe(), motivo: "several live subscriptions" };
  }

  // 2) ¿Se puede cobrar?
  if (e.status !== "active") {
    return { accion: "registrar", estado: "omitido_no_activa", exceso, centimos: importe(), motivo: `subscription ${e.status}` };
  }
  if (!e.plan) {
    return { accion: "registrar", estado: "omitido_sin_precio", exceso, centimos: 0, motivo: "price not configured: plan price unknown" };
  }
  const centimos = importe();
  if (centimos < Math.round(MINIMO_FACTURABLE_EUR * 100)) {
    return { accion: "registrar", estado: "omitido_bajo_minimo", exceso, centimos, motivo: `below Stripe minimum (${centimos} cents)` };
  }
  return { accion: "cobrar", exceso, centimos, motivo: rec.detail };
}

// ─────────────────────────────────────────────────────────────────────────────
// LO QUE VE STRIPE
// ─────────────────────────────────────────────────────────────────────────────

/** El valor de metadata que marca un invoice item como ajuste de asientos. */
export const TIPO_AJUSTE_ASIENTOS = "ajuste-asientos";

/**
 * La clave de idempotencia de Stripe por (org, período, pieza). Versionada como
 * la de la comisión (`claveIdempotencia` de facturacion.ts), con otro prefijo:
 * las dos no pueden chocar.
 */
export function claveIdempotenciaAsientos(orgId: string, periodo: string, pieza: "item" | "cantidad" | "factura"): string {
  return `bvsala-asientos-${orgId}-${periodo}-${pieza}-v1`;
}

export interface AjusteParaStripe {
  orgId: string;
  periodo: string;
  plan: PlanDePago;
  periodoPago: PeriodoDePago;
  usados: number;
  pagados: number;
  exceso: number;
  centimos: number;
}

export function metadataDelAjuste(a: AjusteParaStripe): Record<string, string> {
  return {
    bvsala_tipo: TIPO_AJUSTE_ASIENTOS,
    bvsala_org_id: a.orgId,
    bvsala_periodo: a.periodo,
    bvsala_usados: String(a.usados),
    bvsala_pagados: String(a.pagados),
    bvsala_exceso: String(a.exceso),
  };
}

/** ¿Es este invoice item el ajuste de asientos de (org, período)? Para el reintento. */
export function esItemDelAjuste(metadata: Record<string, string> | null | undefined, orgId: string, periodo: string): boolean {
  return (
    metadata?.["bvsala_tipo"] === TIPO_AJUSTE_ASIENTOS &&
    metadata["bvsala_org_id"] === orgId &&
    metadata["bvsala_periodo"] === periodo
  );
}

const NOMBRE_DEL_PLAN: Record<PlanDePago, string> = { pro: "Pro", equipo: "Team", comision: "per-seat" };

/**
 * La línea de la factura, legible. En inglés, como la de la comisión (los
 * recibos de Stripe no se localizan por org todavía). Cada cifra sale del
 * ajuste: no hay plantilla con importes.
 */
export function descripcionDelAjuste(a: AjusteParaStripe): string {
  const eur = (c: number): string => `€${(c / 100).toFixed(2)}`;
  const ciclo = a.periodoPago === "yearly" ? " (yearly price ÷ 12)" : "";
  return (
    `BV-SALA seats used above your subscription — period ${a.periodo}. ` +
    `${a.usados} seats in use (active on at least 3 distinct days, CI excluded), ${a.pagados} paid for: ` +
    `${a.exceso} extra seat${a.exceso === 1 ? "" : "s"} for one month on the ${NOMBRE_DEL_PLAN[a.plan]} plan${ciclo}, ${eur(a.centimos)}.`
  );
}

/**
 * HACIA DELANTE: qué se hace con la suscripción además de cobrar el mes pasado.
 *
 *   · MENSUAL: la `quantity` sube a los asientos usados con
 *     `proration_behavior: "none"` —el mes pasado ya lo cobra el invoice item;
 *     prorratear lo cobraría dos veces— y el item va a la PRÓXIMA factura de la
 *     suscripción (≤ un mes).
 *   · ANUAL: la `quantity` NO se toca. Subirla sin prorrateo regalaría los
 *     asientos hasta la renovación (el mes siguiente usados = pagados y ya no hay
 *     exceso que cobrar); prorratearla cobraría el resto del año de golpe sin que
 *     nadie lo haya pedido. Así el exceso se sigue cobrando MES A MES, a
 *     anual/12, lo que cuesta de verdad. Y como la próxima factura de una anual
 *     puede estar a once meses, el item se factura YA, en una factura de la
 *     propia suscripción.
 */
export function comportamientoHaciaDelante(periodoPago: PeriodoDePago): {
  subirCantidad: boolean;
  facturarYa: boolean;
} {
  return periodoPago === "monthly" ? { subirCantidad: true, facturarYa: false } : { subirCantidad: false, facturarYa: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// EL MODO
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `seco` salvo que BVSALA_COBRO_ASIENTOS sea EXACTAMENTE `vivo` y la petición no
 * pida `?seco=1`. Cualquier otro valor (vacío, una errata) es seco: el error
 * barato es no cobrar un mes, no cobrar sin querer.
 */
export function modoDeCobro(variable: string | undefined, secoPedido: boolean): "seco" | "vivo" {
  if (secoPedido) return "seco";
  return (variable ?? "").trim() === "vivo" ? "vivo" : "seco";
}

// ─────────────────────────────────────────────────────────────────────────────
// EL RESUMEN DE CADA PASADA
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lo auditable de una pasada, aunque nadie deba nada: el informe completo solo
 * vive en la respuesta HTTP, así que cada ejecución deja además UNA línea en el
 * log con recuentos (nunca correos ni nombres; ni siquiera ids de org).
 */
export interface ResumenDeCobro {
  periodo: string;
  modo: "seco" | "vivo";
  /** Organizaciones evaluadas en la pasada. */
  evaluadas: number;
  /** A cobrar: `cobraria` en seco, cobros intentados en vivo. */
  aCobrar: number;
  /** Enviadas a revisión humana (incluidas las exentas con exceso). */
  revision: number;
  /** Evaluadas con `organizations.comision_exenta`. */
  exentas: number;
  /** Cobradas de verdad (siempre 0 en seco). */
  cobrados: number;
  fallos: number;
  /** El total de lo que se cobra (o se cobraría), en céntimos. */
  totalCentimos: number;
}

export function lineaDeResumen(r: ResumenDeCobro): string {
  return (
    `[cobrar-asientos] resumen periodo=${r.periodo} modo=${r.modo} evaluadas=${r.evaluadas} ` +
    `a_cobrar=${r.aCobrar} revision=${r.revision} exentas=${r.exentas} cobrados=${r.cobrados} ` +
    `fallos=${r.fallos} total_eur=${(r.totalCentimos / 100).toFixed(2)}`
  );
}
