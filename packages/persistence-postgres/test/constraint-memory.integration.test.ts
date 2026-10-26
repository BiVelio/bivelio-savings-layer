import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createSavingsLayer } from "../../../src/pipeline/create.js";
import type { ConstraintMemoryStore } from "../../../src/constraints/memory.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../../../src/providers/types.js";
import type { SavingsRequest } from "../../../src/contracts/types.js";
import { PgConstraintMemoryStore } from "../src/index.js";

const connectionString = process.env.BIVELIO_TEST_POSTGRES_URL;
const describePostgres = describe.skipIf(!connectionString);
let pool: Pool;

class SpyProvider implements Provider {
  readonly enviados: ProviderRequest[] = [];
  constructor(readonly id: string, private readonly responses: string[]) {}
  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    this.enviados.push(request);
    return {
      text: this.responses[Math.min(this.enviados.length - 1, this.responses.length - 1)]!,
      finishReason: "stop",
      usage: { inputTokens: 60, outputTokens: 18 },
    };
  }
}

const valid = JSON.stringify({ answer: "30 días" });
const tooLong = JSON.stringify({ answer: "x".repeat(80) });
const hasHint = (request: ProviderRequest) => request.messages.some((message) => message.content.includes("JSON limits"));

function request(contractId: string, overrides: Partial<SavingsRequest> = {}): SavingsRequest {
  return {
    model: "openai/gpt-4o-mini",
    messages: [{ role: "user", content: "¿Cuántos días dura la ventana de reembolso?" }],
    response: {
      contractId,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["answer"],
        properties: { answer: { type: "string", maxLength: 40 } },
      },
    },
    context: { tenantId: "tenant-a", authorizationScope: "reader", sessionId: "person-a" },
    savings: { exactCache: false },
    ...overrides,
  } as SavingsRequest;
}

