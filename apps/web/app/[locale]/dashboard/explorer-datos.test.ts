import { describe, it, expect } from "vitest";
import {
  cortarPorPeriodo,
  valorDia,
  serieDiaria,
  serieAcumulada,
  valorModelo,
  agregarPorModelo,
  topConResto,
  PERIODOS,
} from "./explorer-datos";
import type { UsageRollup, ModelDia } from "./data";

/** Fila de uso mínima: solo lo que tocan los puros, el resto a 0. */
function fila(day: string, over: Partial<UsageRollup> = {}): UsageRollup {
  return {
    day,
    requests: 0,
    avoidedLlm: 0,
    actualLlm: 0,
    eliminatedInputTokens: 0,
    compressedInputTokens: 0,
    providerCachedInputTokens: 0,
    baselineCost: 0,
    actualCost: 0,
    measuredRequests: 0,
    measuredBaselineCost: 0,
    measuredActualCost: 0,
    ...over,
  };
}

function filaModelo(model: string, over: Partial<ModelDia> = {}): ModelDia {
  return {
    day: "2026-09-01",
    model,
    requests: 0,
    baselineCost: 0,
    actualCost: 0,
    actualInputTokens: 0,
    actualOutputTokens: 0,
    ...over,
  };
}

describe("cortarPorPeriodo", () => {
  // "hoy" fijo: 2026-09-10T12:00:00Z.
  const ahora = Date.parse("2026-09-10T12:00:00Z");

  it("conserva las filas dentro de la ventana e incluye el borde exacto", () => {
    const rows = [
      fila("2026-08-01"),
      fila("2026-09-03"), // hace 7 días exactos → borde inclusivo
      fila("2026-09-10"), // hoy
    ];
    const out = cortarPorPeriodo(rows, 7, ahora);
    expect(out.map((r) => r.day)).toEqual(["2026-09-03", "2026-09-10"]);
  });

  it("descarta lo anterior al umbral", () => {
    const rows = [fila("2026-09-02"), fila("2026-09-03")];
    // umbral de 7 días desde el 10 = 2026-09-03; el 02 queda fuera.
    expect(cortarPorPeriodo(rows, 7, ahora).map((r) => r.day)).toEqual(["2026-09-03"]);
  });

  it("una ventana grande se lo queda todo", () => {
    // 2026-06-01 está a ~100 días del 09-10 → dentro de la ventana de 120.
    const rows = [fila("2026-06-01"), fila("2026-09-10")];
    expect(cortarPorPeriodo(rows, 120, ahora)).toHaveLength(2);
  });

  it("los periodos por defecto están ordenados y son los cuatro esperados", () => {
    expect([...PERIODOS]).toEqual([7, 30, 90, 120]);
  });
});

describe("valorDia", () => {
  const r = fila("2026-09-01", {
    baselineCost: 10,
    actualCost: 4,
    requests: 25,
    actualInputTokens: 1234,
  });
  it("neto = baseline − actual", () => expect(valorDia(r, "neto")).toBe(6));
  it("peticiones = requests", () => expect(valorDia(r, "peticiones")).toBe(25));
  it("tokens de entrada = actualInputTokens", () => expect(valorDia(r, "tokensEntrada")).toBe(1234));
  it("tokens de entrada cae a 0 cuando la columna 0015 no vino", () => {
    expect(valorDia(fila("2026-09-01"), "tokensEntrada")).toBe(0);
  });
});

describe("serieDiaria", () => {
  it("un punto por fila, sin rellenar días sin fila", () => {
    const rows = [
      fila("2026-09-01", { baselineCost: 5, actualCost: 1 }),
      fila("2026-09-03", { baselineCost: 8, actualCost: 2 }), // salta el 02 a propósito
    ];
    expect(serieDiaria(rows, "neto")).toEqual([
      { day: "2026-09-01", valor: 4 },
      { day: "2026-09-03", valor: 6 },
    ]);
  });
});

describe("serieAcumulada", () => {
  it("suma el ahorro neto día a día", () => {
    const rows = [
      fila("2026-09-01", { baselineCost: 5, actualCost: 1 }), // +4
      fila("2026-09-02", { baselineCost: 10, actualCost: 4 }), // +6 → 10
      fila("2026-09-03", { baselineCost: 3, actualCost: 3 }), // +0 → 10
    ];
    expect(serieAcumulada(rows, "neto")).toEqual([
      { day: "2026-09-01", acumulado: 4 },
      { day: "2026-09-02", acumulado: 10 },
      { day: "2026-09-03", acumulado: 10 },
    ]);
  });

  it("generaliza a otras métricas (peticiones acumuladas)", () => {
    const rows = [
      fila("2026-09-01", { requests: 3 }),
      fila("2026-09-02", { requests: 5 }),
    ];
    expect(serieAcumulada(rows, "peticiones")).toEqual([
      { day: "2026-09-01", acumulado: 3 },
      { day: "2026-09-02", acumulado: 8 },
    ]);
  });

  it("array vacío → serie vacía", () => {
    expect(serieAcumulada([], "neto")).toEqual([]);
  });
});

describe("valorModelo", () => {
  const r = filaModelo("claude-opus", {
    baselineCost: 20,
    actualCost: 12,
    requests: 7,
    actualInputTokens: 999,
  });
  it("neto = baseline − actual", () => expect(valorModelo(r, "neto")).toBe(8));
  it("peticiones = requests", () => expect(valorModelo(r, "peticiones")).toBe(7));
  it("tokens de entrada = actualInputTokens", () => expect(valorModelo(r, "tokensEntrada")).toBe(999));
});

describe("agregarPorModelo", () => {
  it("suma varias filas del mismo modelo y ordena de mayor a menor", () => {
    const rows = [
      filaModelo("a", { day: "2026-09-01", requests: 3 }),
      filaModelo("a", { day: "2026-09-02", requests: 2 }),
      filaModelo("b", { day: "2026-09-01", requests: 10 }),
      filaModelo("c", { day: "2026-09-01", requests: 5 }),
    ];
    // Empate a 5 entre "a" y "c": el desempate por nombre ascendente pone "a" antes.
    expect(agregarPorModelo(rows, "peticiones")).toEqual([
      { model: "b", valor: 10 },
      { model: "a", valor: 5 },
      { model: "c", valor: 5 },
    ]);
  });

  it("empate resuelto por nombre de modelo (determinista)", () => {
    const rows = [
      filaModelo("zeta", { requests: 4 }),
      filaModelo("alfa", { requests: 4 }),
    ];
    expect(agregarPorModelo(rows, "peticiones").map((b) => b.model)).toEqual(["alfa", "zeta"]);
  });

  it("sin filas → sin barras", () => {
    expect(agregarPorModelo([], "neto")).toEqual([]);
  });
});

describe("topConResto", () => {
  const barras = [
    { model: "a", valor: 10 },
    { model: "b", valor: 8 },
    { model: "c", valor: 6 },
    { model: "d", valor: 4 },
    { model: "e", valor: 2 },
  ];
  it("agrupa la cola en una sola barra 'resto'", () => {
    expect(topConResto(barras, 3, "resto")).toEqual([
      { model: "a", valor: 10 },
      { model: "b", valor: 8 },
      { model: "c", valor: 6 },
      { model: "resto", valor: 6 }, // 4 + 2
    ]);
  });
  it("con n o menos barras las devuelve tal cual, sin fila resto", () => {
    expect(topConResto(barras.slice(0, 3), 3, "resto")).toEqual(barras.slice(0, 3));
  });
});
