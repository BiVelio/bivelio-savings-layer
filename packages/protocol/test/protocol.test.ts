import { describe, it, expect } from "vitest";
import {
  parseUsageRecord,
  parseUsageRecords,
  usageRecordFromReport,
  UsageValidationError,
  type SavingsReportLike,
} from "@bivelio/protocol";

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: "r1",
    model: "openai/gpt-4o-mini",
    at: 1_700_000_000_000,
    avoidedLlm: 0,
    actualLlm: 1,
    baselineInputTokens: 100,
    actualInputTokens: 60,
    eliminatedInputTokens: 0,
    compressedInputTokens: 40,
    baselineOutputTokens: 80,
    actualOutputTokens: 20,
    providerCachedInputTokens: 0,
    cacheResult: "miss",
    baselineCost: 0.001,
    actualCost: 0.0004,
    netSavings: 0.6,
    ...overrides,
  };
}

describe("privacy backstop — parseUsageRecord", () => {
  it("accepts a well-formed record and derives orgId from the server, not the client", () => {
    // Client tries to claim orgId 'victim'; the server-derived org must win.
    const rec = parseUsageRecord(validBody({ orgId: "victim" }), "authed-org");
    expect(rec.orgId).toBe("authed-org");
    expect(rec.actualInputTokens).toBe(60);
  });

  it("REJECTS any content field so a prompt/completion can never cross the boundary", () => {
    for (const leak of ["prompt", "completion", "messages", "text", "input", "output", "content"]) {
      expect(() => parseUsageRecord(validBody({ [leak]: "secret user data" }), "org")).toThrow(
        UsageValidationError,
      );
    }
  });

  it("rejects unknown fields even when they look innocuous", () => {
    expect(() => parseUsageRecord(validBody({ note: "hi" }), "org")).toThrow(/disallowed field "note"/);
  });

  it("closes the VALUE channel — content cannot hide in an allowlisted string field", () => {
    // cacheResult is a closed enum: free text (a smuggled prompt) is rejected.
    expect(() => parseUsageRecord(validBody({ cacheResult: "USER PROMPT: SSN 123-45-6789 ..." }), "org")).toThrow(
      /cacheResult/,
    );
    expect(() => parseUsageRecord(validBody({ cacheResult: "hit" }), "org")).toThrow(/cacheResult/);
    // identity fields are charset+length capped: spaces/newlines/long blobs rejected.
    expect(() => parseUsageRecord(validBody({ seatId: "the user asked: how do I ..." }), "org")).toThrow(/seatId/);
    expect(() => parseUsageRecord(validBody({ requestId: "x".repeat(200) }), "org")).toThrow(/requestId/);
    expect(() => parseUsageRecord(validBody({ model: "completion text with spaces" }), "org")).toThrow(/model/);
  });

  it("still accepts the legitimate enum values and normal identities", () => {
    for (const cr of ["miss", "exact", "semantic", "singleflight", "deterministic"]) {
      expect(() => parseUsageRecord(validBody({ cacheResult: cr }), "org")).not.toThrow();
    }
    expect(() => parseUsageRecord(validBody({ seatId: "svc-account_01:eu-west" }), "org")).not.toThrow();
    expect(() => parseUsageRecord(validBody({ model: "anthropic/claude-sonnet-5" }), "org")).not.toThrow();
  });

  it("rejects type mismatches (numbers must be finite numbers)", () => {
    expect(() => parseUsageRecord(validBody({ actualInputTokens: "60" }), "org")).toThrow(UsageValidationError);
    expect(() => parseUsageRecord(validBody({ netSavings: Infinity }), "org")).toThrow(UsageValidationError);
    expect(() => parseUsageRecord(validBody({ model: 123 }), "org")).toThrow(UsageValidationError);
  });

  it("rejects non-objects", () => {
    expect(() => parseUsageRecord(null, "org")).toThrow(UsageValidationError);
    expect(() => parseUsageRecord("[]", "org")).toThrow(UsageValidationError);
  });

  it("parses a batch and stamps every record with the authorized org", () => {
    const recs = parseUsageRecords([validBody(), validBody({ orgId: "spoof" })], "authed");
    expect(recs).toHaveLength(2);
    expect(recs.every((r) => r.orgId === "authed")).toBe(true);
  });

  it("the emit-side allowlist output passes the ingest-side validator (round-trip)", () => {
    // usageRecordFromReport is the only sanctioned way to build a record; its
    // output must always survive the strict ingest validator.
    const report: SavingsReportLike = {
      requestId: "r9",
      model: "m",
      calls: { avoidedLlm: 1, actualLlm: 0 },
      tokens: { baselineInput: 10, actualInput: 0, eliminatedInput: 10, compressedInput: 0, baselineOutput: 5, actualOutput: 0 },
      cache: { result: "exact" },
      cost: { baselineEstimate: 0.01, actual: 0, netSavings: 1 },
    };
    const emitted = usageRecordFromReport(report, { orgId: "o", seatId: "svc-1", at: 1 });
    // Simulate the wire: strip the server-derived orgId, re-validate as the server would.
    const { orgId: _drop, ...onWire } = emitted as Record<string, unknown> & { orgId: string };
    expect(() => parseUsageRecord(onWire, "o")).not.toThrow();
    expect(parseUsageRecord(onWire, "o").seatId).toBe("svc-1");
  });
});
