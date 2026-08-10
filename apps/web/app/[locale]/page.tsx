import { Fragment } from "react";

import { getTranslations, setRequestLocale } from "next-intl/server";

import abData from "@/public/data/ab-live.json";
import { type AbArtifact } from "@/app/[locale]/dashboard/data";
import { ProjectorVerifier } from "@/app/[locale]/dashboard/components/ProjectorVerifier";
import { ReferenceModeBadge } from "@/app/[locale]/dashboard/components/ReferenceModeBadge";
import { NetSavingsCIBand } from "@/app/[locale]/dashboard/components/NetSavingsCIBand";
import { ReferenceLedgerCards } from "@/app/[locale]/dashboard/components/ReferenceLedgerCards";
import { IntegrityQualityChips } from "@/app/[locale]/dashboard/components/IntegrityQualityChips";
import { ScenarioTable } from "@/app/[locale]/dashboard/components/ScenarioTable";
import { CacheBreakEven } from "@/app/[locale]/dashboard/components/CacheBreakEven";
import Footer from "@/app/components/Footer";
import { Link } from "@/i18n/navigation";
import { absolute, languageAlternates } from "@/i18n/site";

// The measured A/B artifact powers Step 2 (the reference bench) and the price
// used by the Step-1 projector — exactly like the dashboard verify/proof pages.
const ab = abData as unknown as AbArtifact;
const mini = (ab.pricing.table["gpt-4o-mini"] ?? {}) as { inputPer1k?: number; outputPer1k?: number };
const prices = { inPer1k: mini.inputPer1k ?? 0.00015, outPer1k: mini.outputPer1k ?? 0.0006 };

// The "integrate" SDK snippet stays verbatim English (brand/code tokens), only
// the surrounding heading/paragraph are localized. Tokens carry a highlight class.
const CODE: { cls?: "c" | "k" | "s"; v: string }[][] = [
  [{ cls: "c", v: "// your app — the data plane. LLM traffic goes straight to your provider." }],
  [
    { cls: "k", v: "import" },
    { v: " { createSavingsLayer } " },
    { cls: "k", v: "from" },
    { v: " " },
    { cls: "s", v: '"@bivelio/savings-layer"' },
    { v: ";" },
  ],
  [],
  [{ cls: "k", v: "const" }, { v: " layer = createSavingsLayer({" }],
  [{ v: "  provider: yourProvider," }],
  [
    { v: "  licenseKey: process.env." },
    { cls: "s", v: "BIVELIO_LICENSE_KEY" },
    { v: ",       " },
    { cls: "c", v: "// from your dashboard" },
  ],
  [
    { v: "  licenseServerUrl: " },
    { cls: "s", v: '"https://savings.bivelio.com"' },
    { v: ",   " },
    { cls: "c", v: "// license check + kill-switch" },
  ],
  [{ v: "});" }],
  [],
  [
    { cls: "k", v: "const" },
    { v: " { data, report } = " },
    { cls: "k", v: "await" },
    { v: " layer.generate({" },
  ],
  [{ v: "  model: " }, { cls: "s", v: '"openai/gpt-4o-mini"' }, { v: "," }],
  [{ v: "  messages," }],
  [
    { v: "  response: { contractId: " },
    { cls: "s", v: '"answer:v1"' },
    { v: ", schema, maxOutputTokens: " },
    { cls: "s", v: "220" },
    { v: " }," },
  ],
  [{ v: "});" }],
  [],
  [{ v: "report.cost.netSavings;   " }, { cls: "c", v: "// → your net savings on this request" }],
  [{ v: "report.calls.avoidedLlm;  " }, { cls: "c", v: "// → whole calls you never paid for" }],
];

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "landing" });
  const title = t("metaTitle");
  const description = t("metaDescription");
  const url = absolute(`/${locale}`);

  return {
    title,
    description,
    // `canonical` por idioma + `hreflang` de los 12 (con x-default). Sin esto,
    // doce traducciones de esta misma página compiten entre sí como duplicados.
    alternates: { canonical: url, languages: languageAlternates() },
    // Sin Open Graph, compartir el enlace en LinkedIn, X, Slack o WhatsApp
    // producía una URL pelada, sin título ni imagen. Para un producto cuyo gancho
    // es "entra y verifica tu ahorro", esa tarjeta es la primera impresión.
    openGraph: {
      type: "website",
      siteName: "BiVelio Savings Layer",
      title,
      description,
      url,
      locale,
      images: [{ url: `${url}/opengraph-image`, width: 1200, height: 630, alt: title }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [`${url}/opengraph-image`],
    },
  };
}

