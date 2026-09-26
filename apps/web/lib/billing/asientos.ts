/**
 * Los asientos, como decisiones puras y COMPARTIDAS.
 *
 * Vive aparte para que el campo del panel, el tope del servidor y el aviso de la
 * tarjeta de cuenta usen LA MISMA función, y no tres copias del mismo criterio
 * que se separan en cuanto alguien toca una. Es además lo que permite que los
 * tests prueben algo: un test que reimplementa la regla pasa igual con el código
 * roto.
 */

/**
 * Tope de cordura. Por encima de esto es un dedazo, no una flota — y una cantidad
 * disparatada que llegue a Stripe es un cobro REAL que hay que reembolsar a mano.
 */
export const MAX_ASIENTOS = 500;

/**
 * Días DISTINTOS de un mes natural (UTC) que un asiento tiene que estar activo
 * para contar como usado: el `having count(distinct day) >= N` de
 * `bvsala.billable_seats` (db/migrations/0003_metering.sql). La cifra vive en
 * SQL; esta constante es su espejo para la web pública, y
 * `lib/legal/precios-publicados.test.ts` la ata al SQL leyéndolo como texto.
 */
export const DIAS_ACTIVOS_PARA_CONTAR_ASIENTO = 3;

/**
 * Cuántos asientos se compran, a partir de lo que haya escrito o mandado quien
 * sea. Acepta el texto del campo del panel y el número del cuerpo de la petición.
 *
 * Cae siempre en el rango [1, MAX_ASIENTOS]:
 *   - vacío, texto o NaN     → 1 (borrar el campo para teclear "12" pasa por ahí)
 *   - cero o negativo        → 1
 *   - decimal                → se TRUNCA, nunca se redondea hacia arriba, porque
 *                              redondear cobraría un asiento que nadie pidió
 *   - enorme                 → MAX_ASIENTOS
 */
export function normalizarAsientos(crudo: unknown): number {
  const n = typeof crudo === "number" ? crudo : Number(crudo);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(MAX_ASIENTOS, Math.floor(n));
}

export type AvisoAsientos = "nada" | "en-uso" | "exceso" | "rotado";

export interface EntradaAvisoAsientos {
  planActivo: boolean;
  /** `billable_seats` de este mes. `null` = no se ha podido medir. */
  usados: number | null;
  pagados: number | null;
  /**
   * ¿Se ha revocado alguna clave de servicio ESTE MES?
   *
   * Cambia lo que se puede afirmar, y el motivo es incómodo: `deriveSeatId` es
   * `HMAC(clave_de_servicio, huella_de_máquina)` — la clave es la LLAVE del
   * HMAC—, así que al rotarla TODAS las máquinas estrenan `seat_id`.
   * `billable_seats` cuenta ids distintos sin ninguna noción de continuidad de
   * máquina, de modo que los viejos y los nuevos SUMAN dentro del mismo mes
   * natural: una flota de 20 que rota a mitad de mes se cuenta como 40.
   *
   * Sin esto, el panel le diría a quien acaba de revocar por seguridad —lo que
   * nosotros le recomendamos— que suba su suscripción al doble. Cobrarle por
   * protegerse es la peor factura posible.
   */
  rotacionEsteMes: boolean;
}

/**
 * Qué se le dice al cliente sobre sus asientos.
 *
 * `usados === null` significa NO SE HA PODIDO MEDIR, y eso no es cero: pintar un
 * cero le diría que no está usando nada justo cuando el problema es que no hemos
 * podido mirar.
 *
 * `usados === 0` tampoco se pinta: `billable_seats` solo cuenta un asiento cuando
 * ha estado activo TRES días distintos del mes natural, así que los días 1 y 2 de
 * cada mes el cero es del calendario, no del cliente. Enseñarlo sería decirle a
 * una flota que lleva un año corriendo que no está usando nada.
 */
export function avisoDeAsientos({
  planActivo,
  usados,
  pagados,
  rotacionEsteMes,
}: EntradaAvisoAsientos): AvisoAsientos {
  if (!planActivo || usados == null || usados === 0) return "nada";
  if (pagados != null && usados > pagados) return rotacionEsteMes ? "rotado" : "exceso";
  return "en-uso";
}
