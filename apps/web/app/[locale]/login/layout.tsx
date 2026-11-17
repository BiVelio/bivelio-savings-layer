import type { ReactNode } from "react";

import { MensajesCliente } from "@/i18n/MensajesCliente";

// El formulario de acceso es cliente y traduce con `auth`.
// El layout del idioma solo entrega al navegador la barra; ver
// i18n/mensajes-cliente.ts y su test, que vigila que no falte nada.
export default async function LayoutDeLogin({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  return (
    <MensajesCliente tramo="acceso" locale={locale}>
      {children}
    </MensajesCliente>
  );
}
