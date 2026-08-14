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
  TokenizerRegistry,
  registrarTokenizadorExacto,
} from "../src/index.js";
import type { ProviderRequest } from "../src/providers/types.js";
import { scenarios, type Scenario } from "./scenarios.js";
import { bootstrapRatioCI, wilcoxonSignedRankP, mean, type CI } from "./stats.js";
import { writeReport, writeCsv } from "./report.js";
import { validateAgainstSchema } from "../src/constraints/validate.js";

function tryParseJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return undefined; }
}

// ── Real per-model price table (USD per 1K tokens). Public list pricing; the
// EXACT figures are dated in the report and overridable. Because both arms are
// priced with the SAME model, any price error cancels in the savings RATIO —
// only cross-model and cached-rate differences move the percentage.
const PRICES: Record<string, CostModel> = {
  "gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006, cachedInputPer1k: 0.000075 },
  "gpt-4o": { inputPer1k: 0.0025, outputPer1k: 0.01, cachedInputPer1k: 0.00125 },
  "gpt-4.1-mini": { inputPer1k: 0.0004, outputPer1k: 0.0016, cachedInputPer1k: 0.0001 },
  "gpt-4.1": { inputPer1k: 0.002, outputPer1k: 0.008, cachedInputPer1k: 0.0005 },
  // Anthropic. La lectura cacheada cuesta el 10% de la entrada —contra el 50%
  // de la familia 4o/4.1— y por eso es donde más vale la palanca de la caché de
  // prefijo. Lo que esta tabla NO puede expresar es la otra mitad del trato: la
  // ESCRITURA se cobra a 1,25x, así que un escenario con pocos aciertos sale más
  // caro de lo que este precio sugiere. La verja económica del layer es quien
  // vigila eso; aquí sólo se tarifa lo que el proveedor reporte.
  "claude-sonnet-4-5": { inputPer1k: 0.003, outputPer1k: 0.015, cachedInputPer1k: 0.0003 },
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

// ── Tokenizador EXACTO. Una tirada que hace afirmaciones en dólares no puede
// contar con el estimador heurístico: mide 2171 tokens donde o200k_base mide
// 1155 en el mismo JSON (1,88x), y ese sesgo NO se cancela al restar contra un
// formato distinto. Con él registrado, `basis` puede ser "measured"; sin él, el
// propio layer degrada a "estimated" y la tirada lo dirá.
const registroTokens = new TokenizerRegistry();
const tokenizadorExacto = await registrarTokenizadorExacto(registroTokens);
if (!tokenizadorExacto) {
  console.warn(
    "[ab] gpt-tokenizer no está instalado: se usará el estimador heurístico y la " +
      "contabilidad se publicará como ESTIMADA. Instálalo con `pnpm add -D gpt-tokenizer`.",
  );
}

/** Todas las capas de la tirada comparten el mismo registro y el mismo proveedor. */
// Lo aprendido sobre los contratos SÍ persiste entre repeticiones; las cachés
// no. Es el modelo honesto de una capa desplegada: los aciertos de caché no se
// precalientan para el titular, pero tampoco se finge que cada petición sea la
// primera que ve ese contrato — en producción no lo es.
const memoriaContratos = new Set<string>();

const nuevaCapa = (provider: Provider, model: string) =>
  createSavingsLayer({
    provider,
    defaultCostModel: priceFor(model),
    tokenizer: registroTokens,
    constraintMemory: memoriaContratos,
  });

function priceFor(model: string): CostModel {
  const key = model.replace(/^[^/]+\//, "");
  return PRICES[key] ?? PRICES[model] ?? FALLBACK_PRICE;
}

/**
 * El reparto entrada/salida del gasto, EN DINERO y no en tokens.
 *
 * La distinción no es cosmética: la salida cuesta unas 4x por token, así que un
 * tráfico con 80% de tokens de entrada tiene una factura repartida al 50/50. Un
 * plan que razone sobre el reparto de TOKENS presupuesta mal las palancas.
 */
function repartoDeLaFactura(
  model: string,
  entradaTokens: number,
  salidaTokens: number,
): { entrada: number; salida: number } {
  const p = priceFor(model);
  const entrada = (entradaTokens / 1000) * p.inputPer1k;
  const salida = (salidaTokens / 1000) * p.outputPer1k;
  const total = entrada + salida;
  return total > 0 ? { entrada: entrada / total, salida: salida / total } : { entrada: 0, salida: 0 };
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
function buildNaive(req: SavingsRequest): ProviderRequest {
  const messages = req.messages.map((m) => ({ role: m.role, content: m.content }));
  if (req.structuredData !== undefined) {
    messages.push({ role: "user", content: JSON.stringify(req.structuredData) });
  }
  return {
    model: modelId(req),
    messages,
    ...(req.tools && req.tools.length ? { tools: req.tools } : {}),
    // EL CONTRATO VA EN LOS DOS BRAZOS. Antes `buildNaive` descartaba
    // `req.response` entero, así que el brazo A resolvía una tarea MÁS FÁCIL:
    // respondía en texto libre mientras el B tenía que devolver JSON válido
    // contra el contrato. El B pagaba el bloque `response_format` (+38 tokens de
    // entrada, medidos) y la estructura JSON en la salida — que cuesta 4x por
    // token — sin que el A pagara ninguno de los dos. Eso no mide la capa: mide
    // la diferencia entre dos tareas distintas.
    //
    // El contrato lo pide QUIEN LLAMA (está en el request del escenario), no lo
    // añade la capa. Un equipo sin BV-SALA que necesite JSON estructurado manda
    // el mismo esquema. Así que el brazo A honesto lo manda también.
    //
    // Y el TOPE de salida también. Lo dejé fuera en su momento porque era el
    // lever bajo medición (`output_restriction`), pero 210 ensayos después ese
    // libro mide -2,8%: el tope NO ahorra. Así que la asimetría no estaba
    // midiendo nada, solo distorsionando en las dos direcciones — nos penalizaba
    // en calidad (nuestro brazo truncaba, el suyo no: 5 fallos de 210) y nos
    // favorecía en coste (pagábamos menos salida por estar capados).
    //
    // El tope está en el contrato de QUIEN LLAMA, exactamente igual que el
    // esquema. Un equipo sin BV-SALA que declare `maxOutputTokens` lo manda. Así
    // que va en los dos brazos y la comparación queda simétrica.
    ...(req.response?.schema ? { schema: req.response.schema } : {}),
    ...(req.response?.maxOutputTokens != null
      ? { maxOutputTokens: req.response.maxOutputTokens }
      : {}),
    temperature: 0,
    seed: 7,
  };
}

type Kind = "resolver" | "cache" | "ran";

/**
 * El modelo que el proveedor dice haber servido. Se normaliza el prefijo de
 * proveedor ("openai/gpt-4o-mini" y "gpt-4o-mini" son el mismo modelo) porque a
 * través de una pasarela el eco puede traerlo o no.
 */
function modeloDe(raw: unknown): string | null {
  const m = (raw as { model?: unknown } | undefined)?.model;
  return typeof m === "string" && m ? m.replace(/^[^/]+\//, "") : null;
}

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
  /**
   * FORMA DE LA FACTURA del brazo naive: qué fracción del dinero es entrada y
   * qué fracción es salida.
   *
   * Sin esto el titular es imposible de interpretar, y llevábamos tiempo
   * publicándolo. `docs/ROADMAP-ALGORITMOS.md` declaraba 36,3/63,7; recomputar
   * el propio artefacto de este banco da 46,4/53,6; y la tirada del 2026-08-13
   * contra el proveedor real, con preguntas de FAQ de ~16 tokens, daba 3,8/96,2.
   * Los tres son ciertos sobre tráficos distintos, y cambian el valor de cada
   * palanca por un factor de tres: una palanca que solo toca la entrada vale
   * mucho o no vale NADA según cuál de las tres sea el tráfico del cliente.
   *
   * Se publica por escenario y agregada, para que nadie tenga que recomputarla
   * a mano desde el CSV como hubo que hacer.
   */
  formaFactura: { entrada: number; salida: number };
  /**
   * Tokens que el PROVEEDOR dice haber servido desde su caché de prefijo, en los
   * DOS brazos. El brazo naive también cuenta, y es la mitad que faltaba: si el
   * cliente ya obtiene ese descuento sin nosotros y nuestra compresión lo saca
   * del tramo mínimo, le estamos QUITANDO dinero mientras el informe dice que se
   * lo ahorramos. `attribution` solo miraba el brazo optimizado.
   */
  cacheDePrefijo: { naive: number; optimizado: number };
  quality: { gate: string; passed: number; total: number };
  /** Cuántas respuestas del brazo NAIVE cumplían el contrato que se le pidió. */
  naiveContractValid: { valid: number; total: number };
  /** Provably positive savings at 95% AND every answer passed the gate. */
  proven: boolean;
  /**
   * True cuando LOS DOS BRAZOS hablaron con el mismo modelo en todas las reps.
   * Esta es la garantía que hace comparable un A/B pareado.
   */
  modelStable: boolean;
  servedModels: string[];
  /**
   * INFORMATIVO, nunca una verja: a través de una pasarela `system_fingerprint`
   * es un id por petición, así que exigir que sea estable haría imposible
   * demostrar nada.
   */
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
  // Los dos brazos tienen que muestrear de la MISMA distribución. El brazo A
  // fijaba temperature:0 y seed:7 (buildNaive) y el B no mandaba ninguno de los
  // dos, porque el pipeline solo los propaga si vienen en el request. Comparar
  // así mezcla el efecto de la capa con el del muestreo.
  const req: SavingsRequest = {
    ...s.request,
    ...(liveModel ? { model: liveModel } : {}),
    temperature: s.request.temperature ?? 0,
    seed: s.request.seed ?? 7,
  };
  const model = modelId(req);

  // Probe the optimized arm once (fresh layer) to classify the scenario.
  // `warm` scenarios demonstrate caching (their value is repeat-traffic, shown
  // in the amortization pass); the COLD headline treats their first call like
  // any ran call so caches honestly read ~0% per single call.
  const probe = await nuevaCapa(provider, model).generate(req);
  const kind: Kind = s.warm
    ? "cache"
    : probe.report.calls.actualLlm === 0
      ? "resolver"
      : "ran";

  const minReps = kind === "ran" ? REPS : Math.max(2, Math.ceil(REPS / 2));

  const paired: { costA: number; costB: number }[] = [];
  const aIn: number[] = [], aOut: number[] = [], bIn: number[] = [], bOut: number[] = [];
  const fingerprints = new Set<string>();
  // Lo que de verdad hay que garantizar: que los DOS brazos hablaron con el
  // mismo modelo. La verja anterior solo recogía el fingerprint del brazo A y
  // nunca los comparaba, mientras el README y la verja de publicación afirmaban
  // literalmente "los dos brazos no midieron el mismo modelo". Y encima
  // `system_fingerprint` a través de una pasarela es un id POR PETICIÓN (14 de
  // 14 distintos en la primera tirada), así que como señal de estabilidad es
  // inalcanzable: proven=true nunca podría darse con más de una repetición.
  const modelosServidos = new Set<string>();
  let naiveValid = 0;
  let naiveTotal = 0;
  /** Envuelve el proveedor para poder ver qué modelo sirvió al brazo B. */
  const espia: Provider = {
    id: provider.id,
    generate: async (r) => {
      const resp = await provider.generate(r);
      const m = modeloDe(resp.raw);
      if (m) modelosServidos.add(m);
      return resp;
    },
  };
  let qPass = 0;
  let gate = "structural";
  // Acumuladores de caché de prefijo, uno por brazo.
  let cacheNaive = 0;
  let cacheOptimizado = 0;
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
    modelosServidos.add(modeloDe(respA.raw) ?? "(sin declarar)");
    const uA: Usage = {
      inputTokens: respA.usage.inputTokens,
      outputTokens: respA.usage.outputTokens,
      ...(respA.usage.cachedInputTokens != null ? { cachedInputTokens: respA.usage.cachedInputTokens } : {}),
    };
    const costA = cost(model, uA);
    cacheNaive += uA.cachedInputTokens ?? 0;

    // ¿El brazo naive cumplió de verdad el contrato? Hasta ahora nadie lo
    // comprobaba: se le exigía validez SOLO al brazo optimizado. Pero el layer
    // paga tokens por avisar al modelo de las restricciones que el proveedor NO
    // impone (maxLength, maxItems…), y el naive no los paga. Si a cambio el
    // naive devuelve respuestas que incumplen el contrato, no ha hecho la misma
    // tarea y compararlas es engañoso — esta vez en NUESTRO favor.
    if (req.response?.schema) {
      naiveTotal++;
      const p = tryParseJson(respA.text);
      if (p !== undefined && validateAgainstSchema(p, req.response.schema).valid) naiveValid++;
    }

    // Arm B: BV-SALA optimized — a COLD run (fresh layer) so caching is never
    // secretly pre-warmed for the headline. Avoided calls cost $0 (real).
    const resB = await nuevaCapa(espia, model).generate(req);
    const uB = usageOf(resB);
    cacheOptimizado += uB.cachedInputTokens ?? 0;
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
  // Solo cuenta cuando hubo llamada de verdad en el brazo B: en un escenario
  // resolver la capa no llama al proveedor, así que solo hay modelo del brazo A
  // y exigir dos coincidentes convertiría el único +100% de la tirada en error.
  const modelStable = modelosServidos.size <= 1;

  const result: ScenarioResult = {
    name: s.name,
    lever: s.lever,
    ledger: s.ledger,
    kind,
    reps,
    armA: { meanInputTokens: mean(aIn), meanOutputTokens: mean(aOut), meanCost: mean(paired.map((p) => p.costA)) },
    armB: { meanInputTokens: mean(bIn), meanOutputTokens: mean(bOut), meanCost: mean(paired.map((p) => p.costB)) },
    formaFactura: repartoDeLaFactura(model, mean(aIn), mean(aOut)),
    cacheDePrefijo: { naive: cacheNaive, optimizado: cacheOptimizado },
    measured: {
      inputTokenDeltaMean: mean(aIn) - mean(bIn),
      outputTokenDeltaMean: mean(aOut) - mean(bOut),
      savings,
      wilcoxonP: wilcoxonSignedRankP(paired.map((p) => p.costA - p.costB)),
    },
    quality: { gate, passed: qPass, total: reps },
    naiveContractValid: { valid: naiveValid, total: naiveTotal },
    proven: mode === "LIVE" && savings.lower > 0 && qualityOk && modelStable,
    modelStable,
    servedModels: [...modelosServidos],
    fingerprints: [...fingerprints],
    attribution,
    paired,
  };

  // Cache amortization: repeat traffic pays the miss ONCE, then hits are $0.
  if (kind === "cache") {
    const layer = nuevaCapa(provider, model);
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
  // `structurallyValid` es OPCIONAL en el contrato, así que esto era
  // `boolean | undefined` y nadie lo veía: `benchmarks/` no estaba en el
  // `include` del tsconfig. Para una verja de calidad, AUSENTE significa NO
  // VERIFICADO, y no verificado no pasa — la duda tiene que restar afirmación.
  const structural =
    answer.trim().length > 0 && optimized.report.constraints.structurallyValid === true;

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
    padL("bill in/out", 14) + padL("cached A/B", 12) +
    padL("savings (95% lo)", 20) + padL("qa", 8),
  );
  console.log("─".repeat(130));

  const results: ScenarioResult[] = [];
  for (const s of scenarios) results.push(await runScenario(s));

  for (const r of results) {
    const qa = `${r.quality.passed}/${r.quality.total}`;
    console.log(
      pad(r.name, 26) + pad(r.kind, 9) +
      padL(`${r.armA.meanInputTokens.toFixed(0)}/${r.armA.meanOutputTokens.toFixed(0)}`, 16) +
      padL(`${r.armB.meanInputTokens.toFixed(0)}/${r.armB.meanOutputTokens.toFixed(0)}`, 16) +
      padL(`${(r.formaFactura.entrada * 100).toFixed(0)}/${(r.formaFactura.salida * 100).toFixed(0)}`, 14) +
      padL(`${r.cacheDePrefijo.naive}/${r.cacheDePrefijo.optimizado}`, 12) +
      padL(`${pct(r.measured.savings.point)} (${pct(r.measured.savings.lower)})`, 20) +
      padL(qa, 8),
    );
  }
  console.log("─".repeat(130));

  // LA SEÑAL QUE DECIDE SI ESTE BANCO PUEDE VER LA PALANCA MAYOR DE LA ENTRADA.
  // Si ningún escenario consigue que el proveedor devuelva `cached_tokens > 0`,
  // la caché de prefijo es INVISIBLE aquí: no se puede ni medir lo que ya hace
  // el cliente sin nosotros, ni demostrar lo que aportaríamos. Durante siete
  // escenarios el banco reportó 0 en los dos brazos y nadie lo miró.
  const conCache = results.filter((r) => r.cacheDePrefijo.naive > 0 || r.cacheDePrefijo.optimizado > 0);
  if (mode === "LIVE" && conCache.length === 0) {
    console.log(
      "\n⚠ NINGÚN escenario alcanzó la caché de prefijo del proveedor (cached_tokens = 0 en los dos\n" +
      "  brazos). Este banco NO puede medir esa palanca: los prompts no llegan al mínimo de tramo.\n" +
      "  Cualquier titular que salga de aquí ignora una de las mayores palancas de la entrada.",
    );
  }

  // Aggregate over ALL scenarios' cold single-call paired costs (honest: cache
  // shows its cold-miss cost here; repeat-traffic amortization is separate).
  const allA = results.flatMap((r) => r.paired.map((p) => p.costA));
  const allB = results.flatMap((r) => r.paired.map((p) => p.costB));
  const agg = bootstrapRatioCI(allA, allB, { seed: SEED });
  const wP = wilcoxonSignedRankP(results.flatMap((r) => r.paired.map((p) => p.costA - p.costB)));
  const qTotalPass = results.reduce((n, r) => n + r.quality.passed, 0);
  const qTotal = results.reduce((n, r) => n + r.quality.total, 0);
  const qualityPassRate = qTotal ? qTotalPass / qTotal : 0;
  const allFpStable = results.every((r) => r.modelStable);

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
      proven: mode === "LIVE" && ci.lower > 0 && rs.length > 0 && rs.every((r) => r.quality.passed === r.quality.total && r.modelStable),
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
    if (!allFpStable) console.log(`  ⚠ los dos brazos no hablaron con el mismo modelo: ${results.flatMap((r) => r.servedModels).join(", ")}`);
  } else {
    console.log(`  Net savings:   ${pct(agg.point)}  — ESTIMATED (mock provider), NOT a real savings claim`);
    console.log(`  Run LIVE (set BVSALA_DEMO_BASE_URL) for real provider tokens & dollars.`);
  }
  console.log(`  Quality:       ${qTotalPass}/${qTotal} answers passed the gate (${pct(qualityPassRate)})`);
  const nv = results.reduce((n, r) => n + r.naiveContractValid.valid, 0);
  const nt = results.reduce((n, r) => n + r.naiveContractValid.total, 0);
  if (nt > 0) {
    console.log(`  Naive valid:   ${nv}/${nt} respuestas del brazo SIN la capa cumplían el contrato (${pct(nv / nt)})`);
    console.log(`                 (la capa paga tokens por garantizarlo; el naive no, y hasta ahora nadie se lo exigía)`);
  }
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
    modelStable: allFpStable,
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
      "El modelo SERVIDO se compara entre los dos brazos; si difiere, la afirmación no vale. (system_fingerprint se registra pero no se usa como verja: a través de una pasarela es un id por petición.)",
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
