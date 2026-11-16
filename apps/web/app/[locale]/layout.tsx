import type { ReactNode } from "react";
import Script from "next/script";
import { notFound } from "next/navigation";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getMessages, setRequestLocale } from "next-intl/server";

import "../globals.css";
// Las hojas de affectUI que usa el sitio público, en un fichero y DESPUÉS de
// globals.css (el orden de cascada de siempre). Van aquí y no en cada
// componente: así una página espera dos hojas antes de pintar en vez de hasta
// quince, y la 404 no depende de hojas que solo conoce su árbol — eso la
// dejaba en blanco en una de cada tres cargas directas (la causa, en la
// cabecera de affectui.css). Las que solo usa el panel las carga su layout.
import "@/vendor/affectui/affectui.css";
import { NavBar } from "@/app/components/NavBar";
import { SiteNavGate } from "@/app/components/SiteNavGate";
import { routing } from "@/i18n/routing";
import { metaFor } from "@/i18n/locale-meta";

// Pre-render one static shell per live locale.
export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

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
    // Superficie light-only, igual que bivelio.com: no hay script de tema, ni
    // atributo que corregir antes del primer paint, ni parpadeo que evitar.
    <html lang={locale} dir={dir}>
      <head>
        {/* Las @font-face viven dentro de globals.css, así que el navegador no
            descubre los woff2 hasta parsear la hoja — un round-trip extra justo
            sobre el elemento LCP (el h1 en Plus Jakarta Sans). Solo los dos
            subconjuntos latinos que pinta el primer pliegue: Geist (cuerpo y
            cabecera) y Plus Jakarta Sans (titular). Geist Mono, Instrument
            Serif y los latin-ext NO se precargan: el navegador los pide solo
            si la página los usa. */}
        <link rel="preload" href="/fonts/geist-latin-wght-normal.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        <link rel="preload" href="/fonts/plus-jakarta-sans-latin-wght-normal.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
      </head>
      <body>
        {/* Google tag (gtag.js) — seguimiento de conversiones de Google Ads
            (pedido del dueño, 02-09). `afterInteractive` para no competir con
            el LCP; los hosts van declarados en la CSP (next.config.mjs) o el
            navegador lo bloquearía en silencio. */}
        <Script src="https://www.googletagmanager.com/gtag/js?id=AW-18425303387" strategy="afterInteractive" />
        <Script id="gtag-init" strategy="afterInteractive">{`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          gtag('js', new Date());
          gtag('config', 'AW-18425303387');
        `}</Script>
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
