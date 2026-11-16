import type { CatalogoDeComision, PlanDePago, PreciosConfigurados } from "@/lib/billing/planes";

// Stripe configuration, read from the environment (mirrors lib/supabase/env.ts).
// The secret + webhook signing secret are SERVER-ONLY; the publishable key is
// public. `billingConfigured` gates the routes so an unconfigured deploy fails
// closed (501) rather than half-working.

export const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "";
export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";
export const STRIPE_PRICE_ID_MONTHLY = process.env.STRIPE_PRICE_ID_MONTHLY ?? "";
export const STRIPE_PRICE_ID_YEARLY = process.env.STRIPE_PRICE_ID_YEARLY ?? "";
// LOS PLANES SIN COMISIÓN (2026-09-29, lib/billing/planes.ts). Los dos de arriba
// siguen siendo la modalidad «comision» de siempre (cerrada a clientes nuevos:
// ya no se vende, pero sus suscripciones vivas se reconocen y cobran igual);
// estos cuatro son los Prices de Pro y Equipo que crea el dueño en Stripe.
// Vacíos = el plan no se vende todavía (el checkout responde 501 para ese plan)
// y /pricing pinta la cifra de respaldo de planes.ts.
export const STRIPE_PRICE_ID_PRO_MONTHLY = process.env.STRIPE_PRICE_ID_PRO_MONTHLY ?? "";
export const STRIPE_PRICE_ID_PRO_YEARLY = process.env.STRIPE_PRICE_ID_PRO_YEARLY ?? "";
export const STRIPE_PRICE_ID_TEAM_MONTHLY = process.env.STRIPE_PRICE_ID_TEAM_MONTHLY ?? "";
export const STRIPE_PRICE_ID_TEAM_YEARLY = process.env.STRIPE_PRICE_ID_TEAM_YEARLY ?? "";
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

/**
 * The Stripe Price id for a plan and period (empty string if not configured).
 * «comision» is the historical per-seat price above — unchanged.
 */
export function priceIdForPlan(plan: PlanDePago, period: BillingPeriod): string {
  if (plan === "pro") return period === "yearly" ? STRIPE_PRICE_ID_PRO_YEARLY : STRIPE_PRICE_ID_PRO_MONTHLY;
  if (plan === "equipo") return period === "yearly" ? STRIPE_PRICE_ID_TEAM_YEARLY : STRIPE_PRICE_ID_TEAM_MONTHLY;
  return priceIdFor(period);
}

/** Los Prices de los planes SIN comisión que tiene este despliegue (para `planDelPrecio`). */
export function preciosSinComision(): PreciosConfigurados {
  return {
    pro: [STRIPE_PRICE_ID_PRO_MONTHLY, STRIPE_PRICE_ID_PRO_YEARLY].filter(Boolean),
    equipo: [STRIPE_PRICE_ID_TEAM_MONTHLY, STRIPE_PRICE_ID_TEAM_YEARLY].filter(Boolean),
  };
}

const listaDelEntorno = (nombre: string): string[] =>
  (process.env[nombre] ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * EL CATÁLOGO QUE DECIDE LA COMISIÓN (lib/billing/plan-de-la-org.ts). Cada
 * Price de una suscripción nuestra tiene que estar DECLARADO en una de estas
 * listas; el cierre no sella el extracto de una organización con un Price que
 * no esté en ninguna (alerta crítica, se relanza al declararlo).
 *
 * · `comision` — los que LLEVAN comisión: STRIPE_PRICE_ID_MONTHLY / YEARLY (los
 *   vigentes de la modalidad histórica) y, separados por comas,
 *   STRIPE_PRICE_IDS_COMISION.
 *   ⛔ STRIPE_PRICE_IDS_COMISION TIENE QUE INCLUIR LOS PRICES DE COMISIÓN
 *   ROTADOS: el 2026-08-13 (#53, scripts/provision-precios-exclusive.mjs)
 *   MONTHLY/YEARLY pasaron a apuntar a los Prices `exclusive` nuevos y los
 *   anteriores —con los que sigue renovando quien se suscribió antes— quedaron
 *   SOLO en STRIPE_PRICE_IDS_EXTRA. También el de un contrato Enterprise que
 *   lleve comisión.
 * · `pro`, `equipo` — los cuatro Prices de cuota fija.
 * · `sinComision` — STRIPE_PRICE_IDS_SIN_COMISION: cualquier otro Price que NO
 *   la lleva (cortesía, socio, contrato de cuota fija).
 *
 * STRIPE_PRICE_IDS_EXTRA no clasifica nada: es el escape de la ATRIBUCIÓN
 * («este evento es nuestro»), y mezcla Prices con comisión (los rotados) y sin
 * ella (cortesías). Por eso un Price que solo está ahí es DESCONOCIDO.
 *
 * Las listas extra se leen del entorno en cada llamada, como el escape de
 * lib/stripe/atribucion.ts.
 */
export function catalogoDeComision(): CatalogoDeComision {
  return {
    comision: [...new Set([STRIPE_PRICE_ID_MONTHLY, STRIPE_PRICE_ID_YEARLY, ...listaDelEntorno("STRIPE_PRICE_IDS_COMISION")].filter(Boolean))],
    ...preciosSinComision(),
    sinComision: listaDelEntorno("STRIPE_PRICE_IDS_SIN_COMISION"),
  };
}
