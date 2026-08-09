import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/stripe/client";
import { billingFullyConfigured, priceIdFor, type BillingPeriod } from "@/lib/stripe/env";

/**
 * Start a Stripe Checkout for the per-seat PRO plan (monthly or yearly). Auth'd
 * by the cookie session; the org id (CP-0: == the auth user id) is carried in
 * the session + subscription metadata so the webhook can resolve it. Returns the
 * hosted Checkout URL; the client redirects.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  if (!billingFullyConfigured) {
    return NextResponse.json({ error: "Billing isn't configured yet." }, { status: 501 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  // Optional body: period (monthly|yearly), seats, locale. Empty body is fine.
  let period: BillingPeriod = "monthly";
  let seats = 1;
  let locale = "es";
  try {
    const body = (await req.json()) as { period?: string; seats?: number; locale?: string };
    if (body.period === "yearly") period = "yearly";
    if (typeof body.seats === "number" && Number.isFinite(body.seats) && body.seats > 0) {
      seats = Math.floor(body.seats);
    }
    if (typeof body.locale === "string" && body.locale.length <= 5) locale = body.locale;
  } catch {
    /* no body — use defaults */
  }

  const price = priceIdFor(period);
  if (!price) {
    return NextResponse.json({ error: `No Stripe price configured for ${period}.` }, { status: 501 });
  }

  // Reuse the org's existing Stripe customer if we've recorded one (no duplicates).
  let customer: string | undefined;
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("organizations")
      .select("stripe_customer_id")
      .eq("id", user.id)
      .maybeSingle();
    customer = (data as { stripe_customer_id?: string | null } | null)?.stripe_customer_id ?? undefined;
  } catch {
    /* org row may not exist yet — Stripe creates the customer at checkout */
  }

  const origin = new URL(req.url).origin;
  try {
    const session = await getStripe().checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price, quantity: seats, adjustable_quantity: { enabled: true, minimum: 1 } }],
      ...(customer ? { customer } : { customer_email: user.email ?? undefined }),
      client_reference_id: user.id,
      metadata: { org_id: user.id, email: user.email ?? "" },
      subscription_data: { metadata: { org_id: user.id } },
      allow_promotion_codes: true,
      success_url: `${origin}/${locale}/dashboard/account?checkout=success`,
      cancel_url: `${origin}/${locale}/dashboard/account?checkout=cancelled`,
    });
    if (!session.url) throw new Error("no session url returned");
    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("[stripe/checkout] create session failed:", err);
    return NextResponse.json({ error: "Could not start checkout." }, { status: 502 });
  }
}
