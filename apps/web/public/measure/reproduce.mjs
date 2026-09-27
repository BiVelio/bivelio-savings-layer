#!/usr/bin/env node
// reproduce.mjs — recompute BiVelio's published A/B savings from its public trials CSV.
//
// Zero dependencies: Node 20+ built-ins and the global fetch. It never trusts the
// artefact's own numbers: it re-reads every paired trial from the CSV, re-runs the
// same seeded stratified bootstrap the bench runs (a line-by-line port of
// benchmarks/stats.ts) and compares the result with `===` against what the
// artefact publishes.
//
//   node reproduce.mjs [--artifact <path|url>] [--trials <path|url>] [--json]
//
// Defaults: https://savings.bivelio.com/data/ab-live.json and
//           https://savings.bivelio.com/data/ab-live-trials.csv
//
// Exit codes: 0 = every recomputation matches; 1 = at least one mismatch;
//             2 = input error (unreadable file, bad JSON/CSV, missing column).
//
// The method is documented in independent-measurement.md, next to this file.

import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const DEFAULT_ARTIFACT = "https://savings.bivelio.com/data/ab-live.json";
export const DEFAULT_TRIALS = "https://savings.bivelio.com/data/ab-live-trials.csv";

// ── Statistics: a line-by-line port of benchmarks/stats.ts ──────────────────

/** Deterministic PRNG (mulberry32), identical to the bench. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sum(xs) {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

const fraction = (aSum, bSum) => (aSum <= 0 ? 0 : 1 - bSum / aSum);

/** Pooled percentile bootstrap of f = 1 − ΣcostB/ΣcostA (per-scenario rows and `aggregatePooled`). */
export function bootstrapRatio(costA, costB, { resamples = 10000, alpha = 0.05, seed = 0x1234567 } = {}) {
  const n = Math.min(costA.length, costB.length);
  const point = fraction(sum(costA), sum(costB));
  if (n < 2) return { point, lower: point, upper: point };
  const rng = mulberry32(seed);
  const fs = new Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let aSum = 0;
    let bSum = 0;
    for (let i = 0; i < n; i++) {
      const j = (rng() * n) | 0;
      aSum += costA[j];
      bSum += costB[j];
    }
    fs[r] = fraction(aSum, bSum);
  }
  fs.sort((x, y) => x - y);
  return { point, lower: percentile(fs, alpha / 2), upper: percentile(fs, 1 - alpha / 2) };
}

/**
 * Stratified percentile bootstrap, one stratum per scenario, equal weight:
 *   f = 1 − Σ_s mean(costB_s) / Σ_s mean(costA_s)
 * resampled within each stratum. This is the headline estimator.
 */
export function bootstrapEstratificado(strata, { resamples = 10000, alpha = 0.05, seed = 0x1234567 } = {}) {
  const estratos = strata
    .map((e) => {
      const n = Math.min(e.costA.length, e.costB.length);
      return { n, costA: e.costA.slice(0, n), costB: e.costB.slice(0, n) };
    })
    .filter((e) => e.n > 0);
  if (estratos.length === 0) return { point: 0, lower: 0, upper: 0 };
  let aPoint = 0;
  let bPoint = 0;
  for (const e of estratos) {
    aPoint += sum(e.costA) / e.n;
    bPoint += sum(e.costB) / e.n;
  }
  const point = fraction(aPoint, bPoint);
  if (!estratos.some((e) => e.n >= 2)) return { point, lower: point, upper: point };
  const rng = mulberry32(seed);
  const fs = new Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let aTotal = 0;
    let bTotal = 0;
    for (const e of estratos) {
      let aSum = 0;
      let bSum = 0;
      for (let i = 0; i < e.n; i++) {
        const j = (rng() * e.n) | 0;
        aSum += e.costA[j];
        bSum += e.costB[j];
      }
      aTotal += aSum / e.n;
      bTotal += bSum / e.n;
    }
    fs[r] = fraction(aTotal, bTotal);
  }
  fs.sort((x, y) => x - y);
  return { point, lower: percentile(fs, alpha / 2), upper: percentile(fs, 1 - alpha / 2) };
}

// ── Input ────────────────────────────────────────────────────────────────────

