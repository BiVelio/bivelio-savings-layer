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

/** Paired per-scenario samples: `costA[i]` and `costB[i]` are the same rep. */
export interface EstratoPareado {
  costA: number[];
  costB: number[];
}

/**
 * STRATIFIED percentile bootstrap CI for the savings fraction, one stratum per
 * scenario and EVERY scenario weighted the same:
 *
 *   f = 1 − Σ_s mean(costB_s) / Σ_s mean(costA_s)
 *
 * Why this exists. The pooled estimator (`bootstrapRatioCI` over every trial of
 * every scenario together) weights a scenario by its rep count × its cost. The
 * adaptive sampler pours extra reps into the NOISY scenarios, so the pooled
 * headline moved with the rep split, not with the layer: 20.8 % with REPS=16,
 * 16.5 % with REPS=8 when two low-saving scenarios reached 24 reps, 19.1 % the
 * next run — while the equal-weight figure stayed at 21.3 / 19.4 / 20.5. A
 * headline that depends on how long the sampler ran is not a measurement.
 *
 * Resampling is done WITHIN each stratum (n_s draws with replacement out of the
 * stratum's own n_s pairs), so a stratum's weight never changes across
 * resamples and the interval reflects per-scenario noise only — it is
 * CONDITIONAL on this scenario set (no between-scenario mix variance), which
 * is why it comes out much narrower than the pooled one. Seeded via
 * mulberry32 for reproducibility. Strata with no samples are skipped; a stratum
 * with one sample contributes a constant. With equal reps everywhere the point
 * equals the pooled point exactly (Σ n·mean = n·Σ mean).
 */
export function bootstrapRatioCIEstratificado(
  porEscenario: EstratoPareado[],
  opts: { resamples?: number; alpha?: number; seed?: number } = {},
): CI {
  const fraction = (aSum: number, bSum: number): number => (aSum <= 0 ? 0 : 1 - bSum / aSum);
  const estratos = porEscenario
    .map((e) => {
      const n = Math.min(e.costA.length, e.costB.length);
      return { n, costA: e.costA.slice(0, n), costB: e.costB.slice(0, n) };
    })
    .filter((e) => e.n > 0);
  if (estratos.length === 0) return { point: 0, lower: 0, upper: 0 };

  let aPoint = 0, bPoint = 0;
  for (const e of estratos) {
    aPoint += sum(e.costA) / e.n;
    bPoint += sum(e.costB) / e.n;
  }
  const point = fraction(aPoint, bPoint);
  // No stratum can vary under resampling → the interval is degenerate.
  if (!estratos.some((e) => e.n >= 2)) return { point, lower: point, upper: point };

  const resamples = opts.resamples ?? 10000;
  const alpha = opts.alpha ?? 0.05;
  const rng = mulberry32(opts.seed ?? 0x1234567);
  const fs: number[] = new Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let aTotal = 0, bTotal = 0;
    for (const e of estratos) {
      let aSum = 0, bSum = 0;
      for (let i = 0; i < e.n; i++) {
        const j = (rng() * e.n) | 0;
        aSum += e.costA[j]!;
        bSum += e.costB[j]!;
      }
      aTotal += aSum / e.n;
      bTotal += bSum / e.n;
    }
    fs[r] = fraction(aTotal, bTotal);
  }
  fs.sort((a, b) => a - b);
  return { point, lower: percentile(fs, alpha / 2), upper: percentile(fs, 1 - alpha / 2) };
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

/**
 * Cuantil de la normal estándar (algoritmo de Acklam; error relativo < 1,2e-9).
 * Solo para convertir `alpha` en `z`: con 0,05 da 1,959963985.
 */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError(`normalQuantile: p must be in (0,1), got ${p}`);
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const bajo = 0.02425;
  if (p < bajo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > 1 - bajo) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

/**
 * Wilson score interval for a binomial proportion k/n (two-sided, `alpha` total
 * error). Returns `null` when n = 0: there is no proportion to bound, and a
 * made-up [0, 1] would read as a measurement.
 *
 * Por qué Wilson y no Wald: con proporciones cerca de 0 o de 1 —la precisión de
 * una caché que casi nunca se equivoca— el intervalo de Wald se sale de [0, 1]
 * o colapsa a un punto con k = n. Wilson no.
 */
export function wilsonCI(k: number, n: number, alpha = 0.05): CI | null {
  if (n <= 0) return null;
  if (k < 0 || k > n) throw new RangeError(`wilsonCI: k=${k} out of [0, ${n}]`);
  const z = normalQuantile(1 - alpha / 2);
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centro = (p + z2 / (2 * n)) / denom;
  const radio = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { point: p, lower: Math.max(0, centro - radio), upper: Math.min(1, centro + radio) };
}

/** Un grupo (clúster) de observaciones: `num` aciertos sobre `den` intentos. */
export interface GrupoDeProporcion {
  num: number;
  den: number;
}

/**
 * CLUSTER bootstrap for a ratio of sums, Σnum / Σden, resampling whole GROUPS
 * with replacement (percentile interval, seeded with mulberry32).
 *
 * Existe para el stream de la caché semántica, donde las consultas NO son
 * independientes: si una acierta depende de lo que ya hay en la caché, y eso
 * depende de las consultas anteriores de la misma clase. Remuestrear consultas
 * sueltas fingiría una independencia que no hay y daría un intervalo más
 * estrecho del que toca; remuestrear clases conserva esa dependencia dentro del
 * grupo.
 *
 * Los grupos con `den = 0` no aportan nada a ningún remuestreo y se descartan.
 * Un remuestreo cuyo Σden sale 0 no define proporción y no entra en los
 * percentiles.
 */
export function bootstrapProporcionPorGrupos(
  grupos: GrupoDeProporcion[],
  opts: { resamples?: number; alpha?: number; seed?: number } = {},
): CI | null {
  const utiles = grupos.filter((g) => g.den > 0);
  let num = 0;
  let den = 0;
  for (const g of utiles) {
    num += g.num;
    den += g.den;
  }
  if (den === 0) return null;
  const point = num / den;
  const G = utiles.length;
  if (G < 2) return { point, lower: point, upper: point };
  const resamples = opts.resamples ?? 2000;
  const alpha = opts.alpha ?? 0.05;
  const rng = mulberry32(opts.seed ?? 0x5eed);
  const ratios: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let sn = 0;
    let sd = 0;
    for (let i = 0; i < G; i++) {
      const g = utiles[(rng() * G) | 0]!;
      sn += g.num;
      sd += g.den;
    }
    if (sd > 0) ratios.push(sn / sd);
  }
  if (ratios.length === 0) return { point, lower: point, upper: point };
  ratios.sort((a, b) => a - b);
  return { point, lower: percentile(ratios, alpha / 2), upper: percentile(ratios, 1 - alpha / 2) };
}
