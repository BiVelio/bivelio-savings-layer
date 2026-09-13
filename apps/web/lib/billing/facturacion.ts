/**
 * LA DECISIÓN DE FACTURAR, como función pura — el cron solo la ejecuta.
 *
 * Cierra el hueco del modelo a comisión: el cierre mensual fija `cargo_eur` en
 * bvsala.extractos (0016) y ahí se quedaba — nada convertía ese cargo en una
 * factura. Esta pieza decide, para cada extracto cerrado, si toca facturar y
 * exactamente cuánto; la ejecución contra Stripe vive en
 * `app/api/cron/facturar-extractos` y el estado del cobro en bvsala.cargos
 * (0017).
 *
 * Doctrina heredada del extracto y de la tarifa:
 *   · Se factura EL CARGO DEL EXTRACTO, céntimo a céntimo. La factura no
 *     recalcula nada: cita un documento inmutable ya fijado. Por eso la línea
 *     lleva (org, período) en metadata y el desglose en la descripción.
 *   · Calibración jamás factura (el extracto ya lo garantiza con cargo=0, y
 *     aquí se comprueba IGUALMENTE: dos verjas valen más que una).
 *   · La factura la GENERA Stripe con los datos del período — numeración, PDF
 *     e impuestos suyos. Aquí no hay ninguna plantilla con importes escritos.
 */

import type { FilaDeCierre } from "./cierre";

/**
 * Por debajo de esto no se puede cobrar en automático: el mínimo de un cargo
 * con tarjeta en EUR es 0,50 € (límite de Stripe, no nuestro). Se deja rastro
 * (`omitido_bajo_minimo`) en vez de acumularlo a otro mes: inventar arrastres
 * cambiaría el extracto de un período con dinero de otro.
 */
export const MINIMO_FACTURABLE_EUR = 0.5;

/** El subconjunto del extracto del que depende la decisión. */
export type ExtractoFacturable = Pick<
  FilaDeCierre,
  "org_id" | "periodo" | "es_calibracion" | "cargo_eur" | "ahorro_medido_eur" | "base_medida_eur" | "ratio"
>;

export type DecisionDeCargo =
  /** Nada que facturar: cargo 0 o período de calibración. */
  | { accion: "nada"; motivo: "sin_cargo" | "calibracion" }
  /** Ya hay fila de cargo para (org, período): no se toca. */
  | { accion: "nada"; motivo: "ya_facturado" }
  /** Hay cargo pero no se puede facturar; se deja constancia. */
  | { accion: "omitir"; estado: "omitido_sin_cliente" | "omitido_bajo_minimo" }
  /** Facturar exactamente estos céntimos a este cliente. */
  | { accion: "facturar"; centimos: number; clienteStripe: string };

export function decidirCargo(
  extracto: ExtractoFacturable,
  clienteStripe: string | null,
  yaHayCargo: boolean,
): DecisionDeCargo {
  if (yaHayCargo) return { accion: "nada", motivo: "ya_facturado" };
  if (extracto.es_calibracion) return { accion: "nada", motivo: "calibracion" };
  const centimos = Math.round(extracto.cargo_eur * 100);
  if (centimos <= 0) return { accion: "nada", motivo: "sin_cargo" };
  if (!clienteStripe) return { accion: "omitir", estado: "omitido_sin_cliente" };
  if (extracto.cargo_eur < MINIMO_FACTURABLE_EUR) return { accion: "omitir", estado: "omitido_bajo_minimo" };
  return { accion: "facturar", centimos, clienteStripe };
}

/**
 * La clave de idempotencia de Stripe para el cargo de un período. Versionada:
 * si algún día cambia la FORMA de facturar (no la cifra), se sube el sufijo y
 * las claves viejas no chocan.
 */
export function claveIdempotencia(orgId: string, periodo: string, pieza: "factura" | "linea"): string {
  return `bvsala-cargo-${orgId}-${periodo}-${pieza}-v1`;
}

/** El valor de metadata que marca una factura como cargo de comisión. */
export const TIPO_FACTURA_COMISION = "comision-ahorro";

/** ¿Es esta factura de Stripe un cargo de comisión nuestro? (para el webhook) */
export function esFacturaDeComision(metadata: Record<string, string> | null | undefined): boolean {
  return metadata?.["bvsala_tipo"] === TIPO_FACTURA_COMISION;
}

/**
 * La línea de la factura, generada desde el extracto — no hay plantilla con
 * cifras: cada dato sale del documento cerrado que la factura cita. En inglés,
 * como el resto de textos que salen del producto hacia el cliente final
 * (los recibos de Stripe no se localizan por org todavía).
 */
export function descripcionDeLinea(e: ExtractoFacturable): string {
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
  const eur = (n: number): string => `€${n.toFixed(2)}`;
  return (
    `BV-SALA savings commission — period ${e.periodo}. ` +
    `Measured baseline ${eur(e.base_medida_eur)}, measured savings ${eur(e.ahorro_medido_eur)} ` +
    `(${pct(e.ratio)} of baseline). Commission per the published tiered rate on verified savings only; ` +
    `full statement in your dashboard (Billing → ${e.periodo}).`
  );
}

