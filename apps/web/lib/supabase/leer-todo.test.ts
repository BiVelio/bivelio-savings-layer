import { describe, it, expect } from "vitest";

import { leerTodo } from "./leer-todo";

/**
 * PAGINACIÓN. El bug del cierre (27-08): PostgREST corta a 1000 filas SIN error,
 * así que un `.select()` a secas se dejaba orgs sin cerrar en silencio. leerTodo
 * pide en páginas con `.range()` hasta que una llega incompleta.
 */

/** Un doble de PostgREST que sirve `total` filas en páginas de `tam`. */
function fakeDatos(total: number, tam: number) {
  let llamadas = 0;
  const filas = Array.from({ length: total }, (_, i) => ({ i }));
  const constructor = () => ({
    range: async (desde: number, hasta: number) => {
      llamadas++;
      // PostgREST nunca devuelve más de `tam` aunque pidas más: se acota el corte.
      const fin = Math.min(hasta + 1, desde + tam);
      return { data: filas.slice(desde, fin), error: null };
    },
  });
  return { constructor, llamadas: () => llamadas };
}

describe("leerTodo", () => {
  it("junta TODAS las filas cuando hay más de una página", async () => {
    const { constructor, llamadas } = fakeDatos(1020, 1000);
    const todo = await leerTodo<{ i: number }>(constructor, 1000);
    expect(todo).toHaveLength(1020); // las 1020, no 1000
    expect(todo.at(-1)!.i).toBe(1019);
    expect(llamadas()).toBe(2); // página llena + página corta
  });

  it("una sola página cuando cabe de sobra", async () => {
    const { constructor, llamadas } = fakeDatos(300, 1000);
    expect(await leerTodo(constructor, 1000)).toHaveLength(300);
    expect(llamadas()).toBe(1);
  });

  it("un múltiplo EXACTO fuerza una vuelta más que vuelve vacía (correcto)", async () => {
    const { constructor, llamadas } = fakeDatos(2000, 1000);
    expect(await leerTodo(constructor, 1000)).toHaveLength(2000);
    expect(llamadas()).toBe(3); // 1000 + 1000 + 0
  });

  it("cero filas: una llamada, lista vacía", async () => {
    const { constructor } = fakeDatos(0, 1000);
    expect(await leerTodo(constructor, 1000)).toEqual([]);
  });

  it("propaga el error de PostgREST en vez de tragárselo", async () => {
    const constructor = () => ({ range: async () => ({ data: null, error: { message: "boom" } }) });
    await expect(leerTodo(constructor)).rejects.toBeTruthy();
  });
});
