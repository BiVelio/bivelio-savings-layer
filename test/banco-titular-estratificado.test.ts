import { describe, it, expect } from "vitest";
import { bootstrapRatioCI, bootstrapRatioCIEstratificado } from "../benchmarks/stats.js";

/**
 * EL TITULAR NO PUEDE DEPENDER DE CUÁNTAS REPS RECIBIÓ CADA ESCENARIO.
 *
 * El agregado antiguo (`bootstrapRatioCI` sobre todas las muestras de todos los
 * escenarios juntas, f = 1 − ΣcostB/ΣcostA) pondera cada escenario por sus reps
 * × su coste. El muestreo adaptativo mete más reps en los escenarios ruidosos,
 * así que tres tiradas de la MISMA capa titularon 20,8 / 16,5 / 19,1 % según el
 * reparto, mientras la media con peso igual por escenario daba 21,3 / 19,4 /
 * 20,5. Estos tests fijan la propiedad que arregla eso: duplicar las reps de un
 * escenario NO mueve el punto estratificado.
 */

/** Tres escenarios con ahorros distintos y costes distintos. */
const base = () => [
  // Ahorra mucho y es barato.
  { costA: [1, 1.1, 0.9, 1.0], costB: [0.4, 0.5, 0.3, 0.4] },
  // Ahorra poco y es caro (el que el pooled sobrepondera cuando recibe reps).
  { costA: [10, 10.5, 9.5, 10], costB: [9.5, 10, 9, 9.5] },
  // Ahorra a medias.
  { costA: [3, 3.2, 2.8, 3], costB: [2, 2.1, 1.9, 2] },
];

/** El mismo banco con las reps del escenario `i` repetidas `k` veces. */
function conRepsDuplicadas(estratos: { costA: number[]; costB: number[] }[], i: number, k: number) {
  return estratos.map((e, j) =>
    j === i
      ? { costA: Array.from({ length: k }, () => e.costA).flat(), costB: Array.from({ length: k }, () => e.costB).flat() }
      : e,
  );
}

const pooled = (estratos: { costA: number[]; costB: number[] }[]) =>
  bootstrapRatioCI(
    estratos.flatMap((e) => e.costA),
    estratos.flatMap((e) => e.costB),
    { resamples: 500, seed: 1 },
  );

describe("titular estratificado — invariante al reparto de reps", () => {
  it("(a) duplicar las reps de un escenario NO cambia el punto estratificado, y SÍ cambiaba el pooled", () => {
    const antes = base();
    const despues = conRepsDuplicadas(base(), 1, 3); // el escenario caro que ahorra poco, ×3 reps

    const estAntes = bootstrapRatioCIEstratificado(antes, { resamples: 500, seed: 1 });
    const estDespues = bootstrapRatioCIEstratificado(despues, { resamples: 500, seed: 1 });
    expect(estDespues.point).toBeCloseTo(estAntes.point, 12);

    const poolAntes = pooled(antes);
    const poolDespues = pooled(despues);
    // El pooled se desplaza hacia el escenario que recibió las reps (ahorra poco → baja).
    expect(Math.abs(poolDespues.point - poolAntes.point)).toBeGreaterThan(0.02);
    expect(poolDespues.point).toBeLessThan(poolAntes.point);
  });

  it("(b) con reps iguales en todos los escenarios, estratificado y pooled dan el mismo punto", () => {
    const estratos = base(); // 4 reps en cada uno
    const est = bootstrapRatioCIEstratificado(estratos, { resamples: 200, seed: 3 });
    const pool = pooled(estratos);
    expect(est.point).toBeCloseTo(pool.point, 12);
    // …y con la fórmula a mano: f = 1 − Σ mean(B_s) / Σ mean(A_s).
    const m = (xs: number[]) => xs.reduce((n, x) => n + x, 0) / xs.length;
    const aMano = 1 - estratos.reduce((n, e) => n + m(e.costB), 0) / estratos.reduce((n, e) => n + m(e.costA), 0);
    expect(est.point).toBeCloseTo(aMano, 12);
  });

  it("(c) el CI estratificado es determinista con semilla y contiene el punto", () => {
    const estratos = conRepsDuplicadas(base(), 0, 2);
    const uno = bootstrapRatioCIEstratificado(estratos, { resamples: 2000, seed: 42 });
    const dos = bootstrapRatioCIEstratificado(estratos, { resamples: 2000, seed: 42 });
    expect(uno).toEqual(dos);
    expect(uno.lower).toBeLessThanOrEqual(uno.point);
    expect(uno.upper).toBeGreaterThanOrEqual(uno.point);
    expect(uno.lower).toBeLessThan(uno.upper); // hay varianza dentro de los estratos
    // Otra semilla da otro intervalo (misma anchura aproximada, distintos decimales).
    const tres = bootstrapRatioCIEstratificado(estratos, { resamples: 2000, seed: 43 });
    expect(tres.point).toBe(uno.point);
    expect(tres.lower === uno.lower && tres.upper === uno.upper).toBe(false);
  });

  it("remuestrea DENTRO de cada escenario: un estrato constante no aporta anchura", () => {
    // Dos estratos sin varianza → intervalo degenerado en el punto.
    const constantes = [
      { costA: [1, 1, 1], costB: [0.5, 0.5, 0.5] },
      { costA: [2, 2, 2], costB: [1, 1, 1] },
    ];
    const ci = bootstrapRatioCIEstratificado(constantes, { resamples: 300, seed: 5 });
    expect(ci.point).toBeCloseTo(0.5, 12);
    expect(ci.lower).toBe(ci.point);
    expect(ci.upper).toBe(ci.point);
  });

  it("bordes: sin estratos → 0; estratos vacíos se ignoran; una sola muestra por estrato → CI degenerado", () => {
    expect(bootstrapRatioCIEstratificado([], { resamples: 10 })).toEqual({ point: 0, lower: 0, upper: 0 });
    const conVacio = bootstrapRatioCIEstratificado(
      [{ costA: [], costB: [] }, { costA: [4], costB: [1] }],
      { resamples: 10 },
    );
    expect(conVacio).toEqual({ point: 0.75, lower: 0.75, upper: 0.75 });
  });
});
