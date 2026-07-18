/**
 * BV-SALA TRUE A/B live benchmark. Run: pnpm ab
 * ---------------------------------------------------------------------------
 * The only honest way to prove a saving is to MEASURE both worlds against the
 * same real provider — never to compare a measured optimized call against a
 * MODELED baseline. So for every scenario this runs TWO real requests to the
 * SAME endpoint/model:
 *
 *   Arm A (naive)     — what a team WITHOUT BV-SALA sends: full uncompressed
 *                       JSON payload on the wire, all tools transmitted, no
 *                       cache, no output cap, no schema. Priced from the
 *                       provider's own usage.
 *   Arm B (BV-SALA)   — the same task through the layer. Priced from the
 *                       provider's own usage (or $0 when the call is genuinely
 *                       avoided).
 *
 * savings = the MEASURED paired dollar delta. Both arms are metered by the same
 * provider tokenizer, so no fabricated baseline can enter. We report the 95%
 * bootstrap CI LOWER bound ("verified ≥ X%"), never the flattering point value,
 * and a quality gate voids any saving whose answer regressed.
 *
 * MODES:
 *   LIVE  — set BVSALA_DEMO_BASE_URL (+ BVSALA_DEMO_API_KEY, BVSALA_DEMO_MODEL)
 *           to an OpenAI-compatible endpoint (OpenAI, Vercel AI Gateway, vLLM…).
 *           Dollars are REAL provider tokens & cost.
 *   MOCK  — no network. Exercises the entire A/B pipeline deterministically to
 *           prove the plumbing, but every dollar is labeled "ESTIMATED — NOT a
 *           savings claim" because the mock is not a real model.
 *
 * ENV: BVSALA_AB_REPS (paired reps for generative scenarios), BVSALA_AB_SEED,
 *      BVSALA_DEMO_KEEP_PREFIX, and optionally a judge endpoint
 *      BVSALA_JUDGE_BASE_URL / _API_KEY / _MODEL for LIVE answer-vs-answer QA.
 */
import {
  createSavingsLayer,
  createMockProvider,
  OpenAICompatibleProvider,
  type CostModel,
  type Provider,
  type SavingsRequest,
  type SavingsResult,
} from "../src/index.js";
import { scenarios, type Scenario } from "./scenarios.js";
import { bootstrapRatioCI, wilcoxonSignedRankP, mean, type CI } from "./stats.js";
import { writeReport, writeCsv } from "./report.js";

// ── Real per-model price table (USD per 1K tokens). Public list pricing; the
// EXACT figures are dated in the report and overridable. Because both arms are
// priced with the SAME model, any price error cancels in the savings RATIO —
// only cross-model and cached-rate differences move the percentage.
const PRICES: Record<string, CostModel> = {
  "gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006, cachedInputPer1k: 0.000075 },
  "gpt-4o": { inputPer1k: 0.0025, outputPer1k: 0.01, cachedInputPer1k: 0.00125 },
  "gpt-4.1-mini": { inputPer1k: 0.0004, outputPer1k: 0.0016, cachedInputPer1k: 0.0001 },
  "gpt-4.1": { inputPer1k: 0.002, outputPer1k: 0.008, cachedInputPer1k: 0.0005 },
};
const PRICING_NOTE =
  "USD/1K tokens, illustrative public list pricing; verify against your provider's current rates. " +
  "Both arms share one price, so the savings % is insensitive to price level.";
const FALLBACK_PRICE: CostModel = { inputPer1k: 0.00015, outputPer1k: 0.0006, cachedInputPer1k: 0.000075 };

