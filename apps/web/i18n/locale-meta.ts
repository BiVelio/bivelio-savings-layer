// Presentation metadata for every locale we may ship — the single table that
// feeds the language selector (native + English names), the `dir` attribute and
// `<html lang>`. Ported from the corporate site so the two surfaces present
// languages identically.
//
// Decoupled from `config.ts`: `config.ts` decides which locales are LIVE; this
// table just describes how to present any code once it goes live. Native names
// are endonyms and are NOT translated (Español is "Español" in every UI
// language, exactly like iLovePDF's picker).

export type LocaleDir = 'ltr' | 'rtl';

export interface LocaleMeta {
  /** Endonym — the language's own name, shown as the primary label. */
  native: string;
  /** English name, shown as muted subtext to aid recognition. */
  english: string;
  /** Text direction; drives the per-option `dir` and <html dir>. */
  dir: LocaleDir;
  /** `lang_REGION` for og:locale / og:locale:alternate. */
  ogLocale: string;
  /** Coarse grouping for a future column layout at 20+ locales. */
  region: 'Europa' | 'Global' | 'Asia' | 'MENA';
}

export const localeMeta: Record<string, LocaleMeta> = {
  es: { native: 'Español', english: 'Spanish', dir: 'ltr', ogLocale: 'es_ES', region: 'Europa' },
  en: { native: 'English', english: 'English', dir: 'ltr', ogLocale: 'en_US', region: 'Global' },
  ca: { native: 'Català', english: 'Catalan', dir: 'ltr', ogLocale: 'ca_ES', region: 'Europa' },
  fr: { native: 'Français', english: 'French', dir: 'ltr', ogLocale: 'fr_FR', region: 'Europa' },
  de: { native: 'Deutsch', english: 'German', dir: 'ltr', ogLocale: 'de_DE', region: 'Europa' },
  it: { native: 'Italiano', english: 'Italian', dir: 'ltr', ogLocale: 'it_IT', region: 'Europa' },
  pt: { native: 'Português', english: 'Portuguese', dir: 'ltr', ogLocale: 'pt_PT', region: 'Europa' },
  nl: { native: 'Nederlands', english: 'Dutch', dir: 'ltr', ogLocale: 'nl_NL', region: 'Europa' },
  pl: { native: 'Polski', english: 'Polish', dir: 'ltr', ogLocale: 'pl_PL', region: 'Europa' },
  tr: { native: 'Türkçe', english: 'Turkish', dir: 'ltr', ogLocale: 'tr_TR', region: 'Europa' },
  id: { native: 'Bahasa Indonesia', english: 'Indonesian', dir: 'ltr', ogLocale: 'id_ID', region: 'Asia' },
  vi: { native: 'Tiếng Việt', english: 'Vietnamese', dir: 'ltr', ogLocale: 'vi_VN', region: 'Asia' },
  ru: { native: 'Русский', english: 'Russian', dir: 'ltr', ogLocale: 'ru_RU', region: 'Europa' },
  uk: { native: 'Українська', english: 'Ukrainian', dir: 'ltr', ogLocale: 'uk_UA', region: 'Europa' },
  el: { native: 'Ελληνικά', english: 'Greek', dir: 'ltr', ogLocale: 'el_GR', region: 'Europa' },
  ja: { native: '日本語', english: 'Japanese', dir: 'ltr', ogLocale: 'ja_JP', region: 'Asia' },
  ko: { native: '한국어', english: 'Korean', dir: 'ltr', ogLocale: 'ko_KR', region: 'Asia' },
  zh: { native: '中文', english: 'Chinese', dir: 'ltr', ogLocale: 'zh_CN', region: 'Asia' },
  th: { native: 'ภาษาไทย', english: 'Thai', dir: 'ltr', ogLocale: 'th_TH', region: 'Asia' },
  hi: { native: 'हिन्दी', english: 'Hindi', dir: 'ltr', ogLocale: 'hi_IN', region: 'Asia' },
  ar: { native: 'العربية', english: 'Arabic', dir: 'rtl', ogLocale: 'ar_SA', region: 'MENA' },
};

/** Safe metadata for a code with no table entry — never render a raw code. */
export function fallbackMeta(code: string): LocaleMeta {
  return { native: code.toUpperCase(), english: code.toUpperCase(), dir: 'ltr', ogLocale: code, region: 'Global' };
}

export function metaFor(code: string): LocaleMeta {
  return localeMeta[code] ?? fallbackMeta(code);
}
