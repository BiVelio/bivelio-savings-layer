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

/**
 * La imagen al compartir (Open Graph + X) de una página SIN `opengraph-image`
 * propia: la de la portada de ese idioma.
 *
 * POR QUÉ HACE FALTA. En cuanto una página declara su propio objeto
 * `openGraph`, Next deja de heredar la imagen del segmento padre: pricing,
 * privacy, benchmarks y la guía de migración salían en LinkedIn, Slack o X
 * sin imagen y con la tarjeta pequeña (`summary`). Las medidas viven aquí y
 * no en la página porque /pricing no admite literales numéricos
 * (lib/legal/precios-publicados.test.ts).
 */
export function tarjetaSocial(locale: string, alt: string) {
  const imagen = absolute("/brand/og-image.png");
  return {
    openGraph: { locale, images: [{ url: imagen, width: 1731, height: 909, alt }] },
    twitter: { card: "summary_large_image" as const, images: [imagen] },
  };
}