export class InputError extends Error {}

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"' && field === "") {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (quoted) throw new InputError("CSV: unterminated quoted field");
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** The paired trials, grouped by scenario in order of first appearance. */
export function readTrials(csvText) {
  const rows = parseCsv(csvText);
  if (rows.length === 0) throw new InputError("CSV: empty");
  const header = rows[0];
  const col = (name, required) => {
    const i = header.indexOf(name);
    if (i < 0 && required) throw new InputError(`CSV: missing column ${name}`);
    return i;
  };
  const iS = col("scenario", true);
  const iA = col("costA", true);
  const iB = col("costB", true);
  const iA1 = col("costA1", false);
  const iA2 = col("costA2", false);
  const num = (v, what) => {
    const n = Number(v);
    if (v === "" || !Number.isFinite(n)) throw new InputError(`CSV: ${what} is not a number (${JSON.stringify(v)})`);
    return n;
  };
  const opt = (r, i) => (i < 0 || r[i] === undefined || r[i] === "" ? null : num(r[i], header[i]));
  const byScenario = new Map();
  for (const r of rows.slice(1)) {
    const name = r[iS];
    if (!byScenario.has(name)) byScenario.set(name, []);
    byScenario.get(name).push({ costA: num(r[iA], "costA"), costA1: opt(r, iA1), costA2: opt(r, iA2), costB: num(r[iB], "costB") });
  }
  return { rows: rows.length - 1, scenarios: [...byScenario.entries()].map(([name, trials]) => ({ name, trials })) };
}