export default async function LandingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("landing");

  const cascadeSteps = t.raw("cascade.steps") as {
    n: string;
    title: string;
    sub: string;
    tag: string;
    grey: boolean;
  }[];
  const ledgers = t.raw("ledgers") as { idx: string; name: string; desc: string }[];
  const features = t.raw("pricing.features") as string[];
  const trust = t.raw("pricing.trust") as { lead: string; rest: string }[];

  return (
    <div className="lp">
      <main className="wrap">
        {/* HERO */}
        <section className="hero">
          <div>
            <span className="eyebrow">{t("hero.eyebrow")}</span>
            <h1>
              {t("hero.title")} <span className="u">{t("hero.titleAccent")}</span>
            </h1>
            <p className="lede">{t("hero.lede")}</p>
            <div className="hero-cta">
              <a className="btn" href="#verify">
                {t("hero.ctaRun")}
              </a>
              <a className="btn ghost" href="#pricing">
                {t("hero.ctaPricing")}
              </a>
            </div>
            <div className="hero-note">
              <span className="pulse" /> {t("hero.note")}
            </div>
          </div>

          <div className="cascade" aria-label={t("cascade.title")}>
            <div className="cascade-h">
              <span className="t">{t("cascade.title")}</span>
              <span className="k">{t("cascade.per")}</span>
            </div>
            {cascadeSteps.map((s) => (
              <div className="step" key={s.n}>
                <span className="n">{s.n}</span>
                <span className="s">
                  {s.title}
                  <span>{s.sub}</span>
                </span>
                <span className={`tag${s.grey ? " grey" : ""}`}>{s.tag}</span>
              </div>
            ))}
          </div>
        </section>

        {/* STEP 1 — verify locally (reused ProjectorVerifier island) */}
        <section id="verify">
          <div className="sec-head">
            <span className="eyebrow">{t("step1.eyebrow")}</span>
            <h2>{t("step1.title")}</h2>
            <p>
              {t.rich("step1.body", {
                b: (c) => <b>{c}</b>,
                i: (c) => <i>{c}</i>,
                link: (c) => <a href="#measured">{c}</a>,
              })}
            </p>
          </div>
          <ProjectorVerifier prices={prices} />
        </section>

        {/* STEP 2 — provably measured (reused reference-bench components) */}
        <section id="measured">
          <div className="sec-head">
            <span className="eyebrow">{t("step2.eyebrow")}</span>
            <h2>{t("step2.title")}</h2>
            <p>
              {t.rich("step2.body", {
                b: (c) => <b>{c}</b>,
                i: (c) => <i>{c}</i>,
                code: (c) => <code>{c}</code>,
              })}
            </p>
          </div>
          <div className="bench">
            <ReferenceModeBadge ab={ab} />
            <NetSavingsCIBand savings={ab.aggregate.savings} mode={ab.mode} />
            <div style={{ marginTop: "16px" }}>
              <ReferenceLedgerCards ab={ab} />
            </div>
            <div style={{ marginTop: "16px" }}>
              <IntegrityQualityChips ab={ab} />
            </div>
            <div style={{ marginTop: "16px" }}>
              <ScenarioTable scenarios={ab.scenarios} />
            </div>
            <div style={{ marginTop: "16px" }}>
              <CacheBreakEven ab={ab} />
            </div>
          </div>
        </section>

        {/* LEDGERS — four separate ledgers, never summed */}
        <section>
          <div className="sec-head">
            <span className="eyebrow">{t("ledgersHead.eyebrow")}</span>
            <h2>{t("ledgersHead.title")}</h2>
            <p>{t("ledgersHead.body")}</p>
          </div>
          <div className="ledgers">
            {ledgers.map((l) => (
              <div className="ledger" key={l.idx}>
                <div className="idx">{l.idx}</div>
                <h4>{l.name}</h4>
                <p>{l.desc}</p>
                <div className="mval">—</div>
                <div className="munit">{t("ledgersHead.runToMeasure")}</div>
              </div>
            ))}
          </div>
        </section>

        {/* INTEGRATE — five lines to start */}
        <section>
          <div className="sec-head">
            <span className="eyebrow">{t("integrate.eyebrow")}</span>
            <h2>{t("integrate.title")}</h2>
            <p>{t("integrate.body")}</p>
          </div>
          <pre className="code">
            {CODE.map((line, i) => (
              <Fragment key={i}>
                {line.map((tok, j) =>
                  tok.cls ? (
                    <span className={tok.cls} key={j}>
                      {tok.v}
                    </span>
                  ) : (
                    <Fragment key={j}>{tok.v}</Fragment>
                  ),
                )}
                {i < CODE.length - 1 ? "\n" : null}
              </Fragment>
            ))}
          </pre>
        </section>

        {/* PRICING */}
        <section id="pricing">
          <div className="sec-head">
            <span className="eyebrow">{t("pricing.eyebrow")}</span>
            <h2>{t("pricing.title")}</h2>
            <p>{t("pricing.body")}</p>
          </div>
          <div className="split">
            <div className="price-card">
              <div className="amt">
                {t("pricing.amount")}
                <small> {t("pricing.per")}</small>
              </div>
              <p style={{ margin: 0, opacity: 0.85 }}>
                {t.rich("pricing.proNote", { b: (c) => <b>{c}</b> })}
              </p>
              <p style={{ margin: "6px 0 0", opacity: 0.65, fontSize: 13 }}>
                {t.rich("pricing.seatNote", { b: (c) => <b>{c}</b> })}
              </p>
              <ul>
                {features.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
              <Link className="btn" href="/signup" style={{ alignSelf: "flex-start", marginTop: 6 }}>
                {t("pricing.cta")}
              </Link>
            </div>
            <div className="trust">
              <h3>{t("pricing.trustTitle")}</h3>
              <ul>
                {trust.map((it) => (
                  <li key={it.lead}>
                    <b>{it.lead}</b> {it.rest}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
