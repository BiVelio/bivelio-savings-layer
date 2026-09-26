import type { ReactNode } from "react";

import { getTranslations, setRequestLocale } from "next-intl/server";

import Footer from "@/app/components/Footer";
import { etiquetasQueRigen } from "@/app/components/LegalGoverns";
import { Link } from "@/i18n/navigation";
import { absolute, languageAlternates } from "@/i18n/site";
import { terminosDePrecio } from "@/lib/legal/precios-publicados";
import { preciosDelPlan } from "@/lib/stripe/pricing";

/**
 * LA «PUBLISHED PRICING» QUE CITA LA LICENSE §6 — pública, indexable y sin una
 * sola cifra escrita a mano: cada número sale de `terminosDePrecio`, que lo lee
 * de las constantes que cobran (tarifa.ts, facturacion.ts, asientos.ts y el
 * Price de Stripe). `lib/legal/precios-publicados.test.ts` prohíbe literales
 * numéricos en este fichero, y los mensajes `pricingPage.*` no llevan dígitos
 * (tarifa-en-parametros.test.ts).
 *
 * Lo que dice cada frase es lo que hace el código hoy: la calibración como la
 * calcula cierre.ts, la exención como la ponen el webhook y el cierre, lo que
 * se comisiona por las etiquetas de `basis`. La LICENSE y los BiVelio Terms
 * rigen, y la página lo dice antes que ninguna cifra.
 */

// Como la portada: el precio del asiento lo lee Stripe con una caché de una
// hora, así que la página se regenera con el mismo ritmo (ISR).
export const revalidate = 3600;

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "pricingPage" });
  const title = t("metaTitle");
  const description = t("metaDescription");
  const url = absolute(`/${locale}/pricing`);

  return {
    title,
    description,
    alternates: { canonical: url, languages: languageAlternates("pricing") },
    openGraph: { title, description, url, siteName: "BiVelio Savings Layer", type: "article" },
    twitter: { card: "summary", title, description },
  };
}

export default async function PricingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("pricingPage");
  const p = terminosDePrecio(locale, await preciosDelPlan());
  const b = (c: ReactNode) => <b>{c}</b>;

  return (
    <div className="lp terms-page">
      <main className="wrap">
        <section className="terms-hero">
          <span className="eyebrow">{t("eyebrow")}</span>
          <h1>{t("title")}</h1>
          <p className="terms-governs">{t.rich("governs", etiquetasQueRigen(locale))}</p>
          <p className="lede">{t("lede")}</p>
        </section>

        <section className="terms-sec" aria-labelledby="seat">
          <h2 id="seat">{t("seat.title")}</h2>
          <p className="terms-amount">
            {t.rich("seat.amount", { b, monthly: p.mensual, yearly: p.anual, currency: p.monedaCuota })}
          </p>
          <p>{t.rich("seat.paidAlways", { b })}</p>
          <p>{t("seat.vat")}</p>
          <h3>{t("seat.whatTitle")}</h3>
          <p>{t.rich("seat.what", { b, max: p.maxAsientos })}</p>
          <p>{t("seat.counted", { dias: p.diasActivos })}</p>
          <p>
            {t.rich("seat.identifier", {
              privacy: (c) => <Link href="/privacy">{c}</Link>,
            })}
          </p>
        </section>

        <section className="terms-sec" aria-labelledby="commission">
          <h2 id="commission">{t("commission.title")}</h2>
          <p>{t.rich("commission.only", { b, labels: p.comisionables, never: p.sinComision })}</p>
          <ul className="terms-list">
            <li>{t("commission.measured")}</li>
            {p.reglaReferencia ? <li>{t("commission.reference", { regla: p.reglaReferencia })}</li> : null}
            <li>{t("commission.valued")}</li>
            <li>{t("commission.flatRate")}</li>
            {p.elisionFueraDeLaBase ? <li>{t("commission.elision")}</li> : null}
          </ul>

          <h3>{t("commission.tiersTitle")}</h3>
          <p>{t("commission.tiersIntro", { currency: p.monedaComision })}</p>
          <table className="terms-table">
            <thead>
              <tr>
                <th scope="col">{t("commission.colBand")}</th>
                <th scope="col">{t("commission.colRate")}</th>
              </tr>
            </thead>
            <tbody>
              {p.tramos.map((tr) => (
                <tr key={`${tr.forma}-${tr.desde}`}>
                  <td>
                    {tr.forma === "hasta"
                      ? t("commission.bandUpTo", { hasta: tr.hasta })
                      : tr.forma === "entre"
                        ? t("commission.bandBetween", { desde: tr.desde, hasta: tr.hasta })
                        : t("commission.bandAbove", { desde: tr.desde })}
                  </td>
                  <td>{tr.tipo}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>{t.rich("commission.ceiling", { b, max: p.tipoMaximo, garantia: p.garantia })}</p>
          <p>{t("commission.fx")}</p>
          <p>{t("commission.rounding", { minimo: p.minimoFacturable })}</p>
          <p>{t.rich("commission.zero", { b })}</p>
          <p>
            {t.rich("commission.calculator", {
              calc: (c) => <Link href="/#pricing">{c}</Link>,
            })}
          </p>
        </section>

        <section className="terms-sec" aria-labelledby="calibration">
          <h2 id="calibration">{t("calibration.title")}</h2>
          <p>{t.rich("calibration.body", { b })}</p>
        </section>

        <section className="terms-sec" aria-labelledby="exemption">
          <h2 id="exemption">{t("exemption.title")}</h2>
          <p>{t("exemption.body")}</p>
        </section>

        <section className="terms-sec" aria-labelledby="statement">
          <h2 id="statement">{t("statement.title")}</h2>
          <p>{t("statement.body")}</p>
        </section>
      </main>
      <Footer />
    </div>
  );
}
