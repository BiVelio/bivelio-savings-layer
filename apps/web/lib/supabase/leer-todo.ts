import type { AdminClient } from "./admin";

/**
 * LEER TODAS LAS FILAS, PAGINANDO. PostgREST corta a 1000 filas por respuesta
 * SIN error — un `.select()` a secas devuelve como mucho mil y calla. El cierre
 * mensual (caza del 2026-08-27) leía usage_daily así: con ≥34 orgs activas
 * (34 × 30 días > 1000) el mes salía truncado y, como el extracto es inmutable
 * (0016 ignoreDuplicates), quedaba sellado mal para siempre y Stripe lo cobraba.
 *
 * Este helper pide en páginas de `tam` con `.range()` hasta que una página llega
 * incompleta (la última). El `constructor` recibe la tabla ya con esquema,
 * filtros y `.select(...)` puestos por quien llama, y solo se le encadena el
 * range — así cada cron mantiene sus columnas y su where.
 */
export async function leerTodo<T>(
  constructor: () => {
    range: (desde: number, hasta: number) => PromiseLike<{ data: unknown[] | null; error: unknown }>;
  },
  tam = 1000,
): Promise<T[]> {
  const todo: T[] = [];
  for (let pagina = 0; ; pagina++) {
    const desde = pagina * tam;
    const { data, error } = await constructor().range(desde, desde + tam - 1);
    if (error) throw error;
    const filas = (data ?? []) as T[];
    todo.push(...filas);
    // Página incompleta ⇒ era la última. (Una página EXACTA de `tam` fuerza una
    // vuelta más que vuelve vacía; correcto, no un bug.)
    if (filas.length < tam) break;
  }
  return todo;
}

/** Tipo mínimo del builder de una consulta de Supabase para `leerTodo`. */
export type QueryConstructor = Parameters<typeof leerTodo>[0];
export type { AdminClient };
