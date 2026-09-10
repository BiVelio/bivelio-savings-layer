import { describe, it, expect } from "vitest";

import { deriveVerdict } from "./derive";

/**
 * El panel colapsaba cuatro situaciones en el mismo mensaje «0 solicitudes
 * vistas. Instala el SDK»: (1) fallo de consulta, (2) tráfico sin precio, (3)
 * sin tráfico de verdad, (4) con ahorro. Las tres primeras se ven idénticas y
 * las dos primeras son afirmaciones FALSAS a un cliente con datos intactos.
 *
 * ESTE FICHERO REIMPLEMENTABA la decisión de VerdictHero para poder probarla, y
 * eso era el problema: había TRES copias de la misma lógica —el componente, la
 * función `deriveVerdict` que nadie usaba, y esta— y las tres podían divergir
 * sin que nada se quejara. De hecho divergieron: el componente sumaba el total y
 * lo llamaba «medido» durante meses mientras esta prueba pasaba en verde.
 *
 * Desde el 2026-09-10 se prueba la función REAL, la misma que pinta el
 * componente. Si vuelven a divergir, es que alguien reintrodujo una copia.
 */

/** El estado que el titular acaba pintando, derivado de la función de verdad. */
function estado(
  usage: {
    baselineCost: number;
    actualCost: number;
    requests: number;
    measuredRequests?: number;
    measuredBaselineCost?: number;
    measuredActualCost?: number;
  }[],
  failed: boolean,
): "live" | "error" | "unpriced" | "empty" | "sin_medir" {
  const v = deriveVerdict(usage);
  if (!failed && v.kind === "measured") return "live";
  if (failed) return "error";
  if (v.kind === "unpriced") return "unpriced";
  if (v.kind === "sin_medir") return "sin_medir";
  return "empty";
}

describe("VerdictHero — un cero por error no puede verse como un cero honesto", () => {
  it("un fallo de consulta es su propio estado, NO 'sin tráfico'", () => {
    expect(estado([], true)).toBe("error");
  });

  it("tráfico real sin precio es 'unpriced', no '0 solicitudes vistas'", () => {
    expect(estado([{ baselineCost: 0, actualCost: 0, requests: 1200 }], false)).toBe("unpriced");
  });

  it("sin tráfico de verdad sigue siendo 'empty'", () => {
    expect(estado([], false)).toBe("empty");
  });

  it("con ahorro MEDIDO es 'live'", () => {
    expect(
      estado(
        [{ baselineCost: 10, actualCost: 6, requests: 100,
           measuredRequests: 100, measuredBaselineCost: 10, measuredActualCost: 6 }],
        false,
      ),
    ).toBe("live");
  });

  it("⛔ con tráfico tarifado pero NADA medido es su propio estado, no 'live'", () => {
    // La fila tiene precio, así que antes caía a 'live' y el titular pintaba el
    // total bajo el rótulo «medido». No hay ni una petición comprobable contra
    // el contador del proveedor: decirlo es la única salida honesta.
    expect(estado([{ baselineCost: 10, actualCost: 6, requests: 100 }], false)).toBe("sin_medir");
  });

  it("el fallo de consulta NO se disfraza de tráfico cuando además hay filas viejas vacías", () => {
    // filas presentes pero baseline 0 Y failed: prioriza el error real.
    expect(estado([{ baselineCost: 0, actualCost: 0, requests: 0 }], true)).toBe("error");
  });
});
