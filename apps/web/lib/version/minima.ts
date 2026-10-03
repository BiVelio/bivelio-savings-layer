/**
 * Espejo de `VERSION_MINIMA_PALANCA_TARIFA` (src/version.ts). La web no importa
 * del SDK, así que la constante se copia y `minima.test.ts` lee el fuente del
 * SDK como TEXTO y afirma la igualdad — el mismo mecanismo que ata la clave
 * pública (lib/license/clave-esperada.test.ts). NUNCA un literal suelto en un
 * componente: solo se cambia aquí y en el SDK, a la vez, en el PR de release.
 *
 * Qué significa: la primera versión publicada con la palanca facturable de
 * tarifa. El panel la usa para EXPLICAR («esta versión no lleva la palanca:
 * actualiza»); la decisión de avisar la toma el dinero medido por asiento.
 */
export const VERSION_MINIMA_PALANCA_TARIFA = "0.4.16";

/**
 * Espejo de `VERSION_MINIMA_AHORRO_NETO` (src/version.ts), con el mismo test de
 * paridad. La primera versión cuyo gateway informa el ahorro de la rebaja de
 * TTL en NETO (resta los fallos de caché que la rebaja provoca). Por debajo, lo
 * que la máquina informa es el bruto, y el panel lo etiqueta.
 */
export const VERSION_MINIMA_AHORRO_NETO = "0.5.1";
