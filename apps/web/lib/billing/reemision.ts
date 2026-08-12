/**
 * ¿Hay que re-emitir la licencia tras un cambio en la suscripción?
 *
 * QUÉ ARREGLA. La condición era `f.quantity !== cur.seats`: solo se re-emitía al
 * cambiar los ASIENTOS. Y `handleInvoicePaid` ignora toda factura que no sea
 * `subscription_cycle`, delegando en `ensurePrimeraLicencia`, que no hace nada si
 * ya hay una licencia viva. Entre las dos dejaban un agujero de dinero:
 *
 *   Un cliente pasa de 4 €/mes a 39 €/año con los mismos asientos. La cantidad NO
 *   cambia, así que nadie re-emite — y su licencia conserva la caducidad MENSUAL.
 *   Ha pagado doce meses y el SDK se le para hacia el día 51.
 *
 * La regla correcta no es "cambiaron los asientos" sino **la licencia tiene que
 * seguir a la suscripción**: si lo que la licencia promete (asientos, caducidad)
 * ya no es lo que el cliente ha pagado, se re-emite. Así queda cubierto también
 * cualquier otro camino que mueva el periodo y que hoy no conocemos.
 */

/**
 * Tolerancia al comparar caducidades. La licencia se emite con
 * `new Date(periodEnd * 1000).toISOString()`, así que normalmente coinciden al
 * milisegundo; el margen evita re-emitir en bucle por un redondeo si alguna vez
 * dejan de hacerlo. Un minuto es indistinguible para el cliente y suficiente
 * para no disparar sobre ruido.
 */
const TOLERANCIA_MS = 60_000;

export interface EntradaReemision {
  /** Asientos que la suscripción dice ahora. */
  asientosNuevos: number;
  /** Fin de periodo de la suscripción (unix segundos), o null si Stripe no lo da. */
  finDePeriodoUnix: number | null;
  /** La licencia viva, o null si no hay ninguna. */
  licencia: { seats: number; expiresAt: string | null } | null;
}

export type MotivoReemision = "asientos" | "periodo" | null;

/**
 * Devuelve POR QUÉ hay que re-emitir, o `null` si no hace falta. Se devuelve el
 * motivo y no un booleano para que quede en el rastro de auditoría: sin él, un
 * pico de re-emisiones no se puede diagnosticar después.
 */
export function motivoDeReemision({
  asientosNuevos,
  finDePeriodoUnix,
  licencia,
}: EntradaReemision): MotivoReemision {
  if (!licencia) return null; // sin licencia viva no se re-emite: se EMITE, por otro camino

  if (asientosNuevos !== licencia.seats) return "asientos";

  // Sin fecha en alguno de los dos lados no se puede comparar, y ante la duda NO
  // se re-emite: una re-emisión de más rota la continuidad del token del cliente
  // sin ganar nada.
  if (finDePeriodoUnix == null || !licencia.expiresAt) return null;
  const caducidadActual = Date.parse(licencia.expiresAt);
  if (Number.isNaN(caducidadActual)) return null;

  const finNuevo = finDePeriodoUnix * 1000;
  return Math.abs(finNuevo - caducidadActual) > TOLERANCIA_MS ? "periodo" : null;
}
