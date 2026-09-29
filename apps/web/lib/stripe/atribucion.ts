import { STRIPE_PRICE_ID_MONTHLY, STRIPE_PRICE_ID_YEARLY } from "./env";

/**
 * ¿ESTE EVENTO DE STRIPE ES NUESTRO?
 *
 * EL INCIDENTE QUE LO TRAE (2026-08-12). BV-SALA y BV-PRGA comparten la MISMA
 * cuenta de Stripe, y Stripe entrega los webhooks por TIPO de evento, no por
 * producto: cada endpoint recibe también los del otro. Los dos productos usan
 * además la misma clave `metadata.org_id`, con uuids de esquemas distintos, y
 * ninguno comprobaba que la organización fuese suya.
 *
 * Resultado: nuestro webhook intentaba insertar en `bvsala.subscriptions` un
 * `org_id` de `bvprga`, la clave ajena lo rechazaba, se lanzaba, la ruta devolvía
 * 503 y Stripe reintentaba. En espejo, su endpoint llevaba cinco horas y media
 * atragantado con los nuestros. Los dos endpoints acaban DESHABILITADOS por
 * Stripe si eso se sostiene — y ahí sí se cae el cobro entero, de los dos
 * productos, sin dar la cara.
 *
 * ⚠️ POR QUÉ NO SE ATRIBUYE POR «el org_id no existe en bvsala». Es la regla que
 * parece obvia y es una trampa: un evento NUESTRO al que se le haya perdido el
 * metadato —que es un fallo real, grave y silencioso, el que la alerta de la fase
 * 3 existe para cazar— se confundiría con uno ajeno y se silenciaría. Perderíamos
 * exactamente la señal que más nos importa.
 *
 * Se atribuye por PRICE ID, que viene del CATÁLOGO de Stripe y no de un metadato
 * que alguien pudo olvidar poner. Un precio nuestro no puede aparecer en la
 * suscripción de otro producto.
 */

export type Atribucion =
  /** Lleva uno de nuestros precios: es nuestro, se procesa. */
  | "nuestro"
  /** Lleva un precio que no es nuestro: es de otro producto de la misma cuenta. */
  | "ajeno"
  /**
   * No hay señal con la que decidir. NO es lo mismo que "ajeno": aquí puede haber
   * un evento nuestro con algo roto, y eso hay que verlo, no taparlo.
   */
  | "sin_senal";

const lista = (s: string | undefined): string[] =>
  (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

/** Nuestros precios, filtrando los que no estén configurados. */
export function preciosPropios(): string[] {
  return [
    ...lista(STRIPE_PRICE_ID_MONTHLY),
    ...lista(STRIPE_PRICE_ID_YEARLY),
    // Los planes sin comisión (lib/billing/planes.ts): tan nuestros como el de
    // siempre. Sin ellos, el primer evento de una suscripción Pro o Equipo se
    // descartaría como «ajeno» y el cliente pagaría sin licencia. Se leen del
    // entorno aquí (los nombres son los de env.ts) igual que el escape de abajo.
    ...lista(process.env.STRIPE_PRICE_ID_PRO_MONTHLY),
    ...lista(process.env.STRIPE_PRICE_ID_PRO_YEARLY),
    ...lista(process.env.STRIPE_PRICE_ID_TEAM_MONTHLY),
    ...lista(process.env.STRIPE_PRICE_ID_TEAM_YEARLY),
    // Escape para precios que no pasan por el catálogo normal (cortesía, socio,
    // un nivel nuevo — el esquema ya admite `team` y `enterprise` desde 0001).
    // Sin esto, una suscripción NUESTRA sobre un precio que el despliegue no
    // conoce se descartaría por error.
    ...lista(process.env.STRIPE_PRICE_IDS_EXTRA),
  ];
}

/**
 * Nuestros PRODUCTOS. Segunda señal, y con un modo de fallo distinto al de los
 * precios: un price id ROTA cada vez que se cambia el importe; el product id no.
 * Si el precio no se reconoce pero el producto sí, el evento es nuestro.
 */
export function productosPropios(): string[] {
  return lista(process.env.STRIPE_PRODUCT_IDS);
}

/**
 * @param priceId   el `price.id` del primer item de la suscripción del evento.
 * @param productId el `price.product` de ese mismo item, si se conoce.
 */
export function atribuirPorPrecio(
  priceId: string | null | undefined,
  productId?: string | null,
): Atribucion {
  // El producto manda cuando se conoce: sobrevive a un cambio de precio, que es
  // el modo de fallo natural del catálogo.
  const productos = productosPropios();
  if (productId && productos.length > 0) {
    return productos.includes(productId) ? "nuestro" : "ajeno";
  }
  const nuestros = preciosPropios();
  // EL CATÁLOGO TIENE QUE ESTAR COMPLETO PARA PODER DESCARTAR NADA. Son dos
  // precios (mensual y anual); con uno solo configurado, una renovación ANUAL
  // nuestra se vería como ajena y se descartaría en silencio — un cobro real
  // perdido por una variable de entorno a medias. Con el catálogo incompleto se
  // devuelve "sin_senal", que se procesa y avisa: ruidoso en vez de mudo.
  if (nuestros.length < 2) return "sin_senal";
  if (!priceId) return "sin_senal";
  return nuestros.includes(priceId) ? "nuestro" : "ajeno";
}
