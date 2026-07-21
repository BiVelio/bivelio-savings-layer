import { defineRouting } from 'next-intl/routing';
import { locales, defaultLocale } from './config';

// localePrefix defaults to 'always' → every locale is prefixed in the URL,
// including the default (`/es`, `/es/dashboard`), exactly like bivelio.com.
export const routing = defineRouting({
  locales,
  defaultLocale,
});
