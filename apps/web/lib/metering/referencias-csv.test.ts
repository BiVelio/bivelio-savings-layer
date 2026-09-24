import { describe, it, expect } from "vitest";

import {
  DescargaSinTiempoError,
  diasEntre,
  esDiaValido,
  MAX_FILAS_POR_DESCARGA,
  paginasDeReferencias,
  PRESUPUESTO_DESCARGA_MS,
  DURACION_MAXIMA_DESCARGA_S,
  type FilaDeReferencia,
  type LectorDePaginaDeReferencias,
} from "./referencias-csv";

/**
 * El generador de páginas del CSV de referencias (0029), sin red: paginación
 * por CLAVE día a día, presupuesto de tiempo que corta con ERROR (nunca un CSV
 * truncado que parece completo) y defensa contra una lectura que no avanza.
 */

function fila(day: string, requestId: string): FilaDeReferencia {
  return {
    request_id: requestId,
    day,
    model: "openai/gpt-4o-mini",
    cache_result: "exact",
    reference_request_id: "req-poblada",
    reference_at: `${day}T08:00:00+00:00`,
    baseline_input_tokens: 40,
    baseline_output_tokens: 0,
    baseline_cost: "0.0000030000",
  };
}

/** Un lector por clave sobre una tabla en memoria, que apunta cada petición. */
function lectorSobre(tabla: FilaDeReferencia[]) {
  const peticiones: Array<{ dia: string; despuesDe: string | null; tam: number }> = [];
  const leer: LectorDePaginaDeReferencias = async (dia, despuesDe, tam) => {
    peticiones.push({ dia, despuesDe, tam });
    return tabla
      .filter((f) => f.day === dia && (despuesDe === null || f.request_id > despuesDe))
      .sort((a, b) => (a.request_id < b.request_id ? -1 : 1))
      .slice(0, tam);
  };
  return { leer, peticiones };
}

async function todo(gen: AsyncGenerator<string>): Promise<string> {
  let s = "";
  for await (const trozo of gen) s += trozo;
  return s;
}

describe("paginasDeReferencias", () => {
  it("recorre los días en orden y cada día por clave, con páginas del tamaño pedido", async () => {
    const tabla = [
      ...Array.from({ length: 25 }, (_, i) => fila("2026-09-01", `r${String(i).padStart(3, "0")}`)),
      ...Array.from({ length: 10 }, (_, i) => fila("2026-09-03", `r${String(i).padStart(3, "0")}`)),
    ];
    const { leer, peticiones } = lectorSobre(tabla);
    const texto = await todo(paginasDeReferencias(["2026-09-01", "2026-09-02", "2026-09-03"], leer, { fin: Infinity, tam: 10 }));
    const lineas = texto.split("\r\n").filter(Boolean);
    expect(lineas).toHaveLength(35);
    expect(new Set(lineas).size).toBe(35);
    expect(peticiones).toEqual([
      { dia: "2026-09-01", despuesDe: null, tam: 10 },
      { dia: "2026-09-01", despuesDe: "r009", tam: 10 },
      { dia: "2026-09-01", despuesDe: "r019", tam: 10 },
      { dia: "2026-09-02", despuesDe: null, tam: 10 },
      { dia: "2026-09-03", despuesDe: null, tam: 10 },
      // Página exacta de `tam`: una vuelta más que vuelve vacía.
      { dia: "2026-09-03", despuesDe: "r009", tam: 10 },
    ]);
  });

  it("pasado el presupuesto de tiempo LANZA (la descarga falla a la vista), aunque ya haya servido páginas", async () => {
    const tabla = Array.from({ length: 30 }, (_, i) => fila("2026-09-01", `r${String(i).padStart(3, "0")}`));
    const { leer } = lectorSobre(tabla);
    let reloj = 0;
    const gen = paginasDeReferencias(["2026-09-01"], leer, { fin: 100, tam: 10, ahora: () => reloj });
    expect((await gen.next()).done).toBe(false);
    reloj = 101;
    await expect(gen.next()).rejects.toBeInstanceOf(DescargaSinTiempoError);
  });

  it("una lectura que no avanza (ignora el filtro por clave) no gira para siempre", async () => {
    const pagina = Array.from({ length: 10 }, (_, i) => fila("2026-09-01", `r${i}`));
    const leer: LectorDePaginaDeReferencias = async () => pagina;
    await expect(todo(paginasDeReferencias(["2026-09-01"], leer, { fin: Infinity, tam: 10 }))).rejects.toThrow(/no avanza/);
  });

  it("un error de lectura se propaga (la ruta lo convierte en 503 o en un corte con error)", async () => {
    const leer: LectorDePaginaDeReferencias = async () => {
      throw { code: "57014", message: "statement timeout" };
    };
    await expect(todo(paginasDeReferencias(["2026-09-01"], leer, { fin: Infinity }))).rejects.toMatchObject({ code: "57014" });
  });
});

describe("días y cotas de la descarga", () => {
  it("diasEntre cubre [desde, hasta) cruzando meses y años", () => {
    expect(diasEntre("2026-02-27", "2026-03-02")).toEqual(["2026-02-27", "2026-02-28", "2026-03-01"]);
    expect(diasEntre("2026-12-31", "2027-01-01")).toEqual(["2026-12-31"]);
    expect(diasEntre("2026-09-01", "2026-10-01")).toHaveLength(30);
  });

  it("esDiaValido rechaza fechas que no existen o mal formadas", () => {
    expect(esDiaValido("2028-02-29")).toBe(true);
    for (const malo of ["2026-02-29", "2026-02-30", "2026-9-01", "2026-09", "2026-09-01T00:00:00Z", ""]) {
      expect(esDiaValido(malo), malo).toBe(false);
    }
  });

  it("el presupuesto deja margen dentro de maxDuration, y el tope cabe en él a 1000 filas por página", () => {
    expect(PRESUPUESTO_DESCARGA_MS).toBeLessThan(DURACION_MAXIMA_DESCARGA_S * 1000);
    // ≤ 1000 páginas: a 250 ms la página (muy por encima de lo medido en fra1) siguen cabiendo.
    expect((MAX_FILAS_POR_DESCARGA / 1000) * 250).toBeLessThanOrEqual(PRESUPUESTO_DESCARGA_MS);
  });
});
