import { spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const output = process.env.BIVELIO_LIVE_CANARY_OUTPUT ??
  join(packageRoot, "benchmark", "out", "live-canary.json");

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
      : reject(new Error(`${command} failed with exit code ${code}; output suppressed for safety: ${stderr.length > 0}`)));
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
let providerCalls = 0;
let layer;
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

async function invoke(payload) {
  const before = providerCalls;
  const started = performance.now();
  const result = await layer.generate(payload);
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
  if (phase === "cold") {
    for (const file of ["001_exact_and_breakpoints.sql", "002_semantic_cache.sql"]) {
      const migration = new URL("../sql/" + file, import.meta.resolve("@bivelio/persistence-postgres"));
      await pool.query(await readFile(migration, "utf8"));
    }
  }

  const exact = new TrackedExactCache({ pool, queryTimeoutMs: 75 });
  const semantic = new PgSemanticCache({
    pool,
    namespace,
    queryTimeoutMs: 75,
    lockTimeoutMs: 50,
    calibration: { maxErrorRate: 0.5, confidence: 0.9, auditRate: 0 }
  });
  const provider = new GoogleProvider({
    apiKey: env.BVSALA_DEMO_GOOGLE_API_KEY,
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    requireUsage: true,
    thinkingConfig: { thinkingBudget: 0 },
    fetchImpl: async (url, init) => {
      providerCalls++;
      return fetch(url, { ...init, signal: AbortSignal.timeout(4_500) });
    }
  });
  layer = createSavingsLayer({
    provider,
    licenseKey: env.BIVELIO_LICENSE_KEY,
    licensePublicKey: env.CANARY_LICENSE_PUBLIC_KEY,
    exactCache: exact,
    semanticCacheStore: semantic,
    semanticCacheDefault: true,
    silenceWarnings: true
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

  await layer.close();
  await pool.end();
  await writeFile(resultPath, JSON.stringify({ ok: true, phase, records, baselineHash, providerCalls }));
} catch {
  try { await layer?.close(); } catch {}
  try { await pool?.end(); } catch {}
  try { await writeFile(resultPath, JSON.stringify({ ok: false, phase, records, providerCalls })); } catch {}
  process.exitCode = 1;
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
  records: WorkerRecord[];
  providerCalls: number;
}

function ephemeralLicense(): { token: string; publicKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const b64url = (value: Buffer | string) => Buffer.from(value).toString("base64url");
  const header = b64url(JSON.stringify({ alg: "EdDSA", typ: "BVL", v: 1 }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({
    jti: `live-canary-${randomUUID()}`,
    org_id: "live-canary",
    plan: "pro",
    seats: 1,
    features: ["semantic_cache", "dashboards"],
    issued_at: now,
    expires_at: now + 3600,
    grace_days: 0,
    iss: "bivelio-live-canary",
  }));
  const signature = sign(null, Buffer.from(`${header}.${payload}`), privateKey);
  return { token: `${header}.${payload}.${b64url(signature)}`, publicKey };
}

async function main(): Promise<void> {
  const missing = [
    process.env.BIVELIO_LIVE_CANARY === "1" ? null : "BIVELIO_LIVE_CANARY=1",
    process.env.BIVELIO_TEST_POSTGRES_URL ? null : "BIVELIO_TEST_POSTGRES_URL",
    process.env.BVSALA_DEMO_GOOGLE_API_KEY ? null : "BVSALA_DEMO_GOOGLE_API_KEY",
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
  const license = ephemeralLicense();
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
        BIVELIO_LICENSE_KEY: license.token,
        CANARY_LICENSE_PUBLIC_KEY: license.publicKey,
        CANARY_PHASE: phase,
        CANARY_RESULT: resultPath,
        CANARY_KEYS: keysPath,
        CANARY_NAMESPACE: namespace,
        CANARY_MODEL: process.env.CANARY_MODEL ?? "google/gemini-3.8-flash",
      };
      try {
        await command(process.execPath, [workerPath], consumer, childEnv);
      } catch {
        throw new Error(`${phase} packaged worker failed; provider output and credentials were suppressed`);
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
      license: "ephemeral-ed25519-offline-test",
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
} catch {
  console.error("Live canary failed; error details are suppressed to avoid exposing credentials or request content.");
  process.exitCode = 1;
}
