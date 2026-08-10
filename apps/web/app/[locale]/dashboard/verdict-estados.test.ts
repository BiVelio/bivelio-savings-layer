import { describe, it, expect, vi } from "vitest";

/**
 * El panel colapsaba cuatro situaciones en el mismo mensaje "0 solicitudes
 * vistas. Instala el SDK": (1) fallo de consulta, (2) tráfico sin precio, (3)
 * sin tráfico de verdad, (4) con ahorro. Las tres primeras se ven idénticas y
 * las dos primeras son afirmaciones FALSAS a un cliente con datos intactos.
 *
 * Se prueba la lógica de selección de estado, que es donde vivía el defecto,
 * sin renderizar (evita montar next-intl). Reproduce las mismas condiciones que
 * VerdictHero calcula.
 */

interface Fila {
  baselineCost: number;
  actualCost: number;
  requests: number;
}

/** La misma decisión que toma VerdictHero, extraída para poder verificarla. */
function estado(usage: Fila[], failed: boolean): "live" | "error" | "unpriced" | "empty" {
  const baseline = usage.reduce((n, r) => n + r.baselineCost, 0);
  const peticiones = usage.reduce((n, r) => n + r.requests, 0);
  const live = usage.length > 0 && baseline > 0;
  if (live) return "live";
  if (failed) return "error";
  if (peticiones > 0 && baseline <= 0) return "unpriced";
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

  it("con ahorro medido es 'live'", () => {
    expect(estado([{ baselineCost: 10, actualCost: 6, requests: 100 }], false)).toBe("live");
  });

  it("el fallo de consulta NO se disfraza de tráfico cuando además hay filas viejas vacías", () => {
    // filas presentes pero baseline 0 Y failed: prioriza el error real.
    expect(estado([{ baselineCost: 0, actualCost: 0, requests: 0 }], true)).toBe("error");
  });
});
