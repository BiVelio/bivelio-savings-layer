import { getTranslations, setRequestLocale } from "next-intl/server";

import Footer from "@/app/components/Footer";
import { HowItWorks } from "@/app/components/HowItWorks";
import { PageHeader } from "@/app/components/ui";
import { Link } from "@/i18n/navigation";
import { absolute, languageAlternates } from "@/i18n/site";

/**
 * Página pública «¿Dónde se instala el ahorro?» — la explicación sin jerga que
 * responde a la pregunta que se hace cualquier visitante no técnico: «¿y esto
 * cómo lo instalo yo, que uso ChatGPT?». Indexable, con canonical + hreflang y
 * su propia tarjeta OG (ver `opengraph-image.tsx` al lado).
 */
export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "howItWorks" });
  const title = t("metaTitle");
  const description = t("metaDescription");
  const url = absolute(`/${locale}/how-it-works`);

  return {
    title,
    description,
    alternates: { canonical: url, languages: languageAlternates("how-it-works") },
    openGraph: { title, description, url, siteName: "BiVelio Savings Layer", type: "article" },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function HowItWorksPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("howItWorks");

  return (
    <div className="lp hiw-page">
      <main className="wrap">
        {/* Instalar open source no pasa por registro ni compra: la acción principal
            lleva al bloque de instalación de la portada; la de apoyo, al banco. */}
        <PageHeader
          className="hiw-hero"
          eyebrow={t("eyebrow")}
          titulo={t("title")}
          lede={t("lede")}
          acciones={
            <>
              <Link className="btn btn-lg" href="/#sdk-install">
                {t("hero.ctaInstall")}
              </Link>
              <Link className="btn btn-lg ghost" href="/benchmarks">
                {t("hero.ctaResults")}
              </Link>
            </>
          }
        />
        <HowItWorks variant="landing" />
      </main>
      <Footer />
    </div>
  );
}
