import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { HeroeDeCampana } from "@/app/components/campana/HeroeDeCampana";
import { Migas } from "@/app/components/docs/Migas";
import Footer from "@/app/components/Footer";
import { Link } from "@/i18n/navigation";
import { tarjetaSocial } from "@/i18n/site";
import { GridBackground } from "@/vendor/affectui/grid-background";

import { fechaLegible } from "./articulo";
import { GUIAS, IDIOMA_DE_LAS_GUIAS, urlDeGuia } from "./registry";

/**
 * /<idioma>/guides — EL ÍNDICE DE LAS GUÍAS. Las guías están en inglés y se
 * sirven igual bajo los doce prefijos, con el `canonical` en /en (como el
 * paper): el selector de idioma y la cabecera `Link:` del middleware nunca
 * llevan a un 404, y el sitemap anuncia solo /en. La lista sale de
 * `registry.ts`.
 */
export const dynamic = "force-static";

const TITULO = "Guides to cutting your LLM API bill";
const DESCRIPCION =
  "Practical guides to lower OpenAI, Anthropic, DeepSeek and Qwen API costs: caching, deduplication, Claude Code spend per request, and how to verify savings on your bill.";

export function generateMetadata(): Metadata {
  const url = urlDeGuia();
  const social = tarjetaSocial(IDIOMA_DE_LAS_GUIAS, TITULO);
  return {
    title: `${TITULO} · BiVelio`,
    description: DESCRIPCION,
    alternates: { canonical: url, languages: { en: url, "x-default": url } },
    openGraph: { title: TITULO, description: DESCRIPCION, url, siteName: "BiVelio Savings Layer", type: "website", ...social.openGraph },
    twitter: { ...social.twitter, title: TITULO, description: DESCRIPCION },
  };
}

export default async function GuidesIndexPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("docsPage");

  return (
    <div className="lp terms-page doc-page">
      <main className="wrap guia-page" lang="en">
        <HeroeDeCampana pagina="guides">
          <GridBackground className="doc-fondo">
            <section className="terms-hero guia-hero" id="inicio">
              <Migas actual="Guides" lang="en" />
              <span className="eyebrow">Guides · LLM API costs</span>
              <h1>{TITULO}</h1>
              {locale === IDIOMA_DE_LAS_GUIAS ? null : (
                <p className="doc-nota" lang={locale}>
                  {t("englishOnly")}
                </p>
              )}
              <p>
                Practical, provider-neutral guides for developers who pay a per-token bill. Each one teaches the
                technique first, so it is useful without any tool; then shows how the open-source BV-SALA layer does it,
                free and with no key; then shows how to check the saving against your provider&apos;s own usage
                numbers.
              </p>
              <p>
                Every figure comes from the provider&apos;s documentation or from our{" "}
                <Link href="/benchmarks">published benchmarks</Link>, and says where it came from. The code is on{" "}
                <a href="https://github.com/BiVelio/bivelio-savings-layer" rel="noopener noreferrer">
                  GitHub
                </a>
                .
              </p>
            </section>
          </GridBackground>
        </HeroeDeCampana>
        <div className="doc-body">
          {GUIAS.map((g) => (
            <section key={g.slug} className="terms-sec" aria-labelledby={`guia-${g.slug}`}>
              <h2 id={`guia-${g.slug}`}>
                <Link href={`/guides/${g.slug}`}>{g.title}</Link>
              </h2>
              <p>{g.description}</p>
              <p>
                <time dateTime={g.date}>{fechaLegible(g.date)}</time> ·{" "}
                <Link href={`/guides/${g.slug}`} aria-label={`Read: ${g.title}`}>
                  Read the guide
                </Link>
              </p>
            </section>
          ))}
        </div>
      </main>
      <Footer />
    </div>
  );
}
