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

/**
 * EL CATÁLOGO QUE DECIDE LA COMISIÓN (lib/billing/plan-de-la-org.ts). Solo se
 * cobra comisión a una suscripción cuyo Price está en `comision`, y esa lista es
 * EXPLÍCITA: los dos Prices de la modalidad histórica (STRIPE_PRICE_ID_MONTHLY /
 * YEARLY) y, separados por comas, los de STRIPE_PRICE_IDS_COMISION — para un
 * Price con comisión que ya no es el vigente (uno rotado al cambiar el importe,
 * o el de un contrato Enterprise que la lleve).
 *
 * ⛔ STRIPE_PRICE_IDS_EXTRA NO entra: es el escape de la ATRIBUCIÓN («este
 * evento es nuestro»: cortesías, socios), no una declaración de que el Price
 * lleve comisión. Lo que no está aquí no se cobra (LICENSE-CLOUD §6(b)).
 *
 * La lista extra se lee del entorno en cada llamada, como el escape de
 * lib/stripe/atribucion.ts.
 */
export function catalogoDeComision(): CatalogoDeComision {
  const extra = (process.env.STRIPE_PRICE_IDS_COMISION ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  return {
    comision: [...new Set([STRIPE_PRICE_ID_MONTHLY, STRIPE_PRICE_ID_YEARLY, ...extra].filter(Boolean))],
    ...preciosSinComision(),
  };
}
