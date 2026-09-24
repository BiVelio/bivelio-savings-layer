import { describe, it, expect } from "vitest";
import {
  downgradeReferences,
  parseUsageRecord,
  usageRecordFromReport,
  type SavingsReportLike,
} from "@bivelio/protocol";

/**
 * Mirror of test/usage-validator.test.ts (0029): the reference lane behaves
 * exactly as in the web ingest — clip, never reject.
 */
function referenceBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: "r-ref",
    model: "openai/gpt-4o-mini",
    at: Date.now(),
    avoidedLlm: 1,
    actualLlm: 0,
    baselineInputTokens: 1736,
    actualInputTokens: 0,
    eliminatedInputTokens: 0,
    compressedInputTokens: 0,
    baselineOutputTokens: 267,
    actualOutputTokens: 0,
    providerCachedInputTokens: 0,
    cacheResult: "exact",
    baselineCost: 0.0002904,
    actualCost: 0,
    netSavings: 1,
    basis: "reference",
    referenceRequestId: "r-populated",
    referenceAt: Date.now() - 60_000,
    ...overrides,
  };
}

describe("reference lane (0029) — parseUsageRecord", () => {
  it("a coherent reference passes and keeps both fields", () => {
    const rec = parseUsageRecord(referenceBody(), "org");
    expect(rec.basis).toBe("reference");
    expect(rec.referenceRequestId).toBe("r-populated");
    expect(typeof rec.referenceAt).toBe("number");
  });

  it("an incoherent reference is downgraded to estimated without throwing, and loses both fields", () => {
    for (const bad of [
      { actualCost: 0.0001 },
      { cacheResult: "miss" },
      { cacheResult: "semantic" },
      { avoidedLlm: 0, actualLlm: 1 },
      { netSavings: 0.5 },
      { baselineCost: 0 },
      { baselineCost: 0.03 }, // above 1736 × 0.002/1K + 267 × 0.08/1K
    ]) {
      const rec = parseUsageRecord(referenceBody(bad), "org");
      expect(rec.basis, JSON.stringify(bad)).toBe("estimated");
      expect("referenceRequestId" in rec).toBe(false);
      expect("referenceAt" in rec).toBe(false);
    }
  });

  it("referenceAt in seconds and a referenceRequestId with spaces are dropped, not a 400 — and without a pointer it is not a reference", () => {
    const seconds = parseUsageRecord(referenceBody({ referenceAt: Math.floor(Date.now() / 1000) }), "org");
    expect(seconds.basis).toBe("estimated");
    expect("referenceAt" in seconds).toBe(false);
    expect("referenceRequestId" in seconds).toBe(false);
    const spaces = parseUsageRecord(referenceBody({ referenceRequestId: "the user asked" }), "org");
    expect(spaces.basis).toBe("estimated");
    expect("referenceRequestId" in spaces).toBe(false);
  });

  it("a missing referenceRequestId or referenceAt downgrades to estimated, never a 400", () => {
    const { referenceRequestId: _id, ...noId } = referenceBody();
    const { referenceAt: _at, ...noAt } = referenceBody();
    for (const body of [noId, noAt]) {
      const rec = parseUsageRecord(body, "org");
      expect(rec.basis).toBe("estimated");
      expect("referenceRequestId" in rec).toBe(false);
      expect("referenceAt" in rec).toBe(false);
    }
  });

  it("the published age (30 days, 5 min of clock skew either way) is checked as at - referenceAt", () => {
    const at = Date.now();
    const day = 86_400_000;
    const basisAt = (ageMs: number) => parseUsageRecord(referenceBody({ at, referenceAt: at - ageMs }), "org").basis;
    expect(basisAt(30 * day)).toBe("reference");
    expect(basisAt(30 * day + 4 * 60_000)).toBe("reference");
    expect(basisAt(30 * day + 5 * 60_000 + 1)).toBe("estimated");
    expect(basisAt(-4 * 60_000)).toBe("reference");
    expect(basisAt(-5 * 60_000 - 1)).toBe("estimated");
  });

  it("an avoided call carries no removed, compressed or provider-cached tokens", () => {
    for (const bad of [{ eliminatedInputTokens: 5 }, { compressedInputTokens: 5 }, { providerCachedInputTokens: 5 }]) {
      expect(parseUsageRecord(referenceBody(bad), "org").basis, JSON.stringify(bad)).toBe("estimated");
    }
  });

  it("both fields are removed from a non-reference record", () => {
    const rec = parseUsageRecord(referenceBody({ basis: "estimated" }), "org");
    expect("referenceRequestId" in rec).toBe(false);
    expect("referenceAt" in rec).toBe(false);
  });

  it('"verified" is still rejected', () => {
    expect(() => parseUsageRecord(referenceBody({ basis: "verified" }), "org")).toThrow(/basis/);
  });

  it("downgradeReferences rewrites only reference records and counts them", () => {
    const recs = [
      parseUsageRecord(referenceBody(), "org"),
      parseUsageRecord(referenceBody({ basis: "measured", cacheResult: "miss", avoidedLlm: 0, actualLlm: 1 }), "org"),
    ];
    expect(downgradeReferences(recs)).toBe(1);
    expect(recs.map((r) => r.basis)).toEqual(["estimated", "measured"]);
    expect("referenceRequestId" in recs[0]!).toBe(false);
  });
});

describe("reference lane (0029) — usageRecordFromReport", () => {
  const report = (over: Partial<SavingsReportLike> = {}): SavingsReportLike => ({
    requestId: "r-hit",
    model: "openai/gpt-4o-mini",
    calls: { avoidedLlm: 1, actualLlm: 0 },
    tokens: { baselineInput: 1736, actualInput: 0, eliminatedInput: 0, compressedInput: 0, baselineOutput: 267, actualOutput: 0 },
    cache: { result: "exact", reference: { requestId: "r-populated", at: Date.now() - 1_000 } },
    cost: { baselineEstimate: 0.0002904, actual: 0, netSavings: 1, basis: "reference" },
    ...over,
  });

  it("carries referenceRequestId/referenceAt with basis reference, and the ingest keeps them (round-trip)", () => {
    const emitted = usageRecordFromReport(report(), { orgId: "o", at: Date.now() });
    expect(emitted.basis).toBe("reference");
    expect(emitted.referenceRequestId).toBe("r-populated");
    expect(Number.isInteger(emitted.referenceAt)).toBe(true);
    const { orgId: _drop, ...onWire } = emitted as unknown as Record<string, unknown>;
    const parsed = parseUsageRecord(onWire, "o");
    expect(parsed.basis).toBe("reference");
    expect(parsed.referenceRequestId).toBe("r-populated");
  });

  it("never carries them without basis reference, or with a malformed id", () => {
    const estimated = usageRecordFromReport(
      report({ cost: { baselineEstimate: 0.001, actual: 0, netSavings: 1, basis: "estimated" } }),
      { orgId: "o", at: Date.now() },
    );
    expect("referenceRequestId" in estimated).toBe(false);
    const bad = usageRecordFromReport(
      report({ cache: { result: "exact", reference: { requestId: "has spaces", at: Date.now() } } }),
      { orgId: "o", at: Date.now() },
    );
    expect("referenceRequestId" in bad).toBe(false);
    expect("referenceAt" in bad).toBe(false);
    // What cannot carry its pointer cannot be billed as a reference: the ingest downgrades it.
    const { orgId: _drop, ...onWire } = bad as unknown as Record<string, unknown>;
    expect(parseUsageRecord(onWire, "o").basis).toBe("estimated");
  });
});
