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
  at: 1_800_000_000_000,
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
