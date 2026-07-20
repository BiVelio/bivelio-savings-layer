import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { loadPrivateKey, signCompact } from "@/lib/license/sign";
import { createClient } from "@/lib/supabase/server";

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
  const payload = {
    jti: `internal_${randomUUID()}`,
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
    const token = signCompact(LICENSE_HEADER, payload, privateKey);
    return NextResponse.json({
      token,
      plan: "pro",
      features,
      expiresAt: new Date(payload.expires_at * 1000).toISOString(),
    });
  } catch (err) {
    console.error("[license/issue] signing failed:", err);
    return NextResponse.json({ error: "Could not sign the license." }, { status: 500 });
  }
}
