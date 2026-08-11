import { cache } from "react";

import { authConfigured } from "@/lib/supabase/env";
// Server Component: cliente de SOLO LECTURA. No puede persistir un token
// rotado, asi que tampoco debe provocar la rotacion — ver server.ts.
import { createReadOnlyClient } from "@/lib/supabase/server";
import { getOrgContext, getUsageRollups, type OrgContext, type UsageRollup } from "./data";

export interface DashboardData {
  user: { id: string; email: string | null } | null;
  ctx: OrgContext;
  usage: UsageRollup[];
  /** La lectura de uso falló (503/RLS/columna ausente), distinto de "sin tráfico". */
  usageFailed: boolean;
}

const EMPTY_CTX: OrgContext = {
  org: null,
  role: null,
  seats: null,
  subscription: null,
  license: null,
  serviceAccount: null,
};

/**
 * Load the signed-in user + org context + usage once per request. `cache()` dedupes
 * across the dashboard layout and every sub-page so they don't each re-fetch.
 */
export const loadDashboard = cache(async (): Promise<DashboardData> => {
  // Without Supabase env (e.g. local without .env), createClient() would throw —
  // degrade to a signed-out shell instead of a 500.
  if (!authConfigured) return { user: null, ctx: EMPTY_CTX, usage: [], usageFailed: false };
  const supabase = await createReadOnlyClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { user: null, ctx: EMPTY_CTX, usage: [], usageFailed: false };
  const [ctx, usage] = await Promise.all([getOrgContext(supabase, user.id), getUsageRollups(supabase, user.id)]);
  return { user: { id: user.id, email: user.email ?? null }, ctx, usage: usage.rows, usageFailed: usage.failed };
});

/** Display label for the account plan pill (no active plan → "free"). */
export function planLabel(ctx: OrgContext): string {
  const p = ctx.org?.plan;
  return p === "pro" || p === "enterprise" ? p : "free";
}
