import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { canonicalize } from "../../../src/canonicalization/canonicalize.js";
import type { SavingsRequest } from "../../../src/contracts/types.js";
import {
  DEFAULT_QUERY_TIMEOUT_MS,
  PgCacheBreakpointStore,
  PgExactCache,
  PgSemanticCache,
  type PgPoolClient,
} from "../src/index.js";
import { FakePool, rows } from "./fake-pool.js";

describe("shared PostgreSQL behavior", () => {
  it("has a conservative default query timeout", () => {
    expect(DEFAULT_QUERY_TIMEOUT_MS).toBeLessThanOrEqual(250);
  });

  it("requires exactly one pool source", () => {
    expect(() => new PgExactCache({})).toThrow("exactly one");
    expect(() => new PgExactCache({
      pool: new FakePool(() => rows([])),
      connectionString: "postgresql://invalid.test/database",
    })).toThrow("exactly one");
  });

  it("bounds the await when a query never resolves", async () => {
    const pool = new FakePool(() => new Promise(() => undefined));
    const cache = new PgExactCache({ pool, queryTimeoutMs: 5 });

    await expect(cache.get("key")).rejects.toThrow("timed out after 5 ms");
  });

  it("keeps the timeout alive in an otherwise idle process", () => {
    const modulePath = JSON.stringify(fileURLToPath(new URL("../src/index.ts", import.meta.url)));
    const root = fileURLToPath(new URL("../../..", import.meta.url));
    const result = spawnSync(process.execPath, [
      "--import", "tsx", "--input-type=module", "--eval",
      `import { PgExactCache } from ${modulePath};
       const cache = new PgExactCache({ pool: { query: () => new Promise(() => undefined), end: async () => undefined }, queryTimeoutMs: 20 });
       await cache.get("key").then(() => { throw new Error("expected timeout"); }, (error) => {
         if (!error.message.includes("timed out after 20 ms")) throw error;
         console.log("timeout-observed");
       });`,
    ], { cwd: root, encoding: "utf8", timeout: 5_000 });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("timeout-observed");
  });

  it("propagates a query rejection before the timeout", async () => {
    const failure = new Error("query failed");
    const pool = new FakePool(() => Promise.reject(failure));
    const cache = new PgExactCache({ pool, queryTimeoutMs: 1_000 });

    await expect(cache.get("key")).rejects.toBe(failure);
  });

  it("does not release a transaction client while its query is pending", async () => {
    let rejectQuery: ((reason?: unknown) => void) | undefined;
    const release = vi.fn();
    const client: PgPoolClient = {
      query: ((text: string) => {
        if (text === "ROLLBACK") return rows([]);
        return new Promise((_, reject) => { rejectQuery = reject; });
      }) as PgPoolClient["query"],
      release,
    };
    const pool = new FakePool(() => rows([]));
    pool.connect = async () => client;
    const cache = new PgSemanticCache({
      pool,
      namespace: "transaction-cleanup",
      candidateLimit: 33,
      queryTimeoutMs: 5,
      calibration: { maxErrorRate: 0.5 },
    });
    const request = canonicalize({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "transaction timeout" }],
    } as SavingsRequest);

    await expect(cache.lookup(request)).rejects.toThrow("timed out after 5 ms");
    expect(release).not.toHaveBeenCalled();
    rejectQuery!(new Error("socket closed"));
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
  });

  it("does not close an injected pool", async () => {
    const pool = new FakePool(() => rows([]));
    const cache = new PgExactCache({ pool });
    const breakpoints = new PgCacheBreakpointStore({ pool });

    await cache.close();
    await breakpoints.close();
    expect(pool.end).not.toHaveBeenCalled();
  });

  it("closes only its own pool and makes close idempotent", async () => {
    const cache = new PgExactCache({
      connectionString: "postgresql://invalid.test/database",
    });

    await cache.close();
    await expect(cache.close()).resolves.toBeUndefined();
  });
});
