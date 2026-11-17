import type { ReactNode } from "react";

import { MensajesCliente } from "@/i18n/MensajesCliente";

// Aceptar la invitación es cliente: traduce con `invitacion`, los roles de
// `dashboard.equipo` y el «mostrar/ocultar» de la clave de `auth`.
// El layout del idioma solo entrega al navegador la barra; ver
// i18n/mensajes-cliente.ts y su test, que vigila que no falte nada.
export default async function LayoutDeInvitacion({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  return (
    <MensajesCliente tramo="invitacion" locale={locale}>
      {children}
    </MensajesCliente>
  );
}
