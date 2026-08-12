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
// Uso (desde apps/web):
//   STRIPE_SECRET_KEY=sk_live_xxx node scripts/provision-portal.mjs
//   # opcional: BVSALA_PORTAL_RETURN_URL=https://savings.bivelio.com/es/dashboard/account

import Stripe from "stripe";

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error("Falta STRIPE_SECRET_KEY:  STRIPE_SECRET_KEY=sk_live_... node scripts/provision-portal.mjs");
  process.exit(1);
}
const live = key.startsWith("sk_live_");
const stripe = new Stripe(key);

const PRECIO_MENSUAL = process.env.STRIPE_PRICE_ID_MONTHLY;
const PRECIO_ANUAL = process.env.STRIPE_PRICE_ID_YEARLY;
if (!PRECIO_MENSUAL || !PRECIO_ANUAL) {
  console.error("Faltan STRIPE_PRICE_ID_MONTHLY y STRIPE_PRICE_ID_YEARLY (los mismos que usa la web).");
  process.exit(1);
}

/** Marca para reconocer NUESTRA configuración y no pisar otra de la cuenta. */
const MARCA = { bvsala_portal: "v1" };

/** Tope de asientos: el MISMO que el panel y el checkout (lib/billing/asientos.ts). */
const MAX_ASIENTOS = 500;

async function main() {
  console.log(`\nModo: ${live ? "REAL" : "TEST"}\n`);

  // El portal admite HASTA 10 productos, y el cliente puede saltar a cualquiera
  // de los precios listados. En esta cuenta el mensual y el anual cuelgan de
  // productos DISTINTOS, asi que se listan los dos: agrupar por producto es lo
  // que hace que el cambio mensual <-> anual siga siendo posible.
  const [mensual, anual] = await Promise.all([
    stripe.prices.retrieve(PRECIO_MENSUAL),
    stripe.prices.retrieve(PRECIO_ANUAL),
  ]);
  const idDeProducto = (p) => (typeof p.product === "string" ? p.product : p.product.id);

  /** producto -> precios suyos que el portal debe ofrecer. */
  const porProducto = new Map();
  for (const precio of [mensual, anual]) {
    const prod = idDeProducto(precio);
    porProducto.set(prod, [...(porProducto.get(prod) ?? []), precio.id]);
  }
  const productos = [...porProducto.entries()].map(([product, prices]) => ({
    product,
    prices,
    // El mismo tope que el resto del producto, para que el panel y Stripe no
    // digan cosas distintas.
    adjustable_quantity: { enabled: true, minimum: 1, maximum: MAX_ASIENTOS },
  }));

  if (porProducto.size === 1) {
    console.log(`✓ Producto: ${[...porProducto.keys()][0]}`);
  } else {
    console.log(`✓ ${porProducto.size} productos (mensual y anual estan separados en esta cuenta):`);
    for (const [prod, precios] of porProducto) console.log(`    ${prod}  ->  ${precios.join(", ")}`);
    console.log(
      "  ⚠ Funciona, pero conviene UNIFICARLOS en un solo producto con dos precios:\n" +
        "    los informes de Stripe agrupan por producto, asi que hoy tus ingresos\n" +
        "    mensuales y anuales salen como dos lineas de negocio distintas.",
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
  console.log("Comprobaciones que conviene hacer a mano en el portal después:");
  console.log("  · que se puede cambiar la CANTIDAD de asientos");
  console.log("  · que cancelar dice «al final del periodo», NO «inmediatamente»");
  console.log("  · que aparecen las facturas y se puede cambiar la tarjeta\n");
}

main().catch((err) => {
  console.error("Falló el aprovisionamiento del portal:", err?.message || err);
  process.exit(1);
});
