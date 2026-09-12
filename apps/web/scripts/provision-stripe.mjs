// One-shot Stripe provisioning for BV-SALA per-seat PRO billing.
//
// Creates the Product, the two Licensed Prices (4 EUR/mo + 39 EUR/yr) and the
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

// LOS SIETE QUE EL WEBHOOK MANEJA. Esta lista tiene que cuadrar EXACTAMENTE con
// los `case` de apps/web/app/api/stripe/webhook/route.ts, y hay un test que lo
// ata (`test/eventos-del-webhook.test.ts`) porque ya se desincronizó una vez: se
// aprovisionó con seis, y `checkout.session.async_payment_succeeded` se añadió al
// código DESPUÉS. Ese es justo el evento del pago SEPA —normal en EUR/España—,
// que llega días después de que el cliente pague: sin él, el checkout ve
// `incomplete`, el dinero entra y NADIE emite la licencia. Nunca.
const EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
];

async function main() {
  console.log(`\nMode: ${live ? "LIVE" : "TEST"}  ·  webhook: ${WEBHOOK_URL}\n`);

  // GUARDIA DE NO-REEJECUCIÓN. Este script CREA objetos nuevos cada vez: relanzarlo
  // sobre una cuenta ya aprovisionada deja un producto duplicado, dos precios que
  // nadie sabe cuál es el bueno y DOS endpoints de webhook con secretos distintos.
  // La nota de la cabecera ya lo decía, pero una nota no para a nadie a las once de
  // la noche. Si lo que hace falta es AÑADIR un evento a un endpoint que ya existe,
  // eso se hace en el panel de Stripe, no aquí.
  const existentes = await stripe.webhookEndpoints.list({ limit: 100 });
  const yaEsta = existentes.data.find((w) => w.url === WEBHOOK_URL);
  if (yaEsta) {
    const suyos = new Set(yaEsta.enabled_events);
    const faltan = EVENTS.filter((e) => !suyos.has(e) && !suyos.has("*"));
    console.error(`✗ Ya existe un endpoint para ${WEBHOOK_URL} (${yaEsta.id}).`);
    console.error("  NO se re-aprovisiona: duplicaría producto, precios y webhook.");
    if (faltan.length) {
      console.error(`\n  Le FALTAN ${faltan.length} evento(s), añádelos en el panel de Stripe:`);
      for (const e of faltan) console.error(`    · ${e}`);
      console.error("\n  Developers → Webhooks → ese endpoint → Update details → Select events.");
    } else {
      console.error("  Tiene los siete eventos: no hay nada que hacer.");
    }
    process.exit(1);
  }

  const product = await stripe.products.create({
    name: "BiVelio Savings Layer — Pro",
    description: "Per-seat PRO — every BV-SALA optimization, per-request SavingsReport, savings dashboards. Commission only on measured savings.",
  });
  console.log("✓ Product:", product.id);

  // Licensed (quantity-based) recurring prices — the default usage_type.
  const monthly = await stripe.prices.create({
    product: product.id,
    currency: "eur",
    unit_amount: 400, // 4,00 €
    recurring: { interval: "month" },
    nickname: "PRO monthly (per seat)",
  });
  console.log("✓ Monthly price:", monthly.id);

  const yearly = await stripe.prices.create({
    product: product.id,
    currency: "eur",
    unit_amount: 3900, // 39,00 €
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
