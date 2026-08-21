import type { MetadataRoute } from "next";

import { locales } from "@/i18n/config";
import { absolute, languageAlternates } from "@/i18n/site";

/**
 * `/sitemap.xml`. Solo entra lo que de verdad queremos indexar: la landing en
 * cada uno de los 12 idiomas. El dashboard y las pantallas de auth quedan fuera
 * a propósito — están tras sesión y llevan `noindex`.
 *
 * Cada entrada declara sus `alternates.languages`, que es como Next emite el
 * `hreflang`: sin eso, doce traducciones de la misma página compiten entre sí
 * como si fueran duplicados y Google decide por su cuenta cuál enseña a quién.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const languages = languageAlternates();
  const hiwLanguages = languageAlternates("how-it-works");
  return [
    ...locales.map((locale) => ({
      url: absolute(`/${locale}`),
      changeFrequency: "weekly" as const,
      priority: 1,
      alternates: { languages },
    })),
    // La página explicativa pública («¿Dónde se instala el ahorro?») también
    // se indexa: es la respuesta de marca a la búsqueda de quien no es técnico.
    ...locales.map((locale) => ({
      url: absolute(`/${locale}/how-it-works`),
      changeFrequency: "monthly" as const,
      priority: 0.8,
      alternates: { languages: hiwLanguages },
    })),
  ];
}
