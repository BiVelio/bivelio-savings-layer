import { unstable_cache } from "next/cache";

import { getStripe } from "./client";
import { billingConfigured, priceIdFor, type BillingPeriod } from "./env";

/**
 * El precio del plan, leído del objeto Price de Stripe.
 *
 * POR QUÉ EXISTE: el importe estaba escrito a mano en cuatro sitios —los 12 ficheros
 * de traducción, dos componentes del panel, la landing estática y el README— y ninguno
 * se hablaba con Stripe. El resultado fue que la web anunciaba dólares mientras Stripe
 * cobraba euros, y que cambiar el precio exigía 24 ediciones sin que nada avisara si se
 * olvidaba una. Ahora la fuente de verdad es la misma que cobra.
 */
export type Importe = {
  /** En la unidad mínima de la moneda (céntimos para EUR). */
  amount: number;
  /** Código ISO en minúsculas, tal como lo devuelve Stripe ("eur"). */
  currency: string;
};

export type PreciosDelPlan = { monthly: Importe; yearly: Importe };

/**
 * Respaldo. Coincide con lo que crean los scripts de aprovisionamiento
 * (`scripts/provision-stripe.mjs:45-55`): 4,00 € y 39,00 €.
 *
 * **Este es el ÚNICO literal de precio que debe quedar en todo el repositorio.** Si
 * hace falta cambiar el precio, se cambia en Stripe y aquí; nunca en un texto.
 */
export const PRECIO_RESPALDO: PreciosDelPlan = {
  monthly: { amount: 400, currency: "eur" },
  yearly: { amount: 3900, currency: "eur" },
};

async function importeDe(period: BillingPeriod): Promise<Importe> {
  const price = await getStripe().prices.retrieve(priceIdFor(period));
  if (typeof price.unit_amount !== "number" || !price.currency) {
    throw new Error(`El Price ${period} no tiene unit_amount/currency utilizables.`);
  }
  return { amount: price.unit_amount, currency: price.currency };
}

/**
 * La lectura cacheada. La landing es pública: no puede llamar a la API de Stripe en
 * cada visita. Una hora es de sobra — el precio de un SaaS no cambia a diario — y
 * `revalidateTag("precios")` permite forzar el refresco si algún día hace falta.
 *
 * Si la llamada falla, esto LANZA a propósito: así el fallo NO se cachea y el
 * siguiente render lo reintenta, en vez de servir el respaldo durante una hora por un
 * corte de dos segundos.
 */
const leerCacheado = unstable_cache(
  async (): Promise<PreciosDelPlan> => ({
    monthly: await importeDe("monthly"),
    yearly: await importeDe("yearly"),
  }),
  ["bvsala-precios-del-plan"],
  { revalidate: 3600, tags: ["precios"] },
);

let avisado = false;
function respaldo(motivo: unknown): PreciosDelPlan {
  // Una vez por proceso: si esto pasara en bucle, el log dejaría de leerse justo
  // cuando más falta hace. Pero silencio total tampoco: una landing que anuncia un
  // precio distinto del que se cobra es exactamente el fallo que este módulo cierra.
  if (!avisado) {
    avisado = true;
    console.warn(
      "[bvsala] no se pudo leer el precio de Stripe; se usa el respaldo de pricing.ts. " +
        "Si el Price real ha cambiado, la web está anunciando un importe que NO es el que " +
        "se cobra. Motivo:",
      motivo instanceof Error ? motivo.message : motivo,
    );
  }
  return PRECIO_RESPALDO;
}

/**
 * El precio para pintar. Falla ABIERTO —al revés que el resto de este directorio, que
 * falla cerrado— porque una página de precios sin precio es peor que un precio
 * cacheado: aquí no se cobra nada, solo se muestra.
 */
export async function preciosDelPlan(): Promise<PreciosDelPlan> {
  if (!billingConfigured || !priceIdFor("monthly") || !priceIdFor("yearly")) {
    return respaldo("Stripe no está configurado en este entorno");
  }
  try {
    return await leerCacheado();
  } catch (err) {
    return respaldo(err);
  }
}
