import { createHash } from "node:crypto";
import { NextResponse } from "next/server";

import { parseUsageRecords, UsageValidationError } from "@/lib/metering/usage";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * SDK usage ingest. Authenticated by a service-account Bearer key (bvk_…): we hash
 * it, look it up in service_accounts, and DERIVE the org server-side — the body's
 * orgId (if any) is never trusted. Records pass the counts-only content backstop,
 * then an atomic RPC folds them into seat_activity + usage_daily. Fail-closed (401)
 * with no matching key.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function bearer(authorization: string | null): string | null {
  if (!authorization || !authorization.startsWith("Bearer ")) return null;
  const t = authorization.slice(7).trim();
  return t.length > 0 ? t : null;
}

export async function POST(req: Request): Promise<NextResponse> {
  const token = bearer(req.headers.get("authorization"));
  if (!token) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const keyHash = createHash("sha256").update(token).digest("hex");

  const supabase = createAdminClient();

  const { data: sa, error: saErr } = await supabase
    .from("service_accounts")
    .select("org_id")
    .eq("key_hash", keyHash)
    .maybeSingle();
  if (saErr) {
    console.error("[metering/usage] service-account lookup failed:", saErr);
    return NextResponse.json({ error: "metering store unavailable" }, { status: 503 });
  }
  if (!sa) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const orgId = sa.org_id as string;

  let records;
  try {
    records = parseUsageRecords(await req.json(), orgId);
  } catch (err) {
    if (err instanceof UsageValidationError) return NextResponse.json({ error: err.message }, { status: 400 });
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (records.length === 0) return NextResponse.json({ ingested: 0 }, { status: 202 });

  const { data, error } = await supabase.rpc("ingest_usage_batch", { p_org: orgId, records });
  if (error) {
    console.error("[metering/usage] ingest RPC failed:", error);
    return NextResponse.json({ error: "ingest failed" }, { status: 500 });
  }

  // Best-effort liveness stamp; never fail the ingest on it.
  await supabase
    .from("service_accounts")
    .update({ last_used_at: new Date().toISOString() })
    .eq("key_hash", keyHash);

  return NextResponse.json({ ingested: data ?? records.length }, { status: 202 });
}
