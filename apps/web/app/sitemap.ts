import type { MetadataRoute } from "next";

import { locales } from "@/i18n/config";
import { absolute, languageAlternates } from "@/i18n/site";
import { EDICION_PAPER } from "@/lib/paper/edicion";
import { entradasDeGuias, type GuiaRegistrada } from "@/lib/seo/guias-en-el-sitemap";

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
 * edición (lib/paper/edicion.ts), que es exacta.
 *
 * FUERA DEL SITEMAP (la página sigue publicada): la guía de migración 0.4 → 0.5
 * (/en/migrate-to-0.5). Es de una versión antigua; quien la necesita llega por
 * el enlace del README o de las notas de versión, no por un buscador.
 */
const CONSTRUIDO = new Date();

/**
 * GUÍAS EN INGLÉS (/en/guides/<slug>) — EL ENGANCHE ES LA LÍNEA DE ABAJO.
 * Cuando exista `app/[locale]/guides/registry.ts`, se importa su lista de slugs
 * y se pone en lugar de `[]` (el nombre del export, el que tenga el registro):
 *
 *   import { GUIDE_SLUGS } from "./[locale]/guides/registry";
 *   const GUIAS: readonly GuiaRegistrada[] = GUIDE_SLUGS;
 *
 * Cada guía entra una vez, en /en, con `en` y `x-default` (lib/seo/
 * guias-en-el-sitemap.ts). Un slug puede traer su fecha: `{ slug, lastModified }`.
 */
const GUIAS: readonly GuiaRegistrada[] = [];

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
    ...entradasDeGuias(GUIAS, CONSTRUIDO),
  ];
}
