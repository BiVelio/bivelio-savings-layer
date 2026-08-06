// Enlaces a la web corporativa (bivelio.com), que es donde viven los documentos
// legales de toda la suite: savings no los duplica, los referencia.
//
// OJO CON EL IDIOMA: savings-web sirve 12 locales pero bivelio.com solo traduce
// CUATRO (es · en · ca · fr — ver bivelio-site/apps/website/i18n/config.ts, con
// `dynamicParams = false`). Construir `bivelio.com/${locale}/privacy` a pelo
// mandaba a un visitante alemán a /de/privacy, que responde 308 y acaba en
// /en/privacy: el documento correcto, pero con un salto de más y una URL que en
// el hover se lee como rota. Aquí se resuelve el idioma ANTES de enlazar, con la
// misma regla que aplica el propio bivelio.com (comprobado: /de, /it, /pt, /nl,
// /pl, /tr, /id y /vi redirigen todos a /en).
const CORPORATE_LOCALES = new Set(["es", "en", "ca", "fr"]);
const CORPORATE_FALLBACK = "en";

/** El locale de bivelio.com más cercano al del visitante. */
export function corporateLocale(locale: string): string {
  return CORPORATE_LOCALES.has(locale) ? locale : CORPORATE_FALLBACK;
}

/** URL absoluta a una página de bivelio.com, ya en un idioma que existe allí. */
export function corporateUrl(path: string, locale: string): string {
  return `https://bivelio.com/${corporateLocale(locale)}${path}`;
}

/**
 * El corpus legal de BiVelio, en el mismo orden y con las mismas rutas que
 * publica bivelio.com (lib/attio/data/legal-ui.ts → LEGAL_DOCS) más el hub que
 * los agrupa. Es deliberadamente la lista COMPLETA: antes savings-web solo
 * enlazaba privacy, terms y gdpr, así que tres de los seis documentos que le
 * aplican al cliente —cookies, facturación y AI Act— no eran alcanzables desde
 * este producto.
 */
export const LEGAL_DOCS = [
  { key: "privacy", path: "/privacy" },
  { key: "terms", path: "/terms" },
  { key: "gdpr", path: "/gdpr" },
  { key: "cookies", path: "/cookies" },
  { key: "billing", path: "/billing" },
  { key: "aiAct", path: "/ai-act" },
  { key: "legalCenter", path: "/legal" },
] as const;