const baseUrl = process.env.BVSALA_DEMO_BASE_URL;
const apiKey = process.env.BVSALA_DEMO_API_KEY;
const liveModel = process.env.BVSALA_DEMO_MODEL;
const keepPrefix = !!process.env.BVSALA_DEMO_KEEP_PREFIX;
const mode: "LIVE" | "MOCK" = baseUrl ? "LIVE" : "MOCK";
const SEED = intEnv("BVSALA_AB_SEED", 1234567);
const REPS = intEnv("BVSALA_AB_REPS", mode === "LIVE" ? 8 : 4);
// Adaptive sampling (LIVE only): keep drawing paired reps for a noisy scenario
// until its savings CI is tight enough, or a hard cap is reached. Deterministic
// MOCK converges immediately (CI half-width 0).
const MAX_REPS = intEnv("BVSALA_AB_MAX_REPS", REPS * 3);
const CI_TARGET = Number(process.env.BVSALA_AB_CI_TARGET ?? 0.03); // desired ± half-width on the savings fraction
const QUALITY_FLOOR = Number(process.env.BVSALA_AB_QUALITY_FLOOR ?? 0.999);

function intEnv(name: string, def: number): number {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

/** Raw provider (Arm A calls this directly, bypassing the layer). */
function makeProvider(): Provider {
  return baseUrl
    ? new OpenAICompatibleProvider({
        baseUrl,
        ...(apiKey ? { apiKey } : {}),
        stripProviderPrefix: !keepPrefix,
        requireUsage: true, // never let missing usage become a fabricated 100% saving
      })
    : createMockProvider();
}

const modelId = (r: SavingsRequest): string => (liveModel ? liveModel : r.model);

function priceFor(model: string): CostModel {
  const key = model.replace(/^[^/]+\//, "");
  return PRICES[key] ?? PRICES[model] ?? FALLBACK_PRICE;
}

interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}
function cost(model: string, u: Usage): number {
  const p = priceFor(model);
  const cached = u.cachedInputTokens ?? 0;
  const billedInput = Math.max(0, u.inputTokens - cached);
  return (
    (billedInput / 1000) * p.inputPer1k +
    (cached / 1000) * (p.cachedInputPer1k ?? p.inputPer1k) +
    (u.outputTokens / 1000) * p.outputPer1k
  );
}

/**
 * Arm A — the naive request an un-optimized team would send: full JSON payload
 * inline, all tools transmitted natively, NO schema, NO output cap.
 */
function buildNaive(req: SavingsRequest): {
  model: string;
  messages: { role: "system" | "user" | "assistant" | "tool"; content: string }[];
  tools?: SavingsRequest["tools"];
  temperature: number;
  seed: number;
} {
  const messages = req.messages.map((m) => ({ role: m.role, content: m.content }));
  if (req.structuredData !== undefined) {
    messages.push({ role: "user", content: JSON.stringify(req.structuredData) });
  }
  return {
    model: modelId(req),
    messages,
    ...(req.tools && req.tools.length ? { tools: req.tools } : {}),
    temperature: 0,
    seed: 7,
  };
}

type Kind = "resolver" | "cache" | "ran";

function usageOf(res: SavingsResult): Usage {
  const t = res.report.tokens;
  return {
    inputTokens: t.actualInput,
    outputTokens: t.actualOutput,
    ...(t.providerCachedInput ? { cachedInputTokens: t.providerCachedInput } : {}),
  };
}

function safeExpect(s: Scenario, res: SavingsResult): boolean {
  try {
    return s.expect ? s.expect(res) : true;
  } catch {
    return false;
  }
}

interface ScenarioResult {
  name: string;
  lever: string;
  ledger: string;
  kind: Kind;
  reps: number;
  armA: { meanInputTokens: number; meanOutputTokens: number; meanCost: number };
  armB: { meanInputTokens: number; meanOutputTokens: number; meanCost: number };
  measured: {
    inputTokenDeltaMean: number;
    outputTokenDeltaMean: number;
    savings: CI;
    wilcoxonP: number;
  };
  quality: { gate: string; passed: number; total: number };
  /** Provably positive savings at 95% AND every answer passed the gate. */
  proven: boolean;
  /** False if the provider's system_fingerprint changed mid-run (model swapped). */
  fingerprintStable: boolean;
  fingerprints: string[];
  amortization?: { coldMissCost: number; hitCost: number; breakEvenK: number | null };
  attribution: {
    avoidedCall: boolean;
    eliminatedInputTokens: number;
    compressedInputTokens: number;
    providerCachedInputTokens: number;
  };
  paired: { costA: number; costB: number }[];
}

async function runScenario(s: Scenario): Promise<ScenarioResult> {
  const provider = makeProvider();
  const req: SavingsRequest = liveModel ? { ...s.request, model: liveModel } : s.request;
  const model = modelId(req);

  // Probe the optimized arm once (fresh layer) to classify the scenario.
  // `warm` scenarios demonstrate caching (their value is repeat-traffic, shown
  // in the amortization pass); the COLD headline treats their first call like
  // any ran call so caches honestly read ~0% per single call.
  const probe = await createSavingsLayer({ provider, defaultCostModel: priceFor(model) }).generate(req);
  const kind: Kind = s.warm
    ? "cache"
    : probe.report.calls.actualLlm === 0
      ? "resolver"
      : "ran";

  const minReps = kind === "ran" ? REPS : Math.max(2, Math.ceil(REPS / 2));

  const paired: { costA: number; costB: number }[] = [];
  const aIn: number[] = [], aOut: number[] = [], bIn: number[] = [], bOut: number[] = [];
  const fingerprints = new Set<string>();
  let qPass = 0;
  let gate = "structural";
  let attribution = {
    avoidedCall: probe.report.calls.avoidedLlm > 0,
    eliminatedInputTokens: probe.report.tokens.eliminatedInput,
    compressedInputTokens: probe.report.tokens.compressedInput,
    providerCachedInputTokens: probe.report.tokens.providerCachedInput ?? 0,
  };

  async function sampleOnce(t: number): Promise<void> {
    // Arm A: naive baseline — a real call, measured.
    const respA = await provider.generate(buildNaive(req));
    const fp = (respA.raw as { system_fingerprint?: string } | undefined)?.system_fingerprint;
    if (fp) fingerprints.add(fp);
    const uA: Usage = {
      inputTokens: respA.usage.inputTokens,
      outputTokens: respA.usage.outputTokens,
      ...(respA.usage.cachedInputTokens != null ? { cachedInputTokens: respA.usage.cachedInputTokens } : {}),
    };
    const costA = cost(model, uA);

    // Arm B: BV-SALA optimized — a COLD run (fresh layer) so caching is never
    // secretly pre-warmed for the headline. Avoided calls cost $0 (real).
    const resB = await createSavingsLayer({ provider, defaultCostModel: priceFor(model) }).generate(req);
    const uB = usageOf(resB);
    const ran = resB.report.calls.actualLlm > 0;
    const costB = ran ? cost(model, uB) : 0;

    paired.push({ costA, costB });
    aIn.push(uA.inputTokens); aOut.push(uA.outputTokens);
    bIn.push(uB.inputTokens); bOut.push(uB.outputTokens);

    // Quality gate: ground-truth when available, else structural / judge. Cache
    // scenarios' own expect() asserts a HIT, impossible on this cold call — gate
    // them structurally here; hit correctness is asserted in the amortization pass.
    const q = await qualityGate(s, resB, respA.text, model, kind === "cache");
    if (q.passed) qPass++;
    gate = q.gate;
    if (t === 0) attribution = {
      avoidedCall: resB.report.calls.avoidedLlm > 0,
      eliminatedInputTokens: resB.report.tokens.eliminatedInput,
      compressedInputTokens: resB.report.tokens.compressedInput,
      providerCachedInputTokens: resB.report.tokens.providerCachedInput ?? 0,
    };
  }

  // Draw the minimum, then (LIVE only) keep drawing until the savings CI is tight
  // enough or the cap is hit — spend more reps only where variance demands it.
  let t = 0;
  for (; t < minReps; t++) await sampleOnce(t);
  const ciHalf = (): number => {
    const ci = bootstrapRatioCI(paired.map((p) => p.costA), paired.map((p) => p.costB), { seed: SEED });
    return (ci.upper - ci.lower) / 2;
  };
  while (mode === "LIVE" && paired.length < MAX_REPS && ciHalf() > CI_TARGET) {
    await sampleOnce(t++);
  }

  const savings = bootstrapRatioCI(paired.map((p) => p.costA), paired.map((p) => p.costB), { seed: SEED });
  const reps = paired.length;
  const qualityOk = reps > 0 && qPass / reps >= QUALITY_FLOOR;
  const fpStable = fingerprints.size <= 1;

  const result: ScenarioResult = {
    name: s.name,
    lever: s.lever,
    ledger: s.ledger,
    kind,
    reps,
    armA: { meanInputTokens: mean(aIn), meanOutputTokens: mean(aOut), meanCost: mean(paired.map((p) => p.costA)) },
    armB: { meanInputTokens: mean(bIn), meanOutputTokens: mean(bOut), meanCost: mean(paired.map((p) => p.costB)) },
    measured: {
      inputTokenDeltaMean: mean(aIn) - mean(bIn),
      outputTokenDeltaMean: mean(aOut) - mean(bOut),
      savings,
      wilcoxonP: wilcoxonSignedRankP(paired.map((p) => p.costA - p.costB)),
    },
    quality: { gate, passed: qPass, total: reps },
    proven: mode === "LIVE" && savings.lower > 0 && qualityOk && fpStable,
    fingerprintStable: fpStable,
    fingerprints: [...fingerprints],
    attribution,
    paired,
  };

  // Cache amortization: repeat traffic pays the miss ONCE, then hits are $0.
  if (kind === "cache") {
    const layer = createSavingsLayer({ provider, defaultCostModel: priceFor(model) });
    const miss = await layer.generate(req); // cold miss (real optimized cost)
    const coldMissCost = miss.report.calls.actualLlm > 0 ? cost(model, usageOf(miss)) : 0;
    const hit = await layer.generate(req); // warmed → hit
    const hitCost = hit.report.calls.actualLlm > 0 ? cost(model, usageOf(hit)) : 0;
    // The hit must actually be a cache hit AND satisfy the scenario's own
    // correctness assertion — a saving on a stale/wrong cached answer is void.
    const hitVerified = hit.report.calls.actualLlm === 0 && safeExpect(s, hit);
    if (!hitVerified) result.quality.gate += "+cache-hit-unverified";
    const costA = result.armA.meanCost;
    // savings(K) = 1 − (coldMissCost + (K−1)*hitCost) / (K*costA). Break-even = first K>0.
    let breakEvenK: number | null = null;
    for (let k = 1; k <= 1000; k++) {
      const bTotal = coldMissCost + (k - 1) * hitCost;
      if (costA > 0 && 1 - bTotal / (k * costA) > 0) { breakEvenK = k; break; }
    }
    result.amortization = { coldMissCost, hitCost, breakEvenK };
  }

  return result;
}

// ── Quality gate ────────────────────────────────────────────────────────────
const judgeBase = process.env.BVSALA_JUDGE_BASE_URL;
const judgeProvider: Provider | null = judgeBase
  ? new OpenAICompatibleProvider({
      baseUrl: judgeBase,
      ...(process.env.BVSALA_JUDGE_API_KEY ? { apiKey: process.env.BVSALA_JUDGE_API_KEY } : {}),
      stripProviderPrefix: !keepPrefix,
      requireUsage: false,
    })
  : null;

async function qualityGate(
  s: Scenario,
  optimized: SavingsResult,
  baselineAnswer: string,
  model: string,
  ignoreExpect = false,
): Promise<{ passed: boolean; gate: string }> {
  // 1. Strongest: scenario ground-truth check (e.g. arithmetic == "12", schema valid).
  if (s.expect && !ignoreExpect) return { passed: safeExpect(s, optimized), gate: "ground-truth" };

  const answer = optimized.text ?? "";
  // 2. Structural: a non-empty answer; if a schema was enforced, it is valid.
  const structural = answer.trim().length > 0 && optimized.report.constraints.structurallyValid;

  // 3. LIVE + judge configured: blind answer-vs-answer semantic equivalence.
  if (mode === "LIVE" && judgeProvider && baselineAnswer.trim().length > 0) {
    try {
      const equivalent = await judgeEquivalent(baselineAnswer, answer, s, model);
      return { passed: structural && equivalent, gate: "judge" };
    } catch {
      return { passed: structural, gate: "structural(judge-failed)" };
    }
  }
  return { passed: structural, gate: mode === "LIVE" ? "structural" : "plumbing(mock)" };
}

async function judgeEquivalent(a: string, b: string, s: Scenario, model: string): Promise<boolean> {
  if (!judgeProvider) return true;
  // Blind: randomize which answer is labeled "1" vs "2" to kill position bias.
  const flip = (s.name.length + a.length) % 2 === 0;
  const one = flip ? b : a;
  const two = flip ? a : b;
  const res = await judgeProvider.generate({
    model: process.env.BVSALA_JUDGE_MODEL ?? model,
    messages: [
      { role: "system", content: "You are a strict evaluator. Reply ONLY with compact JSON {\"equivalent\":bool}." },
      { role: "user", content:
        `Task: ${s.request.messages.map((m) => m.content).join(" ")}\n\n` +
        `Response 1:\n${one}\n\nResponse 2:\n${two}\n\n` +
        `Is Response ${flip ? "1" : "2"} at least as correct and complete as the other, with no factual regression? JSON only.` },
    ],
    maxOutputTokens: 20,
    temperature: 0,
  });
  try {
    return !!JSON.parse(res.text.trim()).equivalent;
  } catch {
    return /"equivalent"\s*:\s*true/.test(res.text);
  }
}

// ── Reporting ────────────────────────────────────────────────────────────────
const pct = (n: number): string => (n * 100).toFixed(1) + "%";
const money = (n: number): string => "$" + n.toFixed(6);
const pad = (s: string, n: number): string => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));
const padL = (s: string, n: number): string => (s.length >= n ? s : " ".repeat(n - s.length) + s);

