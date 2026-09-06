import { describe, expect, it } from "vitest";

import {
  cuantil,
  escalaBonita,
  marcasEjeX,
  mediaMovil,
  rellenarCalendario,
  resumirSerie,
  type Ranura,
} from "./explorer-estadisticas";

const p = (day: string, valor: number) => ({ day, valor });
const r = (day: string, valor: number, conDatos = true): Ranura => ({ day, valor, conDatos });
/** N ranuras seguidas desde 2026-09-01 con los valores dados. */
const serie = (...vals: number[]): Ranura[] =>
  vals.map((v, i) => r(`2026-09-${String(i + 1).padStart(2, "0")}`, v));

describe("rellenarCalendario", () => {
  it("sin puntos no inventa eje", () => {
    expect(rellenarCalendario([])).toEqual([]);
  });

  it("rellena el hueco interior con ceros MARCADOS", () => {
    const out = rellenarCalendario([p("2026-09-01", 10), p("2026-09-04", 4)]);
    expect(out.map((x) => x.day)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]);
    expect(out.map((x) => x.valor)).toEqual([10, 0, 0, 4]);
    expect(out.map((x) => x.conDatos)).toEqual([true, false, false, true]);
  });

  it("NO extiende el eje más allá del último día con dato", () => {
    const out = rellenarCalendario([p("2026-09-01", 1), p("2026-09-02", 2)]);
    expect(out).toHaveLength(2);
  });

  it("cruza el cambio de mes sin saltarse días", () => {
    const out = rellenarCalendario([p("2026-08-30", 1), p("2026-09-02", 1)]);
    expect(out.map((x) => x.day)).toEqual(["2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02"]);
  });

  it("ordena aunque las filas lleguen desordenadas", () => {
    const out = rellenarCalendario([p("2026-09-03", 3), p("2026-09-01", 1)]);
    expect(out.map((x) => x.day)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
  });

  it("suma dos filas del mismo día en vez de perder una", () => {
    const out = rellenarCalendario([p("2026-09-01", 2), p("2026-09-01", 3)]);
    expect(out).toEqual([{ day: "2026-09-01", valor: 5, conDatos: true }]);
  });

  it("un día con valor 0 sigue siendo un día MEDIDO", () => {
    const out = rellenarCalendario([p("2026-09-01", 0), p("2026-09-02", 5)]);
    expect(out[0]).toEqual({ day: "2026-09-01", valor: 0, conDatos: true });
  });
});

describe("cuantil", () => {
  it("mediana de una serie impar y de una par", () => {
    expect(cuantil([1, 2, 3], 0.5)).toBe(2);
    expect(cuantil([1, 2, 3, 4], 0.5)).toBe(2.5);
  });
  it("interpola en los extremos y no se sale del rango", () => {
    expect(cuantil([0, 10], 0)).toBe(0);
    expect(cuantil([0, 10], 1)).toBe(10);
    expect(cuantil([0, 10], 0.25)).toBe(2.5);
  });
  it("serie vacía da 0 y no NaN", () => {
    expect(cuantil([], 0.95)).toBe(0);
  });
});

