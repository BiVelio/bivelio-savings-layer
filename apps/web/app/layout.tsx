import type { Metadata } from "next";

import "./globals.css";
import { NavBar } from "./components/NavBar";
import { SiteNavGate } from "./components/SiteNavGate";

export const metadata: Metadata = {
  metadataBase: new URL("https://savings.bivelio.com"),
  title: "BiVelio — Savings Layer",
  description:
    "BV-SALA — BiVelio's provider-neutral LLM cost optimizer. Verify the savings on your own data, then sign in with your BiVelio account.",
  robots: { index: false, follow: false },
  icons: { icon: "/logo-bivelio.png", apple: "/logo-bivelio.png" },
};

// Set the theme before first paint (no flash): honor a stored choice, else the OS.
const THEME_INIT = `(function(){try{var s=localStorage.getItem('bv-theme');var d=s?s==='dark':(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.setAttribute('data-theme',d?'dark':'light');}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>
        <SiteNavGate>
          <NavBar />
        </SiteNavGate>
        {children}
      </body>
    </html>
  );
}
