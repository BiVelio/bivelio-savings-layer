import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PgCacheBreakpointStore,
  PgExactCache,
  PgSemanticCache,
  type PgPool,
} from "../packages/persistence-postgres/src/index.js";
import { InMemoryExactCache } from "../src/cache/exact.js";
import { canonicalize } from "../src/canonicalization/canonicalize.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { createSavingsLayer } from "../src/pipeline/create.js";
import type { SavingsRequest } from "../src/contracts/types.js";
import { CacheAnthropicSimulada } from "../benchmarks/colocador-de-cache/simulador.js";
import { describeExactCacheConformance } from "./helpers/exact-cache-conformance.js";

const connectionString = process.env.BIVELIO_TEST_POSTGRES_URL;
const describePostgres = describe.skipIf(!connectionString);
const prefix = `sdk-postgres-test-${randomUUID()}`;
const key = (suffix: string) => `${prefix}-${suffix}-${randomUUID()}`;

describeExactCacheConformance("ExactCache conformance: in-memory default", () => new InMemoryExactCache());

describePostgres("PostgreSQL through the real SDK", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString, max: 8, query_timeout: 5_000 });
    for (const file of ["001_exact_and_breakpoints.sql", "002_semantic_cache.sql"]) {
      const migration = await readFile(
        new URL(`../packages/persistence-postgres/sql/${file}`, import.meta.url),
        "utf8",
      );
      await pool.query(migration);
    }
  }, 30_000);

  afterAll(async () => {
    if (pool == null) return;
    await pool.query(
      "DELETE FROM bivelio_savings.exact_cache_entries WHERE cache_key LIKE $1",
      [`${prefix}-%`],
    );
    await pool.query("DELETE FROM bivelio_savings.semantic_calibration_observations WHERE namespace LIKE $1", [`${prefix}%`]);
    await pool.query("DELETE FROM bivelio_savings.semantic_calibrations WHERE namespace LIKE $1", [`${prefix}%`]);
    await pool.query("DELETE FROM bivelio_savings.semantic_cache_records WHERE namespace LIKE $1", [`${prefix}%`]);
    await pool.end();
  }, 30_000);

  describeExactCacheConformance(
    "ExactCache conformance: PostgreSQL",
    () => new PgExactCache({ pool, queryTimeoutMs: 1_000 }),
    key,
  );

  it("serves a reference-valued exact hit through a separate SDK instance", async () => {
    const sim = new CacheAnthropicSimulada(() => Date.now());
    const config = {
      provider: new AnthropicProvider({ fetchImpl: sim.fetch }),
      exactCache: new PgExactCache({ pool, queryTimeoutMs: 1_000 }),
      silenceWarnings: true,
    };
    const firstLayer = createSavingsLayer(config);
    const secondLayer = createSavingsLayer({
      ...config,
      exactCache: new PgExactCache({ pool, queryTimeoutMs: 1_000 }),
    });
    const request = {
      model: "anthropic/claude-sonnet-4-5",
      messages: [{ role: "user", content: key("deterministic-request") }],
      temperature: 0,
    } as SavingsRequest;

    await firstLayer.generate(request);
    const hit = await secondLayer.generate(request);
    expect(hit.text).toBe("ok");
    expect(hit.report.cache.result).toBe("exact");
    expect(hit.report.cost.basis).toBe("reference");
    expect(sim.cuerpos).toHaveLength(1);
    await Promise.all([firstLayer.close(), secondLayer.close()]);
  }, 30_000);

  it("merges breakpoint observations from 24 SDK instances without losing any", async () => {
    const sim = new CacheAnthropicSimulada(() => Date.now());
    const cacheBreakpointStore = new PgCacheBreakpointStore({ pool, queryTimeoutMs: 1_000 });
    const layers = Array.from({ length: 24 }, () => createSavingsLayer({
      provider: new AnthropicProvider({ fetchImpl: sim.fetch }),
      cacheBreakpoints: "auto",
      cacheBreakpointStore,
      silenceWarnings: true,
    }));
    let results: Awaited<ReturnType<(typeof layers)[number]["generate"]>>[];
    try {
      results = await Promise.all(layers.map((layer, index) => layer.generate({
        model: "anthropic/claude-sonnet-4-5",
        messages: [
          { role: "system", content: "Stable synthetic PostgreSQL rules. ".repeat(400) },
          { role: "user", content: `Independent PostgreSQL request ${index}. `.repeat(400) },
        ],
      } as SavingsRequest)));
    } finally {
      await Promise.all(layers.map((layer) => layer.close()));
    }

    const stored = await pool.query(
      `SELECT cache_key, value
       FROM bivelio_savings.breakpoint_measurements
       WHERE cache_key LIKE 'bvsala:cache-breakpoints:v1:%'`,
    );
    expect(stored.rows).toHaveLength(1);
    const row = stored.rows[0]!;
    const final = JSON.parse(row.value as string) as { e: [string, ...unknown[]][] };
    await pool.query(
      "DELETE FROM bivelio_savings.breakpoint_measurements WHERE cache_key = $1",
      [row.cache_key],
    );
    expect(new Set(final.e.map((entry) => entry[0])).size).toBeGreaterThanOrEqual(24);
    expect(results.flatMap((result) => result.report.traces).filter((trace) => trace.outcome === "store-error")).toHaveLength(0);
  }, 30_000);

  it("serves a calibrated semantic hit through a separate SDK instance", async () => {
    const namespace = `${prefix}-semantic-sdk`;
    const options = {
      pool,
      namespace,
      queryTimeoutMs: 1_000,
      calibration: { maxErrorRate: 0.5, confidence: 0.9, auditRate: 0 },
    };
    const sim = new CacheAnthropicSimulada(() => Date.now());
    const provider = new AnthropicProvider({ fetchImpl: sim.fetch });
    const original = {
      model: "anthropic/claude-sonnet-4-5",
      messages: [{ role: "user", content: "summarize the quarterly report for the board" }],
      context: { tenantId: "synthetic-tenant", sessionId: "synthetic-person" },
      temperature: 0,
    } as SavingsRequest;
    const reworded = {
      ...original,
      messages: [{ role: "user", content: "please summarize the quarterly report for the board" }],
    } as SavingsRequest;
    const firstLayer = createSavingsLayer({
      provider,
      semanticCacheStore: new PgSemanticCache(options),
      semanticCacheDefault: true,
      silenceWarnings: true,
    });
    const fresh = await firstLayer.generate(original);
    await firstLayer.close();

    const semantic = new PgSemanticCache(options);
    const canonical = canonicalize(reworded);
    for (let index = 0; index < 40; index++) {
      const current = await semantic.lookup(canonical);
      if (current.hit) break;
      expect(current.probe).not.toBeNull();
      expect(await semantic.observe(current.probe!, { text: fresh.text, storedAtMs: 0 })).toBe(true);
    }
    expect((await semantic.lookup(canonical)).hit).not.toBeNull();

    const secondLayer = createSavingsLayer({
      provider,
      semanticCacheStore: new PgSemanticCache(options),
      semanticCacheDefault: true,
      silenceWarnings: true,
    });
    const hit = await secondLayer.generate(reworded);
    expect(hit.text).toBe("ok");
    expect(hit.report.cache.result).toBe("semantic");
    expect(sim.cuerpos).toHaveLength(1);
    await Promise.all([secondLayer.close(), semantic.close()]);
  }, 30_000);
});

