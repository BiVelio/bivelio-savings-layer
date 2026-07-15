import { describe, it, expect } from "vitest";
import { usageRecordFromReport, type SavingsReportLike } from "@bivelio/protocol";
import { createMeteringService } from "../src/index.js";

function reportLike(overrides: Partial<SavingsReportLike> = {}): SavingsReportLike {
  return {
    requestId: "req_1",
    model: "openai/gpt-4o-mini",
    calls: { avoidedLlm: 0, actualLlm: 1 },
    tokens: {
      baselineInput: 1000,
      actualInput: 400,
      eliminatedInput: 300,
      compressedInput: 300,
      baselineOutput: 200,
      actualOutput: 120,
      providerCachedInput: 50,
    },
    cache: { result: "miss" },
    cost: { baselineEstimate: 1.0, actual: 0.4, netSavings: 0.6 },
    ...overrides,
  };
}

describe("usageRecordFromReport", () => {
  it("maps report fields to a usage record, carrying only counts/cost", () => {
    const record = usageRecordFromReport(reportLike(), { orgId: "org_1", seatId: "seat_a", at: 1 });
    expect(record.orgId).toBe("org_1");
    expect(record.eliminatedInputTokens).toBe(300);
    expect(record.providerCachedInputTokens).toBe(50);
    expect(record.netSavings).toBe(0.6);
    // No prompt/content fields exist on the record type at all.
    expect(Object.keys(record)).not.toContain("messages");
  });
});

describe("MeteringService", () => {
  it("aggregates usage per org and counts distinct seats", () => {
    const svc = createMeteringService();
    svc.ingest([
      usageRecordFromReport(reportLike({ calls: { avoidedLlm: 1, actualLlm: 0 }, cache: { result: "exact" } }), { orgId: "org_1", seatId: "a", at: 1 }),
      usageRecordFromReport(reportLike(), { orgId: "org_1", seatId: "b", at: 2 }),
      usageRecordFromReport(reportLike(), { orgId: "org_1", seatId: "a", at: 3 }),
    ]);
    const s = svc.summary("org_1");
    expect(s.requests).toBe(3);
    expect(s.avoidedLlm).toBe(1);
    expect(s.activeSeats).toBe(2); // a, b
    expect(s.byCacheResult).toEqual({ exact: 1, miss: 2 });
    expect(s.savedCost).toBeCloseTo(1.8, 5); // 3 × (1.0 − 0.4)
    expect(s.netSavingsAvg).toBeCloseTo(0.6, 5);
  });

  it("isolates orgs from each other", () => {
    const svc = createMeteringService();
    svc.ingest(usageRecordFromReport(reportLike(), { orgId: "org_1", at: 1 }));
    expect(svc.summary("org_2").requests).toBe(0);
    expect(svc.totalRecords()).toBe(1);
  });
});
