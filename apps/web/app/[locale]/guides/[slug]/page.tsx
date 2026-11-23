import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { HeroeDeCampana } from "@/app/components/campana/HeroeDeCampana";
import { DocIndice } from "@/app/components/docs/DocIndice";
import Footer from "@/app/components/Footer";
import { Link } from "@/i18n/navigation";
import { tarjetaSocial } from "@/i18n/site";
import { textoPlano } from "@/lib/guia-migracion/markdown";
import { Breadcrumb } from "@/vendor/affectui/breadcrumb-clean";
import { GridBackground } from "@/vendor/affectui/grid-background";

import { Bloques, secciones, type Copiar } from "../Bloques";
import { cargarTexto } from "../cargar";
import { datosEstructurados, fechaLegible, minutosDeLectura } from "../articulo";
import { alternativasDe, canonicalDe, GUIAS, guiaEnIdioma, guiaPorSlug } from "../registry";

/**
 * /<idioma>/guides/<slug> — UNA GUÍA, en el idioma de quien lee: el texto de
 * `../content/<idioma>/<slug>.md` y el titular de `_meta.json`, leídos al
 * construir. El `canonical` es su propia URL y los `hreflang` (los mismos que
 * el sitemap) enlazan las doce ediciones con `x-default` en /en.
 *
 * Si a un idioma le falta la traducción de una guía, ese prefijo sirve el
 * original inglés como antes: `lang="en"` en el artículo, una línea que lo
 * dice y el `canonical` en /en. Así ni el selector de idioma ni la cabecera
 * `Link:` del middleware de next-intl llevan nunca a un 404.
 * `dynamicParams = false` deja en 404 cualquier slug que no esté en el registro.
 *
 * La forma es la de la guía de migración (cabecera con la firma de campaña,
 * índice a la izquierda, código en el marco de la fundación), más lo que pide
 * una página que tiene que encontrarse en un buscador: `canonical`, Open Graph
 * de artículo y el JSON-LD `Article` con su fecha, su idioma y BiVelio como autor.
 */
export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return GUIAS.map((g) => ({ slug: g.slug }));
}

type Params = { params: Promise<{ locale: string; slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale, slug } = await params;
  const original = guiaPorSlug(slug);
  if (!original) return {};
  const guia = guiaEnIdioma(original, locale);
  const url = canonicalDe(slug, locale);
  const social = tarjetaSocial(guia.idioma, guia.title);
  return {
    title: `${guia.title} · BiVelio`,
    description: guia.description,
    alternates: { canonical: url, languages: alternativasDe(slug) },
    authors: [{ name: "BiVelio" }],
    openGraph: {
      title: guia.title,
      description: guia.description,
      url,
      siteName: "BiVelio Savings Layer",
      type: "article",
      publishedTime: guia.date,
      modifiedTime: guia.updated ?? guia.date,
      authors: ["BiVelio"],
      ...social.openGraph,
    },
    twitter: { ...social.twitter, title: guia.title, description: guia.description },
  };
}

export default async function GuidePage({ params }: Params) {
  const { locale, slug } = await params;
  const original = guiaPorSlug(slug);
  if (!original) notFound();
  setRequestLocale(locale);
  const guia = guiaEnIdioma(original, locale);
  // El idioma del TEXTO servido: el de la URL si hay traducción; si no, el inglés.
  const lang = guia.idioma;
  const t = await getTranslations("docsPage");
  const tu = await getTranslations("ui");
  const tn = await getTranslations("nav");
  // Lo que es del artículo (antetítulo, firma, «más guías») va en su idioma.
  const tg = await getTranslations({ locale: lang, namespace: "guidesPage" });
  // Lo que es de la interfaz (copiar, nombre de la tabla) va en el de quien lee.
  const tgi = await getTranslations("guidesPage");
  const copiar: Copiar = { etiqueta: tu("copy"), etiquetaCopiado: tu("copied") };

  const bloques = cargarTexto(slug, locale);
  const { entradilla, secciones: partes } = secciones(bloques);
  const indice = partes.flatMap((p) => {
    const titulo = p[0]!;
    return titulo.t === "titulo" ? [{ id: titulo.id, texto: textoPlano(titulo.c) }] : [];
  });
  const otras = GUIAS.filter((g) => g.slug !== slug).map((g) => guiaEnIdioma(g, locale));

  return (
    <div className="lp terms-page doc-page">
      <script
        type="application/ld+json"
        // Datos, no código: JSON escapado para que ningún `<` cierre la etiqueta.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(datosEstructurados(guia, bloques)).replace(/</g, "\\u003c") }}
      />
      {/* La página va en el idioma de quien lee (migas, índice, «volver
          arriba», el botón de copiar) y cada pieza del texto lleva el idioma
          en que está escrita: el de la página si hay traducción, `en` si se
          sirve el original. Un lector de pantalla pronuncia cada cosa en su idioma. */}
      <main className="wrap guia-page" lang={locale}>
        <HeroeDeCampana pagina="guides">
          <GridBackground className="doc-fondo">
            <section className="terms-hero guia-hero" id="inicio">
              <Breadcrumb
                className="doc-migas"
                label={tn("breadcrumb")}
                linkAs={Link}
                items={[
                  { label: tn("home"), href: "/" },
                  { label: <span lang={lang}>{tg("breadcrumb")}</span>, href: "/guides" },
                  { label: <span lang={lang}>{guia.title}</span> },
                ]}
              />
              <span className="eyebrow" lang={lang}>
                {tg("eyebrowGuide")}
              </span>
              <h1 lang={lang}>{guia.title}</h1>
              <p className="doc-nota" lang={lang}>
                {tg("by")} · <time dateTime={guia.date}>{fechaLegible(guia.date, lang)}</time>
                {guia.updated ? (
                  <>
                    {" "}
                    ·{" "}
                    {tg.rich("updated", {
                      date: fechaLegible(guia.updated, lang),
                      fecha: (chunks) => <time dateTime={guia.updated}>{chunks}</time>,
                    })}
                  </>
                ) : null}{" "}
                · {tg("minRead", { n: minutosDeLectura(bloques) })}
              </p>
              {/* Interfaz, no artículo: va en el idioma de quien lee. */}
              {guia.enIngles ? (
                <p className="doc-nota" lang={locale}>
                  {t("englishOnly")}
                </p>
              ) : null}
              <Bloques bloques={entradilla} copiar={copiar} lang={lang} tabla={tgi("table")} />
            </section>
          </GridBackground>
        </HeroeDeCampana>
        <div className="doc-grid">
          <DocIndice titulo={t("contents")} entradas={indice} lang={lang} />
          <div className="doc-body">
            {partes.map((p, i) => (
              <section key={i} className="terms-sec" aria-labelledby={p[0]!.t === "titulo" ? p[0]!.id : undefined}>
                <Bloques bloques={p} copiar={copiar} lang={lang} tabla={tgi("table")} />
              </section>
            ))}
            <section className="terms-sec" aria-labelledby="more-guides">
              <h2 id="more-guides" lang={lang}>
                {tg("moreGuides")}
              </h2>
              <ul className="terms-list">
                {otras.map((g) => (
                  <li key={g.slug} lang={g.idioma}>
                    <Link href={`/guides/${g.slug}`}>{g.title}</Link>
                  </li>
                ))}
              </ul>
            </section>
            <p className="doc-arriba">
              <a href="#inicio">{t("backToTop")}</a>
            </p>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
