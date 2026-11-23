import type { MetadataRoute } from "next";

import { absolute } from "@/i18n/site";

/**
 * LAS GUÍAS (/en/guides): artículos prácticos en inglés para quien busca cómo
 * bajar su factura de LLM y todavía no conoce BV-SALA (2026-11-23, tras el
 * lanzamiento en Product Hunt: muchas visitas y casi ninguna búsqueda del nombre).
 *
 * Esta lista es la ÚNICA fuente de las guías publicadas: el índice, cada página,
 * el sitemap y el test leen de aquí. El texto de cada guía vive en
 * `content/<slug>.md`, en inglés y solo en inglés: las guías no tienen
 * traducción, así que `/<otro idioma>/guides` da 404 en vez de doce copias.
 *
 * Reglas del contenido (las vigila guides.test.ts): cada cifra sale del README
 * o del banco publicado y dice de dónde; cada guía enlaza el banco y el
 * repositorio; ningún texto dice que haga falta una clave para ahorrar.
 * Los fragmentos de código se comprobaron contra el paquete publicado en npm
 * y PyPI (1.2.3) el día de la fecha.
 */
export interface Guia {
  /** El último tramo de la URL: /en/guides/<slug>. */
  slug: string;
  /** El titular: el `<h1>` y el `<title>` de la página. */
  title: string;
  /** La meta description y la entradilla del índice (≤ 160 caracteres). */
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

/** El idioma de las guías: el único en que existen. */
export const IDIOMA_DE_LAS_GUIAS = "en";

export function guiaPorSlug(slug: string): Guia | undefined {
  return GUIAS.find((g) => g.slug === slug);
}

/** La URL absoluta de una guía, o del índice si no se pasa slug. */
export function urlDeGuia(slug?: string): string {
  return absolute(slug ? `/${IDIOMA_DE_LAS_GUIAS}/guides/${slug}` : `/${IDIOMA_DE_LAS_GUIAS}/guides`);
}

/**
 * Las entradas del sitemap: el índice y cada guía, una sola URL cada una (solo
 * existen en inglés), sin `hreflang` a otros idiomas que darían 404.
 */
export function entradasDelSitemap(): MetadataRoute.Sitemap {
  return [
    { url: urlDeGuia(), changeFrequency: "weekly", priority: 0.7 },
    ...GUIAS.map((g) => ({
      url: urlDeGuia(g.slug),
      lastModified: g.updated ?? g.date,
      changeFrequency: "monthly" as const,
      priority: 0.6,
    })),
  ];
}
