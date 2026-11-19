// The single source of truth for which locales are LIVE (routed, generated,
// offered in the language switcher). Mirrors the corporate bivelio.com set so
// the two surfaces stay in lockstep: 12 locales (the fallback differs: see `defaultLocale` below).
//
// Adding a locale = add its code here AND ship a real `messages/<code>.json`
// (the request loader imports it by code). Presentation metadata for each code
// lives in `locale-meta.ts` and already covers a wider set.

export const locales = ['es', 'en', 'ca', 'fr', 'de', 'it', 'pt', 'nl', 'pl', 'tr', 'id', 'vi'] as const;
export type Locale = (typeof locales)[number];

// EL IDIOMA DE RESPALDO ES EL INGLÉS (2026-11-19, auditoría del lanzamiento).
// Es adonde va quien NO habla ninguno de los doce: un navegador en japonés,
// chino o ruso, o un rastreador sin `Accept-Language`. Mientras fue 'es', ese
// público internacional caía en la web en español, y `hreflang="x-default"`
// (i18n/site.ts) les decía lo mismo a los buscadores.
//
// Quien SÍ habla uno de los doce no nota nada: next-intl mira primero la URL,
// luego la cookie NEXT_LOCALE y luego `Accept-Language`; esto solo decide
// cuando no casa ninguno. Lo fija idioma-de-respaldo.test.ts.
export const defaultLocale: Locale = 'en';
