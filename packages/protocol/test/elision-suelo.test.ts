import { describe, it, expect } from "vitest";
import { parseUsageRecord, UsageValidationError } from "@bivelio/protocol";

/** Mirror of apps/web/lib/metering/usage-elision.test.ts: same rules, same outcomes. */
function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: "r1",
    model: "claude-fable-5-1",
    at: 1_700_000_000_000,
    avoidedLlm: 0,
    actualLlm: 1,
    baselineInputTokens: 10_000,
    actualInputTokens: 10_000,
    eliminatedInputTokens: 10_000,
    compressedInputTokens: 0,
    baselineOutputTokens: 80,
    actualOutputTokens: 20,
    providerCachedInputTokens: 0,
    cacheResult: "miss",
    baselineCost: 0.1,
    actualCost: 0.1,
    netSavings: 0,
    ...overrides,
  };
}

describe("eliminatedInputFloorCost — optional, clipped, never mandatory", () => {
  it("absent: the record passes and the field is not set", () => {
    expect("eliminatedInputFloorCost" in parseUsageRecord(validBody(), "org")).toBe(false);
  });
  it("a floor at cache-read price travels intact", () => {
    expect(parseUsageRecord(validBody({ eliminatedInputFloorCost: 0.0025 }), "org")["eliminatedInputFloorCost"]).toBe(0.0025);
  });
  it("negative / NaN / non-number are rejected", () => {
    for (const bad of [-1, Number.NaN, "x"]) {
      expect(() => parseUsageRecord(validBody({ eliminatedInputFloorCost: bad }), "org")).toThrow(UsageValidationError);
    }
  });
  it("money without a count clips to 0; input-rate money clips to the ceiling", () => {
    expect(parseUsageRecord(validBody({ eliminatedInputTokens: 0, eliminatedInputFloorCost: 0.5 }), "org")["eliminatedInputFloorCost"]).toBe(0);
    expect(parseUsageRecord(validBody({ eliminatedInputFloorCost: 0.1 }), "org")["eliminatedInputFloorCost"]).toBe(0.02);
  });
});
