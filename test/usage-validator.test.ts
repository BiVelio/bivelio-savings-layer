import { describe, it, expect } from "vitest";

import { parseUsageRecord, parseUsageRecords, UsageValidationError } from "../apps/web/lib/metering/usage.js";

/**
 * The metering ingest's content backstop. This is a privacy-critical invariant:
 * the control plane must accept ONLY counts/metadata, never a prompt/completion.
 */
const clean = {
  requestId: "req_123",
  model: "openai/gpt-4o-mini",
  cacheResult: "miss",
  seatId: "bvk_ab12:9f3c",
  ci: false,
  at: Date.now(),
  avoidedLlm: 0,
  actualLlm: 1,
  baselineInputTokens: 100,
  actualInputTokens: 40,
  eliminatedInputTokens: 60,
  compressedInputTokens: 0,
  baselineOutputTokens: 20,
  actualOutputTokens: 20,
  providerCachedInputTokens: 0,
  baselineCost: 0.001,
  actualCost: 0.0004,
  netSavings: 0.0006,
};

describe("usage ingest content backstop", () => {
  it("accepts a clean counts-only record and server-derives orgId", () => {
    const r = parseUsageRecord(clean, "org-server-derived");
    expect(r.orgId).toBe("org-server-derived");
    expect(r.seatId).toBe("bvk_ab12:9f3c");
    expect(r.ci).toBe(false);
  });

  it("REJECTS any content field (prompt/completion/messages) — the privacy invariant", () => {
    for (const bad of ["prompt", "completion", "messages", "text", "input"]) {
      expect(() => parseUsageRecord({ ...clean, [bad]: "secret user content" }, "o")).toThrow(UsageValidationError);
    }
  });

  it("ignores a client-supplied orgId — it is always server-derived", () => {
    const r = parseUsageRecord({ ...clean, orgId: "other-tenant" }, "my-org");
    expect(r.orgId).toBe("my-org");
  });

  it("constrains seatId/model/requestId to the identity charset (no free-text channel)", () => {
    expect(() => parseUsageRecord({ ...clean, seatId: "has spaces and 💬" }, "o")).toThrow(UsageValidationError);
    expect(() => parseUsageRecord({ ...clean, requestId: "a".repeat(200) }, "o")).toThrow(UsageValidationError);
  });

  it("rejects a non-finite number and a bad cacheResult enum", () => {
    expect(() => parseUsageRecord({ ...clean, actualCost: Number.NaN }, "o")).toThrow(UsageValidationError);
    expect(() => parseUsageRecord({ ...clean, cacheResult: "totally-made-up" }, "o")).toThrow(UsageValidationError);
  });

  it("rejects an oversized batch", () => {
    expect(() => parseUsageRecords(new Array(1001).fill(clean), "o")).toThrow(/batch too large/);
  });
});

/**
 * Dominio de los datos, no solo su tipo. El validador solo exigía
 * `Number.isFinite`, así que dejaba entrar dos clases de basura que luego
 * corrompen los agregados sin dejar rastro.
 */
describe("usage ingest — dominio de los números", () => {
  const base = () => ({ ...clean, at: Date.now() });

  it("rechaza `at` en SEGUNDOS (el desliz de unidad que fechaba todo en 1970)", () => {
    const enSegundos = Math.floor(Date.now() / 1000);
    expect(() => parseUsageRecord({ ...base(), at: enSegundos }, "org")).toThrow(/out of range|MILLISECONDS/i);
  });

  it("rechaza `at` muy en el futuro (reloj del cliente desbocado)", () => {
    expect(() => parseUsageRecord({ ...base(), at: Date.now() + 30 * 86_400_000 }, "org")).toThrow(/out of range/i);
  });

  it("acepta un desfase de reloj razonable", () => {
    expect(() => parseUsageRecord({ ...base(), at: Date.now() + 60_000 }, "org")).not.toThrow();
  });

  it("rechaza recuentos negativos (restaban de los agregados)", () => {
    for (const campo of ["actualInputTokens", "baselineCost", "avoidedLlm"]) {
      expect(() => parseUsageRecord({ ...base(), [campo]: -5 }, "org")).toThrow(/must be >= 0/i);
    }
  });

  it("rechaza un netSavings imposible (> 1) pero ACEPTA uno negativo", () => {
    // Una petición puede salir más cara que la ingenua: eso es una pérdida real
    // y tiene que poder registrarse. Lo que no existe es ahorrar más del 100%.
    expect(() => parseUsageRecord({ ...base(), netSavings: 1.5 }, "org")).toThrow(/ratio in/i);
    expect(() => parseUsageRecord({ ...base(), netSavings: -0.25 }, "org")).not.toThrow();
  });
});
