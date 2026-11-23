import { rutaParaVercel, urlSinDatos } from "./eventos";

/**
 * LA ETIQUETA DE GOOGLE ADS (gtag.js): dónde se carga y qué se le da. La pidió
 * el dueño el 02-09 para medir las conversiones de los anuncios
 * (ConversionRegistro, en /signup/success).
 *
 * LO QUE HACE GTAG, medido en Chrome contra el build (23-11):
 *  - Al cargar una página usa `page_location`/`page_referrer` si se le dan,
 *    pero en algunas peticiones (`top`; `dl` y `dr` de /ccm/collect) manda la
 *    RUTA real de la página y `document.referrer`. La query y el fragmento de
 *    la carga no los manda; el `gclid` lo lee él mismo (cookie `_gcl_aw`).
 *  - El contenedor (configurado en Google Ads, no aquí) tiene activas las vistas
 *    por cambio de historial CON parámetros: en cada navegación sin recarga
 *    manda la URL entera, query incluida, sin mirar `page_location`. Y los
 *    eventos de formulario (`form_start`, `form_submit`), sin los valores.
 *
 * Por eso (lo fija google-ads.test.ts):
 *  - NO SE CARGA donde la URL lleva un token o un código: la invitación, la
 *    nueva contraseña, un 404 (su ruta puede llevar cualquier cosa) y cualquier
 *    URL cuya query o fragmento traiga un token o un destino `next` hacia una de
 *    esas páginas (`/login?next=/es/invitacion/…`).
 *  - Y si una visita PASA por una de esas URL antes de cargarlo, ya no se carga
 *    en todo ese documento: sus navegaciones sin recarga podrían volver a una
 *    URL con token, y gtag la mandaría entera.
 *  - Donde se carga, `page_location` y `page_referrer` van limpios (la limpieza
 *    de Vercel, `urlSinDatos`; la anterior de otro sitio, solo su origen).
 *  - La página anterior es solo el origen en todo el sitio: Referrer-Policy
 *    `strict-origin` (next.config.mjs).
 *
 * Lo que NO cambia y dice /privacy: gtag pone sus cookies de publicidad, la
 * conversión del alta lleva el id interno de la cuenta como `transaction_id`
 * para que Google no la cuente dos veces, y las navegaciones sin recarga van
 * con su query (aquí: `next`, `plan`, `range`, `periodo`, `checkout`, `error`).
 */

export const ID_GOOGLE_ADS = "AW-18425303387";

/** Las rutas con un token o un código, y la de un 404: ahí no se carga gtag. */
export const RUTAS_SIN_GOOGLE_ADS = ["/[locale]/invitacion/[token]", "/[locale]/reset-password", "/[locale]/[...rest]", "/[...rest]"] as const;

/** Parámetros (de query o de fragmento) que llevan una credencial de un solo uso o de sesión. */
const PARAMETROS_CON_TOKEN = new Set(["code", "token", "token_hash", "access_token", "refresh_token", "provider_token"]);

const rutaVetada = (pathname: string) => (RUTAS_SIN_GOOGLE_ADS as readonly string[]).includes(rutaParaVercel(pathname).route);

/**
 * ¿Puede cargarse gtag con esta URL en la barra? No si su ruta está vetada, si
 * su query o su fragmento traen un token, o si algún parámetro es un destino
 * (`next=…`) hacia una ruta vetada o con token.
 */
export function urlPermiteGoogleAds(href: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (rutaVetada(url.pathname)) return false;
  const parametros = [...url.searchParams, ...new URLSearchParams(url.hash.replace(/^#/, ""))];
  for (const [nombre, valor] of parametros) {
    if (PARAMETROS_CON_TOKEN.has(nombre.toLowerCase())) return false;
    if (valor.startsWith("/") && !urlPermiteGoogleAds(new URL(valor, url.origin).href)) return false;
  }
  return true;
}

/** La página que ve Google: la URL limpia, o el origen si no se puede leer. */
export function ubicacionParaGoogle(href: string): string {
  return urlSinDatos(href) ?? origenDe(href);
}

/**
 * La página anterior que ve Google. De este sitio, limpia como la actual (con
 * `strict-origin` ya llega solo el origen); de otro, solo su origen; sin
 * anterior, vacía.
 */
export function referenteParaGoogle(referrer: string, origen: string): string {
  if (!referrer) return "";
  let url: URL;
  try {
    url = new URL(referrer);
  } catch {
    return "";
  }
  return url.origin === origen ? ubicacionParaGoogle(referrer) : `${url.origin}/`;
}

function origenDe(href: string): string {
  try {
    return `${new URL(href).origin}/`;
  } catch {
    return "";
  }
}
