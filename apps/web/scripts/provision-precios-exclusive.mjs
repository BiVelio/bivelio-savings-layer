#!/usr/bin/env node
/**
 * CREA LOS PRECIOS CON `tax_behavior: exclusive`, sobre los MISMOS productos.
 *
 * POR QUÉ. Los precios originales se crearon `inclusive`, que significa que el
 * impuesto sale de DENTRO de los 4 €. En una venta B2B intracomunitaria con NIF
 * válido da igual —inversión del sujeto pasivo, 0 %— pero a cualquier cliente sin
 * NIF válido le corresponde IVA, y con `inclusive` ese IVA lo pagamos nosotros:
 * al 21 % los 4 € se quedan en 3,31. Con `exclusive` el cliente paga 4 € + IVA y
 * el margen no se mueve nunca. Nunca se pierde con `exclusive`, y a veces se gana.
 *
 * ⚠️ `tax_behavior` NO SE PUEDE CAMBIAR en un precio existente. Stripe obliga a
 * crear uno nuevo, y las suscripciones vivas se quedan con el viejo — por eso esto
 * se hace con UNA suscripción y no con cincuenta.
 *
 * ⚠️ LA TRAMPA QUE ESTO OBLIGA A CERRAR. El webhook atribuye los eventos por
 * `price_id` (`lib/stripe/atribucion.ts`), porque esta cuenta de Stripe la
 * comparten BV-SALA y BV-PRGA y cada endpoint recibe también los eventos del
 * otro. Si se cambian los precios y no se hace nada más, la RENOVACIÓN de la
 * suscripción que ya existe llegaría con el precio VIEJO, no estaría en la lista,
 * y se descartaría como ajena: un cobro real perdido en silencio.
 *
 * Por eso el script imprime al final las TRES variables que hay que fijar, y la
 * primera es `STRIPE_PRODUCT_IDS`: la atribución por PRODUCTO sobrevive a
 * cualquier cambio de precio, que es el modo de fallo natural de un catálogo.
 *
 * Idempotente: si ya existe un precio `exclusive` con el mismo importe, moneda e
 * intervalo en ese producto, lo reutiliza en vez de crear otro.
 *
 *   node --env-file=<fichero-con-STRIPE_SECRET_KEY> scripts/provision-precios-exclusive.mjs
 */
import Stripe from "stripe";

const clave = process.env.STRIPE_SECRET_KEY;
if (!clave) {
  console.error("Falta STRIPE_SECRET_KEY.");
  process.exit(1);
}
const stripe = new Stripe(clave);

const VIEJOS = [process.env.STRIPE_PRICE_ID_MONTHLY, process.env.STRIPE_PRICE_ID_YEARLY].filter(Boolean);
if (VIEJOS.length !== 2) {
  console.error("Faltan STRIPE_PRICE_ID_MONTHLY / STRIPE_PRICE_ID_YEARLY: sin ellos no se sabe qué clonar.");
  process.exit(1);
}

const nuevos = [];
const productos = new Set();

for (const id of VIEJOS) {
  const viejo = await stripe.prices.retrieve(id);
  const producto = typeof viejo.product === "string" ? viejo.product : viejo.product.id;
  productos.add(producto);

  const intervalo = viejo.recurring?.interval;
  if (!intervalo) throw new Error(`${id} no es un precio recurrente`);

  if (viejo.tax_behavior === "exclusive") {
    console.log(`  ${intervalo}: ${id} YA es exclusive, no se toca.`);
    nuevos.push({ intervalo, id });
    continue;
  }

  // ¿Ya existe el gemelo exclusive? Idempotencia: este script se ejecuta más de
  // una vez (una en seco, otra de verdad) y no puede llenar el catálogo de
  // duplicados que luego nadie sabe cuál es cuál.
  const existentes = await stripe.prices.list({ product: producto, active: true, limit: 100 });
  const gemelo = existentes.data.find(
    (p) =>
      p.tax_behavior === "exclusive" &&
      p.unit_amount === viejo.unit_amount &&
      p.currency === viejo.currency &&
      p.recurring?.interval === intervalo &&
      p.recurring?.interval_count === viejo.recurring?.interval_count,
  );
  if (gemelo) {
    console.log(`  ${intervalo}: reutilizo ${gemelo.id} (ya existía exclusive)`);
    nuevos.push({ intervalo, id: gemelo.id });
    continue;
  }

  const creado = await stripe.prices.create({
    product: producto,
    currency: viejo.currency,
    unit_amount: viejo.unit_amount,
    recurring: { interval: intervalo, interval_count: viejo.recurring.interval_count ?? 1 },
    tax_behavior: "exclusive",
    // El mismo producto y el mismo importe: lo ÚNICO que cambia es quién paga el
    // impuesto. Se deja constancia de a quién sustituye, para que dentro de un año
    // se pueda reconstruir por qué hay dos precios iguales.
    metadata: { sustituye_a: viejo.id, motivo: "tax_behavior inclusive -> exclusive" },
    nickname: `${intervalo === "year" ? "Annual" : "Monthly"} seat (excl. tax)`,
  });
  console.log(`  ${intervalo}: creado ${creado.id} · ${(creado.unit_amount ?? 0) / 100} ${creado.currency.toUpperCase()} · exclusive`);
  nuevos.push({ intervalo, id: creado.id });
}

const mensual = nuevos.find((n) => n.intervalo === "month")?.id;
const anual = nuevos.find((n) => n.intervalo === "year")?.id;

console.log("\n─── VARIABLES DE ENTORNO ───────────────────────────────────────");
console.log("Las tres, y en este orden de importancia:\n");
console.log(`STRIPE_PRODUCT_IDS=${[...productos].join(",")}`);
console.log("  ↑ la atribución por PRODUCTO sobrevive a cualquier cambio de precio.");
console.log(`STRIPE_PRICE_IDS_EXTRA=${VIEJOS.join(",")}`);
console.log("  ↑ los precios VIEJOS. La suscripción que ya existe renueva con ellos:");
console.log("    sin esto, ese cobro se descartaría como ajeno.");
console.log(`STRIPE_PRICE_ID_MONTHLY=${mensual}`);
console.log(`STRIPE_PRICE_ID_YEARLY=${anual}`);
console.log("  ↑ lo que se le ofrece a quien compra a partir de ahora.");
console.log("────────────────────────────────────────────────────────────────");
