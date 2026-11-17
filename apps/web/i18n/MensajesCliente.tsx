import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import { getMessages, setRequestLocale } from "next-intl/server";

import { elegirRamas, RAMAS_DEL_CLIENTE, type TramoDelCliente } from "./mensajes-cliente";

/**
 * El ÚNICO `NextIntlClientProvider` de la aplicación: entrega a los componentes
 * cliente que envuelve solo las ramas del catálogo de su tramo (ver
 * `i18n/mensajes-cliente.ts`), no el catálogo entero.
 *
 * Fija el idioma de la petición antes de leer nada: un layout anidado puede
 * renderizarse sin el del idioma (navegación en el cliente) y, sin
 * `setRequestLocale`, next-intl lo deduciría de las cabeceras, lo que haría
 * dinámica una ruta estática.
 */
export async function MensajesCliente({
  tramo,
  locale,
  children,
}: {
  tramo: TramoDelCliente;
  locale: string;
  children: ReactNode;
}) {
  setRequestLocale(locale);
  const mensajes = await getMessages({ locale });
  return (
    <NextIntlClientProvider locale={locale} messages={elegirRamas(mensajes, RAMAS_DEL_CLIENTE[tramo])}>
      {children}
    </NextIntlClientProvider>
  );
}
