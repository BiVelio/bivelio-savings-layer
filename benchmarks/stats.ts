/**
 * Statistics for the A/B live benchmark.
 * ---------------------------------------------------------------------------
 * LLM outputs are nondeterministic, so a single trial is a sample, not a fact.
 * These pure functions turn paired per-trial measurements into a claim we can
 * defend: a bootstrap confidence interval whose LOWER bound is what we surface
 * ("verified ≥ X%"), never the flattering point estimate. A seeded PRNG keeps
 * the interval reproducible for a given run.
 */

/** Deterministic PRNG (mulberry32) — reproducible bootstrap given a seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx]!;
}

export interface CI {
  point: number;
  lower: number;
  upper: number;
}

/**
 * Percentile bootstrap CI for the mean of a paired-difference sample. `alpha`
 * is the two-sided error (0.05 → 95% CI). Resampling is seeded for reproducibility.
 */
export function bootstrapMeanCI(
  deltas: number[],
  opts: { resamples?: number; alpha?: number; seed?: number } = {},
): CI {
  const n = deltas.length;
  const point = mean(deltas);
  if (n < 2) return { point, lower: point, upper: point };
  const resamples = opts.resamples ?? 10000;
  const alpha = opts.alpha ?? 0.05;
  const rng = mulberry32(opts.seed ?? 0x9e3779b9);
  const means: number[] = new Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += deltas[(rng() * n) | 0]!;
    means[r] = s / n;
  }
  means.sort((a, b) => a - b);
  return { point, lower: percentile(means, alpha / 2), upper: percentile(means, 1 - alpha / 2) };
}

/**
 * Percentile bootstrap CI for the paired savings FRACTION
 *   f = 1 − Σ costB / Σ costA
 * resampling paired (costA[i], costB[i]) indices together. This is the headline
 * "net savings" — we report its LOWER bound.
 */
export function bootstrapRatioCI(
  costA: number[],
  costB: number[],
  opts: { resamples?: number; alpha?: number; seed?: number } = {},
): CI {
  const n = Math.min(costA.length, costB.length);
  const fraction = (aSum: number, bSum: number): number => (aSum <= 0 ? 0 : 1 - bSum / aSum);
  const point = fraction(sum(costA), sum(costB));
  if (n < 2) return { point, lower: point, upper: point };
  const resamples = opts.resamples ?? 10000;
  const alpha = opts.alpha ?? 0.05;
  const rng = mulberry32(opts.seed ?? 0x1234567);
  const fs: number[] = new Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let aSum = 0, bSum = 0;
    for (let i = 0; i < n; i++) {
      const j = (rng() * n) | 0;
      aSum += costA[j]!;
      bSum += costB[j]!;
    }
    fs[r] = fraction(aSum, bSum);
  }
  fs.sort((a, b) => a - b);
  return { point, lower: percentile(fs, alpha / 2), upper: percentile(fs, 1 - alpha / 2) };
}

function sum(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

/**
 * One-sided Wilcoxon signed-rank test (normal approximation with tie &
 * continuity correction) for H0: median(delta) = 0 vs H1: median > 0. Returns a
 * p-value; small p ⇒ the positive savings are unlikely to be noise. A robust
 * secondary check alongside the bootstrap (does not assume normality).
 */
export function wilcoxonSignedRankP(deltas: number[]): number {
  const nz = deltas.filter((d) => d !== 0);
  const n = nz.length;
  if (n < 1) return 1;
  const abs = nz.map((d, i) => ({ a: Math.abs(d), sign: Math.sign(d), i }));
  abs.sort((x, y) => x.a - y.a);
  // Assign average ranks, tracking tie groups for the variance correction.
  const ranks = new Array(n).fill(0);
  let tieSum = 0;
  let k = 0;
  while (k < n) {
    let j = k;
    while (j + 1 < n && abs[j + 1]!.a === abs[k]!.a) j++;
    const avg = (k + 1 + (j + 1)) / 2; // average of ranks (1-based) k+1..j+1
    const groupSize = j - k + 1;
    if (groupSize > 1) tieSum += groupSize ** 3 - groupSize;
    for (let m = k; m <= j; m++) ranks[m] = avg;
    k = j + 1;
  }
  let wPlus = 0;
  for (let m = 0; m < n; m++) if (abs[m]!.sign > 0) wPlus += ranks[m]!;
  const meanW = (n * (n + 1)) / 4;
  const varW = (n * (n + 1) * (2 * n + 1)) / 24 - tieSum / 48;
  if (varW <= 0) return wPlus > meanW ? 0 : 1;
  const z = (wPlus - meanW - 0.5) / Math.sqrt(varW); // continuity correction
  return 1 - normalCdf(z);
}

function normalCdf(z: number): number {
  // Abramowitz & Stegun 7.1.26 approximation of erf.
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp((-z * z) / 2);
  const cdf = 0.5 * (1 + (z >= 0 ? y : -y));
  return cdf;
}
