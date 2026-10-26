import { celdaCsv } from "@/lib/metering/referencias-csv";

import type { ShadowModelDia, UsageRollup } from "./data";

export interface OpportunityRow {
  model: string;
  shadowRequests: number;
  baselineCost: number;
  actualCost: number;
  hypotheticalSavings: number;
  coverageRatio: number | null;
}

export interface OpportunitySummary {
  rows: OpportunityRow[];
  totalShadowRequests: number;
  attributedShadowRequests: number;
  coverageRatio: number | null;
  partialCoverage: boolean | null;
  dailyShadowAvailable: boolean;
}

export function deriveOpportunities(
  rows: readonly ShadowModelDia[],
  usage: readonly UsageRollup[],
): OpportunitySummary {
  const dailyShadowAvailable = usage.length === 0 || usage.some((r) => r.shadowRequests != null);
  const totalShadowRequests = dailyShadowAvailable
    ? usage.reduce((sum, r) => sum + (r.shadowRequests ?? 0), 0)
    : 0;
  const byModel = new Map<string, { requests: number; baseline: number; actual: number }>();
  for (const row of rows) {
    const current = byModel.get(row.model) ?? { requests: 0, baseline: 0, actual: 0 };
    current.requests += row.shadowRequests;
    current.baseline += row.shadowBaselineCost;
    current.actual += row.shadowActualCost;
    byModel.set(row.model, current);
  }
  const attributedShadowRequests = [...byModel.values()].reduce((sum, row) => sum + row.requests, 0);
  const denominator = dailyShadowAvailable && totalShadowRequests > 0 ? totalShadowRequests : null;
  const opportunityRows = [...byModel.entries()]
    .map(([model, row]) => ({
      model,
      shadowRequests: row.requests,
      baselineCost: row.baseline,
      actualCost: row.actual,
      hypotheticalSavings: row.baseline - row.actual,
      coverageRatio: denominator === null ? null : row.requests / denominator,
    }))
    .sort((a, b) => b.hypotheticalSavings - a.hypotheticalSavings || a.model.localeCompare(b.model));
  return {
    rows: opportunityRows,
    totalShadowRequests,
    attributedShadowRequests,
    coverageRatio: denominator === null ? null : attributedShadowRequests / totalShadowRequests,
    partialCoverage: dailyShadowAvailable ? attributedShadowRequests < totalShadowRequests : null,
    dailyShadowAvailable,
  };
}

export function opportunityExportJson(summary: OpportunitySummary, rangeDays: number, generatedAt: string) {
  return {
    basis: "shadow",
    estimated: true,
    source: "bvsala.usage_daily_shadow_by_model",
    coverageSource: "bvsala.usage_daily.shadow_requests",
    unavailableDimensions: {
      lever: "not_preserved_by_current_wire",
      surface: "not_preserved_by_current_wire",
    },
    rangeDays,
    generatedAt,
    coverageRatio: summary.coverageRatio,
    partialCoverage: summary.partialCoverage,
    totalShadowRequests: summary.dailyShadowAvailable ? summary.totalShadowRequests : null,
    attributedShadowRequests: summary.attributedShadowRequests,
    rows: summary.rows,
  };
}

export function opportunityExportCsv(summary: OpportunitySummary, rangeDays: number, generatedAt: string): string {
  const coverage = summary.coverageRatio === null ? "" : String(summary.coverageRatio);
  const partial = summary.partialCoverage === null ? "unknown" : String(summary.partialCoverage);
  const lines = [
    "# basis=SHADOW",
    "# estimated=true",
    "# source=bvsala.usage_daily_shadow_by_model",
    "# coverage_source=bvsala.usage_daily.shadow_requests",
    "# lever=unavailable_not_preserved_by_current_wire",
    "# surface=unavailable_not_preserved_by_current_wire",
    `# range_days=${rangeDays}`,
    `# generated_at=${generatedAt}`,
    `# coverage_ratio=${coverage}`,
    `# partial_coverage=${partial}`,
    "model,shadow_requests,shadow_baseline_cost_usd,shadow_actual_cost_usd,hypothetical_savings_usd,coverage_ratio",
  ];
  for (const row of summary.rows) {
    lines.push(
      [
        celdaCsv(row.model),
        String(row.shadowRequests),
        String(row.baselineCost),
        String(row.actualCost),
        String(row.hypotheticalSavings),
        row.coverageRatio === null ? "" : String(row.coverageRatio),
      ].join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}
