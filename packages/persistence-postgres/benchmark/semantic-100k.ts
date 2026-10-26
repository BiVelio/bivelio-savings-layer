import { mkdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { Pool } from "pg";

import { canonicalize, type CanonicalRequest } from "../../../src/canonicalization/canonicalize.js";
import { SemanticCalibrationJournal } from "../../../src/cache/semantic-journal.js";
import { localEmbedding, LOCAL_EMBEDDING_THRESHOLD } from "../../../src/cache/embedder-local.js";
import { SemanticCacheSafety } from "../../../src/cache/semantic-safety.js";
import type { SavingsRequest } from "../../../src/contracts/types.js";
import { PgSemanticCache } from "../src/semantic.js";

const connectionString = process.env.BIVELIO_TEST_POSTGRES_URL;
if (!connectionString) throw new Error("Set BIVELIO_TEST_POSTGRES_URL to a disposable PostgreSQL + pgvector database");
const target = Number(process.env.BIVELIO_BENCH_RECORDS ?? 100_000);
if (!Number.isSafeInteger(target) || target < 1) throw new Error("BIVELIO_BENCH_RECORDS must be a positive integer");
const tenantCount = Math.min(100, target);
const groups = Math.ceil(target / tenantCount);
const namespace = process.env.BIVELIO_BENCH_NAMESPACE ?? `semantic-bench-${Date.now()}`;
const output = process.env.BIVELIO_BENCH_OUTPUT ?? "benchmarks/out/semantic-postgres-100k.json";
const pool = new Pool({
  connectionString,
  max: Number(process.env.BIVELIO_BENCH_POOL_MAX ?? 16),
  query_timeout: 30_000,
  statement_timeout: 30_000,
});
const base = canonicalize({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "benchmark" }],
  context: { tenantId: "tenant-0", sessionId: "benchmark-person" },
} as SavingsRequest);
const backend = "postgres-hnsw-cosine-v1;guard=key-tokens-v1;candidates=32";

function textFor(group: number): string {
  return `user:synthetic semantic document ${group} with shared billing context`;
}

function requestFor(group: number, tenant: number): CanonicalRequest {
  return { ...base, normalizedText: textFor(group), tenantId: `tenant-${tenant}` };
}

function norm(vector: number[]): number {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

function literal(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))]!;
}

function summary(values: number[]) {
  return {
    samples: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: Math.max(...values),
  };
}

async function timed<T>(operation: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await operation();
  return { value, ms: performance.now() - start };
}

async function loadRecords(embeddings: string[], dimensions: number): Promise<void> {
  const columns = `namespace, record_id, embedding, embedding_256,
    embedding_dimensions, embedding_norm, query, answer, tenant_id,
    authorization_scope, principal, knowledge_epoch, contract_id, model,
    system_prompt_hash, structured_data_hash, locale, schema_version,
    safety_policy_version, toolset_hash, tool_turns_hash, temperature,
    seed, reasoning_effort, stored_at_ms`;
  const batchSize = 250;
  for (let start = 0; start < target; start += batchSize) {
    const values: unknown[] = [];
    const tuples: string[] = [];
    const end = Math.min(target, start + batchSize);
    for (let index = start; index < end; index++) {
      const tenant = Math.floor(index / groups);
      const group = index % groups;
      const vector = embeddings[group]!;
      const row = [
        namespace, `record-${index}`, vector, vector, dimensions,
        norm(JSON.parse(embeddings[group]!) as number[]),
        textFor(group), JSON.stringify({ text: `answer-${group}`, storedAtMs: 0 }),
        `tenant-${tenant}`, base.authorizationScope, base.principal,
        base.knowledgeEpoch, base.contractId, base.model, base.systemPromptHash,
        base.structuredDataHash, base.locale, base.schemaVersion,
        base.safetyPolicyVersion, base.toolsetHash, null, null, null, null, Date.now(),
      ];
      tuples.push(`(${row.map((_, column) => `$${values.length + column + 1}`).join(",")})`);
      values.push(...row);
    }
    await pool.query(`INSERT INTO bivelio_savings.semantic_cache_records (${columns}) VALUES ${tuples.join(",")}`, values);
    if (end % 10_000 === 0 || end === target) console.log(`loaded ${end}/${target}`);
  }
}

