import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { HeroeDeCampana } from "@/app/components/campana/HeroeDeCampana";
import Footer from "@/app/components/Footer";
import { ArrowRightIcon } from "@/app/components/icons";
import { Link } from "@/i18n/navigation";
import { tarjetaSocial } from "@/i18n/site";
import { leerEnLinea } from "@/lib/guia-migracion/markdown";
import { Breadcrumb } from "@/vendor/affectui/breadcrumb-clean";
import { GridBackground } from "@/vendor/affectui/grid-background";

import { fechaLegible, minutosDeLectura } from "./articulo";
import { EnLineaR } from "./Bloques";
import { cargarTexto } from "./cargar";
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
 *
 * La lista es una rejilla de tarjetas (dos columnas desde 960 px, una por
 * debajo; dueño, 2026-11-23: «darle espacio y modernizar»): el tema, el
 * titular, la descripción y un pie con la fecha corta, los minutos de lectura
 * (los mismos que da la cabecera de la guía) y «Leer la guía →». La guía
 * `destacada` de lista.ts abre a todo el ancho con su propia composición. UN
 * solo enlace por tarjeta, el del titular, estirado sobre toda ella con
 * `::after`: un lector de pantalla oye un enlace por guía con su titular por
 * nombre, y el «Leer la guía →» del pie es solo la señal visual (`aria-hidden`;
 * en el móvil, solo la flecha).
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
        <div className="guias-indice">
          <ul className="guias-lista" role="list">
            {GUIAS.map((guia) => {
              const g = guiaEnIdioma(guia, locale);
              return (
                <li key={g.slug} className={g.destacada ? "guias-item guias-item--destacada" : "guias-item"}>
                  <article
                    className={g.destacada ? "guia-tarjeta guia-tarjeta--destacada" : "guia-tarjeta"}
                    aria-labelledby={`guia-${g.slug}`}
                    lang={g.idioma}
                  >
                    <p className="guia-tarjeta-tema" lang={lang}>
                      {tg(`topics.${g.tema}`)}
                    </p>
                    <h2 id={`guia-${g.slug}`} className="guia-tarjeta-titulo">
                      <Link href={`/guides/${g.slug}`}>{g.title}</Link>
                    </h2>
                    <p className="guia-tarjeta-resumen">{g.description}</p>
                    <div className="guia-tarjeta-pie" lang={lang}>
                      <p className="guia-tarjeta-datos">
                        <time dateTime={g.date}>{fechaLegible(g.date, lang, "short")}</time>
                        <span aria-hidden="true">·</span>
                        <span>{tg("minRead", { n: minutosDeLectura(cargarTexto(g.slug, locale)) })}</span>
                      </p>
                      <span className="guia-tarjeta-leer" aria-hidden="true">
                        <span className="guia-tarjeta-leer-texto">{tg("readGuide")}</span>
                        <ArrowRightIcon />
                      </span>
                    </div>
                  </article>
                </li>
              );
            })}
          </ul>
        </div>
      </main>
      <Footer />
    </div>
  );
}
