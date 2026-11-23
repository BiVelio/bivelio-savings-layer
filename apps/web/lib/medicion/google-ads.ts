import { rutaParaVercel, urlSinDatos } from "./eventos";

/**
 * LA ETIQUETA DE GOOGLE ADS (gtag.js): dónde corre y qué se le da. La pidió el
 * dueño el 02-09 para medir las conversiones de los anuncios
 * (ConversionRegistro, en /signup/success).
 *
 * LO QUE HACE GTAG, medido en Chrome contra el build, detrás de HTTPS (23-11):
 *  - Al cargar una página usa `page_location`/`page_referrer` si se le dan,
 *    pero en algunas peticiones (`top`; `dl` y `dr` de /ccm/collect) manda la
 *    ruta real de la página y `document.referrer` tal cual.
 *  - `page_location` dado en `config` manda sobre `set` y se queda pegado a la
 *    primera página: la página limpia va solo en `set`, refijada en cada
 *    navegación.
 *  - El contenedor (configurado en Google Ads, no aquí) tiene activas las vistas
 *    por cambio de historial CON parámetros (en cada navegación sin recarga
 *    manda `url` y `ref` enteros, query incluida), los eventos de formulario y
 *    la recogida automática de datos de usuario: en HTTPS manda el SHA-256 del
 *    correo escrito en un formulario (`em=tv.1~em.…`).
 *
 * Por eso (lo fija google-ads.test.ts):
 *  - SOLO CORRE EN LAS PÁGINAS PÚBLICAS SIN FORMULARIOS y en la confirmación del
 *    alta (RUTAS_CON_GOOGLE_ADS). Nunca en el alta, el acceso, la contraseña,
 *    la invitación, el panel ni un 404. Si se llega a una de esas desde una
 *    página que ya lo tiene, se entra con una carga nueva, sin gtag.
 *  - TOKENS: una URL con token o código (invitación, nueva contraseña,
 *    `?code=`, `#access_token=`, un `next=` hacia una de ellas) o un 404 vetan
 *    gtag el resto de la visita en esa pestaña (sessionStorage).
 *  - ANTES DE CARGARLO se quitan de la barra de direcciones los parámetros que
 *    la web no usa (PARAMETROS_QUE_SE_QUEDAN): ni `?email=` ni `utm_*` llegan
 *    a las vistas por historial.
 *  - Cualquier cosa que no se pueda leer = no se carga. Nada de esto lanza.
 *  - La página anterior es solo el origen dentro del sitio: Referrer-Policy
 *    `strict-origin` (next.config.mjs).
 */

export const ID_GOOGLE_ADS = "AW-18425303387";

/** Donde corre gtag: las páginas públicas sin formularios y la confirmación del alta. */
export const RUTAS_CON_GOOGLE_ADS = [
  "/[locale]",
  "/[locale]/how-it-works",
  "/[locale]/pricing",
  "/[locale]/benchmarks",
  "/[locale]/paper",
  "/[locale]/privacy",
  "/[locale]/migrate-to-0.5",
  "/[locale]/signup/success",
] as const;

/** Las rutas que llevan un token o un código, y la de un 404: vetan gtag el resto de la visita. */
export const RUTAS_QUE_VETAN_LA_VISITA = ["/[locale]/invitacion/[token]", "/[locale]/reset-password", "/[locale]/[...rest]", "/[...rest]"] as const;

/** Parámetros (de query o de fragmento) que llevan una credencial de un solo uso o de sesión. */
const PARAMETROS_CON_TOKEN = new Set(["code", "token", "token_hash", "access_token", "refresh_token", "provider_token"]);

/**
 * Los únicos parámetros que se quedan en la barra cuando gtag va a cargarse.
 * `next` y `plan` los lee la confirmación del alta; `gclid`, `gbraid` y
 * `wbraid` son los identificadores de clic de Google Ads (atribución). Todo lo
 * demás (`utm_*`, `fbclid`, un `?email=` de una herramienta de correo…) se
 * quita antes de que gtag pueda verlo.
 */
export const PARAMETROS_QUE_SE_QUEDAN = ["next", "plan", "gclid", "gbraid", "wbraid"] as const;

