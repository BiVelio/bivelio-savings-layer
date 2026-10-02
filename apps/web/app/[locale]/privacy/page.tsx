import type { ReactNode } from "react";

import { getTranslations, setRequestLocale } from "next-intl/server";

import Footer from "@/app/components/Footer";
import { etiquetasQueRigen } from "@/app/components/LegalGoverns";
import { Link } from "@/i18n/navigation";
import { absolute, languageAlternates, tarjetaSocial } from "@/i18n/site";
import { corporateUrl } from "@/lib/corporate";
import {
  GRUPOS_DE_LA_VERIFICACION,
  GRUPOS_DEL_REGISTRO_DE_USO,
  PLAZOS_DE_RETENCION,
  type GrupoDeCampos,
} from "@/lib/legal/lo-que-sale";
import { CABECERA_VERSION } from "@/lib/metering/version";

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

function Grupos({
  grupos,
  titulo,
  cuerpo,
}: {
  grupos: readonly GrupoDeCampos[];
  titulo: (clave: string) => string;
  cuerpo: (clave: string) => string;
}) {
  return (
    <div className="terms-groups">
      {grupos.map((g) => (
        <div className="terms-group" key={g.clave}>
          <h3>{titulo(g.clave)}</h3>
          <p>{cuerpo(g.clave)}</p>
          <ul className="terms-fields" aria-label={titulo(g.clave)}>
            {g.campos.map((c) => (
              <li key={c}>
                <code>{c}</code>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export default async function PrivacyPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("privacyPage");
  const b = (c: ReactNode) => <b>{c}</b>;
  const dias = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });

  return (
    <div className="lp terms-page">
      <main className="wrap">
        <section className="terms-hero">
          <span className="eyebrow">{t("eyebrow")}</span>
          <h1>{t("title")}</h1>
          <p className="terms-governs">{t.rich("governs", etiquetasQueRigen(locale))}</p>
          <p className="lede">{t("lede")}</p>
        </section>

        <section className="terms-sec" aria-labelledby="never">
          <h2 id="never">{t("never.title")}</h2>
          <ul className="terms-list">
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
          />
        </section>

        <section className="terms-sec" aria-labelledby="verification">
          <h2 id="verification">{t("verification.title")}</h2>
          <p>{t.rich("verification.when", { b })}</p>
          <Grupos
            grupos={GRUPOS_DE_LA_VERIFICACION}
            titulo={(k) => t(`verification.groups.${k}.title`)}
            cuerpo={(k) => t(`verification.groups.${k}.body`)}
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
          <ul className="terms-list">
            {PLAZOS_DE_RETENCION.map((r) => (
              <li key={r.clave}>{t(`retention.items.${r.clave}`, { dias: dias.format(r.dias) })}</li>
            ))}
          </ul>
          <p>{t("retention.noSchedule")}</p>
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
      </main>
      <Footer />
    </div>
  );
}