describe("PostgreSQL timeouts through the real SDK", () => {
  const stalledPool: PgPool = {
    query: () => new Promise(() => undefined),
    connect: async () => ({
      query: () => new Promise(() => undefined),
      release: () => undefined,
    }),
    end: async () => undefined,
  };

  it("fails open to one provider call when the exact store stalls", async () => {
    const sim = new CacheAnthropicSimulada(() => Date.now());
    const exactCache = new PgExactCache({ pool: stalledPool, queryTimeoutMs: 10 });
    const layer = createSavingsLayer({
      provider: new AnthropicProvider({ fetchImpl: sim.fetch }),
      exactCache,
      silenceWarnings: true,
    });
    const start = Date.now();
    const result = await layer.generate({
      model: "anthropic/claude-sonnet-4-5",
      messages: [{ role: "user", content: "synthetic timeout probe" }],
      temperature: 0,
    } as SavingsRequest);

    expect(result.text).toBe("ok");
    expect(sim.cuerpos).toHaveLength(1);
    expect(result.report.cache.result).toBe("miss");
    expect(Date.now() - start).toBeLessThan(1_000);
    await layer.close();
  });

  it("uses fixed placement and does not record learning when breakpoints stall", async () => {
    const sim = new CacheAnthropicSimulada(() => Date.now());
    const cacheBreakpointStore = new PgCacheBreakpointStore({ pool: stalledPool, queryTimeoutMs: 10 });
    const layer = createSavingsLayer({
      provider: new AnthropicProvider({ fetchImpl: sim.fetch }),
      cacheBreakpoints: "auto",
      cacheBreakpointStore,
      silenceWarnings: true,
    });
    const start = Date.now();
    const result = await layer.generate({
      model: "anthropic/claude-sonnet-4-5",
      messages: [
        { role: "system", content: "Stable synthetic rules. ".repeat(400) },
        { role: "user", content: "synthetic timeout probe" },
      ],
    } as SavingsRequest);

    expect(result.text).toBe("ok");
    expect(sim.cuerpos).toHaveLength(1);
    expect(Date.now() - start).toBeLessThan(1_000);
    const traces = result.report.traces.filter((trace) => trace.stage === "prefix-cache-placement");
    expect(traces.some((trace) => trace.detail?.["mirrorStore"] === "unavailable")).toBe(true);
    expect(traces.some((trace) => trace.outcome === "store-error")).toBe(true);
    await layer.close();
  });

  it("fails open to one provider call when the semantic transaction stalls", async () => {
    const sim = new CacheAnthropicSimulada(() => Date.now());
    const semanticCacheStore = new PgSemanticCache({
      pool: stalledPool,
      namespace: `${prefix}-stalled-semantic`,
      queryTimeoutMs: 10,
      calibration: { maxErrorRate: 0.5, confidence: 0.9, auditRate: 0 },
    });
    const layer = createSavingsLayer({
      provider: new AnthropicProvider({ fetchImpl: sim.fetch }),
      semanticCacheStore,
      semanticCacheDefault: true,
      silenceWarnings: true,
    });
    const start = Date.now();
    const result = await layer.generate({
      model: "anthropic/claude-sonnet-4-5",
      messages: [{ role: "user", content: "synthetic semantic timeout probe" }],
      temperature: 0,
    } as SavingsRequest);

    expect(result.text).toBe("ok");
    expect(sim.cuerpos).toHaveLength(1);
    expect(result.report.cache.result).toBe("miss");
    expect(Date.now() - start).toBeLessThan(1_000);
    await layer.close();
  });
});
