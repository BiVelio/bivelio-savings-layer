/**
 * Crea en Stripe los dos productos de BiVelio Savings, con la misma jerga que
 * BiVelio Shield: dos productos separados, precio por asiento en EUR.
 *
 *   BiVelio Savings — Monthly seat   4,00 €/asiento/mes
 *   BiVelio Savings — Annual seat   39,00 €/asiento/año
 *
 * Cero dependencias: usa `fetch` contra la API de Stripe. Tu clave secreta se lee
 * del entorno y NUNCA se escribe ni se versiona.
 *
 * USO (en TU terminal, no en el chat):
 *   cd /Users/fisagol/bivelio-savings-layer
 *   STRIPE_SECRET_KEY=sk_live_xxx node apps/web/scripts/create-savings-products.mjs
 *
 * Solo crea catálogo (productos + precios). NO crea webhooks, NO cobra a nadie,
 * NO toca clientes. Al terminar imprime los dos price_id para configurar el
 * entorno. Es seguro re-ejecutarlo: Stripe permite productos con el mismo nombre,
 * pero para no duplicar, si ya los creaste, no lo vuelvas a correr.
 */

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error("Falta STRIPE_SECRET_KEY en el entorno. Ejemplo:");
  console.error("  STRIPE_SECRET_KEY=sk_live_xxx node apps/web/scripts/create-savings-products.mjs");
  process.exit(1);
}
const modo = key.startsWith("sk_live_") ? "PRODUCCION (live)" : key.startsWith("sk_test_") ? "PRUEBA (test)" : "DESCONOCIDO";
console.log(`Clave detectada: modo ${modo}\n`);

/** POST form-encoded a la API de Stripe. */
async function stripe(path, params) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) body.append(k, String(v));
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const j = await r.json();
  if (!r.ok) {
    throw new Error(`Stripe ${path} -> ${r.status}: ${j.error?.message ?? JSON.stringify(j)}`);
  }
  return j;
}

async function crearProductoConPrecio(nombre, unitAmount, interval, nickname) {
  const product = await stripe("products", {
    name: nombre,
    "metadata[app]": "bivelio-savings",
  });
  console.log(`✓ Producto: ${nombre}  (${product.id})`);
  const price = await stripe("prices", {
    product: product.id,
    currency: "eur",
    unit_amount: String(unitAmount), // en céntimos
    "recurring[interval]": interval, // 'month' | 'year'
    "recurring[usage_type]": "licensed", // por asiento (cantidad), no medido
    nickname,
    "metadata[app]": "bivelio-savings",
  });
  console.log(`  precio: ${(unitAmount / 100).toFixed(2)} €/asiento/${interval === "month" ? "mes" : "año"}  ->  ${price.id}`);
  return price.id;
}

try {
  console.log("Creando catálogo de BiVelio Savings...\n");
  const monthly = await crearProductoConPrecio("BiVelio Savings — Monthly seat", 400, "month", "Savings monthly (per seat)");
  const annual = await crearProductoConPrecio("BiVelio Savings — Annual seat", 3900, "year", "Savings annual (per seat)");

  console.log("\n────────────────────────────────────────────────");
  console.log("LISTO. Pega estos dos valores cuando configuremos el entorno:\n");
  console.log(`  STRIPE_PRICE_MONTHLY=${monthly}`);
  console.log(`  STRIPE_PRICE_ANNUAL=${annual}`);
  console.log("────────────────────────────────────────────────");
} catch (err) {
  console.error("\n✗ Error:", err.message);
  process.exit(1);
}
