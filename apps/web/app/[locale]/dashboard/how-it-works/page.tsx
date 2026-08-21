import { getTranslations } from "next-intl/server";

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
      <div className="app-head">
        <p className="ck-eyebrow">{t("eyebrow")}</p>
        <h1>{t("title")}</h1>
        <p>{t("lede")}</p>
      </div>
      <HowItWorks variant="app" />
    </>
  );
}
