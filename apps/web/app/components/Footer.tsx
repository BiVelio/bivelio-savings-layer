import { getLocale, getTranslations } from "next-intl/server";

import { BrandMark } from "./BrandMark";

// The corporate BiVelio footer (brand + link columns + trust/legal + the giant
// glass background wordmark), mirroring the static public/landing.html footer.
// Product sections link to in-page anchors; BiVelio/legal columns link out to
// bivelio.com — locale-aware where the corporate site is localized.
function Column({ head, links }: { head: string; links: string[][] }) {
  return (
    <div className="ftr-col">
      <h3>{head}</h3>
      <ul>
        {links.map(([label, href]) => (
          <li key={href}>
            {href.startsWith("http") ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {label}
              </a>
            ) : (
              // In-page hash anchor — plain <a>, never the locale-prefixing Link.
              <a href={href}>{label}</a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Decorative giant "BiVelio" wordmark with a handcrafted SVG glass filter. */
function GlassWordmark() {
  return (
    <div className="ftr-wordmark-wrap" aria-hidden="true">
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden focusable="false">
        <defs>
          <filter id="ftr-glass" x="-50%" y="-50%" width="200%" height="200%">
            <feDropShadow dx="0" dy="4" stdDeviation="6" floodColor="#0F1218" floodOpacity="0.18" result="outer" />
            <feComponentTransfer in="SourceAlpha" result="alpha">
              <feFuncA type="linear" slope="1" />
            </feComponentTransfer>
            <feOffset in="alpha" dx="0" dy="4" result="ow" />
            <feGaussianBlur in="ow" stdDeviation="4" result="bw" />
            <feComposite in="alpha" in2="bw" operator="out" result="iwm" />
            <feFlood floodColor="#ffffff" floodOpacity="0.35" result="wf" />
            <feComposite in="wf" in2="iwm" operator="in" result="iwf" />
            <feGaussianBlur in="alpha" stdDeviation="6" result="bb" />
            <feComposite in="alpha" in2="bb" operator="out" result="ibm" />
            <feFlood floodColor="#1A3477" floodOpacity="0.22" result="bf" />
            <feComposite in="bf" in2="ibm" operator="in" result="ibf" />
            <feMerge>
              <feMergeNode in="outer" />
              <feMergeNode in="SourceGraphic" />
              <feMergeNode in="iwf" />
              <feMergeNode in="ibf" />
            </feMerge>
          </filter>
        </defs>
      </svg>
      <span className="ftr-wordmark" style={{ filter: "url(#ftr-glass)" }}>
        BiVelio
      </span>
    </div>
  );
}

export default async function Footer() {
  const t = await getTranslations("landing");
  const locale = await getLocale();

  const savings: string[][] = [
    [t("footer.verify"), "#verify"],
    [t("footer.measured"), "#measured"],
    [t("footer.pricing"), "#pricing"],
  ];
  const bivelio: string[][] = [
    [t("footer.home"), "https://bivelio.com"],
    [t("footer.docs"), "https://docs.bivelio.com"],
    [t("footer.security"), `https://bivelio.com/${locale}/security`],
    [t("footer.status"), "https://status.bivelio.com"],
  ];
  const legal: string[][] = [
    [t("footer.privacy"), `https://bivelio.com/${locale}/privacy`],
    [t("footer.terms"), `https://bivelio.com/${locale}/terms`],
    [t("footer.gdpr"), `https://bivelio.com/${locale}/gdpr`],
  ];

  return (
    <footer className="ftr">
      <div className="wrap">
        <div className="ftr-card">
          <div className="ftr-inner">
            <div className="ftr-grid">
              <div className="ftr-brand">
                <BrandMark size={34} />
                <p>{t.rich("footer.tagline", { b: (c) => <b>{c}</b> })}</p>
                <span className="ftr-badge">
                  <span className="bar" /> {t("footer.badge")}
                </span>
              </div>
              <div className="ftr-cols">
                <Column head={t("footer.colSavings")} links={savings} />
                <Column head={t("footer.colBivelio")} links={bivelio} />
                <Column head={t("footer.colLegal")} links={legal} />
              </div>
            </div>
            <div className="ftr-fine">
              <p className="ftr-trust">{t("footer.trust")}</p>
              <p className="ftr-entity">{t("footer.entity")}</p>
            </div>
          </div>
          <div className="ftr-bottom">
            <p>{t("footer.copyright")}</p>
            <div className="ftr-bottom-links">
              <span>{t("footer.andorra")}</span>
              <span aria-hidden className="sep" />
              <a href={`https://bivelio.com/${locale}/privacy`} target="_blank" rel="noopener noreferrer">
                {t("footer.bottomPrivacy")}
              </a>
              <a href={`https://bivelio.com/${locale}/terms`} target="_blank" rel="noopener noreferrer">
                {t("footer.bottomTerms")}
              </a>
            </div>
          </div>
        </div>
      </div>
      <GlassWordmark />
    </footer>
  );
}
