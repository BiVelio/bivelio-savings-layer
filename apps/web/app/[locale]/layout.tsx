import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getMessages, setRequestLocale } from "next-intl/server";

import "../globals.css";
import { NavBar } from "@/app/components/NavBar";
import { SiteNavGate } from "@/app/components/SiteNavGate";
import { routing } from "@/i18n/routing";
import { metaFor } from "@/i18n/locale-meta";

// Pre-render one static shell per live locale.
export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

// Set the theme before first paint (no flash). Default is LIGHT — the OS
// preference is intentionally ignored; only an explicit stored 'dark' choice
// flips it, until the user decides otherwise.
const THEME_INIT = `(function(){try{var s=localStorage.getItem('bv-theme');document.documentElement.setAttribute('data-theme',s==='dark'?'dark':'light');}catch(e){}})();`;

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  // Enable static rendering for this request's locale.
  setRequestLocale(locale);

  const messages = await getMessages();
  const dir = metaFor(locale).dir;

  return (
    <html lang={locale} dir={dir} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>
        <NextIntlClientProvider messages={messages}>
          <SiteNavGate>
            <NavBar />
          </SiteNavGate>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