const PLANES = new Set(["pro", "equipo", "team"]);
const ID_DE_CLIC = /^[\w.-]{1,256}$/;

const ruta = (pathname: string) => rutaParaVercel(pathname).route;

/**
 * ¿Esta URL veta gtag para el resto de la visita? Sí si su ruta lleva token o
 * es un 404, si un parámetro es una credencial, si un valor que empieza por
 * «/» apunta a una URL que veta, y si algo no se puede leer.
 */
export function urlVetaLaVisita(href: string, profundidad = 0): boolean {
  try {
    const url = new URL(href);
    if ((RUTAS_QUE_VETAN_LA_VISITA as readonly string[]).includes(ruta(url.pathname))) return true;
    const parametros = [...url.searchParams, ...new URLSearchParams(url.hash.replace(/^#/, ""))];
    for (const [nombre, valor] of parametros) {
      if (PARAMETROS_CON_TOKEN.has(nombre.toLowerCase())) return true;
      if (valor.startsWith("/") && (profundidad > 3 || urlVetaLaVisita(new URL(valor, url.origin).href, profundidad + 1))) return true;
    }
    return false;
  } catch {
    return true;
  }
}

/** ¿Puede correr gtag con esta URL en la barra? Solo en RUTAS_CON_GOOGLE_ADS y si no veta la visita. Nunca lanza. */
export function urlPermiteGoogleAds(href: string): boolean {
  try {
    return (RUTAS_CON_GOOGLE_ADS as readonly string[]).includes(ruta(new URL(href).pathname)) && !urlVetaLaVisita(href);
  } catch {
    return false;
  }
}

/** El `next` que se queda: una ruta de este sitio, conocida, sin más query que un plan. */
function nextLimpio(valor: string, origen: string): string | null {
  const destino = new URL(valor, origen);
  if (destino.origin !== origen || !valor.startsWith("/") || valor.startsWith("//")) return null;
  const { route, path } = rutaParaVercel(destino.pathname);
  if (route.endsWith("[...rest]") || path.includes("[")) return null;
  const plan = destino.searchParams.get("plan");
  return plan && PLANES.has(plan) ? `${path}?plan=${plan}` : path;
}

/**
 * La URL de la barra sin los parámetros que la web no usa, o `null` si ya está
 * así (o no se puede leer: entonces gtag tampoco se carga). El fragmento se
 * queda: son anclas de la página.
 */
export function urlSinParametrosSobrantes(href: string): string | null {
  try {
    const url = new URL(href);
    const limpia = new URLSearchParams();
    for (const [nombre, valor] of url.searchParams) {
      if (nombre === "next") {
        const n = nextLimpio(valor, url.origin);
        if (n) limpia.append(nombre, n);
      } else if (nombre === "plan") {
        if (PLANES.has(valor)) limpia.append(nombre, valor);
      } else if ((PARAMETROS_QUE_SE_QUEDAN as readonly string[]).includes(nombre) && ID_DE_CLIC.test(valor)) {
        limpia.append(nombre, valor);
      }
    }
    const query = limpia.toString();
    const nueva = `${url.pathname}${query ? `?${query}` : ""}${url.hash}`;
    return nueva === `${url.pathname}${url.search}${url.hash}` ? null : nueva;
  } catch {
    return null;
  }
}

/** La página que ve Google: la URL limpia, o el origen si no se puede leer. */
export function ubicacionParaGoogle(href: string): string {
  return urlSinDatos(href) ?? origenDe(href);
}

/**
 * La página anterior que ve Google en `page_referrer`. De este sitio, limpia
 * como la actual (con `strict-origin` ya llega solo el origen); de otro, solo
 * su origen; sin anterior, vacía.
 */
export function referenteParaGoogle(referrer: string, origen: string): string {
  if (!referrer) return "";
  try {
    const url = new URL(referrer);
    return url.origin === origen ? ubicacionParaGoogle(referrer) : `${url.origin}/`;
  } catch {
    return "";
  }
}

function origenDe(href: string): string {
  try {
    return `${new URL(href).origin}/`;
  } catch {
    return "";
  }
}
