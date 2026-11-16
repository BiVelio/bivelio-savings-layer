import type { ReactNode } from "react";

import { getTranslations, setRequestLocale } from "next-intl/server";

import { DocIndice } from "@/app/components/docs/DocIndice";
import { Migas } from "@/app/components/docs/Migas";
import Footer from "@/app/components/Footer";
import { etiquetasQueRigen } from "@/app/components/LegalGoverns";
import { Link } from "@/i18n/navigation";
import { absolute, languageAlternates, tarjetaSocial } from "@/i18n/site";
import { corporateUrl } from "@/lib/corporate";
import {
  GRUPOS_DE_LA_VERIFICACION,
  GRUPOS_DEL_REGISTRO_DE_USO,
  PLAZOS_DE_RETENCION,
  SIN_BORRADO_AUTOMATICO,
  type GrupoDeCampos,
} from "@/lib/legal/lo-que-sale";
import { CABECERA_VERSION } from "@/lib/metering/version";
import { Badge } from "@/vendor/affectui/badge-clean";
import { GlassFolder } from "@/vendor/affectui/glass-folder";
import { GridBackground } from "@/vendor/affectui/grid-background";

/**
 * LO QUE SALE DE TU INFRAESTRUCTURA — la página a la que remite la LICENSE §5.
 *
 * La lista de campos NO está en los mensajes: la pinta el código desde
 * `lib/legal/lo-que-sale.ts`, y `lo-que-sale.test.ts` la compara con las dos
 * listas blancas (la del ingest de uso y la del canal de verificación) y con
 * lo que emiten el SDK y el gateway. Los mensajes (`privacyPage.*`) solo
 * explican cada grupo, sin dígitos: los plazos de retención llegan por
 * parámetro desde lib/metering/retencion.ts, los mismos que aplica el cron.
 *
 * Nada que el código no haga: ni «anonimizado», ni «cifrado en reposo», ni
 * plazos que ningún cron cumpla.
 *
 * LA FORMA (rediseño 2026-11): tablas. Una de resumen —dato, adónde va, para
 * qué y qué guarda BiVelio—, cuyas celdas RESUMEN lo que las secciones ya
 * dicen y enlazan a ellas; una por cada lista de campos, pintada desde
 * `lib/legal/lo-que-sale.ts`; y la de retención, con las tablas reales, el
 * plazo que aplica el cron y, en la misma tabla y sin esconderlo, lo que HOY
 * no tiene borrado automático (`SIN_BORRADO_AUTOMATICO`). En móvil cada fila
 * se apila con el nombre de su columna delante, sin scroll horizontal.
 * Sigue sin haber un solo literal numérico en este fichero.
 */

const PRIVACY_EMAIL = "privacy@bivelio.com";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "privacyPage" });
  const title = t("metaTitle");
  const description = t("metaDescription");
  const url = absolute(`/${locale}/privacy`);
  const social = tarjetaSocial(locale, title);

  return {
    title,
    description,
    alternates: { canonical: url, languages: languageAlternates("privacy") },
    openGraph: { title, description, url, siteName: "BiVelio Savings Layer", type: "article", ...social.openGraph },
    twitter: { ...social.twitter, title, description },
  };
}

/** Las filas del resumen y la sección que desarrolla cada una. */
const RESUMEN = [
  { clave: "content", ancla: "never" },
  { clave: "usage", ancla: "usage" },
  { clave: "verification", ancla: "verification" },
  { clave: "account", ancla: "account" },
] as const;

/*
 * LOS PAPELES ARIA EXPLÍCITOS de las tablas no son un adorno: en móvil cada
 * fila se apila (`display: block`), y con eso varios navegadores dejan de
 * anunciarla como tabla. Con el papel escrito, sigue siéndolo para un lector
 * de pantalla aunque a la vista sea una pila de fichas.
 */
