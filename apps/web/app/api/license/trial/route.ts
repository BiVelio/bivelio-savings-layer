import { randomUUID, sign, createPrivateKey } from "node:crypto";
import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";

/**
 * Issue a 14-day trial license key for the signed-in user. This is the
 * in-product self-serve trial funnel (and the owner's "test it from the product"
 * path). It mints the same signed-token format the SDK verifies offline against
 * the embedded public key, so a returned key unlocks `createSavingsLayer({ licenseKey })`.
 *
 * The Ed25519 PRIVATE signing key lives ONLY server-side (env `LICENSE_PRIVATE_KEY`
 * / `LICENSE_PRIVATE_KEY_B64`) and is never shipped to the client. For production,
 * move signing to the control-plane and call it from here — see the plan.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

function loadPrivateKey(): string | null {
  const b64 = process.env.LICENSE_PRIVATE_KEY_B64;
  if (b64) return Buffer.from(b64, "base64").toString("utf8");
  const raw = process.env.LICENSE_PRIVATE_KEY;
  return raw ? raw.replace(/\\n/g, "\n") : null;
}

function signToken(payload: Record<string, unknown>, privateKeyPem: string): string {
  const head = b64url(JSON.stringify({ alg: "EdDSA", typ: "BVL", v: 1 }));
  const body = b64url(JSON.stringify(payload));
  const sig = sign(null, Buffer.from(`${head}.${body}`), createPrivateKey(privateKeyPem));
  return `${head}.${body}.${b64url(sig)}`;
}

export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in to get a trial key." }, { status: 401 });
  }

  const privateKey = loadPrivateKey();
  if (!privateKey) {
    return NextResponse.json(
      { error: "Trial issuance isn't configured yet (LICENSE_PRIVATE_KEY missing)." },
      { status: 501 },
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const features = ["semantic_cache", "dashboards", "long_context_compression"];
  const payload = {
    jti: `trial_${randomUUID()}`,
    org_id: user.id,
    plan: "pro",
    seats: 1,
    features,
    issued_at: now,
    expires_at: now + 14 * 86400,
    grace_days: 3,
    iss: "bivelio-trial",
  };

  try {
    const token = signToken(payload, privateKey);
    return NextResponse.json({
      token,
      plan: "pro",
      features,
      expiresAt: new Date(payload.expires_at * 1000).toISOString(),
    });
  } catch (err) {
    console.error("[license/trial] signing failed:", err);
    return NextResponse.json({ error: "Could not sign the trial license." }, { status: 500 });
  }
}
