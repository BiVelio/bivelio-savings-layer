import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { canonicalize } from "../../../src/canonicalization/canonicalize.js";
import type { CachedAnswer } from "../../../src/cache/exact.js";
import type { SemanticProbe } from "../../../src/cache/semantic.js";
import type { SavingsRequest } from "../../../src/contracts/types.js";
import { PgSemanticCache } from "../src/index.js";

const connectionString = process.env.BIVELIO_TEST_POSTGRES_URL;
const describePostgres = describe.skipIf(!connectionString);
const namespace = `semantic-test-${randomUUID()}`;
const calibration = { maxErrorRate: 0.5, confidence: 0.9, auditRate: 0 } as const;
const answer = (text: string): CachedAnswer => ({ text, data: { text }, storedAtMs: 0 });
let poolA: Pool;
let poolB: Pool;

function canonical(text: string, tenantId = "tenant-a", principal = "person-a") {
  return canonicalize({
    model: "openai/gpt-4o-mini",
    messages: [{ role: "user", content: text }],
    context: { tenantId, sessionId: principal },
  } as SavingsRequest);
}

function cache(pool: Pool, options: { calibrated?: boolean; maxRecords?: number; ttlMs?: number } = {}) {
  return new PgSemanticCache({
    pool,
    namespace,
    queryTimeoutMs: 5_000,
    lockTimeoutMs: 1_000,
    ...(options.calibrated === false ? {} : { calibration }),
    ...(options.maxRecords ? { maxRecords: options.maxRecords } : {}),
    ...(options.ttlMs ? { ttlMs: options.ttlMs } : {}),
  });
}

async function probeFor(store: PgSemanticCache, text = "summarize the quarterly report for the board") {
  const result = await store.lookup(canonical(text));
  expect(result.hit).toBeNull();
  expect(result.probe).not.toBeNull();
  return result.probe!;
}

