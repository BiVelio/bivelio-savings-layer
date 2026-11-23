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
export interface Guia {
  /** El último tramo de la URL: /<idioma>/guides/<slug>. */
  slug: string;
  /** El titular inglés: el `<h1>` y el `<title>` de la edición /en. */
  title: string;
  /** La meta description inglesa y la entradilla del índice (≤ 160 caracteres). */
  description: string;
  /** Fecha de publicación, ISO (AAAA-MM-DD). */
  date: string;
  /** Fecha de la última revisión de fondo, si la hubo. */
  updated?: string;
}

/** Las guías publicadas, en el orden en que las lista el índice. */
export const GUIAS: readonly Guia[] = [
  {
    slug: "reduce-openai-api-costs",
    title: "How to reduce OpenAI API costs, and prove each saving",
    description:
      "Six levers that cut an OpenAI bill: caching, deduplication, Batch, model choice, output and input size. When each one pays, and how to check it on your usage.",
    date: "2026-11-23",
  },
  {
    slug: "claude-prompt-caching-not-working",
    title: "Claude prompt caching not working? Why cache reads stay at 0",
    description:
      "Why cache_read_input_tokens stays at 0 on Claude, how to find the byte that breaks the prefix, and how to check your hit rate against Anthropic's usage numbers.",
    date: "2026-11-23",
  },
  {
    slug: "claude-code-cost-per-request",
    title: "How much does Claude Code cost? Measure it request by request",
    description:
      "What Claude Code costs on an API key, what /usage and the Console show, and how to see the cost of every request with a free local gateway.",
    date: "2026-11-23",
  },
  {
    slug: "openai-prompt-caching-cached-tokens",
    title: "OpenAI prompt caching: why cached_tokens is 0 and how to fix it",
    description:
      "A checklist for OpenAI prompt caching when cached_tokens stays at 0: prompt length, prefix order, eviction, routing and streams, with code to track the hit rate.",
    date: "2026-11-23",
  },
  {
    slug: "deduplicate-llm-requests",
    title: "Deduplicate identical LLM requests: exact cache and in-flight coalescing",
    description:
      "Stop paying twice for the same LLM call: a safe cache key, what never to cache, coalescing identical requests in flight, and how to check the saving.",
    date: "2026-11-23",
  },
  {
    slug: "deepseek-qwen-api-cost-local-gateway",
    title: "DeepSeek and Qwen API costs: see cache hits and spend per request",
    description:
      "How DeepSeek and Qwen bill cache hits and misses, how to price a request from its usage fields, and how to meter every request with a free local gateway.",
    date: "2026-11-23",
  },
  {
    slug: "verify-llm-savings-against-provider-bill",
    title: "How to verify LLM cost savings against your provider's bill",
    description:
      "A method to check any LLM savings claim: log the provider's counters, reconcile tokens before dollars, keep measured and estimated apart, and attribute the saving.",
    date: "2026-11-23",
  },
];

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
