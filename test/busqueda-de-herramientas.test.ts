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
    expect(verHerramientas(cuerpo)).toEqual({ definiciones: 0, referencias: 2 });
  });

  it("un cuerpo sin herramientas no tiene ni lo uno ni lo otro", () => {
    expect(verHerramientas('{"model":"m","messages":[]}')).toEqual({ definiciones: 0, referencias: 0 });
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
    expect(aviso).toContain("VENTANA NUEVA");
    expect(aviso).toContain("ENABLE_TOOL_SEARCH");
  });

  it("el umbral es un límite, no una sugerencia", () => {
    expect(avisoDeBusquedaDeHerramientas({ definiciones: DEFINICIONES_PARA_AVISAR, referencias: 0 })).not.toBeNull();
  });
});
