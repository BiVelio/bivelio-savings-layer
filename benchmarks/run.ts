/**
 * BV-SALA savings demonstration harness. Run: pnpm demo
 *
 * Runs realistic scenarios through the layer, checks the answer is still
 * correct, and reports the REAL savings — aggregated across the batch. The
 * accounting here is deliberately CONSERVATIVE so we never overclaim:
 *
 *  - Avoided calls (cache / resolver): the whole request is saved (input+output).
 *  - Ran calls: we count input reduction only (compression / pruning), and set
 *    the baseline output equal to the actual output — i.e. we do NOT claim any
 *    output-side saving in MOCK mode, because the mock does not over-generate.
 *
 * Modes:
 *   MOCK (default) — deterministic, no network. Token counts are estimated but
 *     the ledger logic is real: proves the mechanism (calls avoided, tokens
 *     compressed, quality preserved) end to end.
 *   LIVE — set BVSALA_DEMO_BASE_URL (+ BVSALA_DEMO_API_KEY, BVSALA_DEMO_MODEL)
 *     to an OpenAI-compatible endpoint for real provider tokens & dollars.
 */
import {
  createSavingsLayer,
  createMockProvider,
  OpenAICompatibleProvider,
  type CostModel,
  type Provider,
  type SavingsResult,
} from "../src/index.js";
import { scenarios, type Scenario } from "./scenarios.js";
import { compresorDeRepeticionesLiterales } from "./compresor.js";
import { writeReport } from "./report.js";

// Realistic pricing (gpt-4o-mini-class): $/1K tokens.
const COST: CostModel = { inputPer1k: 0.00015, outputPer1k: 0.0006, cachedInputPer1k: 0.000075 };

const baseUrl = process.env.BVSALA_DEMO_BASE_URL;
const apiKey = process.env.BVSALA_DEMO_API_KEY;
const liveModel = process.env.BVSALA_DEMO_MODEL;

// Keep the "provider/model" prefix for gateways (e.g. Vercel AI Gateway); strip
// it for a direct provider endpoint (e.g. api.openai.com).
const keepPrefix = !!process.env.BVSALA_DEMO_KEEP_PREFIX;
const provider: Provider = baseUrl
  ? new OpenAICompatibleProvider({
      baseUrl,
      ...(apiKey ? { apiKey } : {}),
      stripProviderPrefix: !keepPrefix,
      // Sin esto, un proveedor que no devuelva `usage` deja el coste real en 0 y
      // el informe imprime igualmente "(real provider tokens & cost)": un 100%
      // de ahorro fabricado con la etiqueta de medido. `ab-live.ts` ya lo exigía;
      // este harness no, y es el que dice "real" en la misma línea.
      requireUsage: true,
    })
  : createMockProvider();
const mode = baseUrl ? "LIVE" : "MOCK";

// El compresor va aquí por la misma razón que en `ab-live.ts`: sin él, el
// escenario de compresión no comprime y la capa avisa —con razón— de que la
// palanca se pidió y no hay con qué. Es local y determinista; la decisión de
// aplicarlo la siguen tomando las tres verjas económicas del pipeline.
const layer = createSavingsLayer({
  provider,
  defaultCostModel: COST,
  compressor: compresorDeRepeticionesLiterales,
});

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}
function padL(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}
const money = (n: number): string => "$" + n.toFixed(6);
const round = (n: number): number => Math.round(n * 1e8) / 1e8;

