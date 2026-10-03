import { getTranslations, setRequestLocale } from "next-intl/server";

import { BancoPublico, type Traductor } from "@/app/components/BancoPublico";
import Footer from "@/app/components/Footer";
import { absolute, languageAlternates, tarjetaSocial } from "@/i18n/site";
import { cargarBanco } from "@/lib/banco-publico/cargar";
import { PALANCA_TTL } from "@/lib/portada/palanca-ttl";

/**
 * /benchmarks — EL BANCO PÚBLICO: nuestro A/B reproducible y la invitación a
 * medirnos (decisión del dueño, 2026-09-29).
 *
 * Los datos se leen de `docs/benchmarks/<fecha>/*.json` AL CONSTRUIR (de ahí el
 * `force-static`): la página no lleva un número escrito a mano, y un informe
 * nuevo que entre en esa carpeta aparece en el siguiente build sin tocar nada.
 * `dynamicParams = false`: un idioma que no existe da 404 sin intentar leer el
 * disco en tiempo de ejecución.
 *
 * Una excepción, dicha: la sección de la rebaja de caché del gateway
 * (#gateway-ttl) no es una batería A/B ni un JSON de esa carpeta, sino un replay
 * cuyo informe no se sirve. Sus números vienen de lib/portada/palanca-ttl.ts,
 * con una verja que los cuadra uno a uno contra el informe.
 */
export const dynamic = "force-static";
export const dynamicParams = false;

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "benchmarksPage" });
  const title = t("metaTitle");
  const description = t("metaDescription");
  const url = absolute(`/${locale}/benchmarks`);
  const social = tarjetaSocial(locale, title);

  return {
    title,
    description,
    alternates: { canonical: url, languages: languageAlternates("benchmarks") },
    openGraph: { title, description, url, siteName: "BiVelio Savings Layer", type: "article", ...social.openGraph },
    twitter: { ...social.twitter, title, description },
  };
}

export default async function BenchmarksPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("benchmarksPage");

  return (
    <div className="lp terms-page">
      <BancoPublico banco={cargarBanco()} t={t as unknown as Traductor} locale={locale} palancaTtl={PALANCA_TTL} />
      <Footer sinGitHub />
    </div>
  );
}
