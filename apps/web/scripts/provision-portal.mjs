// Configuración del PORTAL DE FACTURACIÓN de Stripe, desde código.
//
// POR QUÉ NO EL INTERRUPTOR DEL PANEL. `subscription_update` viene DESACTIVADO
// por defecto, así que un cliente que crece no podía cambiar sus asientos: el
// checkout le devuelve 409 diciéndole que use «Gestionar plan», y esa puerta
// estaba cerrada. Se puede abrir con un clic en el panel de Stripe, pero este
// repositorio ya tiene la cicatriz de hacerlo así: en agosto los correos de Auth
// se rompieron porque alguien arregló la configuración VIVA y no el repositorio,
// y el fallo habría vuelto al siguiente repegado. Config viva y repo van juntos.
//
// A DIFERENCIA de `provision-stripe.mjs`, este script SÍ es idempotente: busca su
// propia configuración por metadata y la ACTUALIZA en vez de crear otra.
//
// QUÉ PRECIOS OFRECE: los de los planes EN VENTA, Pro y Team (los cuatro de
// `scripts/provision-planes.mjs`, mensual y anual). El plan con comisión
// (STRIPE_PRICE_ID_MONTHLY/YEARLY) está cerrado a clientes nuevos y se deja
// FUERA a propósito: el portal deja saltar a cualquier precio listado, y no debe
// ofrecerle a nadie el plan que /pricing da por cerrado. Quien todavía lo tiene
// conserva su suscripción, su tarjeta, sus facturas y la cancelación; cambiar de
// asientos desde el portal depende de que su precio esté en la lista, así que
// conviene comprobarlo con un cliente de prueba de ese plan después de ejecutar.
//
// Uso (desde apps/web). LO EJECUTA EL DUEÑO, a mano — nunca un agente:
//   STRIPE_SECRET_KEY=sk_live_xxx \
//   STRIPE_PRICE_ID_PRO_MONTHLY=price_… STRIPE_PRICE_ID_PRO_YEARLY=price_… \
//   STRIPE_PRICE_ID_TEAM_MONTHLY=price_… STRIPE_PRICE_ID_TEAM_YEARLY=price_… \
//   node scripts/provision-portal.mjs
//   # opcional: BVSALA_PORTAL_RETURN_URL=https://savings.bivelio.com/es/dashboard/account
// Las cuatro variables son las mismas que lee la web (lib/stripe/env.ts).
// lib/billing/provision-portal.test.ts ejecuta el script contra un Stripe falso.

import Stripe from "stripe";

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error("Falta STRIPE_SECRET_KEY:  STRIPE_SECRET_KEY=sk_live_... node scripts/provision-portal.mjs");
  process.exit(1);
}
const live = key.startsWith("sk_live_");
const stripe = new Stripe(key);

/** Los precios EN VENTA (Pro y Team, mensual y anual). Nunca los del plan cerrado. */
const VARIABLES_EN_VENTA = [
  "STRIPE_PRICE_ID_PRO_MONTHLY",
  "STRIPE_PRICE_ID_PRO_YEARLY",
  "STRIPE_PRICE_ID_TEAM_MONTHLY",
  "STRIPE_PRICE_ID_TEAM_YEARLY",
];
const faltan = VARIABLES_EN_VENTA.filter((v) => !process.env[v]);
if (faltan.length > 0) {
  console.error(`Faltan ${faltan.join(", ")} (los mismos que usa la web; los imprime scripts/provision-planes.mjs).`);
  process.exit(1);
}
const PRECIOS_EN_VENTA = VARIABLES_EN_VENTA.map((v) => process.env[v]);

/** Marca para reconocer NUESTRA configuración y no pisar otra de la cuenta. */
const MARCA = { bvsala_portal: "v1" };

/** Tope de asientos: el MISMO que el panel y el checkout (lib/billing/asientos.ts). */
const MAX_ASIENTOS = 500;

