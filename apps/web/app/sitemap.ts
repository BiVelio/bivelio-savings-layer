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
  const pricingLanguages = languageAlternates("pricing");
  const privacyLanguages = languageAlternates("privacy");
  const benchLanguages = languageAlternates("benchmarks");
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
    // Las dos páginas que cita la LICENSE (§6 y §5): públicas e indexables,
    // porque un cliente tiene que poder encontrarlas sin sesión.
    ...locales.map((locale) => ({
      url: absolute(`/${locale}/pricing`),
      changeFrequency: "monthly" as const,
      priority: 0.7,
      alternates: { languages: pricingLanguages },
    })),
    ...locales.map((locale) => ({
      url: absolute(`/${locale}/privacy`),
      changeFrequency: "monthly" as const,
      priority: 0.5,
      alternates: { languages: privacyLanguages },
    })),
    // El banco público A/B: indexable, es la invitación a medirnos.
    ...locales.map((locale) => ({
      url: absolute(`/${locale}/benchmarks`),
      changeFrequency: "weekly" as const,
      priority: 0.7,
      alternates: { languages: benchLanguages },
    })),
    // La guía de migración 0.4 → 0.5: en inglés en todos los idiomas, así que
    // se indexa una sola vez, la de /en (su `canonical`).
    {
      url: absolute("/en/migrate-to-0.5"),
      changeFrequency: "monthly" as const,
      priority: 0.6,
    },
  ];
}