async function main(): Promise<void> {
  console.log(`\nBV-SALA TRUE A/B live benchmark  [mode: ${mode}]`);
  console.log(
    mode === "LIVE"
      ? `provider: real endpoint   model: ${liveModel ?? "(per-request)"}   reps: ${REPS}   (both arms metered by the provider)`
      : `provider: mock (no network)   reps: ${REPS}   —  ESTIMATED plumbing run, NOT a savings claim`,
  );
  console.log("─".repeat(104));
  console.log(
    pad("scenario", 26) + pad("kind", 9) + padL("A in/out tok", 16) + padL("B in/out tok", 16) +
    padL("savings (95% lo)", 20) + padL("qa", 8),
  );
  console.log("─".repeat(104));

  const results: ScenarioResult[] = [];
  for (const s of scenarios) results.push(await runScenario(s));

  for (const r of results) {
    const qa = `${r.quality.passed}/${r.quality.total}`;
    console.log(
      pad(r.name, 26) + pad(r.kind, 9) +
      padL(`${r.armA.meanInputTokens.toFixed(0)}/${r.armA.meanOutputTokens.toFixed(0)}`, 16) +
      padL(`${r.armB.meanInputTokens.toFixed(0)}/${r.armB.meanOutputTokens.toFixed(0)}`, 16) +
      padL(`${pct(r.measured.savings.point)} (${pct(r.measured.savings.lower)})`, 20) +
      padL(qa, 8),
    );
  }
  console.log("─".repeat(104));

  // Aggregate over ALL scenarios' cold single-call paired costs (honest: cache
  // shows its cold-miss cost here; repeat-traffic amortization is separate).
  const allA = results.flatMap((r) => r.paired.map((p) => p.costA));
  const allB = results.flatMap((r) => r.paired.map((p) => p.costB));
  const agg = bootstrapRatioCI(allA, allB, { seed: SEED });
  const wP = wilcoxonSignedRankP(results.flatMap((r) => r.paired.map((p) => p.costA - p.costB)));
  const qTotalPass = results.reduce((n, r) => n + r.quality.passed, 0);
  const qTotal = results.reduce((n, r) => n + r.quality.total, 0);
  const qualityPassRate = qTotal ? qTotalPass / qTotal : 0;
  const allFpStable = results.every((r) => r.fingerprintStable);

  const proven = mode === "LIVE" && agg.lower > 0 && qualityPassRate >= QUALITY_FLOOR && allFpStable;

  // Per-ledger attribution. Each scenario maps to exactly ONE ledger, so the
  // ledger cost-deltas PARTITION the total delta — double-counting is impossible
  // by construction, and the reconciliation residual below proves it.
  const sumArr = (xs: number[]): number => xs.reduce((n, x) => n + x, 0);
  const LEDGERS = ["avoided_calls", "eliminated_tokens", "compressed_tokens", "output_restriction"];
  const ledgerRollup = LEDGERS.map((lg) => {
    const rs = results.filter((r) => r.ledger === lg);
    const a = rs.flatMap((r) => r.paired.map((p) => p.costA));
    const b = rs.flatMap((r) => r.paired.map((p) => p.costB));
    const ci = bootstrapRatioCI(a, b, { seed: SEED });
    return {
      ledger: lg,
      scenarios: rs.map((r) => r.name),
      savings: ci,
      deltaCost: sumArr(a) - sumArr(b),
      proven: mode === "LIVE" && ci.lower > 0 && rs.length > 0 && rs.every((r) => r.quality.passed === r.quality.total && r.fingerprintStable),
    };
  });

  // Reconciliation: (Σ ledger deltas) + (the "none"/setup bucket) must equal the
  // total measured delta, to the cent. A non-zero residual means a bug.
  const totalDelta = sumArr(allA) - sumArr(allB);
  const noneRs = results.filter((r) => !LEDGERS.includes(r.ledger));
  const noneDelta =
    sumArr(noneRs.flatMap((r) => r.paired.map((p) => p.costA))) -
    sumArr(noneRs.flatMap((r) => r.paired.map((p) => p.costB)));
  const ledgerSum = ledgerRollup.reduce((n, l) => n + l.deltaCost, 0) + noneDelta;
  const residual = totalDelta - ledgerSum;
  const reconciled = Math.abs(residual) < 1e-9;

  console.log("\nHeadline (per cold single call, measured both sides)");
  if (mode === "LIVE") {
    console.log(`  Net savings:   point ${pct(agg.point)}   95% CI [${pct(agg.lower)}, ${pct(agg.upper)}]`);
    console.log(`  Claim:         ${proven ? `VERIFIED ≥ ${pct(agg.lower)} at 95% confidence` : "NOT PROVEN (CI lower ≤ 0, quality regressed, or model swapped)"}`);
    console.log(`  Wilcoxon p:    ${wP.toExponential(2)}   (H1: median saving > 0)`);
    if (!allFpStable) console.log(`  ⚠ model fingerprint changed mid-run — results may span different model versions.`);
  } else {
    console.log(`  Net savings:   ${pct(agg.point)}  — ESTIMATED (mock provider), NOT a real savings claim`);
    console.log(`  Run LIVE (set BVSALA_DEMO_BASE_URL) for real provider tokens & dollars.`);
  }
  console.log(`  Quality:       ${qTotalPass}/${qTotal} answers passed the gate (${pct(qualityPassRate)})`);
  console.log(`  Reconciles:    ${reconciled ? "yes" : "NO — residual " + money(residual)}  (ledger deltas partition the total, no double-counting)`);

  console.log("\nPer-ledger attribution (measured; a ledger is 'proven' only if its 95% CI clears 0)");
  for (const l of ledgerRollup) {
    const badge = mode !== "LIVE" ? "est" : l.proven ? "proven" : "not-proven";
    console.log(`  ${pad(l.ledger, 20)} ${padL(pct(l.savings.point), 8)}  95%lo ${padL(pct(l.savings.lower), 8)}   ${badge}`);
  }

  const cacheRows = results.filter((r) => r.amortization);
  if (cacheRows.length) {
    console.log("\nRepeat-traffic (cache amortization — savings grow with reuse)");
    for (const r of cacheRows) {
      const a = r.amortization!;
      console.log(`  ${pad(r.name, 26)} cold-miss ${money(a.coldMissCost)}  hit ${money(a.hitCost)}  break-even at K=${a.breakEvenK ?? "∞"}`);
    }
  }
  console.log("");

  const artifact = {
    mode,
    ...(liveModel ? { model: liveModel } : {}),
    generatedNote: mode === "LIVE" ? "real provider tokens & cost, quality-gated" : "ESTIMATED — mock provider, not a savings claim",
    pricing: { note: PRICING_NOTE, table: PRICES, fallback: FALLBACK_PRICE },
    methodology:
      "Paired A/B: Arm A = naive request (full JSON, all tools, no cap, no schema) executed against the same provider; " +
      "Arm B = BV-SALA optimized. Both priced from provider usage. Headline = 95% bootstrap CI lower bound of 1−ΣcostB/ΣcostA. " +
      "Quality gate voids regressed answers. Cache savings amortized separately with a break-even K.",
    config: { reps: REPS, minReps: REPS, maxReps: MAX_REPS, ciTarget: CI_TARGET, qualityFloor: QUALITY_FLOOR, seed: SEED },
    scenarios: results.map((r) => ({ ...r, paired: undefined })),
    ledgers: ledgerRollup,
    reconciliation: { totalDelta, ledgerSum, residual, reconciled },
    fingerprintStable: allFpStable,
    aggregate: {
      savings: agg,
      wilcoxonP: wP,
      qualityPassRate,
      proven,
      headline: mode === "LIVE"
        ? (proven ? `verified ≥ ${pct(agg.lower)} (95% CI lower bound)` : "not proven")
        : "ESTIMATED (mock) — not a savings claim",
    },
    honesty: [
      "Both arms are metered by the provider's own tokenizer — no modeled baseline.",
      "The headline is the 95% CI lower bound, never the point estimate.",
      "A saving is voided if its answer fails the quality gate.",
      "Each scenario maps to one ledger, so ledger deltas partition the total (reconciliation residual proves no double-counting).",
      "Adaptive sampling adds reps only where variance is high, up to a hard cap.",
      "A changed model fingerprint mid-run invalidates the 'proven' claim.",
      "Cache savings are shown as repeat-traffic amortization with a break-even K, not a single-call number.",
      "Missing provider usage is a hard error (requireUsage), never a silent 0 → 100% saving.",
    ],
  };
  const jsonPath = writeReport("ab-live", artifact);
  // Raw paired trials so anyone can recompute the CI themselves.
  const csvRows = results.flatMap((r) =>
    r.paired.map((p, i) => ({ scenario: r.name, kind: r.kind, rep: i, costA: p.costA, costB: p.costB, savedFraction: p.costA > 0 ? 1 - p.costB / p.costA : 0 })),
  );
  const csvPath = writeCsv("ab-live-trials", ["scenario", "kind", "rep", "costA", "costB", "savedFraction"], csvRows);
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${csvPath}  (raw paired trials — recompute the CI yourself)\n`);

  if (mode === "LIVE" && !proven) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
