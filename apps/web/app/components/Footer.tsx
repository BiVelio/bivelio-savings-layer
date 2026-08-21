import { getLocale, getTranslations } from "next-intl/server";

import { Link } from "@/i18n/navigation";

import { corporateUrl, LEGAL_DOCS } from "@/lib/corporate";

import { BrandMark } from "./BrandMark";
import { ArrowRightIcon, GitHubIcon, LinkedInIcon } from "./icons";

// Cuentas propiedad de BiVelio, las mismas que publica el SocialDock de
// bivelio.com. No hay cuenta de X (x.com/bivelio es un 404), así que X no está
// en vez de apuntar a otro sitio.
const SOCIALS = [
  { href: "https://www.linkedin.com/company/bivelio/", label: "BiVelio on LinkedIn", Icon: LinkedInIcon },
  { href: "https://github.com/BiVelio", label: "BiVelio on GitHub", Icon: GitHubIcon },
];

/** Dock de cristal con las redes de la compañía — la píldora del footer corporativo. */
function SocialDock() {
  return (
    <div className="ftr-social">
      {SOCIALS.map(({ href, label, Icon }) => (
        <a key={href} href={href} target="_blank" rel="noopener noreferrer me" aria-label={label}>
          <Icon />
        </a>
      ))}
    </div>
  );
}

// The corporate BiVelio footer (brand + link columns + trust/legal + the giant
// glass background wordmark). Its design came from the old static landing, which
// has since been deleted — this is now the only footer.
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
            ) : href.startsWith("/") ? (
              // Internal route — the locale-prefixing Link, so it works from any page.
              <Link href={href}>{label}</Link>
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

  // Rutas con hash (Link), no anclas peladas: este footer ya no vive solo en la
  // landing, y un `#verify` suelto en /how-it-works no llevaría a ninguna parte.
  const savings: string[][] = [
    [t("footer.howItWorks"), "/how-it-works"],
    [t("footer.verify"), "/#verify"],
    [t("footer.measured"), "/#measured"],
    [t("footer.pricing"), "/#pricing"],
  ];
  const bivelio: string[][] = [
    [t("footer.home"), corporateUrl("", locale)],
    [t("footer.docs"), "https://docs.bivelio.com"],
    [t("footer.security"), corporateUrl("/security", locale)],
    [t("footer.status"), "https://status.bivelio.com"],
  ];
  // El corpus legal COMPLETO de bivelio.com, no un extracto: seis documentos
  // más el centro legal que los agrupa.
  const legal: string[][] = LEGAL_DOCS.map((d) => [t(`footer.${d.key}`), corporateUrl(d.path, locale)]);

  return (
    <footer className="ftr">
      {/* Banda CTA — la pieza que abre el footer de bivelio.com. El fantasma
          lleva a la oferta gratuita (el verificador) y el de tinta al alta. */}
      <div className="ftr-cta">
        <div className="ftr-cta-inner">
          <div>
            <p className="ftr-cta-title">{t("footer.ctaTitle")}</p>
            <p className="ftr-cta-sub">{t("footer.ctaSub")}</p>
          </div>
          <div className="ftr-cta-actions">
            <Link className="btn btn-ghost" href="/#verify">
              {t("hero.ctaRun")}
            </Link>
            <Link className="btn btn-primary" href="/signup">
              {t("footer.ctaStart")}
              <ArrowRightIcon />
            </Link>
          </div>
        </div>
      </div>

      <div className="wrap">
        <div className="ftr-card">
          <div className="ftr-inner">
            <div className="ftr-grid">
              <div className="ftr-brand">
                <BrandMark size={36} />
                <p>{t.rich("footer.tagline", { b: (c) => <b>{c}</b> })}</p>
                <span className="ftr-badge">
                  <span className="bar" /> {t("footer.badge")}
                </span>
                <SocialDock />
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
              <a href={corporateUrl("/privacy", locale)} target="_blank" rel="noopener noreferrer">
                {t("footer.bottomPrivacy")}
              </a>
              <a href={corporateUrl("/terms", locale)} target="_blank" rel="noopener noreferrer">
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
