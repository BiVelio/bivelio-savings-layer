import { getTranslations, setRequestLocale } from "next-intl/server";

import { BancoPublico, type Traductor } from "@/app/components/BancoPublico";
import Footer from "@/app/components/Footer";
import { absolute, languageAlternates } from "@/i18n/site";
import { cargarBanco } from "@/lib/banco-publico/cargar";

/**
 * /benchmarks — EL BANCO PÚBLICO: nuestro A/B reproducible y la invitación a
 * medirnos (decisión del dueño, 2026-09-29).
 *
 * Los datos se leen de `docs/benchmarks/<fecha>/*.json` AL CONSTRUIR (de ahí el
 * `force-static`): la página no lleva un número escrito a mano, y un informe
 * nuevo que entre en esa carpeta aparece en el siguiente build sin tocar nada.
 * `dynamicParams = false`: un idioma que no existe da 404 sin intentar leer el
 * disco en tiempo de ejecución.
 */
export const dynamic = "force-static";
export const dynamicParams = false;

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "benchmarksPage" });
  const title = t("metaTitle");
  const description = t("metaDescription");
  const url = absolute(`/${locale}/benchmarks`);

  return {
    title,
    description,
    alternates: { canonical: url, languages: languageAlternates("benchmarks") },
    openGraph: { title, description, url, siteName: "BiVelio Savings Layer", type: "article" },
    twitter: { card: "summary", title, description },
  };
}

export default async function BenchmarksPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("benchmarksPage");

  return (
    <div className="lp terms-page">
      <BancoPublico banco={cargarBanco()} t={t as unknown as Traductor} locale={locale} />
      <Footer sinGitHub />
    </div>
  );
}
