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
import { GUIAS, IDIOMA_DE_LAS_GUIAS, guiaPorSlug, urlDeGuia } from "../registry";

/**
 * /en/guides/<slug> — UNA GUÍA. Solo existe en inglés: en los otros once
 * idiomas la página llama a `notFound()`, y `dynamicParams = false` deja en 404
 * cualquier slug que no esté en el registro.
 *
 * Por qué los slugs se generan para TODOS los idiomas y no solo para `en`: si
 * esta función devuelve `[]` para un idioma, Next (15.5) pasa los parámetros
 * del padre sin `slug` y la ruta entera se queda sin páginas, también en
 * inglés. Generar las doce y dar 404 en once es lo que funciona.
 *
 * El texto es `../content/<slug>.md`, leído al construir. La forma es la de la
 * guía de migración (cabecera con la firma de campaña, índice a la izquierda,
 * código en el marco de la fundación), más lo que pide una página que tiene que
 * encontrarse en un buscador: `canonical`, Open Graph de artículo y el JSON-LD
 * `Article` con su fecha y BiVelio como autor.
 */
export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return GUIAS.map((g) => ({ slug: g.slug }));
}

type Params = { params: Promise<{ locale: string; slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale, slug } = await params;
  const guia = guiaPorSlug(slug);
  if (!guia || locale !== IDIOMA_DE_LAS_GUIAS) return {};
  const url = urlDeGuia(slug);
  const social = tarjetaSocial(IDIOMA_DE_LAS_GUIAS, guia.title);
  return {
    title: `${guia.title} · BiVelio`,
    description: guia.description,
    alternates: { canonical: url },
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
  const guia = guiaPorSlug(slug);
  if (!guia || locale !== IDIOMA_DE_LAS_GUIAS) notFound();
  setRequestLocale(locale);
  const t = await getTranslations("docsPage");
  const tu = await getTranslations("ui");
  const tn = await getTranslations("nav");
  const copiar: Copiar = { etiqueta: tu("copy"), etiquetaCopiado: tu("copied") };

  const bloques = cargarTexto(slug);
  const { entradilla, secciones: partes } = secciones(bloques);
  const indice = partes.flatMap((p) => {
    const titulo = p[0]!;
    return titulo.t === "titulo" ? [{ id: titulo.id, texto: textoPlano(titulo.c) }] : [];
  });
  const otras = GUIAS.filter((g) => g.slug !== slug);

  return (
    <div className="lp terms-page doc-page">
      <script
        type="application/ld+json"
        // Datos, no código: JSON escapado para que ningún `<` cierre la etiqueta.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(datosEstructurados(guia, bloques)).replace(/</g, "\\u003c") }}
      />
      <main className="wrap guia-page" lang="en">
        <HeroeDeCampana pagina="guides">
          <GridBackground className="doc-fondo">
            <section className="terms-hero guia-hero" id="inicio">
              <Breadcrumb
                className="doc-migas"
                label={tn("breadcrumb")}
                linkAs={Link}
                lang="en"
                items={[{ label: tn("home"), href: "/" }, { label: "Guides", href: "/guides" }, { label: guia.title }]}
              />
              <span className="eyebrow">Guide · LLM API costs</span>
              <h1>{guia.title}</h1>
              <p className="doc-nota">
                By BiVelio · <time dateTime={guia.date}>{fechaLegible(guia.date)}</time>
                {guia.updated ? (
                  <>
                    {" "}
                    · updated <time dateTime={guia.updated}>{fechaLegible(guia.updated)}</time>
                  </>
                ) : null}{" "}
                · {minutosDeLectura(bloques)} min read
              </p>
              <Bloques bloques={entradilla} copiar={copiar} />
            </section>
          </GridBackground>
        </HeroeDeCampana>
        <div className="doc-grid">
          <DocIndice titulo={t("contents")} entradas={indice} lang="en" />
          <div className="doc-body">
            {partes.map((p, i) => (
              <section key={i} className="terms-sec" aria-labelledby={p[0]!.t === "titulo" ? p[0]!.id : undefined}>
                <Bloques bloques={p} copiar={copiar} />
              </section>
            ))}
            <section className="terms-sec" aria-labelledby="more-guides">
              <h2 id="more-guides">More guides</h2>
              <ul className="terms-list">
                {otras.map((g) => (
                  <li key={g.slug}>
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
