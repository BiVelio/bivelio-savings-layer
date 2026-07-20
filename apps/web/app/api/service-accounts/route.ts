import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Mint a service-account key (bvk_…) for the signed-in user's org. This is the
 * machine credential the SDK uses to report usage (and, later, pull a rotated
 * license). Only the sha256 HASH + prefix are stored; the plaintext is returned
 * ONCE. CP-0 org model: org id == the user's id (matching the trial route) — the
 * real org/membership model gets populated by the Stripe onboarding flow.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to create a key." }, { status: 401 });

  let body: { label?: string } = {};
  try {
    body = (await req.json()) as { label?: string };
  } catch {
    // no body is fine
  }
  const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 64) : "default";

  const token = `bvk_${randomBytes(24).toString("base64url")}`;
  const keyHash = createHash("sha256").update(token).digest("hex");
  const keyPrefix = token.slice(0, 12); // "bvk_" + 8 chars, for display

  const admin = createAdminClient();

  // Bootstrap the org + owner membership for this user (idempotent).
  const { error: orgErr } = await admin
    .from("organizations")
    .upsert({ id: user.id, name: user.email ?? "My workspace" }, { onConflict: "id", ignoreDuplicates: true });
  if (orgErr) {
    console.error("[service-accounts] org upsert failed:", orgErr);
    return NextResponse.json({ error: "could not set up your workspace" }, { status: 500 });
  }
  await admin
    .from("org_members")
    .upsert({ org_id: user.id, user_id: user.id, role: "owner" }, { onConflict: "org_id,user_id", ignoreDuplicates: true });

  const { error } = await admin
    .from("service_accounts")
    .insert({ org_id: user.id, label, key_hash: keyHash, key_prefix: keyPrefix });
  if (error) {
    console.error("[service-accounts] insert failed:", error);
    return NextResponse.json({ error: "could not create key" }, { status: 500 });
  }

  return NextResponse.json({ key: token, keyPrefix, label }, { status: 201 });
}
