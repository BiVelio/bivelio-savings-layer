import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

// Root layout is intentionally a pass-through: the <html>/<body> element, the
// pre-paint theme script and the next-intl provider all live in
// app/[locale]/layout.tsx (the active locale drives <html lang/dir>). Every page
// route lives under [locale]; the API, auth and revocation route handlers render
// no layout, so nothing outside [locale] needs an <html> shell.
export const metadata: Metadata = {
  metadataBase: new URL("https://savings.bivelio.com"),
  title: "BiVelio — Savings Layer",
  description:
    "BV-SALA — BiVelio's provider-neutral LLM cost optimizer. Verify the savings on your own data, then sign in with your BiVelio account.",
  // NO hay `robots: noindex` global. Lo hubo, y silenciaba el sitio entero: la
  // landing de los 12 idiomas servía `noindex, nofollow`, que no es "no me
  // encuentran" sino "prohíbo indexarme y seguir mis enlaces". El bloqueo se
  // aplica ahora SOLO donde toca — el shell del dashboard y las tres pantallas
  // de auth lo declaran en su propio metadata.
  // Isotipo «S» oficial de Savings (ver public/brand/). El de Apple lleva fondo
  // blanco porque iOS pinta la transparencia de negro.
  icons: {
    icon: [
      { url: "/brand/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/brand/favicon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: { url: "/brand/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
  },
};

// Color con el que se tiñe la barra de direcciones del móvil. Un solo valor:
// esta superficie es light-only, así que no procede el par light/dark que
// declara bivelio.com (cuyo tema tampoco conmuta ya, pero mantiene ambos).
export const viewport: Viewport = {
  themeColor: "#FFFFFF",
  colorScheme: "light",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return children;
}
