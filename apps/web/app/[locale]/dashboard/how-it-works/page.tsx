import { getTranslations } from "next-intl/server";

import { PageHead } from "@/app/components/app/PageHead";
import { HowItWorks } from "@/app/components/HowItWorks";

/** La misma explicación «¿Dónde se instala el ahorro?» de la página pública,
 *  dentro del shell del dashboard: el usuario recién registrado que todavía no
 *  entiende dónde encaja la capa la tiene a un clic de Instalar. */
export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "howItWorks" });
  return { title: t("metaTitle") };
}

export default async function DashboardHowItWorksPage() {
  const t = await getTranslations("howItWorks");
  return (
    <>
      <PageHead eyebrow={t("eyebrow")} title={t("title")} sub={t("lede")} />
      <HowItWorks variant="app" />
    </>
  );
}
