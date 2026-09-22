import { getTranslations } from "next-intl/server";

import { puede } from "@/lib/org/permisos";

import { SectionTabs } from "./SectionTabs";

/**
 * LAS PESTAÑAS DE «TU ORGANIZACIÓN», en un solo sitio: Cuenta · Equipo ·
 * Extracto. Un solo array para las tres páginas, para que la puerta de rol se
 * arregle en un sitio y no en tres.
 *
 * Equipo es de quien puede gestionar miembros — la misma puerta que el raíl y
 * que `GET /api/org/members`. `here` sólo importa cuando el rol NO se pudo
 * leer: una tira que esconde la pestaña de la página en la que estás no es una
 * decisión de permisos, es un mapa equivocado.
 */
export async function AccountTabs({
  role,
  here,
}: {
  role?: string | null;
  here?: "/dashboard/team";
}) {
  const nav = await getTranslations("app.sidebar");
  const roleKnown = typeof role === "string";
  const tabs = [
    { href: "/dashboard/account", label: nav("account") },
    ...(puede(role, "gestionar_miembros") || (!roleKnown && here === "/dashboard/team")
      ? [{ href: "/dashboard/team", label: nav("team") }]
      : []),
    { href: "/dashboard/extracto", label: nav("extracto") },
  ];
  return <SectionTabs tabs={tabs} />;
}
