/**
 * BV-SALA ablation harness. Run: pnpm ablation
 *
 * Comparing "baseline" vs "everything on" hides where the savings come from.
 * This runs the scenario batch under a LADDER of configs, each enabling one more
 * optimization, and reports the MARGINAL contribution of each lever — so we can
 * say, with evidence, how much each part actually pays for itself.
 *
 * Cost per stage is the real spend that stage would incur: actual input+output
 * tokens priced (avoided calls cost 0). Fresh caches per stage keep the stages
 * independent. Writes benchmarks/out/ablation.json for charting.
 */
import {
  createSavingsLayer,
  createMockProvider,
  OpenAICompatibleProvider,
  type CostModel,
  type Provider,
  type SavingsToggles,
} from "../src/index.js";
import { scenarios } from "./scenarios.js";
import { compresorDeRepeticionesLiterales } from "./compresor.js";
import { writeReport } from "./report.js";

const COST: CostModel = { inputPer1k: 0.00015, outputPer1k: 0.0006, cachedInputPer1k: 0.000075 };

const baseUrl = process.env.BVSALA_DEMO_BASE_URL;
const apiKey = process.env.BVSALA_DEMO_API_KEY;
const liveModel = process.env.BVSALA_DEMO_MODEL;
const keepPrefix = !!process.env.BVSALA_DEMO_KEEP_PREFIX;
const provider: Provider = baseUrl
  ? new OpenAICompatibleProvider({ baseUrl, ...(apiKey ? { apiKey } : {}), stripProviderPrefix: !keepPrefix })
  : createMockProvider();
const mode = baseUrl ? "LIVE" : "MOCK";

// Each rung adds exactly one lever on top of the previous.
const LADDER: { name: string; toggles: SavingsToggles }[] = [
  { name: "baseline (naive)",  toggles: { deterministicResolvers: false, exactCache: false, singleflight: false, router: false, serialization: false, compression: false } },
  { name: "+ exact cache",     toggles: { deterministicResolvers: false, exactCache: true,  singleflight: true,  router: false, serialization: false, compression: false } },
  { name: "+ resolvers",       toggles: { deterministicResolvers: true,  exactCache: true,  singleflight: true,  router: false, serialization: false, compression: false } },
  { name: "+ router",          toggles: { deterministicResolvers: true,  exactCache: true,  singleflight: true,  router: true,  serialization: false, compression: false } },
  { name: "+ format selector", toggles: { deterministicResolvers: true,  exactCache: true,  singleflight: true,  router: true,  serialization: true,  compression: false } },
  // Los tres peldaños de las palancas OPT-IN de la 0.3.0. Iban fuera de la
  // escalera porque el banco no las encendía en ningún sitio, así que su
  // contribución marginal salía 0 por construcción y se leía como "no aportan".
  //
  // `compression` va antes que las otras dos porque toca la ENTRADA y las otras
  // dos tocan la salida y las herramientas: así cada peldaño sigue añadiendo una
  // palanca sobre un terreno que la anterior no ha movido.
  { name: "+ compression",     toggles: { deterministicResolvers: true,  exactCache: true,  singleflight: true,  router: true,  serialization: true,  compression: true } },
  { name: "+ output codebook", toggles: { deterministicResolvers: true,  exactCache: true,  singleflight: true,  router: true,  serialization: true,  compression: true, outputCodebook: true } },
  // El ÚLTIMO, y su delta marginal puede salir NEGATIVO: el sondeo parte la
  // petición en dos y contra el proveedor simulado —que nunca devuelve
  // tool_calls— siempre degrada, así que aquí mide el peor caso del patrón. Es
  // el dato honesto, no un fallo de la escalera.
  { name: "+ tool discovery",  toggles: { deterministicResolvers: true,  exactCache: true,  singleflight: true,  router: true,  serialization: true,  compression: true, outputCodebook: true, toolDiscovery: true } },
];

async function stageCost(toggles: SavingsToggles): Promise<number> {
  const layer = createSavingsLayer({
    provider,
    defaultCostModel: COST,
    compressor: compresorDeRepeticionesLiterales,
  }); // fresh caches
  let total = 0;
  for (const s of scenarios) {
    const req = { ...(liveModel ? { ...s.request, model: liveModel } : s.request), savings: toggles };
    if (s.warm) await layer.generate(req);
    const rep = (await layer.generate(req)).report;
    total += (rep.tokens.actualInput / 1000) * COST.inputPer1k + (rep.tokens.actualOutput / 1000) * COST.outputPer1k;
  }
  return total;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
function padL(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}
const money = (n: number): string => "$" + n.toFixed(6);

async function main(): Promise<void> {
  console.log(`\nBV-SALA ablation — marginal contribution of each lever  [mode: ${mode}]`);
  console.log("─".repeat(74));
  console.log(pad("stage", 22) + padL("cost", 12) + padL("vs baseline", 14) + padL("marginal Δ", 14));
  console.log("─".repeat(74));

  const rows: { stage: string; cost: number; savingsVsBaselinePct: number; marginalDeltaCost: number }[] = [];
  let baseline = 0;
  let prev = 0;

  for (let i = 0; i < LADDER.length; i++) {
    const rung = LADDER[i]!;
    const cost = await stageCost(rung.toggles);
    if (i === 0) { baseline = cost; prev = cost; }
    const savings = baseline === 0 ? 0 : 1 - cost / baseline;
    const marginal = prev - cost;
    rows.push({ stage: rung.name, cost, savingsVsBaselinePct: round(savings), marginalDeltaCost: round(marginal) });
    console.log(
      pad(rung.name, 22) +
      padL(money(cost), 12) +
      padL((savings * 100).toFixed(1) + "%", 14) +
      padL(i === 0 ? "—" : money(marginal), 14),
    );
    prev = cost;
  }

  console.log("─".repeat(74));
  const full = rows[rows.length - 1]!;
  console.log(`\nFull stack saves ${(full.savingsVsBaselinePct * 100).toFixed(1)}% vs naive baseline.`);
  console.log("Read 'marginal Δ' as: how much cheaper this rung is than the one above it.\n");

  const path = writeReport("ablation", {
    mode,
    provider: provider.id,
    ...(liveModel ? { model: liveModel } : {}),
    costModel: COST,
    baselineCost: round(baseline),
    ladder: rows,
    note: mode === "MOCK" ? "estimated tokens; run LIVE for real provider $" : "real provider tokens & cost",
  });
  console.log(`Wrote ${path}`);
}

function round(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
