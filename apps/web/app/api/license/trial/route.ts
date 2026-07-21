import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { loadPrivateKey, signCompact } from "@/lib/license/sign";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Internal / pilot license issuance. BV-SALA is PAID: there is NO free tier and NO
 * self-serve trial. This endpoint mints a signed license ONLY for an allow-listed
 * owner/pilot email (`LICENSE_ISSUER_EMAILS`, comma-separated) — fail-closed if the
 * env is unset, so nobody can self-issue by default. Everyone else gets a 402: paid
 * checkout is coming online via Stripe, which will replace this route.
 *
 * The Ed25519 PRIVATE signing key lives ONLY server-side (`LICENSE_PRIVATE_KEY_B64`
 * / `LICENSE_PRIVATE_KEY`); signing goes through the shared `lib/license/sign` helper.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LICENSE_HEADER = { alg: "EdDSA", typ: "BVL", v: 1 } as const;
const ISSUE_DAYS = 90; // internal/pilot window; revoke early via /api/license/revoke

/** Emails allowed to self-issue a license (owner + pilots). Fail-closed if unset. */
function issuerAllowList(): Set<string> {
  return new Set(
    (process.env.LICENSE_ISSUER_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  // Paid product: no free/self-serve keys. Gated to the owner/pilot allow-list until
  // Stripe checkout is live. Fail-closed — an empty allow-list issues to no one.
  const email = (user.email ?? "").toLowerCase();
  if (!issuerAllowList().has(email)) {
    return NextResponse.json(
      {
        error:
          "Subscription checkout is coming online — self-serve license keys aren't issued yet. $4 / seat / month or $39 / seat / year.",
      },
      { status: 402 },
    );
  }

  const privateKey = loadPrivateKey();
  if (!privateKey) {
    return NextResponse.json(
      { error: "License issuance isn't configured yet (LICENSE_PRIVATE_KEY missing)." },
      { status: 501 },
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const features = ["semantic_cache", "dashboards", "long_context_compression"];
  // Bare-uuid jti so it doubles as the `bvsala.licenses.id` (the table's id == jti
  // invariant). `iss: "bivelio-internal"` — not a jti prefix — is what marks it
  // internal, and the SDK matches jti by exact string, so this verifies/revokes
  // identically on already-deployed SDKs.
  const licenseId = randomUUID();
  const payload = {
    jti: licenseId,
    org_id: user.id,
    plan: "pro",
    seats: 1,
    features,
    issued_at: now,
    expires_at: now + ISSUE_DAYS * 86400,
    grace_days: 3,
    iss: "bivelio-internal",
  };

  try {
    // Stamp a key-id only when configured (byte-identical default output), so a
    // future keyset deployment can rotate the signing key without a hard cutover.
    const kid = process.env.LICENSE_KEY_ID;
    const token = signCompact({ ...LICENSE_HEADER, ...(kid ? { kid } : {}) }, payload, privateKey);

    // PERSIST before returning, or the license is unrevocable-by-org (its jti would
    // live only inside the emitted token). Use the service-role client (the anon
    // client above is RLS-blocked from writing). Idempotently ensure the parent org
    // + membership first (the licenses.org_id FK requires it, and nothing else
    // bootstraps an org for this user). FAIL CLOSED — never return an unpersisted
    // token, else a DB hiccup silently reproduces the original leak.
    const admin = createAdminClient();
    const { error: orgErr } = await admin
      .from("organizations")
      .upsert({ id: user.id, name: "My workspace" }, { onConflict: "id", ignoreDuplicates: true });
    if (orgErr) throw orgErr;
    const { error: memErr } = await admin
      .from("org_members")
      .upsert({ org_id: user.id, user_id: user.id, role: "owner" }, { onConflict: "org_id,user_id", ignoreDuplicates: true });
    if (memErr) throw memErr;
    const { error: licErr } = await admin.from("licenses").insert({
      id: licenseId,
      org_id: user.id,
      plan: "pro",
      seats: 1,
      features,
      issued_at: new Date(now * 1000).toISOString(),
      expires_at: new Date(payload.expires_at * 1000).toISOString(),
      grace_days: payload.grace_days,
      token,
    });
    if (licErr) throw licErr;

    return NextResponse.json({
      token,
      plan: "pro",
      features,
      expiresAt: new Date(payload.expires_at * 1000).toISOString(),
    });
  } catch (err) {
    console.error("[license/issue] issue failed:", err);
    return NextResponse.json({ error: "Could not issue the license." }, { status: 500 });
  }
}
