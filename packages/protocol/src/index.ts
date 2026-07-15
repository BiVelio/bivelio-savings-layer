/**
 * @bivelio/protocol — shared wire types for BV-SALA.
 * PROPRIETARY AND CONFIDENTIAL — © 2026 BiVelio Inc. All Rights Reserved.
 *
 * These types are the contract between the SDK (data plane), the license-client,
 * and the control plane (licensing / metering / billing). Keeping them in one
 * dependency-free package guarantees both sides agree on the shape.
 */

/** Commercial plans. `free` is the self-hosted, locally-capped tier. */
export type Plan = "free" | "pro" | "team" | "enterprise";

/**
 * Gated capabilities. Local wins (exact cache, resolvers, format selector,
 * strict output) are NOT gated — they work on the free tier. These are the
 * managed / high-value features that require a paid entitlement.
 */
export type Feature =
  | "semantic_cache"
  | "learned_thresholds"
  | "dashboards"
  | "cross_tenant_optimization"
  | "long_context_compression"
  | "priority_support";

/** The signed payload embedded in a license token. */
export interface LicensePayload {
  /** License id (for revocation lists / audit). */
  jti: string;
  /** Tenant / organization this license belongs to. */
  org_id: string;
  plan: Plan;
  /** Purchased seats (per-seat billing). */
  seats: number;
  /** Entitled features. */
  features: Feature[];
  /** Unix seconds. */
  issued_at: number;
  /** Unix seconds; hard expiry (before grace). */
  expires_at: number;
  /** Extra days the SDK keeps working past expiry (graceful degrade window). */
  grace_days: number;
  /** Optional issuer identifier. */
  iss?: string;
}

/** Current license status resolved by the license-client. */
export type LicenseStatus =
  | "active" // valid, within term
  | "grace" // expired but inside grace window; still entitled, should warn
  | "expired" // past grace; drop to free tier
  | "invalid" // bad signature / malformed
  | "revoked"; // present on a revocation list

/** Snapshot of what a license currently grants. */
export interface Entitlements {
  orgId: string;
  plan: Plan;
  seats: number;
  features: Feature[];
  status: LicenseStatus;
  /** Unix seconds when this snapshot should be re-checked online. */
  refreshAfter?: number;
}

/**
 * A usage record derived from the SDK's SavingsReport and sent to the metering
 * service. Carries ONLY counts/metadata — never prompts or completions.
 */
export interface UsageRecord {
  orgId: string;
  /** Machine identity (service account) that produced the request. */
  seatId?: string;
  requestId: string;
  model: string;
  /** Unix ms. */
  at: number;
  avoidedLlm: number;
  actualLlm: number;
  baselineInputTokens: number;
  actualInputTokens: number;
  eliminatedInputTokens: number;
  compressedInputTokens: number;
  baselineOutputTokens: number;
  actualOutputTokens: number;
  providerCachedInputTokens: number;
  cacheResult: string;
  baselineCost: number;
  actualCost: number;
  netSavings: number;
}

/** Response from the licensing service when validating/refreshing online. */
export interface LicenseValidationResponse {
  status: LicenseStatus;
  entitlements?: Entitlements;
  /** New token if the service rotated/renewed it. */
  token?: string;
  reason?: string;
}

/**
 * Minimal structural view of the SDK's SavingsReport — just the fields metering
 * needs. Declared here (not imported from the SDK) so protocol stays free of any
 * dependency on the SDK, while remaining structurally compatible with it.
 */
export interface SavingsReportLike {
  requestId: string;
  model: string;
  calls: { avoidedLlm: number; actualLlm: number };
  tokens: {
    baselineInput: number;
    actualInput: number;
    eliminatedInput: number;
    compressedInput: number;
    baselineOutput: number;
    actualOutput: number;
    providerCachedInput?: number;
  };
  cache: { result: string };
  cost: { baselineEstimate: number; actual: number; netSavings: number };
}

/**
 * Map a SavingsReport into a metering UsageRecord. Carries ONLY counts and
 * cost — never prompts or completions — matching the data-minimization
 * invariant of the control plane.
 */
export function usageRecordFromReport(
  report: SavingsReportLike,
  ctx: { orgId: string; seatId?: string; at: number },
): UsageRecord {
  return {
    orgId: ctx.orgId,
    ...(ctx.seatId ? { seatId: ctx.seatId } : {}),
    requestId: report.requestId,
    model: report.model,
    at: ctx.at,
    avoidedLlm: report.calls.avoidedLlm,
    actualLlm: report.calls.actualLlm,
    baselineInputTokens: report.tokens.baselineInput,
    actualInputTokens: report.tokens.actualInput,
    eliminatedInputTokens: report.tokens.eliminatedInput,
    compressedInputTokens: report.tokens.compressedInput,
    baselineOutputTokens: report.tokens.baselineOutput,
    actualOutputTokens: report.tokens.actualOutput,
    providerCachedInputTokens: report.tokens.providerCachedInput ?? 0,
    cacheResult: report.cache.result,
    baselineCost: report.cost.baselineEstimate,
    actualCost: report.cost.actual,
    netSavings: report.cost.netSavings,
  };
}

export const PROTOCOL_VERSION = 1 as const;
