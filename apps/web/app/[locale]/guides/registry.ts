import type { MetadataRoute } from "next";

import { locales } from "@/i18n/config";
import { absolute } from "@/i18n/site";

import { hayIndiceTraducido, hayTraduccion, metaDelIdioma, ORIGINAL, type IndiceTraducido } from "./cargar";

/**
 * LAS GUÍAS (/<idioma>/guides): artículos prácticos para quien busca cómo
 * bajar su factura de LLM y todavía no conoce BV-SALA (2026-11-23, tras el
 * lanzamiento en Product Hunt: muchas visitas y casi ninguna búsqueda del nombre).
 *
 * Esta lista es la ÚNICA fuente de las guías publicadas: el índice, cada página,
 * el sitemap y el test leen de aquí. El original de cada guía vive en
 * `content/<slug>.md`, en inglés; su traducción, en `content/<idioma>/<slug>.md`
 * con el titular y la descripción en `content/<idioma>/_meta.json` (cargar.ts).
 *
 * Cada idioma sirve SU traducción, con el `canonical` en su propia URL y los
 * `hreflang` de todas las ediciones que existen. Un idioma sin traducción de
 * una guía sirve la edición inglesa con una línea que lo dice y el `canonical`
 * en /en, como el paper; esa URL no entra en el sitemap ni en los `hreflang`.
 *
 * Reglas del contenido (las vigilan guides.test.ts y traducciones.test.ts):
 * cada cifra sale del README o del banco publicado y dice de dónde; cada guía
 * enlaza el banco y el repositorio; ningún texto, en ningún idioma, dice que
 * haga falta una clave para ahorrar. Los fragmentos de código se comprobaron
 * contra el paquete publicado en npm y PyPI (1.2.3) el día de la fecha, y las
 * traducciones los llevan byte a byte.
 */
import { GUIAS, type Guia } from "./lista";
export { GUIAS, type Guia };

/**
 * El índice /en/guides: titular, descripción y entradilla inglesas (`sources`
 * en Markdown en línea). Las de cada idioma, en `content/<idioma>/_meta.json`.
 */
export const INDICE: IndiceTraducido = {
  title: "Guides to cutting your LLM API bill",
  description:
    "Practical guides to lower OpenAI, Anthropic, DeepSeek and Qwen API costs: caching, deduplication, Claude Code spend per request, and how to verify savings on your bill.",
  intro:
    "Practical, provider-neutral guides for developers who pay a per-token bill. Each one teaches the technique first, so it is useful without any tool; then shows how the open-source BV-SALA layer does it, free and with no key; then shows how to check the saving against your provider's own usage numbers.",
  sources:
    "Every figure comes from the provider's documentation or from our [published benchmarks](/en/benchmarks), and says where it came from. The code is on [GitHub](https://github.com/BiVelio/bivelio-savings-layer).",
};

export function guiaPorSlug(slug: string): Guia | undefined {
  return GUIAS.find((g) => g.slug === slug);
}

/** Una guía tal como se sirve en un idioma: su texto, y en qué idioma está de verdad. */
export interface GuiaEnIdioma extends Guia {
  /** El idioma del texto servido: `locale` si hay traducción; si no, el inglés. */
  idioma: string;
  /** `true` si el texto servido no está en el idioma de la URL (se sirve el original). */
  enIngles: boolean;
}

export function guiaEnIdioma(guia: Guia, locale: string): GuiaEnIdioma {
  if (locale !== ORIGINAL && hayTraduccion(guia.slug, locale)) {
    const t = metaDelIdioma(locale)!.guides[guia.slug]!;
    return { ...guia, title: t.title, description: t.description, idioma: locale, enIngles: false };
  }
  return { ...guia, idioma: ORIGINAL, enIngles: locale !== ORIGINAL };
}

/** El índice tal como se sirve en un idioma. */
export function indiceEnIdioma(locale: string): IndiceTraducido & { idioma: string; enIngles: boolean } {
  const t = locale === ORIGINAL ? undefined : metaDelIdioma(locale)?.index;
  return t ? { ...t, idioma: locale, enIngles: false } : { ...INDICE, idioma: ORIGINAL, enIngles: locale !== ORIGINAL };
}

/** La URL absoluta de una guía (o del índice, sin slug) en un idioma. */
export function urlDeGuia(slug?: string, idioma: string = ORIGINAL): string {
  return absolute(slug ? `/${idioma}/guides/${slug}` : `/${idioma}/guides`);
}

/**
 * Los idiomas en que existe la guía (o el índice, sin slug), en el orden de
 * `i18n/config.ts`. Siempre incluye el inglés.
 */
export function idiomasDe(slug?: string): string[] {
  return locales.filter((l) => (slug ? hayTraduccion(slug, l) : hayIndiceTraducido(l)));
}

/**
 * El mapa `hreflang` → URL de una guía (o del índice): una entrada por cada
 * edición que existe y `x-default` en /en. Es el MISMO en la página y en el
 * sitemap; con las doce traducciones, coincide en idiomas con la cabecera
 * `Link:` que pone el middleware de next-intl.
 */
export function alternativasDe(slug?: string): Record<string, string> {
  const mapa: Record<string, string> = {};
  for (const l of idiomasDe(slug)) mapa[l] = urlDeGuia(slug, l);
  mapa["x-default"] = urlDeGuia(slug, ORIGINAL);
  return mapa;
}

/**
 * El `canonical` de /<locale>/guides[/<slug>]: su propia URL si hay
 * traducción; si no, la inglesa (la página sirve el original).
 */
export function canonicalDe(slug: string | undefined, locale: string): string {
  const traducida = slug ? hayTraduccion(slug, locale) : hayIndiceTraducido(locale);
  return urlDeGuia(slug, traducida ? locale : ORIGINAL);
}

/**
 * Las entradas del sitemap: el índice y cada guía en cada idioma en que
 * existen, una sola URL por edición, cada una con sus `hreflang`. Las copias
 * inglesas bajo un prefijo sin traducción no se anuncian (su `canonical` es /en).
 */
export function entradasDelSitemap(): MetadataRoute.Sitemap {
  const indice = alternativasDe();
  return [
    ...idiomasDe().map((l) => ({
      url: urlDeGuia(undefined, l),
      changeFrequency: "weekly" as const,
      priority: 0.7,
      alternates: { languages: indice },
    })),
    ...GUIAS.flatMap((g) => {
      const languages = alternativasDe(g.slug);
      return idiomasDe(g.slug).map((l) => ({
        url: urlDeGuia(g.slug, l),
        lastModified: g.updated ?? g.date,
        changeFrequency: "monthly" as const,
        priority: 0.6,
        alternates: { languages },
      }));
    }),
  ];
}
