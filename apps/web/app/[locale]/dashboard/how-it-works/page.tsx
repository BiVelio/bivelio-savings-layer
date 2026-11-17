import { getTranslations } from "next-intl/server";

import { CabeceraDePagina } from "@/app/components/app/CabeceraDePagina";
import { Marcado } from "@/app/components/campana/Marcado";
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
  // Firma de campaña: el titular entero (`title` + `titleAccent`), con el
  // acento («el ahorro?») debajo, en serif cursiva, y el marcador donde lo
  // declara cada idioma (`titleMark`), como en el héroe de la página pública.
  return (
    <div className="cfu">
      <CabeceraDePagina
        rotulo={t("eyebrow")}
        titulo={
          <>
            {t("title")}{" "}
            <span className="cfu-acento">
              <Marcado texto={t("titleAccent")} marca={t("titleMark")} />
            </span>
          </>
        }
        entradilla={t("lede")}
      />
      <HowItWorks variant="app" />
    </div>
  );
}
