import { describe, expect, it } from "vitest";
import { PgCacheBreakpointStore } from "../src/index.js";
import { compactSql, FakePool, rows } from "./fake-pool.js";

describe("PgCacheBreakpointStore", () => {
  it("returns null for absent or expired values without deleting them", async () => {
    const pool = new FakePool(() => rows([]));
    const store = new PgCacheBreakpointStore({ pool });

    await expect(store.get("key")).resolves.toBeNull();
    expect(pool.calls[0]!.text).toContain("expires_at_ms >=");
    expect(pool.calls[0]!.text).not.toContain("DELETE");
  });

  it("preserves bigint version tokens beyond the JS safe integer range", async () => {
    const pool = new FakePool(() => rows([
      { value: "measurement", version: "9007199254740993", live: true },
    ]));
    const store = new PgCacheBreakpointStore({ pool });

    await expect(store.getVersioned("key")).resolves.toEqual({
      value: "measurement",
      version: "9007199254740993",
    });
  });

  it("returns a null value and the existing version for an expired row", async () => {
    const pool = new FakePool(() => rows([
      { value: "old", version: 7, live: false },
    ]));
    const store = new PgCacheBreakpointStore({ pool });

    await expect(store.getVersioned("key")).resolves.toEqual({ value: null, version: "7" });
  });

  it("returns null for an absent versioned row", async () => {
    const pool = new FakePool(() => rows([]));
    const store = new PgCacheBreakpointStore({ pool });

    await expect(store.getVersioned("key")).resolves.toBeNull();
  });

  it("uses traditional upsert and increments versions on set", async () => {
    const pool = new FakePool(() => rows([]));
    const store = new PgCacheBreakpointStore({ pool });

    await store.set("key", "measurement", 5_000);
    const sql = compactSql(pool.calls[0]!.text);
    expect(sql).toContain("ON CONFLICT (cache_key) DO UPDATE SET");
    expect(sql).toContain("version = bivelio_savings.breakpoint_measurements.version + 1");
    expect(pool.calls[0]!.values).toEqual(["key", "measurement", 5_000]);
  });

  it("CAS with null expected version only inserts a nonexistent row", async () => {
    const pool = new FakePool(() => rows([]));
    const store = new PgCacheBreakpointStore({ pool });

    await expect(store.compareAndSet("key", "value", 1_000, null)).resolves.toBe(false);
    const sql = compactSql(pool.calls[0]!.text);
    expect(sql).toContain("ON CONFLICT (cache_key) DO NOTHING RETURNING version");
    expect(sql).not.toContain("DO UPDATE");
  });

  it("CAS with a token only updates that exact version", async () => {
    const pool = new FakePool(() => rows([{ version: "10" }]));
    const store = new PgCacheBreakpointStore({ pool });

    await expect(store.compareAndSet("key", "value", 1_000, "9")).resolves.toBe(true);
    const sql = compactSql(pool.calls[0]!.text);
    expect(sql).toContain("UPDATE bivelio_savings.breakpoint_measurements");
    expect(sql).toContain("WHERE cache_key = $1 AND version = $4::bigint");
    expect(sql).not.toContain("INSERT");
    expect(pool.calls[0]!.values).toEqual(["key", "value", 1_000, "9"]);
  });

  it("does not treat an expired row as absent for insert CAS", async () => {
    const pool = new FakePool(() => rows([]));
    const store = new PgCacheBreakpointStore({ pool });

    await store.compareAndSet("key", "value", 1_000, null);
    expect(pool.calls[0]!.text).not.toContain("expires_at_ms <=");
    expect(pool.calls[0]!.text).not.toContain("DELETE");
  });

  it("rejects malformed version tokens before querying", async () => {
    const pool = new FakePool(() => rows([]));
    const store = new PgCacheBreakpointStore({ pool });

    await expect(store.compareAndSet("key", "value", 1_000, "1; DROP TABLE x"))
      .rejects.toThrow("expectedVersion");
    expect(pool.calls).toHaveLength(0);
  });

  it("propagates database errors", async () => {
    const failure = new Error("connection reset");
    const pool = new FakePool(() => Promise.reject(failure));
    const store = new PgCacheBreakpointStore({ pool });

    await expect(store.getVersioned("key")).rejects.toBe(failure);
  });
});
