import { describe, expect, it } from "vitest";

import {
  DEFINICIONES_PARA_AVISAR,
  avisoDeBusquedaDeHerramientas,
  verHerramientas,
} from "../gateway/busqueda-de-herramientas.js";

/**
 * Lo que este fichero protege: que una pérdida SILENCIOSA se vuelva visible.
 *
 * Medido el 2026-09-10 sobre el corpus real: 12.239 peticiones con catálogo de
 * herramientas y solo CUATRO con `tool_reference`. Mediana de 142 definiciones
 * por petición, máximo 261. Ese bloque es el 24,5 % del dinero de entrada, y el
 * arreglo que lo evita llevaba un día mergeado sin que nadie lo ejerciera.
 * Mirando el código no se nota; mirando el tráfico sí.
 */

const definicion = (n: number) =>
  Array.from({ length: n }, (_, i) => `{"name":"h${i}","input_schema":{"type":"object"}}`).join(",");

describe("ver el catálogo de herramientas de una petición", () => {
  it("cuenta definiciones por su esquema, que es lo que pesa", () => {
    expect(verHerramientas(`{"tools":[${definicion(3)}]}`).definiciones).toBe(3);
  });

  it("cuenta las referencias, que son la búsqueda EN ACCIÓN", () => {
    const cuerpo = `{"tools":[{"type":"tool_reference","name":"a"},{"type":"tool_reference","name":"b"}]}`;
    expect(verHerramientas(cuerpo)).toEqual({ definiciones: 0, referencias: 2, diferidas: 0 });
  });

  it("un cuerpo sin herramientas no tiene ni lo uno ni lo otro", () => {
    expect(verHerramientas('{"model":"m","messages":[]}')).toEqual({ definiciones: 0, referencias: 0, diferidas: 0 });
  });
});

describe("cuándo hay algo que decir", () => {
  it("⛔ NO avisa si la búsqueda ya está funcionando, por muchas definiciones que haya", () => {
    // El caso sano: el cliente expande solo lo que necesita.
    expect(
      avisoDeBusquedaDeHerramientas({ definiciones: 200, referencias: 5 }),
    ).toBeNull();
  });

  it("no avisa por un catálogo pequeño: no habría nada que buscar", () => {
    expect(avisoDeBusquedaDeHerramientas({ definiciones: DEFINICIONES_PARA_AVISAR - 1, referencias: 0 })).toBeNull();
  });

  it("avisa con el caso REAL del corpus: 142 definiciones y cero referencias", () => {
    const aviso = avisoDeBusquedaDeHerramientas({ definiciones: 142, referencias: 0 });
    expect(aviso).not.toBeNull();
    expect(aviso).toContain("142");
    // Tiene que decir QUÉ hacer, no solo que algo va mal.
    expect(aviso).toContain("NEW WINDOW");
    expect(aviso).toContain("ENABLE_TOOL_SEARCH");
  });

  it("el umbral es un límite, no una sugerencia", () => {
    expect(avisoDeBusquedaDeHerramientas({ definiciones: DEFINICIONES_PARA_AVISAR, referencias: 0 })).not.toBeNull();
  });
});

describe("⛔ las herramientas diferidas son la búsqueda ENCENDIDA (2026-09-27)", () => {
  // Con tool search, el cliente manda TODAS las definiciones en cada petición
  // —las diferidas también— y el proveedor deja las diferidas fuera del prefijo.
  // En el primer turno aún no hay ninguna `tool_reference`: el aviso saltaba
  // justo en las sesiones que ya lo hacían bien.
  const diferidas = (n: number, espacio = "") =>
    Array.from({ length: n }, (_, i) => `{"name":"d${i}","input_schema":{"type":"object"},"defer_loading":${espacio}true}`).join(",");

  it("verHerramientas cuenta las diferidas, compactas o con espacio", () => {
    expect(verHerramientas(`{"tools":[${definicion(2)},${diferidas(3)}]}`)).toEqual({ definiciones: 5, referencias: 0, diferidas: 3 });
    expect(verHerramientas(`{"tools":[${diferidas(2, " ")}]}`).diferidas).toBe(2);
  });

  it("con diferidas y sin referencias todavía, NO avisa", () => {
    const vista = verHerramientas(`{"tools":[${definicion(5)},${diferidas(140)}]}`);
    expect(vista.referencias).toBe(0);
    expect(avisoDeBusquedaDeHerramientas(vista)).toBeNull();
  });

  it("sin diferidas y con el catálogo entero, SIGUE avisando", () => {
    expect(avisoDeBusquedaDeHerramientas(verHerramientas(`{"tools":[${definicion(142)}]}`))).not.toBeNull();
  });
});
