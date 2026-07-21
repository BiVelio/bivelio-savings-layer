import type { Metadata } from "next";
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
  robots: { index: false, follow: false },
  icons: { icon: "/logo-bivelio.png", apple: "/logo-bivelio.png" },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return children;
}
