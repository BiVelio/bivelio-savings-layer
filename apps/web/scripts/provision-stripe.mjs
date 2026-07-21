// One-shot Stripe provisioning for BV-SALA per-seat PRO billing.
//
// Creates the Product, the two Licensed Prices ($4/mo + $39/yr USD) and the
// production webhook endpoint, then prints the three values you paste into
// Vercel. Idempotency: re-running creates NEW objects, so run it ONCE (or delete
// the extras in the dashboard). Your secret key is read from the environment and
// never leaves your machine.
//
// Usage (from apps/web, where `stripe` is installed):
//   STRIPE_SECRET_KEY=sk_live_xxx node scripts/provision-stripe.mjs
//   # optional override: WEBHOOK_URL=https://savings.bivelio.com/api/stripe/webhook

import Stripe from "stripe";

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error("Set STRIPE_SECRET_KEY first:  STRIPE_SECRET_KEY=sk_live_... node scripts/provision-stripe.mjs");
  process.exit(1);
}
const live = key.startsWith("sk_live_");
const stripe = new Stripe(key);
const WEBHOOK_URL = process.env.WEBHOOK_URL || "https://savings.bivelio.com/api/stripe/webhook";

const EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
];

async function main() {
  console.log(`\nMode: ${live ? "LIVE" : "TEST"}  ·  webhook: ${WEBHOOK_URL}\n`);

  const product = await stripe.products.create({
    name: "BiVelio Savings Layer — Pro",
    description: "Per-seat PRO — every BV-SALA optimization, managed semantic cache, dashboards.",
  });
  console.log("✓ Product:", product.id);

  // Licensed (quantity-based) recurring prices — the default usage_type.
  const monthly = await stripe.prices.create({
    product: product.id,
    currency: "usd",
    unit_amount: 400, // $4.00
    recurring: { interval: "month" },
    nickname: "PRO monthly (per seat)",
  });
  console.log("✓ Monthly price:", monthly.id);

  const yearly = await stripe.prices.create({
    product: product.id,
    currency: "usd",
    unit_amount: 3900, // $39.00
    recurring: { interval: "year" },
    nickname: "PRO yearly (per seat)",
  });
  console.log("✓ Yearly price:", yearly.id);

  const webhook = await stripe.webhookEndpoints.create({
    url: WEBHOOK_URL,
    enabled_events: EVENTS,
    description: "BV-SALA billing — issue/re-issue/revoke licenses",
  });
  console.log("✓ Webhook endpoint:", webhook.id);

  console.log("\n──────────────  paste these into Vercel (Production)  ──────────────");
  console.log(`STRIPE_PRICE_ID_MONTHLY=${monthly.id}`);
  console.log(`STRIPE_PRICE_ID_YEARLY=${yearly.id}`);
  console.log(`STRIPE_WEBHOOK_SECRET=${webhook.secret}`);
  console.log("STRIPE_SECRET_KEY=(the sk_live_… you just used)");
  console.log("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=(pk_live_… from Developers → API keys)");
  console.log("────────────────────────────────────────────────────────────────────\n");
}

main().catch((err) => {
  console.error("Provisioning failed:", err?.message || err);
  process.exit(1);
});
