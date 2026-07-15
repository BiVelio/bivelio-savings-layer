import type { UsageRecord } from "@bivelio/protocol";

/**
 * Metering service (control-plane core).
 *
 * Ingests UsageRecords (derived from the SDK's SavingsReport — counts only,
 * never content) and maintains per-org aggregates that feed billing. Aggregation
 * is incremental so summaries are O(1). In-memory here; a production build writes
 * raw records to ClickHouse/Timescale and keeps rollups in Postgres.
 */
export interface OrgSummary {
  orgId: string;
  requests: number;
  avoidedLlm: number;
  actualLlm: number;
  eliminatedInputTokens: number;
  compressedInputTokens: number;
  providerCachedInputTokens: number;
  baselineCost: number;
  actualCost: number;
  savedCost: number;
  /** Mean of per-request netSavings. */
  netSavingsAvg: number;
  /** Distinct seat identities seen — the basis for per-seat billing. */
  activeSeats: number;
  byCacheResult: Record<string, number>;
}

interface OrgAggregate {
  requests: number;
  avoidedLlm: number;
  actualLlm: number;
  eliminatedInputTokens: number;
  compressedInputTokens: number;
  providerCachedInputTokens: number;
  baselineCost: number;
  actualCost: number;
  netSavingsSum: number;
  seats: Set<string>;
  byCacheResult: Record<string, number>;
}

function emptyAggregate(): OrgAggregate {
  return {
    requests: 0,
    avoidedLlm: 0,
    actualLlm: 0,
    eliminatedInputTokens: 0,
    compressedInputTokens: 0,
    providerCachedInputTokens: 0,
    baselineCost: 0,
    actualCost: 0,
    netSavingsSum: 0,
    seats: new Set<string>(),
    byCacheResult: {},
  };
}

export class MeteringService {
  private readonly byOrg = new Map<string, OrgAggregate>();
  private total = 0;

  /** Ingest one or many usage records. Returns the number ingested. */
  ingest(input: UsageRecord | UsageRecord[]): number {
    const records = Array.isArray(input) ? input : [input];
    for (const r of records) {
      const agg = this.byOrg.get(r.orgId) ?? emptyAggregate();
      agg.requests += 1;
      agg.avoidedLlm += r.avoidedLlm;
      agg.actualLlm += r.actualLlm;
      agg.eliminatedInputTokens += r.eliminatedInputTokens;
      agg.compressedInputTokens += r.compressedInputTokens;
      agg.providerCachedInputTokens += r.providerCachedInputTokens;
      agg.baselineCost += r.baselineCost;
      agg.actualCost += r.actualCost;
      agg.netSavingsSum += r.netSavings;
      if (r.seatId) agg.seats.add(r.seatId);
      agg.byCacheResult[r.cacheResult] = (agg.byCacheResult[r.cacheResult] ?? 0) + 1;
      this.byOrg.set(r.orgId, agg);
      this.total += 1;
    }
    return records.length;
  }

  summary(orgId: string): OrgSummary {
    const agg = this.byOrg.get(orgId) ?? emptyAggregate();
    return {
      orgId,
      requests: agg.requests,
      avoidedLlm: agg.avoidedLlm,
      actualLlm: agg.actualLlm,
      eliminatedInputTokens: agg.eliminatedInputTokens,
      compressedInputTokens: agg.compressedInputTokens,
      providerCachedInputTokens: agg.providerCachedInputTokens,
      baselineCost: round(agg.baselineCost),
      actualCost: round(agg.actualCost),
      savedCost: round(agg.baselineCost - agg.actualCost),
      netSavingsAvg: agg.requests ? round(agg.netSavingsSum / agg.requests) : 0,
      activeSeats: agg.seats.size,
      byCacheResult: agg.byCacheResult,
    };
  }

  totalRecords(): number {
    return this.total;
  }
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export function createMeteringService(): MeteringService {
  return new MeteringService();
}
