import { getRequestConfig } from 'next-intl/server';
import { routing } from './routing';

type Dict = Record<string, unknown>;

// Deep-merge so a partially-translated locale falls back to the English SOURCE
// per key (never a blank string), mirroring bivelio-privacy-gateway's approach.
// Arrays are replaced wholesale (a translated array supersedes the English one).
function deepMerge(base: Dict, over: Dict): Dict {
  const out: Dict = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' && !Array.isArray(b)) {
      out[k] = deepMerge(b as Dict, v as Dict);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// English is the source of truth (extraction emits English), so it is always the
// fallback base; the active locale is layered on top.
export default getRequestConfig(async ({ requestLocale }) => {
  let locale = await requestLocale;
  if (!locale || !routing.locales.includes(locale as (typeof routing.locales)[number])) {
    locale = routing.defaultLocale;
  }
  const en = (await import('../messages/en.json')).default as Dict;
  const messages =
    locale === 'en'
      ? en
      : deepMerge(en, (await import(`../messages/${locale}.json`)).default as Dict);
  return { locale, messages };
});
