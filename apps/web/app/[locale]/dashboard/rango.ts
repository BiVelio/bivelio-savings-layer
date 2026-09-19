/**
 * El RANGO del panel: cuántos días atrás miran el titular y las tarjetas.
 *
 * Viaja en la URL (`?range=30`) y no en un estado de cliente, para que un enlace
 * copiado enseñe lo mismo a quien lo abra y para que el servidor —que es quien
 * deriva el veredicto— filtre las filas antes de derivar nada. El máximo es la
 * ventana que la consulta trae (120 días): «todo» sería mentir sobre lo que se
 * está sumando, así que la opción se llama por su número.
 */
export const RANGOS = [30, 90, 120] as const;
export type Rango = (typeof RANGOS)[number];
export const RANGO_POR_DEFECTO: Rango = 120;

/** `"30"` → 30; cualquier otra cosa (ausente, `"all"`, `"7"`, basura) → por defecto. */
export function rangoDesdeParametro(v: string | string[] | undefined): Rango {
  const s = Array.isArray(v) ? v[0] : v;
  // Solo dígitos: `Number("3e1")` es 30 y colaría. Un parámetro de URL no es
  // una expresión.
  if (typeof s !== "string" || !/^\d{1,3}$/.test(s)) return RANGO_POR_DEFECTO;
  const n = Number(s);
  return (RANGOS as readonly number[]).includes(n) ? (n as Rango) : RANGO_POR_DEFECTO;
}
