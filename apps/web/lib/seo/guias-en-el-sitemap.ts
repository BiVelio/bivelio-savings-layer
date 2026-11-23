import type { MetadataRoute } from "next";

import { absolute } from "@/i18n/site";

/** Lo que una guía puede registrar: su slug, o su slug con la fecha de su último cambio. */
export type GuiaRegistrada = string | { slug: string; lastModified?: string | Date };

/**
 * Las entradas del sitemap de las guías en inglés (/en/guides/<slug>). Cada
 * guía entra una sola vez, en /en, con `en` y `x-default` como el paper (están
 * solo en inglés: doce `hreflang` contradirían su `canonical`). Sin fecha
 * propia, la del build.
 */
export function entradasDeGuias(guias: readonly GuiaRegistrada[], porDefecto: Date): MetadataRoute.Sitemap {
  return guias.map((g) => {
    const { slug, lastModified } = typeof g === "string" ? { slug: g, lastModified: undefined } : g;
    const url = absolute(`/en/guides/${slug}`);
    return {
      url,
      lastModified: lastModified ?? porDefecto,
      changeFrequency: "monthly" as const,
      priority: 0.6,
      alternates: { languages: { en: url, "x-default": url } },
    };
  });
}
