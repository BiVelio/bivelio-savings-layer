import { getTranslations, setRequestLocale } from "next-intl/server";

import Footer from "@/app/components/Footer";
import { HowItWorks } from "@/app/components/HowItWorks";
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
        <section className="hiw-hero">
          <span className="eyebrow">{t("eyebrow")}</span>
          <h1>{t("title")}</h1>
          <p className="lede">{t("lede")}</p>
        </section>
        <HowItWorks variant="landing" />
      </main>
      <Footer />
    </div>
  );
}
