import type { ReactNode } from "react";

import { MensajesCliente } from "@/i18n/MensajesCliente";

// El verificador de formato es cliente y traduce con `landing.verify`.
// El layout del idioma solo entrega al navegador la barra; ver
// i18n/mensajes-cliente.ts y su test, que vigila que no falte nada.
export default async function LayoutDeComoFunciona({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  return (
    <MensajesCliente tramo="verificador" locale={locale}>
      {children}
    </MensajesCliente>
  );
}