async function main() {
  console.log(`\nModo: ${live ? "REAL" : "TEST"}\n`);

  // El portal admite HASTA 10 productos, y el cliente puede saltar a cualquiera
  // de los precios listados (Pro <-> Team, mensual <-> anual). Se agrupan por
  // producto, que es como lo pide Stripe: provision-planes.mjs los crea todos
  // en el mismo, pero si alguno cuelga de otro, sale como otra entrada.
  const precios = await Promise.all(PRECIOS_EN_VENTA.map((id) => stripe.prices.retrieve(id)));
  const idDeProducto = (p) => (typeof p.product === "string" ? p.product : p.product.id);

  /** producto -> precios suyos que el portal debe ofrecer. */
  const porProducto = new Map();
  for (const precio of precios) {
    const prod = idDeProducto(precio);
    porProducto.set(prod, [...(porProducto.get(prod) ?? []), precio.id]);
  }
  const productos = [...porProducto.entries()].map(([product, prices]) => ({
    product,
    prices,
    // El mismo tope que el resto del producto, para que el panel y Stripe no
    // digan cosas distintas. El MÍNIMO es por producto y Pro y Team lo comparten,
    // así que no puede ser el de Team (10): si un cliente Team baja de 10, Stripe
    // le sigue cobrando la cuota de 10 y el webhook firma 10 (A2-20, subFacts).
    adjustable_quantity: { enabled: true, minimum: 1, maximum: MAX_ASIENTOS },
  }));

  if (porProducto.size === 1) {
    console.log(`✓ Producto: ${[...porProducto.keys()][0]}`);
  } else {
    console.log(`✓ ${porProducto.size} productos (los precios en venta no cuelgan todos del mismo):`);
    for (const [prod, ids] of porProducto) console.log(`    ${prod}  ->  ${ids.join(", ")}`);
    console.log(
      "  ⚠ Funciona, pero conviene UNIFICARLOS en un solo producto:\n" +
        "    los informes de Stripe agrupan por producto, asi que hoy tus ingresos\n" +
        "    salen como lineas de negocio distintas.",
    );
  }

  const features = {
    // Lo mínimo imprescindible: sin esto, el aviso de impago del panel manda al
    // cliente a una pantalla donde no puede arreglar su tarjeta.
    payment_method_update: { enabled: true },
    invoice_history: { enabled: true },
    customer_update: { enabled: true, allowed_updates: ["email", "address", "name", "tax_id"] },

    subscription_update: {
      enabled: true,
      // `quantity` = crecer y decrecer en asientos. `price` = mensual <-> anual.
      default_allowed_updates: ["quantity", "price"],
      products: productos,
      // Se factura EN EL MOMENTO de ampliar (decisión del dueño, 2026-08-12).
      proration_behavior: "always_invoice",
    },

    // ⚠️ `at_period_end`, y NO es una preferencia: es un requisito que impone
    // nuestro propio código. `handleSubDeleted` revoca TODAS las licencias vivas
    // en cuanto llega `customer.subscription.deleted`. Con cancelación inmediata,
    // un cliente que ha pagado el mes entero y cancela el día 5 se quedaría sin
    // servicio EN PRODUCCIÓN con 25 días pagados por delante. Con `at_period_end`
    // Stripe manda un `updated` con `cancel_at_period_end` (que no revoca nada) y
    // el `deleted` llega el último día, que es cuando toca revocar.
    subscription_cancel: {
      enabled: true,
      mode: "at_period_end",
      cancellation_reason: {
        enabled: true,
        options: ["too_expensive", "missing_features", "switched_service", "unused", "other"],
      },
    },
  };

  const business_profile = {
    headline: "BiVelio Savings Layer — gestiona tu plan",
    privacy_policy_url: "https://bivelio.com/privacy",
    terms_of_service_url: "https://bivelio.com/terms",
  };

  // Idempotencia: si ya existe LA NUESTRA, se actualiza.
  const existentes = await stripe.billingPortal.configurations.list({ limit: 100 });
  const mia = existentes.data.find((c) => c.metadata?.bvsala_portal === MARCA.bvsala_portal);

  const conf = mia
    ? await stripe.billingPortal.configurations.update(mia.id, { features, business_profile })
    : await stripe.billingPortal.configurations.create({
        features,
        business_profile,
        metadata: MARCA,
      });

  console.log(`✓ Configuración del portal ${mia ? "ACTUALIZADA" : "CREADA"}: ${conf.id}`);
  console.log("\n──────────────  pega esto en Vercel (Production)  ──────────────");
  console.log(`STRIPE_PORTAL_CONFIGURATION_ID=${conf.id}`);
  console.log("────────────────────────────────────────────────────────────────\n");
  console.log("Comprobaciones que conviene hacer a mano en el portal después (con un cliente Pro y otro Team de prueba):");
  console.log("  · que se puede cambiar la CANTIDAD de asientos");
  console.log("  · que solo aparecen Pro y Team, nunca el plan con comisión");
  console.log("  · que cancelar dice «al final del periodo», NO «inmediatamente»");
  console.log("  · que aparecen las facturas y se puede cambiar la tarjeta\n");
}

main().catch((err) => {
  console.error("Falló el aprovisionamiento del portal:", err?.message || err);
  process.exit(1);
});
