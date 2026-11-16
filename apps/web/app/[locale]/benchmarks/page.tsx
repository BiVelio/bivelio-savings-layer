import { getTranslations, setRequestLocale } from "next-intl/server";

import { BancoPublico, type Traductor } from "@/app/components/BancoPublico";
import { CentroDeEvidencia, type SeccionDelIndice } from "@/app/components/evidencia/CentroDeEvidencia";
import { ComparacionAB } from "@/app/components/evidencia/ComparacionAB";
import { filasAB } from "@/app/components/evidencia/filas-ab";
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
  const tUi = await getTranslations("ui");
  const banco = cargarBanco();
  const tr = t as unknown as Traductor;

  // EL CENTRO DE EVIDENCIA: el índice y los filtros de lectura se pintan desde
  // aquí y entran en el banco por su hueco. Solo se listan las secciones que la
  // página pinta de verdad (#weekly y #bugs dependen de los informes).
  const secciones: SeccionDelIndice[] = [
    { id: "method", etiqueta: t("index.method") },
    ...(banco.semanales.length > 0 ? [{ id: "weekly", etiqueta: t("index.weekly") }] : []),
    { id: "savings", etiqueta: t("index.savings") },
    { id: "gateway-ttl", etiqueta: t("index.gatewayTtl") },
    { id: "guarantees", etiqueta: t("index.guarantees") },
    { id: "no-savings", etiqueta: t("index.noSavings") },
    { id: "status", etiqueta: t("index.status") },
    ...(banco.fallos.length > 0 ? [{ id: "bugs", etiqueta: t("index.bugs") }] : []),
    { id: "reproduce", etiqueta: t("index.reproduce") },
    { id: "invite", etiqueta: t("index.invite") },
  ];
  const filas = filasAB(banco, tr, locale);

  return (
    <div className="lp terms-page evc">
      <BancoPublico
        banco={banco}
        t={tr}
        locale={locale}
        palancaTtl={PALANCA_TTL}
        etiquetas={{ abSdk: tUi("evidence.abSdk"), replayGateway: tUi("evidence.replayGateway") }}
        indice={
          <CentroDeEvidencia
            secciones={secciones}
            enlaces={
              <a className="evc-link" href="/papers/bv-sala-savings-layer-2026-10.pdf" target="_blank" rel="noopener">
                {t("centre.paper")}
              </a>
            }
          />
        }
        comparacion={filas.length > 0 ? <ComparacionAB filas={filas} locale={locale} etiquetaAb={tUi("evidence.abSdk")} /> : null}
      />
      <Footer sinGitHub />
    </div>
  );
}
