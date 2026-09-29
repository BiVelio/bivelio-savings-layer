// Aprovisionamiento ÚNICO de los planes SIN comisión: Pro y Equipo
// (apps/web/lib/billing/planes.ts). LO EJECUTA EL DUEÑO, a mano, cuando haya
// confirmado los precios — nunca un agente ni un despliegue.
//
// Crea CUATRO Prices en el MISMO producto que el Price de siempre (así la
// atribución por producto —STRIPE_PRODUCT_IDS— y los cupones acotados a ese
// producto siguen valiendo) y los imprime como las cuatro variables que se pegan
// en Vercel. Los price ids no son secretos.
//
//   · Pro:    licensed, por asiento (quantity = asientos).
//   · Equipo: licensed, «graduated»: primer tramo up_to = asientos incluidos con
//             flat_amount = la cuota fija y unit_amount 0; segundo tramo `inf`
//             con el precio del asiento extra. La cantidad sigue siendo el
//             número de asientos, que es lo que el webhook firma en la licencia.
//
// Uso (desde apps/web):
//   STRIPE_SECRET_KEY=sk_live_… STRIPE_PRICE_ID_MONTHLY=price_… node scripts/provision-planes.mjs
//   # DRY=1 enseña lo que crearía sin crear nada.
//
// ⚠️ LAS CIFRAS de abajo son las de PRECIOS_PROPUESTOS en lib/billing/planes.ts;
// lib/billing/provision-planes.test.ts las ata. Si el dueño cambia la propuesta,
// cambia las dos cosas en el mismo PR ANTES de ejecutar esto.

import Stripe from "stripe";

const PLANES = {
  pro_monthly: { env: "STRIPE_PRICE_ID_PRO_MONTHLY", interval: "month", unit_amount: 1500 },
  pro_yearly: { env: "STRIPE_PRICE_ID_PRO_YEARLY", interval: "year", unit_amount: 15000 },
  team_monthly: { env: "STRIPE_PRICE_ID_TEAM_MONTHLY", interval: "month", incluidos: 10, flat_amount: 12900, extra: 1200 },
  team_yearly: { env: "STRIPE_PRICE_ID_TEAM_YEARLY", interval: "year", incluidos: 10, flat_amount: 129000, extra: 12000 },
};

const key = process.env.STRIPE_SECRET_KEY;
const legado = process.env.STRIPE_PRICE_ID_MONTHLY;
const DRY = process.env.DRY === "1";
if (!key || !legado) {
  console.error("Hacen falta STRIPE_SECRET_KEY y STRIPE_PRICE_ID_MONTHLY (el Price de siempre, para saber el producto).");
  process.exit(1);
}
const stripe = new Stripe(key);

async function main() {
  console.log(`\nModo: ${key.startsWith("sk_live_") ? "LIVE" : "TEST"}${DRY ? " · DRY (no crea nada)" : ""}\n`);
  const base = await stripe.prices.retrieve(legado);
  const product = typeof base.product === "string" ? base.product : base.product.id;
  console.log("Producto (el del Price de siempre):", product);

  // GUARDIA DE NO-REEJECUCIÓN: cada Price lleva un lookup_key; si ya existe, no se duplica.
  const lookupKeys = Object.keys(PLANES).map((k) => `bvsala_${k}`);
  const ya = await stripe.prices.list({ lookup_keys: lookupKeys, limit: 10 });
  if (ya.data.length > 0) {
    console.error("✗ Ya existen Prices con estos lookup_key; no se re-aprovisiona:");
    for (const p of ya.data) console.error(`    ${p.lookup_key} → ${p.id}`);
    process.exit(1);
  }

  const salida = [];
  for (const [nombre, p] of Object.entries(PLANES)) {
    const comun = {
      product,
      currency: "eur",
      recurring: { interval: p.interval },
      lookup_key: `bvsala_${nombre}`,
      nickname: `${nombre.startsWith("pro") ? "PRO sin comisión" : "EQUIPO sin comisión"} (${p.interval === "month" ? "mensual" : "anual"})`,
      metadata: { plan: nombre.startsWith("pro") ? "pro" : "equipo", sin_comision: "true" },
    };
    const params = nombre.startsWith("pro")
      ? { ...comun, unit_amount: p.unit_amount }
      : {
          ...comun,
          billing_scheme: "tiered",
          tiers_mode: "graduated",
          tiers: [
            { up_to: p.incluidos, flat_amount: p.flat_amount, unit_amount: 0 },
            { up_to: "inf", unit_amount: p.extra },
          ],
        };
    if (DRY) {
      console.log("·", nombre, JSON.stringify(params));
      continue;
    }
    const price = await stripe.prices.create(params);
    console.log("✓", nombre, price.id);
    salida.push(`${p.env}=${price.id}`);
  }
  if (salida.length) {
    console.log("\nPega en Vercel (Production y Preview):\n");
    for (const l of salida) console.log(l);
    console.log("\nY añade los cuatro ids a la configuración del portal (scripts/provision-portal.mjs) para que se pueda cambiar de asientos.");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
