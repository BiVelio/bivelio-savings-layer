// The single source of truth for which locales are LIVE (routed, generated,
// offered in the language switcher). Mirrors the corporate bivelio.com set so
// the two surfaces stay in lockstep: 12 locales, Spanish default.
//
// Adding a locale = add its code here AND ship a real `messages/<code>.json`
// (the request loader imports it by code). Presentation metadata for each code
// lives in `locale-meta.ts` and already covers a wider set.

export const locales = ['es', 'en', 'ca', 'fr', 'de', 'it', 'pt', 'nl', 'pl', 'tr', 'id', 'vi'] as const;
export type Locale = (typeof locales)[number];

// Spanish default — matches bivelio.com (`/` → `/es`). Flip to 'en' here if the
// product should default to English; nothing else needs to change.
export const defaultLocale: Locale = 'es';
