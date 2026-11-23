import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { HeroeDeCampana } from "@/app/components/campana/HeroeDeCampana";
import Footer from "@/app/components/Footer";
import { Link } from "@/i18n/navigation";
import { tarjetaSocial } from "@/i18n/site";
import { leerEnLinea } from "@/lib/guia-migracion/markdown";
import { Breadcrumb } from "@/vendor/affectui/breadcrumb-clean";
import { GridBackground } from "@/vendor/affectui/grid-background";

import { fechaLegible } from "./articulo";
import { EnLineaR } from "./Bloques";
import { alternativasDe, canonicalDe, GUIAS, guiaEnIdioma, indiceEnIdioma } from "./registry";

/**
 * /<idioma>/guides — EL ÍNDICE DE LAS GUÍAS, en el idioma de quien lee: el
 * titular, la descripción y la entradilla salen de `content/<idioma>/_meta.json`
 * (texto, como las guías) y la interfaz de `messages/<idioma>.json`
 * (`guidesPage`). Cada entrada de la lista va en el idioma de su guía: la
 * traducción si existe; si no, el titular inglés con `lang="en"`.
 *
 * `canonical` en su propia URL y `hreflang` de todas las ediciones (registry:
 * `alternativasDe`), los mismos que anuncia el sitemap. Un idioma sin índice
 * traducido sirve el inglés con su nota y el `canonical` en /en.
 */
export const dynamic = "force-static";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const indice = indiceEnIdioma(locale);
  const url = canonicalDe(undefined, locale);
  const social = tarjetaSocial(indice.idioma, indice.title);
  return {
    title: `${indice.title} · BiVelio`,
    description: indice.description,
    alternates: { canonical: url, languages: alternativasDe() },
    openGraph: { title: indice.title, description: indice.description, url, siteName: "BiVelio Savings Layer", type: "website", ...social.openGraph },
    twitter: { ...social.twitter, title: indice.title, description: indice.description },
  };
}

export default async function GuidesIndexPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const indice = indiceEnIdioma(locale);
  // La interfaz del índice va en el idioma del índice que se sirve: si no hay
  // índice traducido, todo el texto es el inglés (y la nota lo dice).
  const tg = await getTranslations({ locale: indice.idioma, namespace: "guidesPage" });
  const t = await getTranslations("docsPage");
  const tn = await getTranslations("nav");
  const lang = indice.idioma;

  return (
    <div className="lp terms-page doc-page">
      <main className="wrap guia-page" lang={locale}>
        <HeroeDeCampana pagina="guides">
          <GridBackground className="doc-fondo">
            <section className="terms-hero guia-hero" id="inicio">
              <Breadcrumb
                className="doc-migas"
                label={tn("breadcrumb")}
                linkAs={Link}
                items={[{ label: tn("home"), href: "/" }, { label: <span lang={lang}>{tg("breadcrumb")}</span> }]}
              />
              <span className="eyebrow" lang={lang}>
                {tg("eyebrowIndex")}
              </span>
              <h1 lang={lang}>{indice.title}</h1>
              {indice.enIngles ? (
                <p className="doc-nota" lang={locale}>
                  {t("englishOnly")}
                </p>
              ) : null}
              <p lang={lang}>{indice.intro}</p>
              <p lang={lang}>
                <EnLineaR c={leerEnLinea(indice.sources)} />
              </p>
            </section>
          </GridBackground>
        </HeroeDeCampana>
        <div className="doc-body">
          {GUIAS.map((guia) => {
            const g = guiaEnIdioma(guia, locale);
            return (
              <section key={g.slug} className="terms-sec" aria-labelledby={`guia-${g.slug}`} lang={g.idioma}>
                <h2 id={`guia-${g.slug}`}>
                  <Link href={`/guides/${g.slug}`}>{g.title}</Link>
                </h2>
                <p>{g.description}</p>
                <p lang={lang}>
                  <time dateTime={g.date}>{fechaLegible(g.date, lang)}</time> ·{" "}
                  <Link href={`/guides/${g.slug}`} aria-label={tg("readAria", { title: g.title })}>
                    {tg("readGuide")}
                  </Link>
                </p>
              </section>
            );
          })}
        </div>
      </main>
      <Footer />
    </div>
  );
}