async function directSql(c: CanonicalRequest, vector: string): Promise<number> {
  const result = await timed(() => pool.query(
    `SELECT record_id
     FROM bivelio_savings.semantic_cache_records
     WHERE namespace = $1
       AND embedding_dimensions = $3 AND embedding_norm > 0
       AND tenant_id = $4 AND authorization_scope = $5
       AND principal IS NOT DISTINCT FROM $6 AND knowledge_epoch = $7
       AND contract_id IS NOT DISTINCT FROM $8 AND model = $9
       AND system_prompt_hash = $10 AND structured_data_hash = $11
       AND locale = $12 AND schema_version = $13 AND safety_policy_version = $14
       AND toolset_hash = $15 AND tool_turns_hash IS NOT DISTINCT FROM $16
       AND temperature IS NOT DISTINCT FROM $17 AND seed IS NOT DISTINCT FROM $18
       AND reasoning_effort IS NOT DISTINCT FROM $19
       AND (embedding_256 <=> $2::vector) <= 1.0 - $20::double precision
     ORDER BY embedding_256 <=> $2::vector, seq LIMIT 32`,
    [
      namespace, vector, 256, c.tenantId, c.authorizationScope, c.principal,
      c.knowledgeEpoch, c.contractId, c.model, c.systemPromptHash,
      c.structuredDataHash, c.locale, c.schemaVersion, c.safetyPolicyVersion,
      c.toolsetHash, null, c.temperature, c.seed, null, LOCAL_EMBEDDING_THRESHOLD,
    ],
  ));
  return result.ms;
}

async function measureConcurrency(cache: PgSemanticCache, concurrency: number, samples: number): Promise<number[]> {
  const durations: number[] = [];
  let cursor = process.env.BIVELIO_BENCH_REUSE === "1" ? 1 : 0;
  await Promise.all(Array.from({ length: concurrency }, async (_, worker) => {
    const count = Math.floor(samples / concurrency) + (worker < samples % concurrency ? 1 : 0);
    for (let index = 0; index < count; index++) {
      const group = cursor++ % groups;
      const tenant = group % tenantCount;
      const result = await timed(() => cache.lookup(requestFor(group, tenant)));
      if (!result.value.hit) throw new Error(`expected hit for group ${group}, tenant ${tenant}`);
      durations.push(result.ms);
    }
  }));
  return durations;
}

