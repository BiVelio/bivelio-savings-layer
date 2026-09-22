import { getTranslations } from "next-intl/server";

import { AccountTabs } from "@/app/components/app/AccountTabs";
import { PageHead } from "@/app/components/app/PageHead";
import { EquipoPanel } from "../components/EquipoPanel";
import { loadDashboard } from "../load";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "dashboard" });
  return { title: t("team.metaTitle") };
}

/**
 * EL EQUIPO, CON PÁGINA PROPIA. Vivía como un bloque al final de Cuenta, que
 * es donde nadie lo buscaba; en privacy es una pantalla del grupo «Tu
 * organización» y aquí pasa a serlo también. `EquipoPanel` no decide nada: el
 * listado se lo da (o se lo niega) el servidor con la tabla de permisos, y si
 * devuelve 403 el panel se calla entero.
 */
export default async function TeamPage() {
  const t = await getTranslations("dashboard");
  const { ctx } = await loadDashboard();
  return (
    <>
      <AccountTabs role={ctx.role} here="/dashboard/team" />
      <PageHead eyebrow={t("account.eyebrow")} title={t("equipo.title")} sub={t("equipo.intro")} />
      <EquipoPanel />
    </>
  );
}
