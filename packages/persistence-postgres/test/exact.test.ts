import { describe, expect, it } from "vitest";
import { PgExactCache, type CachedAnswer } from "../src/index.js";
import { compactSql, FakePool, rows } from "./fake-pool.js";

const answer: CachedAnswer = {
  text: "respuesta",
  data: { nested: [1, true, null] },
  rendered: "<p>respuesta</p>",
  storedAtMs: 1_700_000_000_000,
  meta: { reference: "provider-call-1" },
};

describe("PgExactCache", () => {
  it("returns null on a miss and deletes expired rows while reading", async () => {
    const pool = new FakePool(() => rows([]));
    const cache = new PgExactCache({ pool });

    await expect(cache.get("missing")).resolves.toBeNull();
    expect(pool.calls).toHaveLength(1);
    const sql = compactSql(pool.calls[0]!.text);
    expect(sql).toContain("DELETE FROM bivelio_savings.exact_cache_entries");
    expect(sql).toContain("> expires_at_ms");
    expect(sql).toContain("expires_at_ms >=");
  });

  it("returns a fresh validated object on every read", async () => {
    const stored = JSON.parse(JSON.stringify(answer)) as CachedAnswer;
    const pool = new FakePool(() => rows([{ value: stored }]));
    const cache = new PgExactCache({ pool });

    const first = await cache.get("key");
    expect(first).toEqual(answer);
    expect(first).not.toBe(stored);
    first!.meta!.reference = "mutated";
    (first!.data as { nested: unknown[] }).nested.push("mutated");

    const second = await cache.get("key");
    expect(second).toEqual(answer);
  });

  it("serializes a defensive copy and uses null for an absent TTL", async () => {
    const pool = new FakePool(() => rows([]));
    const cache = new PgExactCache({ pool });
    const input = JSON.parse(JSON.stringify(answer)) as CachedAnswer;

    await cache.set("key", input);
    input.text = "mutated";
    input.meta!.reference = "mutated";

    const call = pool.calls[0]!;
    expect(call.values[0]).toBe("key");
    expect(call.values[2]).toBeNull();
    expect(JSON.parse(call.values[1] as string)).toEqual(answer);
    expect(call.text).toContain("$2::jsonb");
  });

  it("passes a numeric TTL to the database clock expression", async () => {
    const pool = new FakePool(() => rows([]));
    const cache = new PgExactCache({ pool });

    await cache.set("key", answer, 1_500);
    expect(pool.calls[0]!.values[2]).toBe(1_500);
    expect(pool.calls[0]!.text).toContain("clock_timestamp()");
  });

  it.each([
    ["bigint", { ...answer, data: { value: 1n } }],
    ["undefined", { ...answer, data: { value: undefined } }],
    ["non-finite number", { ...answer, data: { value: Number.NaN } }],
  ])("rejects non-JSON input containing %s", async (_name, value) => {
    const pool = new FakePool(() => rows([]));
    const cache = new PgExactCache({ pool });

    await expect(cache.set("key", value)).rejects.toThrow(/JSON|finite/);
    expect(pool.calls).toHaveLength(0);
  });

  it("rejects cycles before querying", async () => {
    const pool = new FakePool(() => rows([]));
    const cache = new PgExactCache({ pool });
    const cyclic = { ...answer, data: {} as { self?: unknown } };
    cyclic.data.self = cyclic.data;

    await expect(cache.set("key", cyclic)).rejects.toThrow("cycle");
    expect(pool.calls).toHaveLength(0);
  });

  it("rejects malformed stored answers instead of serving them", async () => {
    const pool = new FakePool(() => rows([{ value: { text: 42, storedAtMs: 1 } }]));
    const cache = new PgExactCache({ pool });

    await expect(cache.get("key")).rejects.toThrow("CachedAnswer");
  });

  it("deletes one key and explicitly purges expired entries", async () => {
    const pool = new FakePool((text) => rows([], text.includes("expires_at_ms") ? 3 : 1));
    const cache = new PgExactCache({ pool });

    await cache.delete("key");
    await expect(cache.purgeExpired()).resolves.toBe(3);
    expect(compactSql(pool.calls[0]!.text)).toBe(
      "DELETE FROM bivelio_savings.exact_cache_entries WHERE cache_key = $1",
    );
    expect(pool.calls[1]!.text).toContain("> expires_at_ms");
  });

  it("propagates database errors", async () => {
    const failure = new Error("database unavailable");
    const pool = new FakePool(() => Promise.reject(failure));
    const cache = new PgExactCache({ pool });

    await expect(cache.get("key")).rejects.toBe(failure);
  });
});
