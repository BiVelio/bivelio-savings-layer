import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const output = process.env.BIVELIO_LIVE_CANARY_OUTPUT ??
  join(packageRoot, "benchmark", "out", "live-canary.json");

function redact(text: string, env: NodeJS.ProcessEnv): string {
  let out = text;
  for (const [name, value] of Object.entries(env)) {
    if (value && value.length > 4 && /KEY|TOKEN|SECRET|LICENSE/.test(name)) out = out.replaceAll(value, "[redacted]");
  }
  if (env.BIVELIO_TEST_POSTGRES_URL) out = out.replaceAll(env.BIVELIO_TEST_POSTGRES_URL, "[redacted]");
  return out.replaceAll("GREEN-742", "[redacted]");
}

function command(command: string, args: string[], cwd: string, env = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-1_000_000); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-1_000_000); });
    child.once("error", () => reject(new Error(`could not execute ${command}`)));
    child.once("exit", (code) => code === 0
      ? resolve(stdout)
      : reject(new Error(`${command} failed with exit code ${code}: ${redact(stderr, env).slice(-2_000)}`)));
  });
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))]!;
}

const worker = String.raw`
import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { Pool } from "pg";
import { createSavingsLayer, GoogleProvider } from "@bivelio/savings-layer";
import { PgExactCache, PgSemanticCache } from "@bivelio/persistence-postgres";

const env = process.env;
const resultPath = env.CANARY_RESULT;
const keysPath = env.CANARY_KEYS;
const namespace = env.CANARY_NAMESPACE;
const model = env.CANARY_MODEL || "google/gemini-3.8-flash";
const phase = env.CANARY_PHASE;
const records = [];
const licenses = JSON.parse(env.CANARY_LICENSES);
const layers = new Map();
let providerCalls = 0;
let pool;

class TrackedExactCache extends PgExactCache {
  async get(key) {
    await appendFile(keysPath, key + "\n");
    return super.get(key);
  }
  async set(key, value, ttlMs) {
    await appendFile(keysPath, key + "\n");
    return super.set(key, value, ttlMs);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function request(text, tenant, exact = true) {
  return {
    model,
    messages: [{ role: "user", content: text }],
    context: { tenantId: tenant, sessionId: "live-canary-principal" },
    temperature: 0,
    seed: 17,
    response: { maxOutputTokens: 24 },
    savings: {
      exactCache: exact,
      semanticCache: true,
      singleflight: false,
      compression: false,
      modelCascade: "off"
    }
  };
}

function isTransientPostgresError(error) {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return ["25P03", "57P01", "ECONNRESET"].includes(code);
}

async function invoke(payload) {
  const before = providerCalls;
  const started = performance.now();
  let result;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const activeLayer = await layerFor(payload.context.tenantId);
      result = await activeLayer.generate(payload);
      break;
    } catch (error) {
      if (providerCalls !== before || !isTransientPostgresError(error) || attempt === 4) throw error;
      await ensurePostgresReady();
    }
  }
  const elapsed = performance.now() - started;
  const summary = {
    cache: result.report.cache.result,
    actualLlm: result.report.calls.actualLlm,
    avoidedLlm: result.report.calls.avoidedLlm,
    retries: result.report.calls.retries,
    basis: result.report.cost.basis,
    netSavingsUsd: result.report.cost.netSavingsUsd,
    qualityStatus: result.report.qualityStatus,
    latencyMs: elapsed,
    providerCalls: providerCalls - before,
    answerHash: createHash("sha256").update(result.text).digest("hex")
  };
  records.push(summary);
  return summary;
}

function assertHit(hit, kind, quality) {
  assert(hit.cache === kind, "expected " + kind + " cache hit");
  assert(hit.actualLlm === 0 && hit.providerCalls === 0, "cache hit called the provider");
  assert(hit.qualityStatus === quality, "unexpected cache quality status");
  assert(hit.netSavingsUsd > 0, "cache hit has no positive net saving");
  if (kind === "exact") {
    assert(hit.basis === "reference" || hit.basis === "measured", "exact-cache saving is not measured");
  }
}

let exact;
let semantic;
let provider;
async function layerFor(tenant) {
  if (!layers.has(tenant)) {
    const license = licenses[tenant];
    assert(license, "missing canary license for tenant");
    layers.set(tenant, createSavingsLayer({
      provider,
      licenseKey: license.token,
      exactCache: exact,
      semanticCacheStore: semantic,
      semanticCacheDefault: true,
      silenceWarnings: true
    }));
  }
  return layers.get(tenant);
}

async function ensurePostgresReady() {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (error) {
      if (!isTransientPostgresError(error) || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
    }
  }
}

try {
  pool = new Pool({
    connectionString: env.BIVELIO_TEST_POSTGRES_URL,
    max: 6,
    connectionTimeoutMillis: 250,
    query_timeout: 1_000,
    statement_timeout: 1_000,
    idle_in_transaction_session_timeout: 1_000,
    keepAlive: true
  });
  pool.on("error", () => {});
  pool.on("connect", (client) => client.on("error", () => {}));
  await ensurePostgresReady();
  if (phase === "cold") {
    for (const file of ["001_exact_and_breakpoints.sql", "002_semantic_cache.sql"]) {
      const migration = new URL("../sql/" + file, import.meta.resolve("@bivelio/persistence-postgres"));
      await pool.query(await readFile(migration, "utf8"));
    }
  }

  exact = new TrackedExactCache({ pool, queryTimeoutMs: 75 });
  semantic = new PgSemanticCache({
    pool,
    namespace,
    queryTimeoutMs: 75,
    lockTimeoutMs: 50,
    calibration: { maxErrorRate: 0.5, confidence: 0.9, auditRate: 0 }
  });
  provider = new GoogleProvider({
    apiKey: env.BVSALA_DEMO_GOOGLE_API_KEY,
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    requireUsage: true,
    thinkingConfig: { thinkingBudget: 0 },
    fetchImpl: async (url, init) => {
      providerCalls++;
      return fetch(url, { ...init, signal: AbortSignal.timeout(4_500) });
    }
  });

  const originalText = "For this synthetic persistence check, reply with exactly GREEN-742 and nothing else.";
  const rewordedText = "Synthetic persistence check: output only GREEN-742, please.";
  const originalA = request(originalText, "tenant-a");
  const rewordedA = request(rewordedText, "tenant-a", false);
  const originalB = request(originalText, "tenant-b");
  let baselineHash;
  let semanticHit = null;

  if (phase === "cold") {
    const cold = await invoke(originalA);
    baselineHash = cold.answerHash;
    assert(cold.actualLlm === 1 && cold.providerCalls === 1, "cold request did not make exactly one provider call");
    assert(cold.basis === "measured", "cold provider usage is not measured");
    const exactHit = await invoke(originalA);
    assertHit(exactHit, "exact", "exact");
    assert(exactHit.answerHash === baselineHash, "exact hit changed the answer");

    for (let index = 0; index < 40 && semanticHit == null; index++) {
      const current = await invoke(rewordedA);
      assert(current.providerCalls <= 1 && current.actualLlm <= 1, "semantic request made more than one provider call");
      if (current.cache === "semantic") semanticHit = current;
      else assert(current.answerHash === baselineHash, "calibration answer quality diverged");
    }
    assert(semanticHit != null, "semantic cache did not certify within 40 requests");
    assertHit(semanticHit, "semantic", "task_equivalent");
    assert(semanticHit.answerHash === baselineHash, "semantic hit changed the answer");

    const isolated = await invoke(originalB);
    assert(isolated.cache === "miss" && isolated.actualLlm === 1 && isolated.providerCalls === 1,
      "tenant B reused tenant A state or did not make exactly one provider call");
    assert(isolated.answerHash !== baselineHash || isolated.cache === "miss", "tenant isolation failed");
  } else {
    const exactHit = await invoke(originalA);
    assertHit(exactHit, "exact", "exact");
    semanticHit = await invoke(rewordedA);
    assertHit(semanticHit, "semantic", "task_equivalent");
    assert(semanticHit.answerHash === exactHit.answerHash, "restart semantic answer differs from exact answer");
    const isolated = await invoke(originalB);
    assertHit(isolated, "exact", "exact");
    assert(isolated.answerHash !== exactHit.answerHash || isolated.cache === "exact", "tenant B did not retain isolated state");

    const lock = await pool.connect();
    try {
      await lock.query("SELECT set_config('idle_in_transaction_session_timeout', '0', false)");
      await lock.query("BEGIN");
      await lock.query("LOCK TABLE bivelio_savings.exact_cache_entries, bivelio_savings.semantic_cache_records, bivelio_savings.semantic_calibrations, bivelio_savings.semantic_calibration_observations IN ACCESS EXCLUSIVE MODE");
      for (const stalled of [originalA, originalB]) {
        const fallback = await invoke(stalled);
        assert(fallback.cache === "miss", "database stall produced a cache hit");
        assert(fallback.actualLlm === 1 && fallback.providerCalls === 1 && fallback.retries === 0,
          "database stall did not fail open with exactly one provider call");
      }
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
    }
  }

  await Promise.all([...layers.values()].map((activeLayer) => activeLayer.close()));
  await closePool();
  await writeFile(resultPath, JSON.stringify({ ok: true, phase, records, baselineHash, providerCalls }));
} catch (error) {
  const errorName = error && typeof error === "object" && "name" in error && typeof error.name === "string" ? error.name : "Error";
  const providerStatus = error instanceof Error ? /provider (\d{3})/.exec(error.message)?.[1] ?? null : null;
  const errorCode = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
  const diagnosticCrudo = errorName === "TimeoutError" || errorName === "AbortError"
    ? "operation aborted before completion (timeout or cancellation)"
    : error instanceof Error || (error && typeof error === "object" && "message" in error && typeof error.message === "string") ? error.message : null;
  let diagnostic = diagnosticCrudo;
  if (diagnostic !== null) {
    for (const [nombre, valor] of Object.entries(env)) {
      if (valor && valor.length > 4 && /KEY|TOKEN|SECRET|LICENSE/.test(nombre)) diagnostic = diagnostic.replaceAll(valor, "[redacted]");
    }
    if (env.BIVELIO_TEST_POSTGRES_URL) diagnostic = diagnostic.replaceAll(env.BIVELIO_TEST_POSTGRES_URL, "[redacted]");
    diagnostic = diagnostic.replaceAll("GREEN-742", "[redacted]");
  }
  try { await writeFile(resultPath, JSON.stringify({ ok: false, phase, errorName, errorCode, providerStatus, diagnostic, records, providerCalls })); } catch {}
  try { await Promise.all([...layers.values()].map((activeLayer) => activeLayer.close())); } catch {}
  try { await closePool(); } catch {}
  process.exitCode = 1;
}

async function closePool() {
  let timer;
  try {
    await Promise.race([
      pool?.end(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("PostgreSQL pool close timed out")), 1_000); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
`;

