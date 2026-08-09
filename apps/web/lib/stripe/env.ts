// Stripe configuration, read from the environment (mirrors lib/supabase/env.ts).
// The secret + webhook signing secret are SERVER-ONLY; the publishable key is
// public. `billingConfigured` gates the routes so an unconfigured deploy fails
// closed (501) rather than half-working.

export const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "";
export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";
export const STRIPE_PRICE_ID_MONTHLY = process.env.STRIPE_PRICE_ID_MONTHLY ?? "";
export const STRIPE_PRICE_ID_YEARLY = process.env.STRIPE_PRICE_ID_YEARLY ?? "";
export const NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "";

/** True once the server-side Stripe secret is present. */
export const billingConfigured = Boolean(STRIPE_SECRET_KEY);

/**
 * True only when BOTH the secret AND the webhook signing secret are present.
 * Checkout/portal gate on this so we never charge a customer on a deploy where
 * the webhook — the only path that mints/revokes their license — can't run.
 */
export const billingFullyConfigured = Boolean(STRIPE_SECRET_KEY && STRIPE_WEBHOOK_SECRET);

export type BillingPeriod = "monthly" | "yearly";

/** The Stripe Price id for a billing period (empty string if not configured). */
export function priceIdFor(period: BillingPeriod): string {
  return period === "yearly" ? STRIPE_PRICE_ID_YEARLY : STRIPE_PRICE_ID_MONTHLY;
}
