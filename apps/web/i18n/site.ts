import { locales, defaultLocale } from "./config";

/**
 * Origen público del sitio. Una sola fuente para `metadataBase`, el sitemap,
 * `robots.txt`, los `canonical` y las URLs absolutas de Open Graph — si algún
 * día cambia el dominio, cambia aquí y en ningún otro sitio.
 *
 * Se puede sobrescribir por entorno para que un preview no anuncie URLs de
 * producción (y no se canonicalice a sí mismo contra el dominio real).
 */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://savings.bivelio.com").replace(/\/+$/, "");

/** URL absoluta de una ruta ya prefijada con idioma, p. ej. `/es` o `/en/login`. */
export function absolute(path: string): string {
  return `${SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Mapa hreflang -> URL absoluta para una ruta SIN prefijo de idioma (`""` = la
 * landing). Incluye `x-default`, que es lo que le dice a Google qué servir a
 * quien no encaje en ninguno de los 12 idiomas; sin él, elige por su cuenta.
 */
export function languageAlternates(pathSinLocale = ""): Record<string, string> {
  const cola = pathSinLocale.replace(/^\/+/, "");
  const url = (loc: string) => absolute(cola ? `/${loc}/${cola}` : `/${loc}`);
  const mapa: Record<string, string> = {};
  for (const loc of locales) mapa[loc] = url(loc);
  mapa["x-default"] = url(defaultLocale);
  return mapa;
}