async function main(): Promise<void> {
  console.log(`\nBV-SALA savings demonstration  [mode: ${mode}]`);
  console.log(`provider: ${provider.id}${liveModel ? `  model: ${liveModel}` : ""}  (conservative accounting)`);
  console.log("─".repeat(98));
  console.log(
    pad("scenario", 26) + pad("lever", 36) + pad("cache", 8) +
    padL("calls", 7) + padL("in saved", 10) + padL("$ saved", 11) + "  ok",
  );
  console.log("─".repeat(98));

  let baselineCost = 0, actualCost = 0;
  let baselineCalls = 0, actualCalls = 0, avoidedCalls = 0;
  let inputSaved = 0;
  let qualityPass = 0, qualityTotal = 0;
  const detail: Record<string, unknown>[] = [];

  for (const s of scenarios) {
    const req = liveModel ? { ...s.request, model: liveModel } : s.request;
    if (s.warm) await layer.generate(req); // populate cache without measuring

    const res: SavingsResult = await layer.generate(req);
    const rep = res.report;
    const avoided = rep.calls.avoidedLlm > 0;

    // Conservative cost model: no phantom output savings on ran calls.
    const baselineOut = avoided ? rep.tokens.baselineOutput : rep.tokens.actualOutput;
    const bCost = (rep.tokens.baselineInput / 1000) * COST.inputPer1k + (baselineOut / 1000) * COST.outputPer1k;
    const aCost = (rep.tokens.actualInput / 1000) * COST.inputPer1k + (rep.tokens.actualOutput / 1000) * COST.outputPer1k;
    const savedCost = Math.max(0, bCost - aCost);
    const inSaved = Math.max(0, rep.tokens.baselineInput - rep.tokens.actualInput);

    baselineCost += bCost;
    actualCost += aCost;
    inputSaved += inSaved;
    baselineCalls += rep.calls.baselineLlm;
    actualCalls += rep.calls.actualLlm;
    avoidedCalls += rep.calls.avoidedLlm;

    let ok = "—";
    if (s.expect) {
      qualityTotal++;
      const passed = safeCheck(s, res);
      if (passed) qualityPass++;
      ok = passed ? "✓" : "✗";
    }

    detail.push({
      name: s.name,
      lever: s.lever,
      cache: rep.cache.result,
      avoidedLlm: rep.calls.avoidedLlm,
      actualLlm: rep.calls.actualLlm,
      inputTokensSaved: inSaved,
      savedCost: round(savedCost),
      quality: ok,
    });

    console.log(
      pad(s.name, 26) + pad(s.lever, 36) + pad(rep.cache.result, 8) +
      padL(`${rep.calls.avoidedLlm}/${rep.calls.actualLlm}`, 7) +
      padL(String(inSaved), 10) + padL(money(savedCost), 11) + "  " + ok,
    );
  }

  const savedPct = baselineCost === 0 ? 0 : 1 - actualCost / baselineCost;
  console.log("─".repeat(98));
  console.log("\nBatch totals (conservative)");
  console.log(`  LLM calls:      baseline ${baselineCalls}  →  actual ${actualCalls}   (avoided ${avoidedCalls} = ${((avoidedCalls / baselineCalls) * 100).toFixed(0)}%)`);
  console.log(`  Input tokens:   saved ${inputSaved}   (eliminated + compressed)`);
  console.log(`  Cost:           baseline ${money(baselineCost)}  →  actual ${money(actualCost)}   (saved ${money(baselineCost - actualCost)})`);
  console.log(`  Net savings:    ${(savedPct * 100).toFixed(1)}%   ${mode === "MOCK" ? "(estimated; run LIVE for real provider $)" : "(real provider tokens & cost)"}`);
  console.log(`  Quality:        ${qualityPass}/${qualityTotal} correctness checks passed`);
  console.log("");

  const path = writeReport("demo", {
    mode,
    provider: provider.id,
    ...(liveModel ? { model: liveModel } : {}),
    costModel: COST,
    scenarios: detail,
    totals: {
      baselineLlmCalls: baselineCalls,
      actualLlmCalls: actualCalls,
      avoidedLlmCalls: avoidedCalls,
      inputTokensSaved: inputSaved,
      baselineCost: round(baselineCost),
      actualCost: round(actualCost),
      savedCost: round(baselineCost - actualCost),
      netSavings: round(savedPct),
      qualityPass,
      qualityTotal,
    },
    note: mode === "MOCK" ? "estimated tokens; run LIVE for real provider $" : "real provider tokens & cost",
  });
  console.log(`Wrote ${path}\n`);

  if (qualityTotal > 0 && qualityPass < qualityTotal) {
    console.error("Some correctness checks failed — savings without correctness do not count.");
    process.exitCode = 1;
  }
}

function safeCheck(s: Scenario, res: SavingsResult): boolean {
  try {
    return s.expect ? s.expect(res) : true;
  } catch {
    return false;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
