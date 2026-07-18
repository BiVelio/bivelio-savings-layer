import { describe, it, expect } from "vitest";
import {
  mean,
  stddev,
  bootstrapMeanCI,
  bootstrapRatioCI,
  wilcoxonSignedRankP,
  mulberry32,
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