interface WorkerRecord {
  cache: string;
  actualLlm: number;
  avoidedLlm: number;
  retries: number;
  basis: string;
  netSavingsUsd: number;
  qualityStatus?: string;
  latencyMs: number;
  providerCalls: number;
  answerHash?: string;
}

interface WorkerResult {
  ok: boolean;
  phase: string;
  errorName?: string;
  errorCode?: string | null;
  providerStatus?: string | null;
  diagnostic?: string | null;
  records: WorkerRecord[];
  providerCalls: number;
}

async function main(): Promise<void> {
  const missing = [
    process.env.BIVELIO_LIVE_CANARY === "1" ? null : "BIVELIO_LIVE_CANARY=1",
    process.env.BIVELIO_TEST_POSTGRES_URL ? null : "BIVELIO_TEST_POSTGRES_URL",
    process.env.BVSALA_DEMO_GOOGLE_API_KEY ? null : "BVSALA_DEMO_GOOGLE_API_KEY",
    process.env.CANARY_LICENSE_A ? null : "CANARY_LICENSE_A",
    process.env.CANARY_LICENSE_B ? null : "CANARY_LICENSE_B",
  ].filter((item): item is string => item != null);
  if (missing.length > 0) {
    console.log("Live canary not run; no provider calls were made. Use a disposable PostgreSQL + pgvector database and set:");
    console.log(missing.join("\n"));
    console.log("Optional: CANARY_MODEL (default google/gemini-3.8-flash), BIVELIO_LIVE_CANARY_OUTPUT.");
    console.log("Build the root and persistence packages first. This opt-in canary makes billed Gemini calls.");
    return;
  }

  await access(join(root, "dist", "index.js"));
  await access(join(packageRoot, "dist", "index.js"));
  const licenses = {
    "tenant-a": { token: process.env.CANARY_LICENSE_A! },
    "tenant-b": { token: process.env.CANARY_LICENSE_B! },
  };
  const temporary = await mkdtemp(join(tmpdir(), "bivelio-live-canary-"));
  const namespace = `live-canary-${randomUUID()}`;
  const keysPath = join(temporary, "exact-keys.txt");
  await writeFile(keysPath, "");
  const pool = new Pool({ connectionString: process.env.BIVELIO_TEST_POSTGRES_URL, max: 2, query_timeout: 5_000 });
  let reportPath: string | undefined;
  try {
    const safeCommandEnv = { ...process.env };
    delete safeCommandEnv.BVSALA_DEMO_GOOGLE_API_KEY;
    delete safeCommandEnv.BIVELIO_LICENSE_KEY;
    delete safeCommandEnv.BIVELIO_TEST_POSTGRES_URL;
    const coreTar = (await command("npm", ["pack", root, "--pack-destination", temporary, "--ignore-scripts"], temporary, safeCommandEnv)).trim().split("\n").at(-1)!;
    const persistenceTar = (await command("npm", ["pack", packageRoot, "--pack-destination", temporary, "--ignore-scripts"], temporary, safeCommandEnv)).trim().split("\n").at(-1)!;
    const consumer = join(temporary, "consumer");
    await mkdir(consumer);
    await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
    await command("npm", [
      "install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false",
      join(temporary, coreTar), join(temporary, persistenceTar), "pg@8.23.1",
    ], consumer, safeCommandEnv);
    const workerPath = join(consumer, "worker.mjs");
    await writeFile(workerPath, worker);

    const results: WorkerResult[] = [];
    for (const phase of ["cold", "restart"]) {
      const resultPath = join(temporary, `${phase}.json`);
      const childEnv = {
        ...process.env,
        CANARY_LICENSES: JSON.stringify(licenses),
        CANARY_PHASE: phase,
        CANARY_RESULT: resultPath,
        CANARY_KEYS: keysPath,
        CANARY_NAMESPACE: namespace,
        CANARY_MODEL: process.env.CANARY_MODEL ?? "google/gemini-3.8-flash",
      };
      try {
        await command(process.execPath, [workerPath], consumer, childEnv);
      } catch (caught) {
        const failure = JSON.parse(await readFile(resultPath, "utf8").catch(() => "{}")) as Partial<WorkerResult>;
        const preservedFailure: WorkerResult = {
          ...failure,
          ok: false,
          phase: failure.phase ?? phase,
          records: failure.records ?? [],
          providerCalls: failure.providerCalls ?? 0,
        };
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, redact(JSON.stringify(preservedFailure), process.env));
        const name = failure.errorName ? ` (${failure.errorName})` : "";
        const code = failure.errorCode ? ` SQLSTATE ${failure.errorCode}` : "";
        const status = failure.providerStatus ? ` provider ${failure.providerStatus}` : "";
        const detail = failure.diagnostic ? redact(failure.diagnostic, process.env)
          : caught instanceof Error ? caught.message : "unknown worker error";
        const completed = failure.records?.length ?? 0;
        throw new Error(`${phase} packaged worker failed after ${completed} requests${name}${code}${status}: ${detail}`);
      }
      const result = JSON.parse(await readFile(resultPath, "utf8")) as WorkerResult;
      if (!result.ok) throw new Error(`${phase} packaged worker failed its gates`);
      results.push(result);
    }

    const records = results.flatMap((result) => result.records);
    const latencies = records.map((record) => record.latencyMs);
    const measured = records.filter((record) => record.basis === "measured" || record.basis === "reference");
    const measuredNetSavingsUsd = measured.reduce((sum, record) => sum + record.netSavingsUsd, 0);
    const p95Ms = percentile(latencies, 0.95);
    const maxMs = Math.max(...latencies);
    const gates = { p95Ms: 3_000, maxMs: 5_000 };
    const passed = results.length === 2 && records.every((record) => record.providerCalls <= 1) &&
      records.some((record) => record.cache === "exact") && records.some((record) => record.cache === "semantic") &&
      measuredNetSavingsUsd > 0 && p95Ms <= gates.p95Ms && maxMs <= gates.maxMs;
    const report = {
      kind: "packaged-postgresql-gemini-live-canary",
      license: "short-lived-per-tenant-offline-test",
      processes: results.map((result) => ({ phase: result.phase, requests: result.records.length, providerCalls: result.providerCalls })),
      requests: records.length,
      providerCalls: results.reduce((sum, result) => sum + result.providerCalls, 0),
      cacheOutcomes: Object.fromEntries(["miss", "exact", "semantic"].map((kind) => [kind, records.filter((record) => record.cache === kind).length])),
      quality: {
        exact: records.filter((record) => record.cache === "exact").every((record) => record.qualityStatus === "exact"),
        semantic: records.filter((record) => record.cache === "semantic").every((record) => record.qualityStatus === "task_equivalent"),
      },
      measuredNetSavingsUsd,
      latencyMs: { samples: latencies.length, p95: p95Ms, max: maxMs },
      gates,
      tenantIsolation: true,
      databaseStallFailOpen: true,
      passed,
    };
    await mkdir(resolve(output, ".."), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    reportPath = output;
    console.log(JSON.stringify({ ...report, output }, null, 2));
    if (!passed) throw new Error("live canary release gates failed");
  } finally {
    try {
      const keys = (await readFile(keysPath, "utf8")).split("\n").filter(Boolean);
      if (keys.length > 0) {
        await pool.query("DELETE FROM bivelio_savings.exact_cache_entries WHERE cache_key = ANY($1::text[])", [[...new Set(keys)]]);
      }
      await pool.query("DELETE FROM bivelio_savings.semantic_calibration_observations WHERE namespace = $1", [namespace]);
      await pool.query("DELETE FROM bivelio_savings.semantic_calibrations WHERE namespace = $1", [namespace]);
      await pool.query("DELETE FROM bivelio_savings.semantic_cache_records WHERE namespace = $1", [namespace]);
    } catch (error) {
      if (reportPath != null) throw error;
      throw new Error("live canary cleanup failed; inspect only the dedicated canary namespace and recorded exact keys");
    } finally {
      await pool.end();
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

try {
  await main();
} catch (error) {
  console.error("Live canary failed; safe diagnostic:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
}
