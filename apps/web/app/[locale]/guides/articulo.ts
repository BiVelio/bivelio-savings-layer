import { absolute, IMAGEN_AL_COMPARTIR } from "@/i18n/site";
import type { Bloque } from "@/lib/guia-migracion/markdown";
import { textoPlano } from "@/lib/guia-migracion/markdown";

import { urlDeGuia, type Guia } from "./registry";

/** Las palabras de una guía, código incluido (lo que se lee de verdad). */
export function palabras(bloques: readonly Bloque[]): number {
  let n = 0;
  const contar = (s: string) => {
    n += s.split(/\s+/).filter(Boolean).length;
  };
  const recorrer = (bs: readonly Bloque[]) => {
    for (const b of bs) {
      switch (b.t) {
        case "titulo":
        case "parrafo":
          contar(textoPlano(b.c));
          break;
        case "codigo":
          contar(b.v);
          break;
        case "cita":
          recorrer(b.c);
          break;
        case "lista":
          for (const it of b.items) recorrer(it);
          break;
        case "tabla":
          for (const fila of [b.cabecera, ...b.filas]) for (const celda of fila) contar(textoPlano(celda));
          break;
        case "separador":
          break;
      }
    }
  };
  recorrer(bloques);
  return n;
}

/**
 * Un enlace interno del texto de una guía, sin el prefijo `/en`, para pasarlo
 * al `Link` de next-intl, que pone el idioma de quien lee. Los textos enlazan
 * `/en/…` (la URL canónica, la que vale también en GitHub); bajo /es, un enlace
 * literal a /en sacaba al lector de su idioma y reescribía su cookie
 * NEXT_LOCALE (revisión del PR #620). `null` si no es una ruta del sitio.
 */
export function rutaSinIdioma(href: string): string | null {
  const m = /^\/en(?=$|[/#?])(.*)$/.exec(href);
  if (m) return m[1] === "" || m[1]!.startsWith("#") || m[1]!.startsWith("?") ? `/${m[1]}` : m[1]!;
  return href.startsWith("/") ? href : null;
}

/** Minutos de lectura, a 220 palabras por minuto (redondeo hacia arriba). */
export function minutosDeLectura(bloques: readonly Bloque[]): number {
  return Math.max(1, Math.ceil(palabras(bloques) / 220));
}

/** «23 November 2026»: la fecha en inglés, sin depender de la zona del servidor. */
export function fechaLegible(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/**
 * El JSON-LD `Article` de una guía: titular, descripción, fechas, idioma, autor
 * y editor (BiVelio), la imagen al compartir y la página canónica.
 */
export function datosEstructurados(guia: Guia, bloques: readonly Bloque[]) {
  const url = urlDeGuia(guia.slug);
  const bivelio = { "@type": "Organization", name: "BiVelio", url: "https://bivelio.com" };
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: guia.title,
    description: guia.description,
    datePublished: guia.date,
    dateModified: guia.updated ?? guia.date,
    inLanguage: "en",
    wordCount: palabras(bloques),
    author: bivelio,
    publisher: { ...bivelio, logo: { "@type": "ImageObject", url: absolute("/logo-bivelio.png") } },
    image: absolute(IMAGEN_AL_COMPARTIR.ruta),
    url,
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
  };
}
