import type { ReactNode } from "react";

import { MensajesCliente } from "@/i18n/MensajesCliente";

// Galería de desarrollo con piezas cliente del panel: las mismas ramas que él.
// El layout del idioma solo entrega al navegador la barra; ver
// i18n/mensajes-cliente.ts y su test, que vigila que no falte nada.
export default async function LayoutDeCapturaDeCuenta({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  return (
    <MensajesCliente tramo="panel" locale={locale}>
      {children}
    </MensajesCliente>
  );
}