describe("resumirSerie", () => {
  it("serie vacía no inventa máximos", () => {
    const s = resumirSerie([]);
    expect(s.total).toBe(0);
    expect(s.max).toBeNull();
    expect(s.tendencia).toBeNull();
  });

  it("los ceros del calendario ENTRAN en la media", () => {
    // 10 en un solo día de cuatro: la media honesta es 2,5, no 10.
    const s = resumirSerie([r("2026-09-01", 10), r("2026-09-02", 0, false), r("2026-09-03", 0, false), r("2026-09-04", 0, false)]);
    expect(s.media).toBe(2.5);
    expect(s.diasConUso).toBe(1);
    expect(s.diasTotales).toBe(4);
  });

  it("máximo y mínimo llevan su día", () => {
    const s = resumirSerie(serie(3, 9, 1));
    expect(s.max).toMatchObject({ day: "2026-09-02", valor: 9 });
    expect(s.min).toMatchObject({ day: "2026-09-03", valor: 1 });
  });

  it("ante empate en el máximo se queda el primer día (determinista)", () => {
    const s = resumirSerie(serie(7, 7));
    expect(s.max?.day).toBe("2026-09-01");
  });

  it("mediana, p95 y desviación sobre la serie completa", () => {
    const s = resumirSerie(serie(0, 0, 4, 4));
    expect(s.mediana).toBe(2);
    expect(s.desviacion).toBe(2);
    expect(s.p95).toBeCloseTo(4, 10);
  });

  it("tendencia por ventana cuando caben dos ventanas enteras", () => {
    const s = resumirSerie(serie(1, 1, 1, 1, 2, 2, 2, 2), 4);
    expect(s.tendencia).toMatchObject({ modo: "ventana", ventana: 4, previo: 4, actual: 8, delta: 1 });
  });

  it("tendencia por mitades cuando no caben dos ventanas", () => {
    const s = resumirSerie(serie(2, 2, 3, 3), 7);
    expect(s.tendencia).toMatchObject({ modo: "mitades", ventana: 2, previo: 4, actual: 6 });
  });

  it("con n impar las dos mitades miden los mismos días", () => {
    const s = resumirSerie(serie(1, 1, 99, 2, 2), 7);
    const tend = s.tendencia!;
    expect(tend.ventana).toBe(2);
    expect(tend.previo).toBe(2); // descarta el día central
    expect(tend.actual).toBe(4);
  });

  it("sin base previa el delta es null, jamás Infinity", () => {
    const s = resumirSerie(serie(0, 0, 5, 5), 2);
    expect(s.tendencia?.previo).toBe(0);
    expect(s.tendencia?.delta).toBeNull();
  });

  it("menos de 4 días no da tendencia", () => {
    expect(resumirSerie(serie(1, 2, 3), 7).tendencia).toBeNull();
  });

  it("una caída da delta negativo", () => {
    const s = resumirSerie(serie(4, 4, 1, 1), 2);
    expect(s.tendencia?.delta).toBe(-0.75);
  });

  it("con base previa negativa el delta usa el valor absoluto", () => {
    const s = resumirSerie(serie(-2, -2, 2, 2), 2);
    expect(s.tendencia?.delta).toBe(2); // (4 − (−4)) / 4
  });
});

describe("mediaMovil", () => {
  it("null hasta que hay ventana entera detrás", () => {
    expect(mediaMovil(serie(1, 2, 3, 4), 3)).toEqual([null, null, 2, 3]);
  });
  it("ventana 1 es la propia serie", () => {
    expect(mediaMovil(serie(5, 7), 1)).toEqual([5, 7]);
  });
  it("ventana absurda no revienta", () => {
    expect(mediaMovil(serie(1, 2), 0)).toEqual([null, null]);
  });
});

describe("escalaBonita", () => {
  it("incluye SIEMPRE el cero aunque el mínimo esté muy arriba", () => {
    const e = escalaBonita(900, 1000);
    expect(e.min).toBe(0);
    expect(e.max).toBeGreaterThanOrEqual(1000);
  });

  it("baja por debajo del cero cuando hay valores negativos", () => {
    const e = escalaBonita(-30, 100);
    expect(e.min).toBeLessThanOrEqual(-30);
    expect(e.max).toBeGreaterThanOrEqual(100);
    expect(e.ticks).toContain(0);
  });

  it("serie toda a cero da una escala usable", () => {
    expect(escalaBonita(0, 0)).toEqual({ min: 0, max: 1, paso: 1, ticks: [0, 1] });
  });

  it("las marcas son redondas y sin basura de coma flotante", () => {
    const e = escalaBonita(0, 0.3);
    for (const t of e.ticks) expect(t).toBe(Number(t.toPrecision(12)));
  });

  it("los ticks están ordenados, sin repetir y cubren el rango", () => {
    const e = escalaBonita(0, 4270);
    expect(e.ticks[0]).toBe(e.min);
    expect(e.ticks[e.ticks.length - 1]).toBe(e.max);
    expect(new Set(e.ticks).size).toBe(e.ticks.length);
    expect(e.ticks).toEqual([...e.ticks].sort((a, b) => a - b));
  });

  it("aguanta valores minúsculos (céntimos de ahorro)", () => {
    const e = escalaBonita(0, 0.004);
    expect(e.max).toBeGreaterThanOrEqual(0.004);
    expect(e.paso).toBeGreaterThan(0);
    expect(e.ticks.length).toBeGreaterThan(1);
  });

  it("no devuelve NaN con entradas rotas", () => {
    const e = escalaBonita(Number.NaN, Number.POSITIVE_INFINITY);
    expect(e.ticks.every(Number.isFinite)).toBe(true);
  });
});

describe("marcasEjeX", () => {
  it("siempre incluye el primero y el último", () => {
    const m = marcasEjeX(30, 6);
    expect(m[0]).toBe(0);
    expect(m[m.length - 1]).toBe(29);
  });
  it("no repite índices cuando hay menos días que marcas", () => {
    expect(marcasEjeX(3, 8)).toEqual([0, 1, 2]);
  });
  it("un solo día da una sola marca", () => {
    expect(marcasEjeX(1, 6)).toEqual([0]);
  });
  it("cero días, ninguna marca", () => {
    expect(marcasEjeX(0, 6)).toEqual([]);
  });
});
