import type { MetadataRoute } from "next";

import { locales } from "@/i18n/config";
import { absolute, languageAlternates } from "@/i18n/site";
import { EDICION_PAPER } from "@/lib/paper/edicion";

import { GUIAS, entradasDelSitemap as guias } from "./[locale]/guides/registry";

/**
 * `/sitemap.xml`. Solo entra lo que de verdad queremos indexar: la landing en
 * cada uno de los 12 idiomas. El dashboard y las pantallas de auth quedan fuera
 * a propósito — están tras sesión y llevan `noindex`.
 *
 * Cada entrada declara sus `alternates.languages`, que es como Next emite el
 * `hreflang`: sin eso, doce traducciones de la misma página compiten entre sí
 * como si fueran duplicados y Google decide por su cuenta cuál enseña a quién.
 *
 * `<lastmod>`: la fecha del BUILD, fijada una vez al cargar el módulo. El
 * sitemap no usa nada dinámico, así que Next lo genera al construir (sale como
 * `○ /sitemap.xml`) y la fecha no cambia en cada petición: cambia cuando se
 * despliega, que es cuando cambia el contenido. El paper lleva la fecha de su
 * edición (lib/paper/edicion.ts) y cada guía la suya (su registro), que son
 * exactas.
 *
 * FUERA DEL SITEMAP (la página sigue publicada): la guía de migración 0.4 → 0.5
 * (/en/migrate-to-0.5). Es de una versión antigua; quien la necesita llega por
 * el enlace del README o de las notas de versión, no por un buscador.
 */
const CONSTRUIDO = new Date();

/**
 * La fecha de la guía más reciente (publicada o revisada): el `<lastmod>` del
 * índice /<idioma>/guides, que cambia cuando entra o se revisa una guía.
 */
const GUIA_MAS_RECIENTE = GUIAS.map((g) => g.updated ?? g.date)
  .sort()
  .at(-1);

/** Una página traducida a los 12 idiomas (`ruta` sin idioma: "" o "/pricing"): una entrada por idioma, con los 12 `hreflang`. */
function enLosDoceIdiomas(ruta: string, changeFrequency: "weekly" | "monthly", priority: number): MetadataRoute.Sitemap {
  const languages = languageAlternates(ruta);
  return locales.map((locale) => ({
    url: absolute(`/${locale}${ruta}`),
    lastModified: CONSTRUIDO,
    changeFrequency,
    priority,
    alternates: { languages },
  }));
}

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    ...enLosDoceIdiomas("", "weekly", 1),
    // La página explicativa pública («¿Dónde se instala el ahorro?») también
    // se indexa: es la respuesta de marca a la búsqueda de quien no es técnico.
    ...enLosDoceIdiomas("/how-it-works", "monthly", 0.8),
    // Las dos páginas que cita la LICENSE (§6 y §5): públicas e indexables,
    // porque un cliente tiene que poder encontrarlas sin sesión.
    ...enLosDoceIdiomas("/pricing", "monthly", 0.7),
    ...enLosDoceIdiomas("/privacy", "monthly", 0.5),
    // El banco público A/B: indexable, es la invitación a medirnos.
    ...enLosDoceIdiomas("/benchmarks", "weekly", 0.7),
    // El paper técnico: mismo contenido en los 12 idiomas (el documento es en
    // inglés, con apéndice en español), así que se indexa una sola vez, la de
    // /en. Sus alternativas son las MISMAS que declara la página
    // (`generateMetadata` de /paper): `en` y `x-default`, las dos a /en/paper.
    // Anunciar aquí doce `hreflang` contradecía su `canonical`, que manda
    // todas las variantes a la edición inglesa.
    {
      url: absolute("/en/paper"),
      lastModified: EDICION_PAPER.fecha,
      changeFrequency: "yearly" as const,
      priority: 0.6,
      alternates: { languages: { en: absolute("/en/paper"), "x-default": absolute("/en/paper") } },
    },
    // Las guías (/<idioma>/guides): el índice y cada guía en cada idioma en que
    // están traducidas (registry.ts, su única fuente), una URL por edición y
    // con los mismos `hreflang` que declara la página. Una copia inglesa bajo
    // un prefijo sin traducción no entra: su `canonical` es /en. Cada guía
    // trae su fecha; el índice, que no la trae, lleva la de la guía más reciente.
    ...guias().map((e) => ({ ...e, lastModified: e.lastModified ?? GUIA_MAS_RECIENTE ?? CONSTRUIDO })),
  ];
}