async function main(): Promise<void> {
  const vectors: number[][] = [];
  const literals: string[] = [];
  for (let group = 0; group < groups; group++) {
    const vector = localEmbedding(textFor(group));
    vectors.push(vector);
    literals.push(literal(vector));
  }
  try {
    for (const file of ["001_exact_and_breakpoints.sql", "002_semantic_cache.sql"]) {
      await pool.query(await readFile(new URL(`../sql/${file}`, import.meta.url), "utf8"));
    }
    const existing = Number((await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM bivelio_savings.semantic_cache_records WHERE namespace = $1",
      [namespace],
    )).rows[0]?.count ?? 0);
    if (process.env.BIVELIO_BENCH_REUSE === "1" && existing === target) {
      console.log(`reusing ${existing} records in ${namespace}`);
    } else {
      if (existing !== 0) throw new Error(`namespace ${namespace} already has ${existing} records`);
      await loadRecords(literals, 256);
    }
    await pool.query("SET maintenance_work_mem = '256MB'");
    await pool.query("ANALYZE bivelio_savings.semantic_cache_records");
    const journal = new SemanticCalibrationJournal({
      embedder: "built_in:lexical-256-v1",
      verifier: null,
      judge: "built_in:same-answer-v1",
      maxErrorRate: 0.5,
      confidence: 0.9,
      similarityThreshold: LOCAL_EMBEDDING_THRESHOLD,
      backend,
    });
    for (let index = 0; index < 40; index++) journal.record("single_shot", 1, true);
    await pool.query(
      `INSERT INTO bivelio_savings.semantic_calibrations
        (namespace, revision, backend_identity, state, updated_at_ms)
       VALUES ($1, 40, $2, $3::jsonb, $4)
       ON CONFLICT (namespace) DO NOTHING`,
      [namespace, backend, JSON.stringify(journal.export()), Date.now()],
    );
    const cache = new PgSemanticCache({
      pool,
      namespace,
      maxRecords: target,
      calibration: { maxErrorRate: 0.5, confidence: 0.9, auditRate: 0 },
      queryTimeoutMs: 250,
    });
    const cold = await timed(() => cache.lookup(requestFor(groups - 1, tenantCount - 1)));
    if (!cold.value.hit) throw new Error("cold lookup did not hit");
    const warm: Record<string, ReturnType<typeof summary>> = {};
    for (const concurrency of [1, 8, 32]) {
      warm[`c${concurrency}`] = summary(await measureConcurrency(cache, concurrency, 96));
      console.log(`c${concurrency}`, JSON.stringify(warm[`c${concurrency}`]));
    }
    const embeddingTimes: number[] = [];
    const sqlTimes: number[] = [];
    for (let index = 0; index < 32; index++) {
      const group = index % groups;
      const tenant = group % tenantCount;
      embeddingTimes.push((await timed(async () => localEmbedding(textFor(group)))).ms);
      sqlTimes.push(await directSql(requestFor(group, tenant), literals[group]!));
    }
    const explain = await pool.query(
      `EXPLAIN (FORMAT JSON)
       SELECT record_id FROM bivelio_savings.semantic_cache_records
       WHERE namespace = $1 AND tenant_id = $2 AND embedding_dimensions = 256
         AND embedding_norm > 0 AND (embedding_256 <=> $3::vector) <= 1.0 - $4::double precision
       ORDER BY embedding_256 <=> $3::vector, seq LIMIT 32`,
      [namespace, "tenant-0", literals[0], LOCAL_EMBEDDING_THRESHOLD],
    );
    const plan = JSON.stringify(explain.rows);
    const hnswUsed = plan.includes("semantic_cache_records_embedding_256_hnsw_idx");
    const identityIndexUsed = plan.includes("semantic_cache_records_identity_idx");
    const seqScanUsed = plan.includes('"Node Type": "Seq Scan"');
    const indexedPlan = hnswUsed || identityIndexUsed;

    const tenantRows = await pool.query<{ record_id: string; query: string; embedding: string }>(
      `SELECT record_id, query, embedding FROM bivelio_savings.semantic_cache_records
       WHERE namespace = $1 AND tenant_id = 'tenant-0'`,
      [namespace],
    );
    let recallHits = 0;
    const recallSamples = Math.min(20, groups);
    const recallStart = process.env.BIVELIO_BENCH_REUSE === "1" ? 1 : 0;
    for (let group = recallStart; group < recallStart + recallSamples; group++) {
      const result = await cache.lookup(requestFor(group, 0));
      let best: { query: string; similarity: number } | null = null;
      for (const row of tenantRows.rows) {
        const embedding = JSON.parse(row.embedding) as number[];
        const similarity = SemanticCacheSafety.cosine(vectors[group]!, embedding);
        if (!best || similarity > best.similarity) best = { query: row.query, similarity };
      }
      if (result.hit?.record.query === best?.query) recallHits++;
    }
    const recallAtOne = recallSamples === 0 ? 0 : recallHits / recallSamples;

    const fifoChecked = process.env.BIVELIO_BENCH_REUSE !== "1";
    let fifoValid = true;
    if (fifoChecked) {
      const beforeEviction = await cache.count();
      await cache.store(requestFor(groups - 1, tenantCount - 1), { text: "one-too-many", storedAtMs: 0 });
      const afterEviction = await cache.count();
      const oldest = await pool.query(
        "SELECT count(*)::int AS count FROM bivelio_savings.semantic_cache_records WHERE namespace = $1 AND record_id = 'record-0'",
        [namespace],
      );
      fifoValid = beforeEviction === target && afterEviction === target && oldest.rows[0]?.count === 0;
    }
    const gate = (name: string, fallback: number): number => {
      const value = Number(process.env[name] ?? fallback);
      if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
      return value;
    };
    const warmP95Ms = gate("BIVELIO_BENCH_P95_MS", 50);
    const warmP99Ms = gate("BIVELIO_BENCH_P99_MS", 100);
    const warmMaxMs = gate("BIVELIO_BENCH_MAX_MS", 100);
    const report = {
      kind: "local-postgresql-pgvector",
      records: target,
      dimensions: 256,
      tenantCount,
      candidateLimit: 32,
      queryTimeoutMs: 250,
      coldMs: cold.ms,
      lookupMs: warm,
      embeddingMs: summary(embeddingTimes),
      directSqlMs: summary(sqlTimes),
      hnswUsed,
      identityIndexUsed,
      seqScanUsed,
      indexRequired: target >= 100_000,
      recallAtOne,
      fifoChecked,
      fifoValid,
      gates: { coldMs: 250, warmP95Ms, warmP99Ms, warmMaxMs, minRecallAtOne: 0.95 },
    };
    const passed = ((indexedPlan && !seqScanUsed) || target < 100_000) && fifoValid && recallAtOne >= 0.95 &&
      cold.ms <= 250 && Object.values(warm).every((item) => item.p95 <= warmP95Ms && item.p99 <= warmP99Ms && item.max <= warmMaxMs);
    await mkdir(new URL("../../../benchmarks/out/", import.meta.url), { recursive: true });
    await writeFile(output, `${JSON.stringify({ ...report, passed }, null, 2)}\n`);
    console.log(JSON.stringify({ ...report, passed, output }, null, 2));
    if (!passed) throw new Error("100k semantic benchmark gates failed");
  } finally {
    if (process.env.BIVELIO_BENCH_KEEP !== "1") {
      await pool.query("DELETE FROM bivelio_savings.semantic_calibration_observations WHERE namespace = $1", [namespace]);
      await pool.query("DELETE FROM bivelio_savings.semantic_calibrations WHERE namespace = $1", [namespace]);
      await pool.query("DELETE FROM bivelio_savings.semantic_cache_records WHERE namespace = $1", [namespace]);
    }
    await pool.end();
  }
}

await main();
