import { URL_CORPORATIVA, URL_DEL_CODIGO } from "@/app/components/sitio";
import { SITE_URL, absolute } from "@/i18n/site";

/**
 * DATOS ESTRUCTURADOS (JSON-LD, schema.org) de la portada.
 *
 * Qué va y de dónde sale cada dato:
 *  · `WebSite` — el nombre del sitio («BiVelio Savings Layer», m28) para que el
 *    buscador no lo titule con el dominio.
 *  · `Organization` — BiVelio Inc, Delaware (Estados Unidos): lo mismo que dice
 *    el pie (`landing.footer.entity`). Logo y redes, los del propio sitio.
 *  · `SoftwareApplication` — el motor open source: Apache-2.0, gratis sin clave
 *    (`offers` a precio 0: SOLO el motor; la nube no se anuncia aquí con
 *    precio, sus cifras viven en /pricing y salen de Stripe), su repositorio y
 *    sus descargas (npm y PyPI). Lleva también el tipo `SoftwareSourceCode`
 *    porque `codeRepository` es una propiedad de ese tipo, no del primero.
 *  · `FAQPage` — SOLO las preguntas que la portada enseña, con su texto exacto
 *    (la página pasa la misma lista que pinta `PreguntasDeCompra`).
 *
 * ⛔ Sin `aggregateRating` ni `review`: no tenemos valoraciones, y unas
 * inventadas están prohibidas (y Google las penaliza). datos-estructurados.test.ts
 * lo vigila.
 */

const NPM = "https://www.npmjs.com/package/@bivelio/savings-layer";
const PYPI = "https://pypi.org/project/bivelio-savings-layer/";
const APACHE_2 = "https://www.apache.org/licenses/LICENSE-2.0";

const ID_SITIO = `${SITE_URL}/#website`;
const ID_ORGANIZACION = `${SITE_URL}/#organization`;
const ID_SOFTWARE = `${SITE_URL}/#software`;

export type Pregunta = { q: string; a: string };
type Nodo = Record<string, unknown>;

export function sitioWeb(): Nodo {
  return {
    "@type": "WebSite",
    "@id": ID_SITIO,
    name: "BiVelio Savings Layer",
    url: `${SITE_URL}/`,
    publisher: { "@id": ID_ORGANIZACION },
  };
}

export function organizacion(): Nodo {
  return {
    "@type": "Organization",
    "@id": ID_ORGANIZACION,
    name: "BiVelio",
    legalName: "BiVelio Inc",
    url: URL_CORPORATIVA,
    logo: absolute("/logo-bivelio.png"),
    // «Powered by BiVelio Inc · Delaware (United States).» (el pie).
    address: { "@type": "PostalAddress", addressRegion: "Delaware", addressCountry: "US" },
    contactPoint: { "@type": "ContactPoint", contactType: "customer support", email: "support@bivelio.com" },
    sameAs: ["https://github.com/BiVelio", "https://www.linkedin.com/company/bivelio/"],
  };
}

/** El motor open source. `descripcion` es la de la página, en su idioma. */
export function aplicacion(locale: string, descripcion: string): Nodo {
  return {
    "@type": ["SoftwareApplication", "SoftwareSourceCode"],
    "@id": ID_SOFTWARE,
    name: "BiVelio Savings Layer",
    alternateName: ["BV-SALA", "@bivelio/savings-layer"],
    description: descripcion,
    url: absolute(`/${locale}`),
    applicationCategory: "DeveloperApplication",
    applicationSubCategory: "LLM API cost optimization",
    // docs/terminales/README.md: «identical on the three systems».
    operatingSystem: "Linux, macOS, Windows",
    softwareRequirements: "Node.js 20.19 or later",
    license: APACHE_2,
    isAccessibleForFree: true,
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "EUR",
      description: "Open-source engine (Apache-2.0): free, with no key and no signup.",
      availability: "https://schema.org/InStock",
    },
    codeRepository: URL_DEL_CODIGO,
    programmingLanguage: ["TypeScript", "Python"],
    downloadUrl: [NPM, PYPI],
    installUrl: `${URL_DEL_CODIGO}#install-anywhere-in-60-seconds`,
    sameAs: [URL_DEL_CODIGO, NPM, PYPI],
    author: { "@id": ID_ORGANIZACION },
    publisher: { "@id": ID_ORGANIZACION },
  };
}

export function preguntasFrecuentes(locale: string, preguntas: readonly Pregunta[]): Nodo {
  return {
    "@type": "FAQPage",
    "@id": `${absolute(`/${locale}`)}#faq`,
    inLanguage: locale,
    mainEntity: preguntas.map((p) => ({
      "@type": "Question",
      name: p.q,
      acceptedAnswer: { "@type": "Answer", text: p.a },
    })),
  };
}

/** El grafo de la portada: un solo bloque `<script type="application/ld+json">`. */
export function grafoDeLaPortada({
  locale,
  descripcion,
  preguntas,
}: {
  locale: string;
  descripcion: string;
  preguntas: readonly Pregunta[];
}): Nodo {
  return {
    "@context": "https://schema.org",
    "@graph": [sitioWeb(), organizacion(), aplicacion(locale, descripcion), preguntasFrecuentes(locale, preguntas)],
  };
}

/**
 * JSON para un `<script>` en línea: `<` va escapado, así que ningún texto
 * (ni un «</script>» en una traducción) puede cerrar la etiqueta antes de tiempo.
 */
export function serializarJsonLd(datos: unknown): string {
  return JSON.stringify(datos).replace(/</g, "\\u003c");
}
