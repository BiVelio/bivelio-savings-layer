import { getLocale, getTranslations } from "next-intl/server";

import { Link } from "@/i18n/navigation";

import { corporateUrl, LEGAL_DOCS } from "@/lib/corporate";
import { VERSION_MINIMA_MEDIR } from "@/lib/license/medir-publico";

import { NvidiaFooterCard } from "./NvidiaInception";

import { ArrowRightIcon, GitHubIcon, LinkedInIcon } from "./icons";
import { SavingsLogo } from "./SavingsLogo";

// Cuentas propiedad de BiVelio, las mismas que publica el SocialDock de
// bivelio.com. No hay cuenta de X (x.com/bivelio es un 404), así que X no está
// en vez de apuntar a otro sitio.
const SOCIALS = [
  { href: "https://www.linkedin.com/company/bivelio/", label: "BiVelio on LinkedIn", Icon: LinkedInIcon },
  { href: "https://github.com/BiVelio", label: "BiVelio on GitHub", Icon: GitHubIcon },
];

/** Dock de cristal con las redes de la compañía — la píldora del footer corporativo. */
function SocialDock({ sinGitHub = false }: { sinGitHub?: boolean }) {
  const redes = sinGitHub ? SOCIALS.filter((s) => !s.href.startsWith("https://github.com/")) : SOCIALS;
  return (
    <div className="ftr-social">
      {redes.map(({ href, label, Icon }) => (
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

/**
 * `sinGitHub`: /benchmarks se publica sin enlaces a GitHub mientras el
 * repositorio sea privado (decisión del dueño, 2026-09-29): allí un icono de
 * GitHub se leería como «el código está aquí». El resto de páginas no cambia.
 */
export default async function Footer({ sinGitHub = false }: { sinGitHub?: boolean } = {}) {
  const t = await getTranslations("landing");
  const locale = await getLocale();

  // Rutas con hash (Link), no anclas peladas: este footer ya no vive solo en la
  // landing, y un ancla suelta en /how-it-works no llevaría a ninguna parte.
  // El enlace de esta columna es el de los resultados medidos (#measured); el
  // verificador de formato (#verify) lo enlaza el menú.
  const savings: string[][] = [
    [t("footer.howItWorks"), "/how-it-works"],
    // `footer.verify` («Verifica tu ahorro») apuntaba también a /#measured
    // cuando #verify no existía: dos enlaces de la misma columna al MISMO
    // sitio. Se quedó el de lo medido, que es lo que dice su etiqueta.
    [t("footer.measured"), "/#measured"],
    // El banco público A/B (/benchmarks): cómo se mide, lo que ahorra y lo que
    // no, y cómo repetirlo. Aquí y no en el menú, para no tocar /pricing.
    [t("footer.benchmarks"), "/benchmarks"],
    // El paper técnico (/paper): la credibilidad medida, enlazada desde el pie.
    [t("footer.paper"), "/paper"],
    // La guía 0.4 → 0.5 (/migrate-to-0.5). Sin este enlace, quien actualiza
    // desde la 0.4 solo llegaba a ella desde npm o GitHub.
    [t("footer.migrate"), "/migrate-to-0.5"],
    [t("footer.pricing"), "/#pricing"],
  ];
  // «Documentación» apuntaba a docs.bivelio.com y «Estado» a status.bivelio.com,
  // y ninguno de los dos dominios resuelve (2026-09-13): dos enlaces muertos en
  // el pie de cada página, en 12 idiomas. La documentación que existe es el
  // README del paquete (la página de npm); la de estado no existe todavía y no
  // se enlaza hasta que exista.
  const bivelio: string[][] = [
    [t("footer.home"), corporateUrl("", locale)],
    [t("footer.docs"), "https://www.npmjs.com/package/@bivelio/savings-layer"],
    [t("footer.security"), corporateUrl("/security", locale)],
  ];
  // El corpus legal COMPLETO de bivelio.com, no un extracto: seis documentos
  // más el centro legal que los agrupa.
  //
  // Delante van las dos páginas de ESTE producto que cita la LICENSE: los
  // términos de precio (§6, «Published Pricing») y lo que sale de la
  // infraestructura del cliente (§5). Son rutas propias, no de bivelio.com.
  const legal: string[][] = [
    [t("footer.pricingTerms"), "/pricing"],
    [t("footer.dataPrivacy"), "/privacy"],
    ...LEGAL_DOCS.map((d) => [t(`footer.${d.key}`), corporateUrl(d.path, locale)]),
  ];

  return (
    <footer className="ftr">
      {/* Banda CTA — la pieza que abre el footer de bivelio.com. Un solo botón,
          el del alta (decisión del dueño 2026-08-24): el verificador ya tiene su
          CTA en el héroe y aquí solo repartía el clic del cierre. */}
      <div className="ftr-cta">
        <div className="ftr-cta-inner">
          <div>
            <p className="ftr-cta-title">{t("footer.ctaTitle")}</p>
            <p className="ftr-cta-sub">{t("footer.ctaSub", { version: VERSION_MINIMA_MEDIR })}</p>
          </div>
          <div className="ftr-cta-actions">
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
                <Link href="/" className="ftr-logo" aria-label="Savings by BiVelio">
                  <SavingsLogo variant="full" height={52} />
                </Link>
                <p>{t.rich("footer.tagline", { b: (c) => <b>{c}</b> })}</p>
                {/* El chip del algoritmo que lleva todo pie BV-* (BV‑SALA,
                    nombre de marca, igual en los 12 idiomas), solo en su fila:
                    el distintivo de NVIDIA que iba a su lado (revisión del
                    2026-09-14) se fue al cierre de la columna, como en
                    bivelio.com (aprobado por el CEO el 2026-09-15). */}
                <div className="ftr-creds">
                  <span className="ftr-badge">
                    <span className="bar" /> {t("footer.badge")}
                  </span>
                </div>
                <SocialDock sinGitHub={sinGitHub} />
                {/* Membresía del NVIDIA Inception Program, cerrando la columna
                    de marca como en bivelio.com: es una credencial de la
                    COMPAÑÍA, así que vive donde vive la identidad — logo,
                    promesa y redes — y no en la fila del producto. La tarjeta
                    blanca con el arte y la frase de pertenencia debajo
                    (NvidiaInception.tsx); la frase es `landing.nvidia.title`,
                    la misma clave que la banda, en los 12 idiomas. El programa
                    se dice UNA vez en el pie. */}
                <NvidiaFooterCard line={t("nvidia.title")} />
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
