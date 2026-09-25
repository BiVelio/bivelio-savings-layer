import { describe, it, expect } from "vitest";

import { bootstrapMeanCI, bootstrapRatioCIEstratificado, mulberry32 } from "../benchmarks/stats.js";
import {
  bootstrapEstratificadoPonderado,
  bootstrapMediaCI,
} from "../apps/web/lib/verificacion/bootstrap.js";

/**
 * EL BOOTSTRAP DE «TU PROPIO BANCO» ES EL DEL BANCO PUBLICADO, CON PESOS.
 * Ancla: con todos los pesos a 1, la fracción coincide BIT A BIT con
 * `bootstrapRatioCIEstratificado` (tres fixtures × tres semillas). Con pesos de
 * población, el punto es Σ W_h·media_h.
 */

function fixture(semilla: number, estratos: number, n: () => number) {
  const rng = mulberry32(semilla);
  return Array.from({ length: estratos }, () => {
    const k = n();
    const a = Array.from({ length: k }, () => 0.0001 + rng() * 0.01);
    const b = a.map((x) => x * (0.4 + rng() * 0.8));
    return { a, b };
  });
}

const FIXTURES = [
  fixture(1, 5, () => 24),
  fixture(2, 3, (() => { let i = 0; return () => [1, 7, 40][i++ % 3]!; })()),
  fixture(3, 8, (() => { let i = 0; return () => 2 + (i++ * 5) % 17; })()),
];

describe("ancla: con pesos 1, igual que el banco publicado", () => {
  for (const [f, estratos] of FIXTURES.entries()) {
    for (const semilla of [0x1234567, 42, 20260925]) {
      it(`fixture ${f}, semilla ${semilla}`, () => {
        const banco = bootstrapRatioCIEstratificado(
          estratos.map((e) => ({ costA: e.a, costB: e.b })),
          { resamples: 2000, alpha: 0.05, seed: semilla },
        );
        const propio = bootstrapEstratificadoPonderado(
          estratos.map((e) => ({ peso: 1, a: e.a, b: e.b })),
          { remuestreos: 2000, alfa: 0.05, semilla },
        );
        expect(propio.fraccion).toEqual(banco);
      });
    }
  }

  it("bootstrapMediaCI = bootstrapMeanCI", () => {
    const d = FIXTURES[0]![0]!.a.map((x, i) => x - FIXTURES[0]![0]!.b[i]!);
    expect(bootstrapMediaCI(d, { remuestreos: 3000, alfa: 0.05, semilla: 9 })).toEqual(
      bootstrapMeanCI(d, { resamples: 3000, alpha: 0.05, seed: 9 }),
    );
  });
});

describe("con pesos de población", () => {
  it("el punto es Σ W_h·media_h (fracción) y la diferencia media ponderada", () => {
    const r = bootstrapEstratificadoPonderado(
      [
        { peso: 900, a: [10, 10], b: [9, 9] },
        { peso: 100, a: [10, 10], b: [1, 1] },
      ],
      { remuestreos: 500, alfa: 0.05, semilla: 1 },
    );
    // Aw = 900·10 + 100·10 = 10000 ; Bw = 900·9 + 100·1 = 8200
    expect(r.fraccion.point).toBeCloseTo(1 - 8200 / 10000, 12);
    expect(r.diferencia.point).toBeCloseTo((10000 - 8200) / 1000, 12);
    // Con pesos iguales el estrato raro dominaría: 1 − 10/20 = 0,5.
    expect(r.fraccion.point).not.toBeCloseTo(0.5, 3);
  });

  it("determinista por semilla, y lower ≤ point ≤ upper", () => {
    const e = FIXTURES[2]!.map((x, i) => ({ peso: 10 + i * 7, a: x.a, b: x.b }));
    const o = { remuestreos: 1500, alfa: 0.05, semilla: 77 };
    const r1 = bootstrapEstratificadoPonderado(e, o);
    expect(bootstrapEstratificadoPonderado(e, o)).toEqual(r1);
    expect(r1.fraccion.lower).toBeLessThanOrEqual(r1.fraccion.point);
    expect(r1.fraccion.point).toBeLessThanOrEqual(r1.fraccion.upper);
    expect(r1.diferencia.lower).toBeLessThanOrEqual(r1.diferencia.upper);
    expect(bootstrapEstratificadoPonderado(e, { ...o, semilla: 78 })).not.toEqual(r1);
  });

  it("casos degenerados: sin estratos, peso 0, n = 1", () => {
    expect(bootstrapEstratificadoPonderado([], { remuestreos: 10, alfa: 0.05, semilla: 1 }).fraccion).toEqual({ point: 0, lower: 0, upper: 0 });
    const r = bootstrapEstratificadoPonderado(
      [
        { peso: 0, a: [1, 2, 3], b: [0, 0, 0] },
        { peso: 5, a: [4], b: [3] },
      ],
      { remuestreos: 10, alfa: 0.05, semilla: 1 },
    );
    expect(r.fraccion).toEqual({ point: 0.25, lower: 0.25, upper: 0.25 });
    expect(r.diferencia).toEqual({ point: 1, lower: 1, upper: 1 });
  });
});
