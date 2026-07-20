import { NextResponse } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Admin revoke — records a jti in the append-only revocation ledger so the SDK's
 * `GET /licenses/revocations` publishes it. Fail-closed: refused unless the caller
 * presents `Authorization: Bearer ${LICENSE_ADMIN_TOKEN}`. Idempotent (unique jti).
 *
 * This is the CP-0 admin write path (lets us revoke + test now). In production the
 * Stripe `customer.subscription.deleted` webhook inserts here instead of a bearer.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  const adminToken = process.env.LICENSE_ADMIN_TOKEN;
  if (!adminToken) {
    return NextResponse.json(
      { error: "Revoke isn't configured (LICENSE_ADMIN_TOKEN unset)." },
      { status: 501 },
    );
  }

  const authorization = req.headers.get("authorization") ?? "";
  const presented = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (presented.length === 0 || presented !== adminToken) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { jti?: string; reason?: string };
  try {
    body = (await req.json()) as { jti?: string; reason?: string };
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.jti) {
    return NextResponse.json({ error: "jti is required" }, { status: 400 });
  }

  try {
    const supabase = createAdminClient();
    const { error } = await supabase
      .from("revocations")
      .upsert(
        { jti: body.jti, reason: body.reason ?? null },
        { onConflict: "jti", ignoreDuplicates: true },
      );
    if (error) throw error;
  } catch (err) {
    console.error("[license/revoke] insert error:", err);
    return NextResponse.json({ error: "could not record revocation" }, { status: 500 });
  }

  return NextResponse.json({ revoked: true, jti: body.jti });
}
