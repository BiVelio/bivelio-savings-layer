import { getTranslations, setRequestLocale } from "next-intl/server";

import { AceptarInvitacion } from "./AceptarInvitacion";

/**
 * La pantalla a la que lleva el enlace del correo de invitación.
 *
 * El token viaja en la RUTA y NO se resuelve aquí, en el servidor: se le pasa al
 * componente de cliente, que lo manda por POST. Resolverlo en el render sería
 * aceptar la invitación con un GET —y los GET los precargan los antivirus de
 * correo y los "link scanners" corporativos, que quemarían el enlace antes de que
 * su destinatario llegara a verlo.
 */
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "invitacion" });
  // No es una pantalla pública y lleva una credencial en la URL: fuera del índice.
  return { title: t("metaTitle"), robots: { index: false, follow: false } };
}

export default async function PaginaInvitacion({
  params,
}: {
  params: Promise<{ locale: string; token: string }>;
}) {
  const { locale, token } = await params;
  setRequestLocale(locale);
  return <AceptarInvitacion token={decodeURIComponent(token)} />;
}
