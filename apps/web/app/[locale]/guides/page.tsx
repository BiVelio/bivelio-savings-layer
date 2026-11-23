import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { HeroeDeCampana } from "@/app/components/campana/HeroeDeCampana";
import Footer from "@/app/components/Footer";
import { Link } from "@/i18n/navigation";
import { tarjetaSocial } from "@/i18n/site";
import { Breadcrumb } from "@/vendor/affectui/breadcrumb-clean";
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
  const tn = await getTranslations("nav");

  return (
    <div className="lp terms-page doc-page">
      {/* En el idioma de quien lee, con `lang="en"` en cada pieza inglesa. */}
      <main className="wrap guia-page" lang={locale}>
        <HeroeDeCampana pagina="guides">
          <GridBackground className="doc-fondo">
            <section className="terms-hero guia-hero" id="inicio">
              <Breadcrumb
                className="doc-migas"
                label={tn("breadcrumb")}
                linkAs={Link}
                items={[{ label: tn("home"), href: "/" }, { label: <span lang="en">Guides</span> }]}
              />
              <span className="eyebrow" lang="en">
                Guides · LLM API costs
              </span>
              <h1 lang="en">{TITULO}</h1>
              {locale === IDIOMA_DE_LAS_GUIAS ? null : (
                <p className="doc-nota" lang={locale}>
                  {t("englishOnly")}
                </p>
              )}
              <p lang="en">
                Practical, provider-neutral guides for developers who pay a per-token bill. Each one teaches the
                technique first, so it is useful without any tool; then shows how the open-source BV-SALA layer does it,
                free and with no key; then shows how to check the saving against your provider&apos;s own usage
                numbers.
              </p>
              <p lang="en">
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
            <section key={g.slug} className="terms-sec" aria-labelledby={`guia-${g.slug}`} lang="en">
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
