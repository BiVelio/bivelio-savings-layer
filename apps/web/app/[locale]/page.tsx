import { Fragment } from "react";

import { getTranslations, setRequestLocale } from "next-intl/server";

import abData from "@/public/data/ab-live.json";
import { ReservarLlamada } from "./components/ReservarLlamada";
import { type AbArtifact } from "@/app/[locale]/dashboard/data";
import { ReferenceModeBadge } from "@/app/[locale]/dashboard/components/ReferenceModeBadge";
import { NetSavingsCIBand } from "@/app/[locale]/dashboard/components/NetSavingsCIBand";
import { ReferenceLedgerCards } from "@/app/[locale]/dashboard/components/ReferenceLedgerCards";
import { IntegrityQualityChips } from "@/app/[locale]/dashboard/components/IntegrityQualityChips";
import { ScenarioTable } from "@/app/[locale]/dashboard/components/ScenarioTable";
import { CacheBreakEven } from "@/app/[locale]/dashboard/components/CacheBreakEven";
import Footer from "@/app/components/Footer";
import { Link } from "@/i18n/navigation";
import { absolute, languageAlternates } from "@/i18n/site";
import { preciosDelPlan } from "@/lib/stripe/pricing";
import { formatearPrecio } from "@/lib/format/precio";

// The measured A/B artifact powers Step 2 (the reference bench) and the price
// used by the Step-1 projector — exactly like the dashboard verify/proof pages.
const ab = abData as unknown as AbArtifact;

const mini = (ab.pricing.table["gpt-4o-mini"] ?? {}) as { inputPer1k?: number; outputPer1k?: number };
const prices = { inPer1k: mini.inputPer1k ?? 0.00015, outPer1k: mini.outputPer1k ?? 0.0006 };