function Grupos({
  grupos,
  titulo,
  cuerpo,
  columnas,
}: {
  grupos: readonly GrupoDeCampos[];
  titulo: (clave: string) => string;
  cuerpo: (clave: string) => string;
  columnas: { grupo: string; campos: string };
}) {
  return (
    <table className="priv-tabla priv-tabla--campos" role="table">
      <thead role="rowgroup">
        <tr role="row">
          <th scope="col" role="columnheader">{columnas.grupo}</th>
          <th scope="col" role="columnheader">{columnas.campos}</th>
        </tr>
      </thead>
      <tbody role="rowgroup">
        {grupos.map((g) => (
          <tr role="row" key={g.clave}>
            <th scope="row" role="rowheader">
              <span className="priv-grupo">{titulo(g.clave)}</span>
              <span className="priv-grupo-que">{cuerpo(g.clave)}</span>
            </th>
            <td role="cell" data-label={columnas.campos}>
              <ul className="terms-fields" aria-label={titulo(g.clave)}>
                {g.campos.map((c) => (
                  <li key={c}>
                    <code>{c}</code>
                  </li>
                ))}
              </ul>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Los nombres de tabla de una fila de retención, como etiquetas de código. */
function Tablas({ nombres, etiqueta }: { nombres: readonly string[]; etiqueta: string }) {
  return (
    <ul className="terms-fields" aria-label={etiqueta}>
      {nombres.map((n) => (
        <li key={n}>
          <code>{n}</code>
        </li>
      ))}
    </ul>
  );
}

export default async function PrivacyPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("privacyPage");
  const b = (c: ReactNode) => <b>{c}</b>;
  const dias = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });

  const td = await getTranslations("docsPage");
  const columnas = { grupo: t("fields.colGroup"), campos: t("fields.colFields") };
  const indice = [
    { id: "overview", texto: t("overview.title") },
    { id: "never", texto: t("never.title") },
    { id: "usage", texto: t("usage.title") },
    { id: "verification", texto: t("verification.title") },
    { id: "other", texto: t("other.title") },
    { id: "retention", texto: t("retention.title") },
    { id: "use", texto: t("use.title") },
    { id: "account", texto: t("account.title") },
  ];

  return (
    <div className="lp terms-page doc-page priv-page">
      <main className="wrap">
        <GridBackground className="doc-fondo">
          <section className="terms-hero priv-hero" id="inicio">
            <div className="priv-hero-texto">
              <Migas actual={t("eyebrow")} />
              <span className="eyebrow">{t("eyebrow")}</span>
              <h1>{t("title")}</h1>
              <p className="lede">{t("lede")}</p>
              <p className="terms-governs">{t.rich("governs", etiquetasQueRigen(locale))}</p>
            </div>
            {/* LA CARPETA (Glass Folder de affectUI): tus documentos, dentro y
                tuyos. No es un diagrama de flujo —eso lo dice la tabla de
                abajo—: dibuja lo único que esta página promete sin matices,
                que el contenido no sale. Quieta; solo responde al puntero. */}
            <figure className="priv-hero-arte">
              <GlassFolder label={t("art.alt")} />
              <figcaption>{t("art.caption")}</figcaption>
            </figure>
          </section>
        </GridBackground>

        <div className="doc-grid">
          <DocIndice titulo={td("contents")} entradas={indice} />

          <div className="doc-body">
            <section className="terms-sec" aria-labelledby="overview">
              <h2 id="overview">{t("overview.title")}</h2>
              <table className="priv-tabla priv-tabla--resumen" role="table">
                <thead role="rowgroup">
                  <tr role="row">
                    <th scope="col" role="columnheader">{t("overview.colData")}</th>
                    <th scope="col" role="columnheader">{t("overview.colDestination")}</th>
                    <th scope="col" role="columnheader">{t("overview.colPurpose")}</th>
                    <th scope="col" role="columnheader">{t("overview.colRetention")}</th>
                  </tr>
                </thead>
                <tbody role="rowgroup">
                  {RESUMEN.map((r) => (
                    <tr role="row" key={r.clave} data-fila={r.clave}>
                      <th scope="row" role="rowheader">
                        <a href={`#${r.ancla}`}>{t(`overview.${r.clave}.data`)}</a>
                      </th>
                      <td role="cell" data-label={t("overview.colDestination")}>{t(`overview.${r.clave}.destination`)}</td>
                      <td role="cell" data-label={t("overview.colPurpose")}>{t(`overview.${r.clave}.purpose`)}</td>
                      <td role="cell" data-label={t("overview.colRetention")}>{t(`overview.${r.clave}.retention`)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section className="terms-sec" aria-labelledby="never">
              <h2 id="never">{t("never.title")}</h2>
              <ul className="terms-list priv-nunca">
                <li>{t.rich("never.content", { b })}</li>
                <li>{t.rich("never.credentials", { b })}</li>
              </ul>
              <p>{t("never.path")}</p>
            </section>

            <section className="terms-sec" aria-labelledby="usage">
              <h2 id="usage">{t("usage.title")}</h2>
              <p>{t.rich("usage.when", { b, header: CABECERA_VERSION })}</p>
              <p>{t.rich("usage.limit", { b })}</p>
              <Grupos
                grupos={GRUPOS_DEL_REGISTRO_DE_USO}
                titulo={(k) => t(`usage.groups.${k}.title`)}
                cuerpo={(k) => t(`usage.groups.${k}.body`)}
                columnas={columnas}
              />
            </section>

            <section className="terms-sec" aria-labelledby="verification">
              <h2 id="verification">{t("verification.title")}</h2>
              <p>{t.rich("verification.when", { b })}</p>
              <Grupos
                grupos={GRUPOS_DE_LA_VERIFICACION}
                titulo={(k) => t(`verification.groups.${k}.title`)}
                cuerpo={(k) => t(`verification.groups.${k}.body`)}
                columnas={columnas}
              />
            </section>

            <section className="terms-sec" aria-labelledby="other">
              <h2 id="other">{t("other.title")}</h2>
              <p>{t("other.body")}</p>
              <p>{t("other.network")}</p>
            </section>

            <section className="terms-sec" aria-labelledby="retention">
              <h2 id="retention">{t("retention.title")}</h2>
              <p>{t("retention.intro")}</p>
              <table className="priv-tabla priv-tabla--plazos" role="table">
                <thead role="rowgroup">
                  <tr role="row">
                    <th scope="col" role="columnheader">{t("retention.colWhere")}</th>
                    <th scope="col" role="columnheader">{t("retention.colWhat")}</th>
                    <th scope="col" role="columnheader">{t("retention.colPeriod")}</th>
                  </tr>
                </thead>
                <tbody role="rowgroup">
                  {PLAZOS_DE_RETENCION.map((r) => (
                    <tr role="row" key={r.clave}>
                      <th scope="row" role="rowheader">
                        <Tablas nombres={r.tablas} etiqueta={t("retention.colWhere")} />
                      </th>
                      <td role="cell" data-label={t("retention.colWhat")}>
                        {t(`retention.items.${r.clave}`, { dias: dias.format(r.dias) })}
                      </td>
                      <td role="cell" data-label={t("retention.colPeriod")}>
                        <Badge tone="neutral">{t("retention.period", { dias: dias.format(r.dias) })}</Badge>
                      </td>
                    </tr>
                  ))}
                  {/* Lo que HOY no se borra solo, en la misma tabla que lo que sí. */}
                  <tr role="row" data-fila="sin-plazo">
                    <th scope="row" role="rowheader">
                      <Tablas nombres={SIN_BORRADO_AUTOMATICO} etiqueta={t("retention.colWhere")} />
                    </th>
                    <td role="cell" data-label={t("retention.colWhat")}>{t("retention.noSchedule")}</td>
                    <td role="cell" data-label={t("retention.colPeriod")}>
                      <Badge tone="warning" dot>
                        {t("retention.none")}
                      </Badge>
                    </td>
                  </tr>
                </tbody>
              </table>
            </section>

            <section className="terms-sec" aria-labelledby="use">
              <h2 id="use">{t("use.title")}</h2>
              <p>{t.rich("use.body", { pricing: (c) => <Link href="/pricing">{c}</Link> })}</p>
            </section>

            <section className="terms-sec" aria-labelledby="account">
              <h2 id="account">{t("account.title")}</h2>
              <p>
                {t.rich("account.body", {
                  policy: (c) => (
                    <a href={corporateUrl("/privacy", locale)} target="_blank" rel="noopener noreferrer">
                      {c}
                    </a>
                  ),
                })}
              </p>
              <p>
                {t.rich("contact", {
                  mail: (c) => <a href={`mailto:${PRIVACY_EMAIL}`}>{c}</a>,
                  email: PRIVACY_EMAIL,
                })}
              </p>
            </section>

            <p className="doc-arriba">
              <a href="#inicio">{td("backToTop")}</a>
            </p>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
