import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://savings.bivelio.com"),
  title: "BiVelio — Savings Layer",
  description:
    "BV-SALA — BiVelio's provider-neutral LLM cost optimizer. Verify the savings on your own data, then sign in with your BiVelio account.",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