describePostgres("PgSemanticCache with real pgvector", () => {
  beforeAll(async () => {
    poolA = new Pool({ connectionString, max: 16, query_timeout: 5_000 });
    poolB = new Pool({ connectionString, max: 16, query_timeout: 5_000 });
    for (const file of ["001_exact_and_breakpoints.sql", "002_semantic_cache.sql"]) {
      const sql = await readFile(new URL(`../sql/${file}`, import.meta.url), "utf8");
      await poolA.query(sql);
      await poolA.query(sql);
    }
  }, 30_000);

  beforeEach(async () => {
    await poolA.query("DELETE FROM bivelio_savings.semantic_calibration_observations WHERE namespace LIKE $1", [`${namespace}%`]);
    await poolA.query("DELETE FROM bivelio_savings.semantic_calibrations WHERE namespace LIKE $1", [`${namespace}%`]);
    await poolA.query("DELETE FROM bivelio_savings.semantic_cache_records WHERE namespace LIKE $1", [`${namespace}%`]);
  });

  afterAll(async () => {
    if (poolA == null) return;
    await poolA.query("DELETE FROM bivelio_savings.semantic_calibration_observations WHERE namespace LIKE $1", [`${namespace}%`]);
    await poolA.query("DELETE FROM bivelio_savings.semantic_calibrations WHERE namespace LIKE $1", [`${namespace}%`]);
    await poolA.query("DELETE FROM bivelio_savings.semantic_cache_records WHERE namespace LIKE $1", [`${namespace}%`]);
    await Promise.all([poolA.end(), poolB.end()]);
  }, 30_000);

  it("stays shadow-only without calibration and isolates tenant and principal in SQL", async () => {
    const isolatedNamespace = `${namespace}-shadow`;
    const store = new PgSemanticCache({ pool: poolA, namespace: isolatedNamespace, queryTimeoutMs: 5_000 });
    await store.store(canonical("describe the water cycle"), answer("rain"));
    expect(await store.lookup(canonical("describe the water cycle"))).toEqual({ hit: null, probe: null });
    expect(await store.count()).toBe(1);
    await poolA.query("DELETE FROM bivelio_savings.semantic_cache_records WHERE namespace = $1", [isolatedNamespace]);

    const calibrated = cache(poolA);
    await calibrated.store(canonical("confidential quarterly answer"), answer("secret"));
    expect(await calibrated.lookup(canonical("confidential quarterly answer", "tenant-b"))).toEqual({ hit: null, probe: null });
    expect(await calibrated.lookup(canonical("confidential quarterly answer", "tenant-a", "person-b"))).toEqual({ hit: null, probe: null });
    await poolA.query(
      "DELETE FROM bivelio_savings.semantic_cache_records WHERE namespace = $1 AND query = $2",
      [namespace, canonical("confidential quarterly answer").normalizedText],
    );
  });

  it("certifies through alternating pools and serves after a restart", async () => {
    const original = canonical("summarize the quarterly report for the board");
    await cache(poolA).store(original, answer("the summary"));
    let hit = null;
    for (let index = 0; index < 40 && !hit; index++) {
      const current = await cache(index % 2 === 0 ? poolA : poolB).lookup(original);
      if (current.hit) {
        hit = current.hit;
        break;
      }
      expect(current.probe).not.toBeNull();
      expect(await cache(index % 2 === 0 ? poolB : poolA).observe(current.probe!, answer("the summary"))).toBe(true);
    }
    const status = await cache(poolA).calibrationStatus();
    const decision = await cache(poolB).lookup(original);
    expect(hit, JSON.stringify({ status, decision })).not.toBeNull();
    expect(hit?.calibration?.labeled).toBeGreaterThanOrEqual(10);
    expect((await cache(poolB).lookup(original)).hit?.record.answer.text).toBe("the summary");
    expect((await cache(poolB).calibrationStatus())?.labeled).toBeGreaterThanOrEqual(10);
  }, 30_000);

  it("deduplicates delivery and rejects reuse of an observation id for another payload", async () => {
    await cache(poolA).store(canonical("deduplicate this synthetic question"), answer("same"));
    const probe = await probeFor(cache(poolA), "deduplicate this synthetic question");
    expect(await cache(poolA).observe(probe, answer("same"))).toBe(true);
    expect(await cache(poolB).observe(probe, answer("same"))).toBe(true);
    expect((await cache(poolA).calibrationStatus())?.labeled).toBe(1);
    expect(await cache(poolB).observe(probe, answer("different"))).toBeNull();
    expect((await cache(poolA).calibrationStatus())?.labeled).toBe(1);
  });

  it("does not lose labels from 24 replicas or duplicate their revisions", async () => {
    const concurrentNamespace = `${namespace}-concurrent`;
    const make = (pool: Pool) => new PgSemanticCache({
      pool,
      namespace: concurrentNamespace,
      calibration,
      queryTimeoutMs: 5_000,
      lockTimeoutMs: 1_000,
    });
    const request = canonical("one shared calibration history across replicas");
    await make(poolA).store(request, answer("shared"));
    const probes = await Promise.all(Array.from({ length: 24 }, (_, index) =>
      make(index % 2 === 0 ? poolA : poolB).lookup(request),
    ));
    const verdicts = await Promise.all(probes.map((result, index) =>
      make(index % 2 === 0 ? poolB : poolA).observe(result.probe!, answer("shared")),
    ));
    expect(verdicts.every((verdict) => verdict === true)).toBe(true);
    expect((await make(poolA).calibrationStatus())?.labeled).toBe(24);
    const state = await poolA.query(
      "SELECT revision FROM bivelio_savings.semantic_calibrations WHERE namespace = $1",
      [concurrentNamespace],
    );
    expect(state.rows[0]?.revision).toBe("24");
    const observations = await poolA.query(
      "SELECT count(*)::int AS count FROM bivelio_savings.semantic_calibration_observations WHERE namespace = $1",
      [concurrentNamespace],
    );
    expect(observations.rows[0]?.count).toBe(24);
    await poolA.query("DELETE FROM bivelio_savings.semantic_calibration_observations WHERE namespace = $1", [concurrentNamespace]);
    await poolA.query("DELETE FROM bivelio_savings.semantic_calibrations WHERE namespace = $1", [concurrentNamespace]);
    await poolA.query("DELETE FROM bivelio_savings.semantic_cache_records WHERE namespace = $1", [concurrentNamespace]);
  }, 30_000);

  it("keeps the maximum per-record failure floor and expires records", async () => {
    await cache(poolA).store(canonical("record floor synthetic question"), answer("stored"));
    let first: SemanticProbe | undefined;
    for (let index = 0; index < 40; index++) {
      const current = await cache(poolA).lookup(canonical("record floor synthetic question"));
      if (current.hit) break;
      first = current.probe!;
      await cache(poolA).observe(first, answer("stored"));
    }
    expect(first).toBeDefined();
    const wrong: SemanticProbe = { ...first!, score: 1, observationId: randomUUID() };
    expect(await cache(poolA).observe(wrong, answer("fresh and different"))).toBe(false);
    const lower: SemanticProbe = { ...first!, score: 0.8, observationId: randomUUID() };
    expect(await cache(poolB).observe(lower, answer("fresh and different"))).toBe(false);
    const stored = await poolA.query(
      "SELECT failed_at_score FROM bivelio_savings.semantic_cache_records WHERE namespace = $1 AND record_id = $2",
      [namespace, first!.record.recordId],
    );
    expect(stored.rows[0]?.failed_at_score).toBe(1);
    expect((await cache(poolA).lookup(canonical("record floor synthetic question"))).probe?.reason).toBe("record_floor");

    const expiring = cache(poolA, { ttlMs: 20 });
    await expiring.store(canonical("short lived semantic entry"), answer("short"));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await expiring.lookup(canonical("short lived semantic entry"))).toEqual({ hit: null, probe: null });
  });

  it("evicts FIFO, deletes by epoch and tenant, and isolates answer mutations", async () => {
    const store = cache(poolA, { maxRecords: 2 });
    await store.store(canonical("first synthetic record"), answer("first"));
    await store.store(canonical("second synthetic record"), answer("second"));
    const original = answer("third");
    await store.store(canonical("third synthetic record"), original);
    original.text = "writer mutation";
    expect(await store.count()).toBe(2);
    const remaining = await poolA.query(
      "SELECT query FROM bivelio_savings.semantic_cache_records WHERE namespace = $1 ORDER BY seq",
      [namespace],
    );
    expect(remaining.rows.map((row) => row.query)).toEqual([
      canonical("second synthetic record").normalizedText,
      canonical("third synthetic record").normalizedText,
    ]);
    const probe = await probeFor(store, "third synthetic record");
    expect(probe.record.answer.text).toBe("third");
    probe.record.answer.text = "reader mutation";
    expect((await probeFor(store, "third synthetic record")).record.answer.text).toBe("third");
    expect(await store.invalidateEpoch("none")).toBe(2);

    await store.store(canonical("tenant deletion", "tenant-a"), answer("a"));
    await store.store(canonical("tenant deletion", "tenant-b"), answer("b"));
    expect(await store.deleteTenant("tenant-a")).toBe(1);
    expect(await store.count()).toBe(1);
  });

  it("supports a custom embedding dimension and rejects invalid vectors", async () => {
    const custom = new PgSemanticCache({
      pool: poolA,
      namespace: `${namespace}-custom`,
      calibration,
      queryTimeoutMs: 5_000,
      embedderId: "synthetic-two-dimensional-v1",
      embed: (text) => text.includes("zero") ? [0, 0] : [text.length, 1],
      similarityThreshold: 0.5,
    });
    await custom.store(canonical("custom dimensions"), answer("custom"));
    expect((await custom.lookup(canonical("custom dimensions"))).probe).not.toBeNull();
    await custom.store(canonical("zero vector"), answer("zero"));
    expect(await custom.lookup(canonical("zero vector"))).toEqual({ hit: null, probe: null });
    const invalid = new PgSemanticCache({
      pool: poolA,
      namespace: `${namespace}-custom`,
      embed: () => [Number.NaN, 1],
    });
    await expect(invalid.store(canonical("invalid vector"), answer("invalid"))).rejects.toThrow("finite numbers");
    await poolA.query("DELETE FROM bivelio_savings.semantic_calibration_observations WHERE namespace = $1", [`${namespace}-custom`]);
    await poolA.query("DELETE FROM bivelio_savings.semantic_calibrations WHERE namespace = $1", [`${namespace}-custom`]);
    await poolA.query("DELETE FROM bivelio_savings.semantic_cache_records WHERE namespace = $1", [`${namespace}-custom`]);
  });

  it("refuses a stale administrative restore and drains observations on close", async () => {
    const request = canonical("revisioned calibration restore");
    const store = cache(poolA);
    await store.store(request, answer("stored"));
    const first = await probeFor(store, "revisioned calibration restore");
    await store.observe(first, answer("stored"));
    const snapshot = await store.exportCalibrationSnapshot();
    const second = await probeFor(store, "revisioned calibration restore");
    await store.observe(second, answer("stored"));
    await expect(cache(poolB).importCalibration(snapshot)).rejects.toThrow("revision or backend changed");
    expect((await store.calibrationStatus())?.labeled).toBe(2);
    await store.close();
    expect((await cache(poolB).calibrationStatus())?.labeled).toBe(2);
  });
});