/** Metadata de la factura y de la línea: lo que el webhook y el panel leen. */
export function metadataDeFactura(e: ExtractoFacturable): Record<string, string> {
  return {
    bvsala_tipo: TIPO_FACTURA_COMISION,
    bvsala_org_id: e.org_id,
    bvsala_periodo: e.periodo,
  };
}

/**
 * LA DECISIÓN de la guardia de orden de la comisión, en puro. Stripe reentrega
 * eventos días y sin orden: un `invoice.payment_failed` reentregado tarde podía
 * llegar DESPUÉS de un `invoice.paid` ya aplicado. `pagado` es TERMINAL para ese
 * cobro (un retry que prospera emite `paid`), así que un `fallido` solo se
 * aplica si el cargo no está ya pagado (el update lleva `.neq(estado,'pagado')`).
 * `aplicado` = si ese update tocó alguna fila. Sin esto, un `fallido` frenado por
 * la verja seguía disparando la alerta crítica de «cobro fallido» por un cargo
 * que SÍ se cobró.
 */
export function decisionDeComision(
  estado: "pagado" | "fallido",
  aplicado: boolean,
): { alertarFallo: boolean; auditKind: string } {
  if (estado === "fallido" && !aplicado) {
    return { alertarFallo: false, auditKind: "comision_fallido_ignorado_ya_pagado" };
  }
  if (estado === "fallido") return { alertarFallo: true, auditKind: "comision_fallido" };
  return { alertarFallo: false, auditKind: "comision_pagado" };
}

/**
 * EL MEDIO DE PAGO DE LA FACTURA DE COMISIÓN. Una factura suelta (sin
 * `subscription`) se cobra contra el medio de pago predeterminado PARA
 * FACTURAS del cliente, y Checkout en modo suscripción NO lo fija: fija el de
 * la SUSCRIPCIÓN. Sin pasarlo explícitamente, la primera factura del día 1
 * salía sin medio de pago, quedaba `open`, el cobro fallaba y saltaba la
 * alerta de cobro fallido por un cliente que sí había dado su tarjeta.
 *
 * Orden: el de la suscripción de asientos (lo que el cliente dio en Checkout),
 * si no el predeterminado del cliente, si no ninguno — y «ninguno» se GRITA
 * antes de emitir, no se descubre en la alerta de impago.
 */
export type MedioDePago = { id: string; origen: "suscripcion" | "cliente" } | null;

/** Lo que Stripe devuelve para un medio de pago: un id, el objeto expandido, o nada. */
type RefDeMedio = string | { id: string } | null | undefined;

export interface FuentesDeMedioDePago {
  suscripcion?: { default_payment_method?: RefDeMedio } | null;
  cliente?: { invoice_settings?: { default_payment_method?: RefDeMedio } | null } | null;
}

function idDeMedio(ref: RefDeMedio): string | null {
  if (!ref) return null;
  return typeof ref === "string" ? ref : ref.id;
}

export function medioDePagoParaLaFactura(f: FuentesDeMedioDePago): MedioDePago {
  const deSuscripcion = idDeMedio(f.suscripcion?.default_payment_method);
  if (deSuscripcion) return { id: deSuscripcion, origen: "suscripcion" };
  const deCliente = idDeMedio(f.cliente?.invoice_settings?.default_payment_method);
  if (deCliente) return { id: deCliente, origen: "cliente" };
  return null;
}

/**
 * EL ENSAYO EN SECO de un cargo (`?seco=1` en el cron): lo que se haría con
 * este extracto, sin hacerlo. Es lo que se lee a finales de mes para saber si
 * el primer día 1 real va a salir bien, en vez de descubrirlo esa mañana.
 */
export interface EnsayoDeCargo {
  org_id: string;
  periodo: string;
  cargo_eur: number;
  accion: "facturar" | "omitir" | "nada" | "exenta";
  detalle: string;
  centimos: number | null;
  cliente: string | null;
  medio_de_pago: "suscripcion" | "cliente" | "ninguno" | null;
}

export function ensayoDeCargo(
  e: ExtractoFacturable,
  decision: DecisionDeCargo | "exenta",
  medio: MedioDePago | undefined,
): EnsayoDeCargo {
  const base = { org_id: e.org_id, periodo: e.periodo, cargo_eur: e.cargo_eur };
  if (decision === "exenta") {
    return { ...base, accion: "exenta", detalle: "organización exenta de comisión", centimos: null, cliente: null, medio_de_pago: null };
  }
  if (decision.accion === "nada") return { ...base, accion: "nada", detalle: decision.motivo, centimos: null, cliente: null, medio_de_pago: null };
  if (decision.accion === "omitir") return { ...base, accion: "omitir", detalle: decision.estado, centimos: null, cliente: null, medio_de_pago: null };
  return {
    ...base,
    accion: "facturar",
    detalle: medio ? `se cobraría al medio de pago de la ${medio.origen}` : "SIN medio de pago: la factura quedaría abierta",
    centimos: decision.centimos,
    cliente: decision.clienteStripe,
    medio_de_pago: medio ? medio.origen : "ninguno",
  };
}
