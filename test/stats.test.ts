import { describe, it, expect } from "vitest";
import {
  mean,
  stddev,
  bootstrapMeanCI,
  bootstrapRatioCI,
  wilcoxonSignedRankP,
  mulberry32,
  wilsonCI,
  normalQuantile,
  bootstrapProporcionPorGrupos,
} from "../benchmarks/stats.js";

describe("stats — descriptive", () => {
  it("mean and sample stddev", () => {
    expect(mean([2, 4, 6])).toBe(4);
    expect(stddev([2, 4, 6])).toBeCloseTo(2, 6);
    expect(stddev([5])).toBe(0);
  });
});

describe("stats — bootstrap CIs (seeded, reproducible)", () => {
  it("mean CI brackets the true mean and is reproducible for a fixed seed", () => {
    const deltas = Array.from({ length: 200 }, (_, i) => 1 + ((i % 5) - 2) * 0.1);
    const a = bootstrapMeanCI(deltas, { resamples: 2000, seed: 42 });
    const b = bootstrapMeanCI(deltas, { resamples: 2000, seed: 42 });
    expect(a.lower).toBe(b.lower); // deterministic under a fixed seed
    expect(a.lower).toBeLessThanOrEqual(a.point);
    expect(a.upper).toBeGreaterThanOrEqual(a.point);
    expect(a.point).toBeCloseTo(1, 1);
    expect(a.lower).toBeLessThanOrEqual(1);
    expect(a.upper).toBeGreaterThanOrEqual(1);
  });

  it("ratio CI: savings fraction lower bound is below the point estimate", () => {
    // costB consistently ~40% of costA → ~60% savings.
    const costA = Array.from({ length: 100 }, () => 10);
    const costB = Array.from({ length: 100 }, (_, i) => 4 + ((i % 3) - 1) * 0.5);
    const ci = bootstrapRatioCI(costA, costB, { resamples: 2000, seed: 7 });
    expect(ci.point).toBeCloseTo(0.6, 1);
    expect(ci.lower).toBeLessThanOrEqual(ci.point);
    expect(ci.lower).toBeGreaterThan(0); // clearly-positive savings
  });

  it("ratio CI lower bound can be ≤ 0 when savings are noisy around zero", () => {
    const costA = Array.from({ length: 60 }, (_, i) => 10 + ((i % 7) - 3));
    const costB = Array.from({ length: 60 }, (_, i) => 10 + ((i * 3) % 7) - 3);
    const ci = bootstrapRatioCI(costA, costB, { resamples: 2000, seed: 11 });
    expect(ci.lower).toBeLessThanOrEqual(0.05);
  });
});

describe("stats — Wilcoxon signed-rank (one-sided, median > 0)", () => {
  it("returns a tiny p-value for clearly positive deltas", () => {
    const deltas = Array.from({ length: 30 }, (_, i) => 0.5 + i * 0.01);
    expect(wilcoxonSignedRankP(deltas)).toBeLessThan(0.001);
  });

  it("returns a large p-value for deltas centered on zero", () => {
    const deltas = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 1 : -1) * (1 + (i % 3)));
    expect(wilcoxonSignedRankP(deltas)).toBeGreaterThan(0.2);
  });
});

describe("stats — mulberry32 PRNG", () => {
  it("is deterministic and in [0,1)", () => {
    const r1 = mulberry32(123);
    const r2 = mulberry32(123);
    for (let i = 0; i < 50; i++) {
      const v = r1();
      expect(v).toBe(r2());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("stats — Wilson (precisión y recall de la caché semántica)", () => {
  it("wilsonCI(5,10) ≈ [0,2366; 0,7634]", () => {
    const ci = wilsonCI(5, 10)!;
    expect(ci.point).toBe(0.5);
    expect(ci.lower).toBeCloseTo(0.2366, 4);
    expect(ci.upper).toBeCloseTo(0.7634, 4);
  });

  it("wilsonCI(0,10) ≈ [0; 0,2775]: no colapsa a un punto con k = 0", () => {
    const ci = wilsonCI(0, 10)!;
    expect(ci.lower).toBe(0);
    expect(ci.upper).toBeCloseTo(0.2775, 4);
  });

  it("wilsonCI(0,0) es null: sin denominador no hay proporción que acotar", () => {
    expect(wilsonCI(0, 0)).toBeNull();
  });

  it("wilsonCI(10,10) no se sale de [0,1] y su suelo queda por debajo de 1", () => {
    const ci = wilsonCI(10, 10)!;
    expect(ci.upper).toBe(1);
    expect(ci.lower).toBeLessThan(1);
    expect(ci.lower).toBeCloseTo(0.7225, 4);
  });

  it("normalQuantile(0,975) = 1,959964", () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 6);
    expect(normalQuantile(0.5)).toBeCloseTo(0, 12);
  });
});

describe("stats — bootstrap por grupos (el stream no tiene consultas independientes)", () => {
  const grupos = Array.from({ length: 40 }, (_, i) => ({ num: i % 3, den: 3 + (i % 5) }));

  it("es determinista con semilla", () => {
    const a = bootstrapProporcionPorGrupos(grupos, { resamples: 500, seed: 9 })!;
    const b = bootstrapProporcionPorGrupos(grupos, { resamples: 500, seed: 9 })!;
    expect(a).toEqual(b);
    expect(a.lower).toBeLessThanOrEqual(a.point);
    expect(a.upper).toBeGreaterThanOrEqual(a.point);
  });

  it("colapsa si todos los grupos tienen la misma proporción", () => {
    const iguales = [
      { num: 1, den: 2 },
      { num: 3, den: 6 },
      { num: 5, den: 10 },
    ];
    expect(bootstrapProporcionPorGrupos(iguales, { resamples: 300, seed: 1 })).toEqual({ point: 0.5, lower: 0.5, upper: 0.5 });
  });

  it("sin denominador, null; los grupos vacíos no cuentan", () => {
    expect(bootstrapProporcionPorGrupos([{ num: 0, den: 0 }])).toBeNull();
    expect(bootstrapProporcionPorGrupos([{ num: 1, den: 2 }, { num: 0, den: 0 }])).toEqual({ point: 0.5, lower: 0.5, upper: 0.5 });
  });
});
