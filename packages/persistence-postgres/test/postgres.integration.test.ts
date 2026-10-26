import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgCacheBreakpointStore, PgExactCache } from "../src/index.js";

const connectionString = process.env.BIVELIO_TEST_POSTGRES_URL;
const describePostgres = describe.skipIf(!connectionString);
const prefix = `persistence-test-${randomUUID()}`;
const timeout = 30_000;

let poolA: Pool;
let poolB: Pool;

function key(name: string): string {
  return `${prefix}-${name}`;
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describePostgres("PostgreSQL integration (set BIVELIO_TEST_POSTGRES_URL to enable)", () => {
  beforeAll(async () => {
    poolA = new Pool({ connectionString, max: 8, query_timeout: 5_000 });
    poolB = new Pool({ connectionString, max: 8, query_timeout: 5_000 });
    const migration = await readFile(
      new URL("../sql/001_exact_and_breakpoints.sql", import.meta.url),
      "utf8",
    );
    await poolA.query(migration);
    await poolA.query(migration);
  }, timeout);

  afterAll(async () => {
    if (poolA == null) return;
    await poolA.query(
      "DELETE FROM bivelio_savings.exact_cache_entries WHERE cache_key LIKE $1",
      [`${prefix}-%`],
    );
    await poolA.query(
      "DELETE FROM bivelio_savings.breakpoint_measurements WHERE cache_key LIKE $1",
      [`${prefix}-%`],
    );
    await Promise.all([poolA.end(), poolB.end()]);
  }, timeout);

  it("shares exact values across pools and isolates caller mutations", async () => {
    const cacheA = new PgExactCache({ pool: poolA, queryTimeoutMs: 5_000 });
    const cacheB = new PgExactCache({ pool: poolB, queryTimeoutMs: 5_000 });
    const cacheKey = key("copies");
    const original = {
      text: "synthetic answer",
      data: { items: ["one"] },
      rendered: "synthetic answer",
      storedAtMs: Date.now(),
      meta: { reference: "synthetic-reference" },
    };

    await cacheA.set(cacheKey, original);
    original.data.items.push("caller mutation");
    const first = await cacheB.get<typeof original.data>(cacheKey);
    expect(first).toEqual({
      ...original,
      data: { items: ["one"] },
      meta: { reference: "synthetic-reference" },
    });
    first!.data!.items.push("reader mutation");
    expect((await cacheA.get(cacheKey))!.data).toEqual({ items: ["one"] });
  }, timeout);

  it("expires exact entries but preserves breakpoint versions", async () => {
    const cache = new PgExactCache({ pool: poolA, queryTimeoutMs: 5_000 });
    const breakpoints = new PgCacheBreakpointStore({ pool: poolB, queryTimeoutMs: 5_000 });
    const exactKey = key("exact-ttl");
    const breakpointKey = key("breakpoint-ttl");

    await cache.set(exactKey, { text: "short lived", storedAtMs: Date.now() }, 30);
    await breakpoints.set(breakpointKey, "first", 30);
    await wait(80);

    expect(await cache.get(exactKey)).toBeNull();
    expect(await breakpoints.get(breakpointKey)).toBeNull();
    expect(await breakpoints.getVersioned(breakpointKey)).toEqual({
      value: null,
      version: "1",
    });
    expect(await breakpoints.compareAndSet(breakpointKey, "not inserted", 1_000, null)).toBe(false);
    expect(await breakpoints.compareAndSet(breakpointKey, "second", 1_000, "1")).toBe(true);
    expect(await breakpoints.getVersioned(breakpointKey)).toEqual({ value: "second", version: "2" });
  }, timeout);

  it("handles 32 concurrent exact writes across two pools", async () => {
    const caches = Array.from({ length: 32 }, (_, index) => new PgExactCache({
      pool: index % 2 === 0 ? poolA : poolB,
      queryTimeoutMs: 5_000,
    }));

    await Promise.all(caches.map((cache, index) => cache.set(
      key(`exact-${index}`),
      { text: `value-${index}`, data: { index }, storedAtMs: index },
    )));
    const values = await Promise.all(caches.map((cache, index) => cache.get(key(`exact-${index}`))));
    expect(values.map((value) => value?.data)).toEqual(
      Array.from({ length: 32 }, (_, index) => ({ index })),
    );
  }, timeout);

  it("keeps contended writes to the same exact key valid", async () => {
    const cacheKey = key("same-exact-key");
    const caches = Array.from({ length: 32 }, (_, index) => new PgExactCache({
      pool: index % 2 === 0 ? poolA : poolB,
      queryTimeoutMs: 5_000,
    }));

    await Promise.all(caches.map((cache, index) => cache.set(
      cacheKey,
      { text: `value-${index}`, data: { index }, storedAtMs: index },
    )));
    const final = await caches[0]!.get<{ index: number }>(cacheKey);
    expect(final?.text).toBe(`value-${final.data?.index}`);
    expect(final?.data?.index).toBeGreaterThanOrEqual(0);
    expect(final?.data?.index).toBeLessThan(32);
    const copies = await Promise.all(caches.map((cache) => cache.get<{ index: number }>(cacheKey)));
    expect(copies.every((value) => value?.text === `value-${value.data?.index}`)).toBe(true);
  }, timeout);

  it("retains every CAS increment from 24 concurrent clients", async () => {
    const counterKey = key("counter");
    const clients = Array.from({ length: 24 }, (_, index) => new PgCacheBreakpointStore({
      pool: index % 2 === 0 ? poolA : poolB,
      queryTimeoutMs: 5_000,
    }));

    await Promise.all(clients.map(async (client) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const current = await client.getVersioned(counterKey);
        const currentValue = current?.value;
        const count = currentValue == null
          ? 0
          : (JSON.parse(currentValue as string) as { count: number }).count;
        const next = JSON.stringify({ count: count + 1 });
        if (await client.compareAndSet(counterKey, next, 60_000, current?.version ?? null)) return;
      }
      throw new Error("CAS retry limit reached");
    }));

    const final = await clients[0]!.getVersioned(counterKey);
    expect(JSON.parse(final!.value as string)).toEqual({ count: 24 });
    expect(final!.version).toBe("24");
    expect(BigInt(final!.version)).toBe(24n);
  }, timeout);
});
