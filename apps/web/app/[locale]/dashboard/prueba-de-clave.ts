/**
 * Qué significa cada respuesta de la sonda «Test my key» (paso 2 de
 * /dashboard/install). La sonda manda un lote VACÍO a /api/metering/usage con la
 * `bvk_`: autentica la clave sin escribir uso.
 *
 *  · 202 → la clave vale y la org puede reportar uso.
 *  · 401 → la clave no existe (borrada, revocada o mal copiada).
 *  · 402 → la clave SÍ es de la org, pero la org no tiene licencia ni suscripción
 *          que la cubra, así que la ingesta le rechaza el uso. No es una clave
 *          mala ni un fallo pasajero —reintentar no lo cura—: se arregla
 *          suscribiéndose o renovando en Cuenta.
 *  · cualquier otro → inesperado (5xx, 400…), y ese sí puede ser pasajero.
 *
 * El 402 ya lo recibían las orgs revocadas o caducadas, y el panel lo pintaba
 * como «Unexpected response (402). Try again in a moment.». Desde que la org que
 * NUNCA tuvo licencia también se bloquea (no hay free tier; ver
 * `decideEntitlement`), lo ve además quien crea la clave ANTES de suscribirse,
 * que es justo el orden que el panel propone. Por eso tiene estado propio.
 *
 * Lo que NO se hace es dejar pasar el lote vacío con un 202 antes del candado:
 * el panel diría entonces «your SDK can report usage with this key», que para
 * esa org es falso.
 */
export type EstadoDeLaPrueba = "valid" | "invalid" | "noPlan" | "error";

export function estadoDeLaPrueba(status: number): EstadoDeLaPrueba {
  if (status === 202) return "valid";
  if (status === 401) return "invalid";
  if (status === 402) return "noPlan";
  return "error";
}