// The "integrate" snippet: the same 3-step story as /how-it-works (package →
// license → wrap the call), with its step headers localized via the shared
// `howItWorks.snip*` keys. Code tokens stay verbatim; each carries a color
// class: n = paso (brand, bold), k = keyword (brand), s = string (ámbar),
// c = comentario (soft), g = resultado (menta).
type TokenCls = "c" | "k" | "s" | "n" | "g";
function lineasDelSnippet(th: (k: string) => string): { cls?: TokenCls; v: string }[][] {
  return [
    [{ cls: "n", v: `# 1 · ${th("snip1")}` }],
    [{ v: "pnpm add " }, { cls: "s", v: "@bivelio/savings-layer" }],
    [],
    [{ cls: "n", v: `# 2 · ${th("snip2")}` }],
    [{ v: "export " }, { cls: "s", v: "BIVELIO_LICENSE_KEY" }, { v: "=…" }],
    [],
    [{ cls: "n", v: `# 3 · ${th("snip3")}` }],
    [{ cls: "k", v: "const" }, { v: " layer = createSavingsLayer({ provider, licenseKey, … });" }],
    [
      { cls: "k", v: "const" },
      { v: " { text, report } = " },
      { cls: "k", v: "await" },
      { v: " layer.generate({ model, messages });" },
    ],
    [],
    [{ v: "console.log(report.cost.netSavings)  " }, { cls: "g", v: `// ← ${th("snipResult")}` }],
  ];
}

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
  const th = await getTranslations("howItWorks");
  const CODE = lineasDelSnippet(th);

  const cascadeSteps = t.raw("cascade.steps") as {
    n: string;
    title: string;
    sub: string;
    ledger: string;
    grey: boolean;
  }[];
  const ledgers = t.raw("ledgers") as { idx: string; name: string; desc: string }[];

  // Las cuatro tarjetas llevaban un guion ESCRITO A MANO y el texto «ejecuta el
  // optimizador para medir», encima de un artefacto que YA traía las cuatro
  // cifras medidas con su intervalo. Cuatro cajas vacías sobre datos reales: la
  // misma clase de fallo que un libro contable sin productor.
  //
  // Se casa por NOMBRE del libro, no por posición: el artefacto viejo traía
  // `output_restriction` donde el nuevo trae `provider_cached`, y casar por
  // índice habría puesto la cifra de una palanca bajo el título de otra.
  const CLAVE_DE_TARJETA: Record<string, string> = {
    avoided_calls: "avoided_calls",
    eliminated_tokens: "eliminated_tokens",
    compressed_tokens: "compressed_tokens",
    provider_cached_tokens: "provider_cached",
  };
  const medidoPorLibro = new Map(
    (ab.ledgers ?? []).map((l) => [l.ledger, l]),
  );
  const features = t.raw("pricing.features") as string[];
  const trust = t.raw("pricing.trust") as { lead: string; rest: string }[];

  // El precio sale del Price de Stripe, que es lo que de verdad se cobra, y se
  // formatea AQUÍ (servidor) para el idioma de la página. Antes estaba escrito a
  // mano en los 12 ficheros de traducción y no se hablaba con Stripe: por eso la
  // landing estática llegó a anunciar dólares mientras se cobraban euros.
  const precios = await preciosDelPlan();
  const precioMensual = formatearPrecio(locale, precios.monthly);
  const precioAnual = formatearPrecio(locale, precios.yearly);
  const moneda = precios.monthly.currency.toUpperCase();

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
              <a className="btn" href="#measured">
                {t("hero.ctaRun")}
              </a>
              <a className="btn ghost" href="#pricing">
                {t("hero.ctaPricing")}
              </a>
            </div>
            <div className="hero-note">
              <span className="pulse" /> {t("hero.note")}
            </div>

            {/* La prueba, en el heroe. Este producto no vende una promesa: vende
                una medicion contra el contador del proveedor. Enseñarla arriba es
                el argumento, no un adorno. */}
            <div className="hero-prueba">
              <span className="hero-prueba-t">{t("hero.proofTitle")}</span>
              <div className="hero-prueba-filas">
                {(t.raw("hero.proofs") as { marca: string; modelo: string; cifra: string; que: string }[]).map((p) => (
                  <div className="hp" key={p.marca}>
                    <div className="hp-marca">
                      <b>{p.marca}</b>
                      <code>{p.modelo}</code>
                    </div>
                    <div className="hp-dato">
                      <span className="hp-n">{p.cifra}</span>
                      <span className="hp-q">{p.que}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="hero-col">
          <div className="cascade" aria-label={t("cascade.title")}>
            <div className="cascade-h">
              <span className="t">{t("cascade.title")}</span>
              <span className="k">{t("cascade.per")}</span>
            </div>
            {cascadeSteps.map((s) => {
              // La etiqueta era cualitativa («−tokens») sobre un artefacto que
              // ya traía la cifra medida de ese libro. Es lo primero que ve un
              // cliente: o lleva un número que se puede defender, o no va.
              const m = medidoPorLibro.get(s.ledger);
              if (!m || !m.proven) return null;
              return (
                <div className="step" key={s.n}>
                  <span className="n">{s.n}</span>
                  <span className="s">
                    {s.title}
                    <span>{s.sub}</span>
                  </span>
                  <span className="tag">{`${(m.savings.lower * 100).toFixed(1)}%`}</span>
                </div>
              );
            })}
          </div>

            <ReservarLlamada
              t={{
                titulo: t("cta15.titulo"),
                sub: t("cta15.sub"),
                placeholder: t("cta15.placeholder"),
                boton: t("cta15.boton"),
                enviando: t("cta15.enviando"),
                ok: t("cta15.ok"),
                errorCorreo: t("cta15.errorCorreo"),
                errorEnvio: t("cta15.errorEnvio"),
                alterna: t("cta15.alterna"),
              }}
            />
            <p className="cascade-nota">{t("cascade.footnote")}</p>
          </div>
        </section>

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

        {/* CACHÉ DE PREFIJO DE ANTHROPIC — el mecanismo, no un titular */}
        <section id="anthropic-cache">
          <div className="sec-head">
            <div className="prov">
              <span className="prov-marca">{t("anthropicCache.providerTag")}</span>
              <code className="prov-modelo">{t("anthropicCache.providerModel")}</code>
            </div>
            <span className="eyebrow">{t("anthropicCache.eyebrow")}</span>
            <h2>{t("anthropicCache.title")}</h2>
            <p>
              {t.rich("anthropicCache.body", {
                b: (c) => <b>{c}</b>,
                code: (c) => <code>{c}</code>,
              })}
            </p>
          </div>

          <div className="ancache">
            <div className="ancache-medida">
              <h4>{t("anthropicCache.evidenceTitle")}</h4>
              <p className="ancache-lede">{t("anthropicCache.evidenceLede")}</p>
              <dl className="ancache-filas">
                <div>
                  <dt>{t("anthropicCache.rowNaiveLabel")}</dt>
                  <dd>{t("anthropicCache.rowNaiveValue")}</dd>
                </div>
                <div className="es-nuestra">
                  <dt>{t("anthropicCache.rowOursLabel")}</dt>
                  <dd>{t("anthropicCache.rowOursValue")}</dd>
                </div>
              </dl>
            </div>
            <div className="ancache-cifra">
              <span className="n">{t("anthropicCache.figure")}</span>
              <span className="nota">{t("anthropicCache.figureNote")}</span>
            </div>
          </div>

          <div className="ancache-notas">
            <div>
              <h4>{t("anthropicCache.scopeTitle")}</h4>
              <p>{t.rich("anthropicCache.scope", { b: (c) => <b>{c}</b> })}</p>
            </div>
            <div>
              <h4>{t("anthropicCache.verifyTitle")}</h4>
              <p>{t.rich("anthropicCache.verify", { code: (c) => <code>{c}</code> })}</p>
            </div>
          </div>
        </section>

        {/* LEDGERS — four separate ledgers, never summed */}
        <section>
          <div className="sec-head">
            <div className="prov">
              <span className="prov-marca">{t("ledgersHead.providerTag")}</span>
              <code className="prov-modelo">{t("ledgersHead.providerModel")}</code>
            </div>
            <span className="eyebrow">{t("ledgersHead.eyebrow")}</span>
            <h2>{t("ledgersHead.title")}</h2>
            <p>{t("ledgersHead.body")}</p>
            <p className="ledgers-modelo">{t("ledgersHead.providerNote")}</p>
          </div>
          <div className="ledgers">
            {ledgers
              .filter((l) => {
                // Una tarjeta sin cifra define una palanca y remata con un guion:
                // promete y no cumple, en la seccion cuya tesis es justamente que
                // aqui no se infla nada. Si esta tirada no midio ese libro, el
                // libro no sale. Que salgan tres tarjetas en vez de cuatro es la
                // verdad de esa tirada.
                const m = medidoPorLibro.get(CLAVE_DE_TARJETA[l.name] ?? "");
                return !!m && m.proven;
              })
              .map((l) => {
              const m = medidoPorLibro.get(CLAVE_DE_TARJETA[l.name] ?? "");
              // Se publica el LÍMITE INFERIOR del intervalo, nunca el punto: es
              // la regla del banco y no cambia por estar en una landing. Y un
              // libro que no despejó el cero NO se anuncia como ahorro.
              const cifra = `${(m!.savings.lower * 100).toFixed(1)}%`;
              const pie = t("ledgersHead.measuredFloor");
              return (
                <div className="ledger" key={l.idx}>
                  <div className="idx">{l.idx}</div>
                  <h4>{l.name}</h4>
                  <p>{l.desc}</p>
                  <div className="mval">{cifra}</div>
                  <div className="munit">{pie}</div>
                </div>
              );
            })}
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
            <p>{t("pricing.body", { currency: moneda })}</p>
          </div>
          <div className="split">
            <div className="price-card">
              <div className="amt">
                {t("pricing.amount", { amount: precioMensual })}
                <small> {t("pricing.per")}</small>
              </div>
              <p style={{ margin: 0, opacity: 0.85 }}>
                {t.rich("pricing.proNote", { b: (c) => <b>{c}</b>, yearly: precioAnual })}
              </p>
              <p className="ck-note">
                {t("pricing.taxNote")}
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
