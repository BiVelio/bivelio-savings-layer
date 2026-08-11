import type { Importe } from "@/lib/stripe/pricing";

/**
 * Formatea el precio de SUSCRIPCIÓN para mostrarlo.
 *
 * NO confundir con `app/[locale]/dashboard/format.ts`, cuyo `money()` fija `"$"` y
 * abrevia a `$1.2k`: ese formatea el GASTO EN TOKENS del proveedor, que está en dólares
 * con razón —es lo que cobra OpenAI— y lo consumen diez componentes del panel. Son dos
 * monedas distintas conviviendo en el mismo producto, y mezclarlas rompería el cálculo
 * de ahorro.
 *
 * DOS REGLAS DE DETERMINISMO, y las dos vienen de un fallo real:
 *
 *  1. El `locale` se pasa SIEMPRE explícito, nunca se infiere del runtime.
 *     `dashboard/format.ts:11-16` documenta que `toLocaleString()` sin locale rompió la
 *     hidratación de React (error #418): el servidor pintaba "1,212" y el navegador en
 *     español "1.212", y esa diferencia de TEXTO tumbaba el componente.
 *  2. Esta función se llama SOLO EN EL SERVIDOR, y a los componentes de cliente les baja
 *     la cadena ya formateada como prop. `Intl.NumberFormat` puede diferir entre la ICU
 *     de Node y la del navegador en detalles invisibles —el tipo de espacio antes del
 *     símbolo, por ejemplo—, así que formatear en los dos lados reabriría exactamente el
 *     mismo problema por otra puerta.
 */
/**
 * Monedas SIN decimales. Stripe las expresa en unidades ENTERAS, no en centésimas,
 * así que dividir entre 100 daría un importe 100 veces menor. Hoy solo cobramos en
 * euros, pero el fallo sería silencioso y de una magnitud absurda el día que no.
 * Lista de Stripe (https://docs.stripe.com/currencies#zero-decimal).
 */
const SIN_DECIMALES = new Set([
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga",
  "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf",
]);

export function formatearPrecio(locale: string, importe: Importe): string {
  const codigo = importe.currency.toUpperCase();
  const divisor = SIN_DECIMALES.has(importe.currency.toLowerCase()) ? 1 : 100;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: codigo,
    // Oculta los decimales SOLO si son cero: "4 €" se lee mejor que "4,00 €" en una
    // tarjeta de precio, pero el día que el importe sea 4,50 € se muestra entero. Un
    // `maximumFractionDigits: 0` fijo lo redondearía a "5 €", que sería mentir — justo
    // lo que este módulo existe para evitar.
    trailingZeroDisplay: "stripIfInteger",
  }).format(importe.amount / divisor);
}