describePostgres("PgConstraintMemoryStore and SDK recovery", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString, max: 8, query_timeout: 5_000 });
    for (const file of ["001_exact_and_breakpoints.sql", "002_semantic_cache.sql", "003_constraint_memory.sql"]) {
      const sql = await readFile(new URL(`../sql/${file}`, import.meta.url), "utf8");
      await pool.query(sql);
      await pool.query(sql);
    }
  }, 30_000);

  beforeEach(async () => {
    await pool.query("DELETE FROM bivelio_savings.constraint_value_hints");
  });

  afterAll(async () => {
    if (pool == null) return;
    await pool.query("DELETE FROM bivelio_savings.constraint_value_hints");
    await pool.end();
  }, 30_000);

  it("shares idempotent hints without storing contract text", async () => {
    const store = new PgConstraintMemoryStore({ pool, queryTimeoutMs: 1_000 });
    const key = randomUUID().replaceAll("-", "").repeat(2);
    expect(await store.has(key)).toBe(false);
    await Promise.all(Array.from({ length: 32 }, () => store.remember(key)));
    expect(await store.has(key)).toBe(true);
    const rows = await pool.query("SELECT memory_key, created_at_ms FROM bivelio_savings.constraint_value_hints");
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.memory_key).toMatch(/^[a-f0-9]{64}$/);
    expect(Number(rows.rows[0]?.created_at_ms)).toBeGreaterThan(0);
    expect(JSON.stringify(rows.rows)).not.toContain("aviso:v1");
  });

  it("gives a second SDK instance the hint on its first request, with hard identity isolation", async () => {
    const store = new PgConstraintMemoryStore({ pool, queryTimeoutMs: 1_000 });
    const contractId = `recovery-${randomUUID()}`;
    const firstProvider = new SpyProvider("provider-a", [tooLong, valid]);
    const firstLayer = createSavingsLayer({ provider: firstProvider, constraintMemoryStore: store, devUnlicensed: true });
    await firstLayer.generate(request(contractId));
    expect(firstProvider.enviados).toHaveLength(2);

    const secondProvider = new SpyProvider("provider-a", [valid]);
    const secondLayer = createSavingsLayer({ provider: secondProvider, constraintMemoryStore: store, devUnlicensed: true });
    await secondLayer.generate(request(contractId));
    expect(secondProvider.enviados).toHaveLength(1);
    expect(hasHint(secondProvider.enviados[0]!)).toBe(true);

    for (const test of [
      { id: "provider-a", overrides: { context: { tenantId: "tenant-b", authorizationScope: "reader", sessionId: "person-a" } } },
      { id: "provider-a", overrides: { context: { tenantId: "tenant-a", authorizationScope: "admin", sessionId: "person-a" } } },
      { id: "provider-b", overrides: {} },
      { id: "provider-a", overrides: { model: "openai/gpt-4o" } },
    ]) {
      const provider = new SpyProvider(test.id, [valid]);
      const layer = createSavingsLayer({ provider, constraintMemoryStore: store, devUnlicensed: true });
      await layer.generate(request(contractId, test.overrides));
      expect(hasHint(provider.enviados[0]!)).toBe(false);
    }
  }, 30_000);

  it("composes the legacy Set with the store and avoids DB work on local hits", async () => {
    const contractId = `legacy-${randomUUID()}`;
    const legacy = new Set([contractId]);
    let reads = 0;
    const store: ConstraintMemoryStore = {
      has: async () => { reads++; throw new Error("must not read"); },
      remember: async () => undefined,
    };
    const provider = new SpyProvider("provider-a", [valid]);
    const layer = createSavingsLayer({ provider, constraintMemory: legacy, constraintMemoryStore: store, devUnlicensed: true });
    await layer.generate(request(contractId));
    expect(hasHint(provider.enviados[0]!)).toBe(true);
    expect(reads).toBe(0);
  });

  it("does no store work without a response contract", async () => {
    let operations = 0;
    const store: ConstraintMemoryStore = {
      has: async () => { operations++; return false; },
      remember: async () => { operations++; },
    };
    const provider = new SpyProvider("provider-a", ["plain answer"]);
    const layer = createSavingsLayer({ provider, constraintMemoryStore: store, devUnlicensed: true });
    await layer.generate({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "plain" }] });
    expect(operations).toBe(0);
  });

  it("fails a stalled read open to one provider call", async () => {
    const store: ConstraintMemoryStore = {
      has: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw new Error("stalled");
      },
      remember: async () => undefined,
    };
    const provider = new SpyProvider("provider-a", [valid]);
    const layer = createSavingsLayer({ provider, constraintMemoryStore: store, devUnlicensed: true });
    const result = await layer.generate(request(`read-timeout-${randomUUID()}`));
    expect(provider.enviados).toHaveLength(1);
    expect(result.data).toEqual({ answer: "30 días" });
    expect(result.report.traces.some((trace) =>
      trace.stage === "constraint-memory" && trace.outcome === "store-error" && trace.detail?.["operation"] === "read",
    )).toBe(true);
  });

  it("keeps a stalled write local and never adds a fail-open or extra repair", async () => {
    const store: ConstraintMemoryStore = {
      has: async () => false,
      remember: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw new Error("stalled");
      },
    };
    const provider = new SpyProvider("provider-a", [tooLong, valid, valid]);
    const layer = createSavingsLayer({ provider, constraintMemoryStore: store, devUnlicensed: true });
    const contractId = `write-timeout-${randomUUID()}`;
    const first = await layer.generate(request(contractId));
    expect(provider.enviados).toHaveLength(2);
    expect(first.report.traces.some((trace) =>
      trace.stage === "constraint-memory" && trace.outcome === "store-error" && trace.detail?.["operation"] === "write",
    )).toBe(true);

    await layer.generate(request(contractId));
    expect(provider.enviados).toHaveLength(3);
    expect(hasHint(provider.enviados[2]!)).toBe(true);
  });

  it("rolls back to process memory by removing the store", async () => {
    const provider = new SpyProvider("provider-a", [tooLong, valid, valid]);
    const layer = createSavingsLayer({ provider, devUnlicensed: true });
    const contractId = `memory-rollback-${randomUUID()}`;
    await layer.generate(request(contractId));
    await layer.generate(request(contractId));
    expect(provider.enviados).toHaveLength(3);
    expect(hasHint(provider.enviados[2]!)).toBe(true);
  });
});
