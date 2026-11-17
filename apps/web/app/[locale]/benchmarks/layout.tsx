import type { ReactNode } from "react";

import { MensajesCliente } from "@/i18n/MensajesCliente";

// El centro de evidencia y la comparación A/B son cliente y traducen con
// `benchmarksPage` (solo las ramas que usan) y `ui.evidence`.
// El layout del idioma solo entrega al navegador la barra; ver
// i18n/mensajes-cliente.ts y su test, que vigila que no falte nada.
export default async function LayoutDeBenchmarks({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  return (
    <MensajesCliente tramo="evidencia" locale={locale}>
      {children}
    </MensajesCliente>
  );
}
