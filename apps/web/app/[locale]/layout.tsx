import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";

import "../globals.css";
// Las hojas de affectUI que usa el sitio público, en un fichero y DESPUÉS de
// globals.css (el orden de cascada de siempre). Van aquí y no en cada
// componente: así una página espera dos hojas antes de pintar en vez de hasta
// quince, y la 404 no depende de hojas que solo conoce su árbol — eso la
// dejaba en blanco en una de cada tres cargas directas (la causa, en la
// cabecera de affectui.css). Las que solo usa el panel las carga su layout, y
// las del acceso (login, alta, invitación), cada una de sus páginas.
import "@/vendor/affectui/affectui.css";
import { EtiquetaGoogleAds } from "@/app/components/EtiquetaGoogleAds";
import { MedicionWeb } from "@/app/components/MedicionWeb";
import { NavBar } from "@/app/components/NavBar";
import { SiteNavGate } from "@/app/components/SiteNavGate";
import { SkipLink, SkipTarget } from "@/app/components/SkipLink";
import { routing } from "@/i18n/routing";
import { metaFor } from "@/i18n/locale-meta";
import { MensajesCliente } from "@/i18n/MensajesCliente";

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
        {/* Al navegador va solo lo que piden los componentes cliente de la
            barra (`sitio`), no el catálogo entero: viajaba serializado en el
            HTML de CADA página (~170 KB). Las rutas cuyos componentes cliente
            piden más envuelven su tramo en su propio MensajesCliente (ver
            i18n/mensajes-cliente.ts). */}
        <MensajesCliente tramo="sitio" locale={locale}>
          {/* Google tag (gtag.js) — seguimiento de conversiones de Google Ads
              (pedido del dueño, 02-09). `afterInteractive` para no competir
              con el LCP; los hosts van declarados en la CSP (next.config.mjs).
              No se carga con una URL con token y, en el resto, va con la URL
              limpia: ver EtiquetaGoogleAds. Va ANTES que la página: su efecto
              define `window.gtag` antes de que ConversionRegistro lo use. */}
          <EtiquetaGoogleAds />
          <SiteNavGate>
            {/* Primer foco de la página y su destino, a los dos lados de la
                cabecera. El panel pinta los suyos (dashboard/layout.tsx). */}
            <SkipLink />
            <NavBar />
            <SkipTarget />
          </SiteNavGate>
          {children}
          {/* Medición de la WEB, no del paquete (que sigue sin telemetría):
              Vercel Web Analytics, sin cookies y en agregado — vistas de
              página, copias del comando de instalación, salidas a
              GitHub/npm/PyPI y pasos al alta (lib/medicion/eventos.ts). No
              pide mensajes. Solo en el build de producción: en `next dev` no
              se carga nada. */}
          {process.env.NODE_ENV === "production" ? <MedicionWeb /> : null}
        </MensajesCliente>
      </body>
    </html>
  );
}
