/**
 * LO PÚBLICO DE LA LICENCIA «MEDIR»: sus topes y la versión mínima del paquete.
 *
 * Sin dependencias a propósito: lo importan la portada, /pricing, /signup y el
 * pie, que no deben arrastrar la firma de licencias ni el cliente de Supabase
 * de `medir.ts` (que lo reexporta para el resto del servidor).
 */

/**
 * Los límites anti-abuso, ACEPTADOS por el dueño el 2026-09-29. ESPEJO de
 * `MEASURE_LIMITS` en packages/protocol (un test fija que coinciden). El porqué
 * de cada número está allí.
 */
export const LIMITES_MEDIR = {
  asientos: 5,
  orgsPorCuenta: 1,
  peticionesDiarias: 20_000,
  diasDeVigencia: 3650,
  diasDeGracia: 30,
} as const;

/**
 * La primera versión del paquete que reconoce la licencia Medir. Las
 * anteriores (≤ 0.4.32) no saben qué es el plan `measure`: la ven caducada y
 * fallan cerradas (docs/LICENCIA-MEDIR.md). La web la publica junto a cada
 * «empieza gratis con Medir» para que nadie la pruebe con una versión que no
 * arranca.
 */
export const VERSION_MINIMA_MEDIR = "0.4.33";
