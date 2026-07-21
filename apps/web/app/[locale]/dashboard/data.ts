import { getTranslations } from "next-intl/server";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Server data layer for the dashboard. Every query is best-effort: the bound
 * Supabase project (the unified BiVelio platform) may not have the savings
 * control-plane tables yet, so a missing table / RLS denial must degrade to an
 * HONEST fallback — never a fabricated or hardcoded value.
 */

// ---- The measured A/B artifact (public/data/ab-live.json) ----
export interface CI {
  point: number;
  lower: number;
  upper: number;
}
export interface AbLedger {
  ledger: string;
  scenarios: string[];
  savings: CI;
  deltaCost: number;
  proven: boolean;
}
export interface AbScenario {
  name: string;
  lever: string;
  ledger: string;
  kind: string;
  reps: number;
  armA: { meanInputTokens: number; meanOutputTokens: number; meanCost: number };
  armB: { meanInputTokens: number; meanOutputTokens: number; meanCost: number };
  measured: { savings: CI; wilcoxonP: number; inputTokenDeltaMean: number; outputTokenDeltaMean: number };
  quality: { gate: string; passed: number; total: number };
  amortization?: { coldMissCost: number; hitCost: number; breakEvenK: number | null };
}
export interface AbArtifact {
  mode: "LIVE" | "MOCK";
  generatedNote: string;
  methodology: string;
  config: { reps: number; seed: number };
  pricing: { note: string; table: Record<string, unknown> };
  scenarios: AbScenario[];
  ledgers: AbLedger[];
  reconciliation: { totalDelta: number; ledgerSum: number; residual: number; reconciled: boolean };
  fingerprintStable: boolean;
  aggregate: { savings: CI; wilcoxonP: number; qualityPassRate: number; proven: boolean; headline: string };
  honesty: string[];
}

// ---- Account / org context (best-effort) ----
export interface OrgContext {
  /** Resolved organization, or null when the user isn't in one / schema absent. */
  org: { name: string; plan: string } | null;
  role: string | null;
  seats: number | null;
  license: { status: "active" | "grace" | "expired" | "unknown"; expiresAt: string | null } | null;
  serviceAccount: { keyPrefix: string; lastUsedAt: string | null } | null;
}

/** Try the standard membership→organization shape; degrade silently on any error. */
export async function getOrgContext(supabase: SupabaseClient, userId: string): Promise<OrgContext> {
  const ctx: OrgContext = { org: null, role: null, seats: null, license: null, serviceAccount: null };

  // organizations via a membership table. Table/column names may differ in the
  // bound project — a PGRST error just means "not resolvable here".
  try {
    const { data } = await supabase
      .schema("bvsala")
      .from("org_members")
      .select("role, organizations(name, plan)")
      .eq("user_id", userId)
      .limit(1)
      .maybeSingle();
    const row = data as { role?: string; organizations?: { name?: string; plan?: string } | null } | null;
    if (row?.organizations?.name) {
      ctx.org = { name: row.organizations.name, plan: (row.organizations.plan ?? "free").toLowerCase() };
      ctx.role = row.role ?? null;
    }
  } catch {
    /* schema absent — honest fallback */
  }

  // Best-effort seat / license from a subscriptions/licenses table.
  if (ctx.org) {
    try {
      const { data } = await supabase
        .schema("bvsala")
        .from("subscriptions")
        .select("seats, status, current_period_end")
        .eq("org_id", userId)
        .limit(1)
        .maybeSingle();
      const sub = data as { seats?: number; status?: string; current_period_end?: string } | null;
      if (sub?.seats != null) ctx.seats = sub.seats;
    } catch {
      /* no subscription table */
    }
  }

  // Service-account key PREFIX only (plaintext key is never stored/reproducible).
  try {
    const { data } = await supabase
      .schema("bvsala")
      .from("service_accounts")
      .select("key_prefix, last_used_at")
      .eq("org_id", userId)
      .limit(1)
      .maybeSingle();
    const sa = data as { key_prefix?: string; last_used_at?: string | null } | null;
    if (sa?.key_prefix) ctx.serviceAccount = { keyPrefix: sa.key_prefix, lastUsedAt: sa.last_used_at ?? null };
  } catch {
    /* no service_accounts table */
  }

  return ctx;
}

// ---- Live usage rollups (currently 0 rows until the CP-1 metering pipeline) ----
export interface UsageRollup {
  day: string;
  requests: number;
  avoidedLlm: number;
  actualLlm: number;
  eliminatedInputTokens: number;
  compressedInputTokens: number;
  providerCachedInputTokens: number;
  baselineCost: number;
  actualCost: number;
}

/** Reads usage_daily. Returns [] today (no metering pipeline). Never invents rows. */
export async function getUsageRollups(supabase: SupabaseClient, orgId: string): Promise<UsageRollup[]> {
  try {
    // Defense-in-depth: scope to this org explicitly (not just via RLS) and bound the
    // window so a dashboard read can't grow unbounded as usage history accumulates.
    const since = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { data, error } = await supabase
      .schema("bvsala")
      .from("usage_daily")
      .select(
        "day, requests, avoided_llm, actual_llm, eliminated_input_tokens, compressed_input_tokens, provider_cached_input_tokens, baseline_cost, actual_cost",
      )
      .eq("org_id", orgId)
      .gte("day", since)
      .order("day", { ascending: true });
    if (error || !data) return [];
    return (data as Record<string, number | string>[]).map((r) => ({
      day: String(r["day"]),
      requests: Number(r["requests"] ?? 0),
      avoidedLlm: Number(r["avoided_llm"] ?? 0),
      actualLlm: Number(r["actual_llm"] ?? 0),
      eliminatedInputTokens: Number(r["eliminated_input_tokens"] ?? 0),
      compressedInputTokens: Number(r["compressed_input_tokens"] ?? 0),
      providerCachedInputTokens: Number(r["provider_cached_input_tokens"] ?? 0),
      baselineCost: Number(r["baseline_cost"] ?? 0),
      actualCost: Number(r["actual_cost"] ?? 0),
    }));
  } catch {
    return [];
  }
}

// ---- Derived connection / activation state ----
export type Metering = "awaiting" | "live";
export function meteringState(usage: UsageRollup[]): Metering {
  return usage.length > 0 ? "live" : "awaiting";
}

export interface StepState {
  /** Stable, locale-independent identity (the original English label). Logic keys off this. */
  id: string;
  /** Human-readable, localized display label. */
  label: string;
  status: "done" | "current" | "pending";
}
/** The 5-node activation spine, derived (never stored). */
export async function activationSteps(
  hasUser: boolean,
  ctx: OrgContext,
  usage: UsageRollup[],
): Promise<StepState[]> {
  const t = await getTranslations("dashboard");
  const installed = ctx.serviceAccount != null;
  const licensed = ctx.license?.status === "active" || ctx.org != null;
  const reporting = usage.length > 0;
  const raw: Array<[string, string, boolean]> = [
    ["Account created", t("overview.steps.accountCreated"), hasUser],
    ["SDK installed", t("overview.steps.sdkInstalled"), installed],
    ["License active", t("overview.steps.licenseActive"), licensed],
    ["First report", t("overview.steps.firstReport"), reporting],
    ["Live meter", t("overview.steps.liveMeter"), reporting],
  ];
  // First not-done step is "current"; the rest "pending".
  let currentAssigned = false;
  return raw.map(([id, label, done]) => {
    if (done) return { id, label, status: "done" as const };
    if (!currentAssigned) {
      currentAssigned = true;
      return { id, label, status: "current" as const };
    }
    return { id, label, status: "pending" as const };
  });
}
