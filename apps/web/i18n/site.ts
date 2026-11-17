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
/**
 * LA IMAGEN AL COMPARTIR (la pieza de campaña, 1731×909). Una sola ruta para
 * todo el sitio. Va en JPEG (157 KB) y no en el PNG de 632 KB: WhatsApp deja
 * sin vista previa las imágenes de más de ~300 KB. El NOMBRE lleva la fecha
 * de la pieza: LinkedIn, X, Slack o WhatsApp guardan la imagen por URL, y una
 * URL nueva es lo único que les hace pedir la nueva. Al cambiar la pieza,
 * fichero nuevo con otra fecha. `/brand/og-image.png` sigue publicado, con la
 * misma pieza, para quien lo enlaza desde fuera (README del repo y de PyPI).
 */
export const IMAGEN_AL_COMPARTIR = { ruta: "/brand/og-image-2026-11.jpg", width: 1731, height: 909, type: "image/jpeg" } as const;

export function tarjetaSocial(locale: string, alt: string) {
  const { ruta, ...medidas } = IMAGEN_AL_COMPARTIR;
  const imagen = absolute(ruta);
  return {
    openGraph: { locale, images: [{ url: imagen, ...medidas, alt }] },
    twitter: { card: "summary_large_image" as const, images: [imagen] },
  };
}