async function load(source) {
  if (/^https?:\/\//.test(source)) {
    let res;
    try {
      res = await fetch(source);
    } catch (e) {
      throw new InputError(`cannot fetch ${source}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) throw new InputError(`cannot fetch ${source}: HTTP ${res.status}`);
    return res.text();
  }
  try {
    return await readFile(source, "utf8");
  } catch (e) {
    throw new InputError(`cannot read ${source}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── The checks ───────────────────────────────────────────────────────────────

const CI_KEYS = ["point", "lower", "upper"];
const same = (a, b) => CI_KEYS.every((k) => a?.[k] === b?.[k]);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * Recompute and compare. Returns a report; `mismatches` > 0 means the artefact
 * does not follow from its own trials.
 */
export function verify(artifact, trials) {
  const checks = [];
  const warnings = [];
  const add = (name, status, detail) => checks.push({ name, status, ...(detail ? { detail } : {}) });
  const seed = isNum(artifact?.config?.seed) ? artifact.config.seed : undefined;
  const resamples = isNum(artifact?.config?.resamples) ? artifact.config.resamples : 10000;
  if (seed === undefined) add("config.seed", "mismatch", "the artefact does not declare config.seed: nothing can be recomputed");
  const opts = { seed, resamples };

  // 1. The trial count ties the CSV to this JSON.
  if (isNum(artifact?.trials)) {
    add("trials", artifact.trials === trials.rows ? "match" : "mismatch", `artefact ${artifact.trials}, CSV ${trials.rows} rows`);
  } else {
    warnings.push("the artefact does not declare `trials`: the CSV cannot be tied to it by count");
  }

  // 2. Every aggregate against its control arm, recomputed from the CSV.
  const comparisons = [
    { name: "aggregate (B vs B0)", field: "aggregate", a: "costA", b: "costB" },
    { name: "aggregateB1 (B vs B1)", field: "aggregateB1", a: "costA1", b: "costB" },
    { name: "aggregateB2 (B vs B2)", field: "aggregateB2", a: "costA2", b: "costB" },
    { name: "aggregateNativeVsB0 (B2 vs B0)", field: "aggregateNativeVsB0", a: "costA", b: "costA2" },
  ];
  const recomputed = {};
  for (const c of comparisons) {
    const published = artifact?.[c.field]?.savings;
    if (!published) continue;
    const strata = trials.scenarios.map((s) => {
      const t = s.trials.filter((x) => x[c.a] !== null && x[c.b] !== null);
      return { costA: t.map((x) => x[c.a]), costB: t.map((x) => x[c.b]) };
    });
    if (strata.every((s) => s.costA.length === 0)) {
      add(c.name, "mismatch", `the artefact publishes ${c.field} but the CSV has no ${c.a} values`);
      continue;
    }
    const r = bootstrapEstratificado(strata, opts);
    recomputed[c.field] = r;
    add(c.name, same(r, published) ? "match" : "mismatch", same(r, published) ? undefined : `recomputed ${JSON.stringify(r)}, published ${JSON.stringify(published)}`);
  }
  if (artifact?.aggregatePooled?.savings) {
    const all = trials.scenarios.flatMap((s) => s.trials);
    const r = bootstrapRatio(all.map((x) => x.costA), all.map((x) => x.costB), opts);
    add("aggregatePooled (B vs B0, all trials)", same(r, artifact.aggregatePooled.savings) ? "match" : "mismatch");
  }

  // 3. Every scenario row, recomputed from its own trials.
  const rowsBy = new Map(trials.scenarios.map((s) => [s.name, s.trials]));
  const published = Array.isArray(artifact?.scenarios) ? artifact.scenarios : [];
  let rowMismatches = 0;
  for (const s of published) {
    const t = rowsBy.get(s?.name);
    if (!t) {
      rowMismatches++;
      add(`scenario «${s?.name}»`, "mismatch", "no trials in the CSV");
      continue;
    }
    for (const [field, a] of [["measured", "costA"], ["measuredB1", "costA1"], ["measuredB2", "costA2"]]) {
      if (!s[field]?.savings) continue;
      const r = bootstrapRatio(t.map((x) => x[a] ?? 0), t.map((x) => x.costB), opts);
      if (!same(r, s[field].savings)) {
        rowMismatches++;
        add(`scenario «${s.name}» ${field}`, "mismatch", `recomputed ${JSON.stringify(r)}`);
      }
    }
  }
  if (published.length) add(`scenario rows (${published.length})`, rowMismatches === 0 ? "match" : "mismatch");
  if (published.length && trials.scenarios.length !== published.length) {
    add("scenarios in CSV vs artefact", "mismatch", `CSV ${trials.scenarios.length}, artefact ${published.length}`);
  }
  if (isNum(artifact?.aggregate?.strata)) {
    add("aggregate.strata", artifact.aggregate.strata === trials.scenarios.length ? "match" : "mismatch");
  }

  // 4. No row dropped in silence.
  const notApplicable = Array.isArray(artifact?.scenariosNotApplicable) ? artifact.scenariosNotApplicable : [];
  if (artifact?.scenarioSet) {
    const names = new Set([...published.map((s) => s?.name), ...notApplicable.map((s) => s?.name)]);
    const missing = (artifact.scenarioSet.names ?? []).filter((n) => !names.has(n));
    const ok = artifact.scenarioSet.size === published.length + notApplicable.length && missing.length === 0;
    add("scenarioSet (every scenario measured or declared)", ok ? "match" : "mismatch", missing.length ? `missing: ${missing.join(", ")}` : undefined);
  } else {
    warnings.push("the artefact does not declare `scenarioSet`: it cannot be checked that no scenario was dropped");
  }

  // 5. The floors: each is its aggregate's lower bound, and `min` is the lowest.
  if (artifact?.floors) {
    const f = artifact.floors;
    const pairs = [["vsB0", "aggregate"], ["vsB1", "aggregateB1"], ["vsB2", "aggregateB2"]];
    let ok = true;
    for (const [k, agg] of pairs) {
      const lower = artifact?.[agg]?.savings?.lower;
      if (f[k] === null || f[k] === undefined) {
        if (isNum(lower)) ok = false;
      } else if (f[k] !== lower) {
        ok = false;
      }
    }
    const present = pairs.map(([k]) => f[k]).filter(isNum);
    if (!present.length || f.min !== Math.min(...present)) ok = false;
    add("floors (each = its aggregate's lower bound; min = the lowest)", ok ? "match" : "mismatch");
  } else {
    warnings.push("the artefact does not declare `floors`: check yourself that any claim fits under the lowest lower bound");
  }

  // 6. Seals: not recomputations, but what a reader must look at before trusting it.
  if (artifact?.sdk?.asShipped !== true) {
    warnings.push("sdk.asShipped is not true: the artefact does not state that it measured the SDK as installed from npm");
  }
  if (artifact?.sdk?.version) {
    warnings.push(`sdk.version = ${artifact.sdk.version}: compare with \`npm view @bivelio/savings-layer version\``);
  }
  if (artifact?.mode !== "LIVE") warnings.push(`mode = ${artifact?.mode}: not a live measurement, not a savings claim`);
  if (artifact?.modelStable === false) warnings.push("modelStable = false: the arms were not served by the same model");
  if (artifact?.pricing?.listPriceKnown === false) warnings.push("pricing.listPriceKnown = false: dollars are illustrative");
  const cw = artifact?.pricing?.cacheWrites;
  if (isNum(cw?.premium) && cw.premium > 1 && cw.metered !== true) {
    warnings.push("pricing.cacheWrites.metered is not true on a model with a cache-write premium: writes may be under-priced");
  }
  if (artifact?.native?.degradedByTransport === true) warnings.push("native.degradedByTransport = true: arm B2 is not what it claims");
  if (artifact?.native?.honored?.promptCacheMode === false) warnings.push("native.honored.promptCacheMode = false");
  if (artifact?.mode === "LIVE" && !artifact?.transport?.endpointHost) {
    warnings.push("transport.endpointHost is missing: the provider measured against is not declared");
  }
  if (!artifact?.aggregateB2 && artifact?.mode === "LIVE") {
    warnings.push("no aggregateB2: no comparison against a natively well-configured integration (arm B2)");
  }

  // 7. Red rows: publish them, do not drop them.
  const red = [];
  for (const s of published) {
    for (const [field, against] of [["measured", "B0"], ["measuredB1", "B1"], ["measuredB2", "B2"]]) {
      const sv = s?.[field]?.savings;
      if (!sv) continue;
      if (sv.upper < 0) red.push({ scenario: s.name, against, status: "proven loss", point: sv.point, upper: sv.upper });
      else if (sv.point < 0) red.push({ scenario: s.name, against, status: "red", point: sv.point, upper: sv.upper });
    }
  }

  const mismatches = checks.filter((c) => c.status === "mismatch").length;
  return {
    ok: mismatches === 0,
    mismatches,
    checks,
    warnings,
    redRows: red,
    notApplicable: notApplicable.map((s) => ({ name: s?.name, reason: s?.motivo ?? s?.reason })),
    leversNotExercised: (artifact?.levers?.notExercised ?? []).length,
    leversNotMeasurable: (artifact?.levers?.notMeasurable ?? []).length,
    recomputed,
    floors: artifact?.floors ?? null,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { artifact: DEFAULT_ARTIFACT, trials: DEFAULT_TRIALS, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--artifact" || a === "--trials") {
      const v = argv[++i];
      if (!v) throw new InputError(`${a} needs a path or URL`);
      out[a.slice(2)] = v;
    } else if (a.startsWith("--artifact=")) out.artifact = a.slice("--artifact=".length);
    else if (a.startsWith("--trials=")) out.trials = a.slice("--trials=".length);
    else if (a === "--help" || a === "-h") {
      out.help = true;
    } else throw new InputError(`unknown argument ${a}`);
  }
  return out;
}

const pct = (n) => (isNum(n) ? `${(n * 100).toFixed(1)}%` : String(n));

export async function main(argv = process.argv.slice(2)) {
  let args;
  let report;
  try {
    args = parseArgs(argv);
    if (args.help) {
      console.log("usage: node reproduce.mjs [--artifact <path|url>] [--trials <path|url>] [--json]");
      return 0;
    }
    const [artifactText, csvText] = await Promise.all([load(args.artifact), load(args.trials)]);
    let artifact;
    try {
      artifact = JSON.parse(artifactText);
    } catch (e) {
      throw new InputError(`artefact is not JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    report = verify(artifact, readTrials(csvText));
  } catch (e) {
    if (e instanceof InputError) {
      if (args?.json) console.log(JSON.stringify({ ok: false, inputError: e.message }, null, 2));
      else console.error(`input error: ${e.message}`);
      return 2;
    }
    throw e;
  }
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`artefact: ${args.artifact}\ntrials:   ${args.trials}\n`);
    for (const c of report.checks) console.log(`${c.status === "match" ? "  ok  " : "  FAIL"}  ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
    if (report.floors) {
      console.log(`\nfloors: vs B0 ${pct(report.floors.vsB0)}, vs B1 ${pct(report.floors.vsB1)}, vs B2 ${pct(report.floors.vsB2)}; any claim must fit under ${pct(report.floors.min)} (against ${report.floors.minAgainst})`);
    }
    if (report.redRows.length) {
      console.log("\nred rows (publish them):");
      for (const r of report.redRows) console.log(`  ${r.status.padEnd(12)} ${r.scenario} vs ${r.against}: point ${pct(r.point)}, upper ${pct(r.upper)}`);
    }
    if (report.notApplicable.length) console.log(`\nscenarios not applicable: ${report.notApplicable.map((s) => s.name).join(", ")}`);
    console.log(`levers not exercised: ${report.leversNotExercised}; not measurable: ${report.leversNotMeasurable}`);
    if (report.warnings.length) {
      console.log("\nwarnings:");
      for (const w of report.warnings) console.log(`  - ${w}`);
    }
    console.log(report.ok ? "\nEvery recomputation matches the published figures." : `\n${report.mismatches} recomputation(s) do NOT match.`);
  }
  return report.ok ? 0 : 1;
}

async function esPrincipal() {
  if (!process.argv[1]) return false;
  try {
    return (await realpath(process.argv[1])) === (await realpath(fileURLToPath(import.meta.url)));
  } catch {
    return false;
  }
}

if (await esPrincipal()) {
  process.exitCode = await main();
}
