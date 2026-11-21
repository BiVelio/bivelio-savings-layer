import type { ReactNode } from "react";

import { getTranslations, setRequestLocale } from "next-intl/server";

import { Marcado } from "@/app/components/campana/Marcado";
import { HeroeDeCampana } from "@/app/components/campana/HeroeDeCampana";
import { Migas } from "@/app/components/docs/Migas";
import Footer from "@/app/components/Footer";
import { PlanesCloud } from "@/app/components/landing/PlanesCloud";
import { etiquetasQueRigen } from "@/app/components/LegalGoverns";
import { URL_DEL_CODIGO } from "@/app/components/sitio";
import { Link } from "@/i18n/navigation";
import { absolute, languageAlternates, tarjetaSocial } from "@/i18n/site";
import { terminosDeLosPlanes, terminosDePrecio } from "@/lib/legal/precios-publicados";
import { HORAS_SIN_RESPUESTA_CON_CLAVE, LIMITES_MEDIR, VERSION_MEDIR_AHORRA, VERSION_MINIMA_MEDIR } from "@/lib/license/medir-publico";
import { preciosDelPlan, tarifasDeLosPlanes } from "@/lib/stripe/pricing";
import { Badge } from "@/vendor/affectui/badge-clean";
import { DataTable } from "@/vendor/affectui/data-table-clean";
import { GridBackground } from "@/vendor/affectui/grid-background";

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
 *
 * REDISEÑO 2026-11 (guía §7): la página VENDE sin dejar de ser el documento.
 *   1. Título, explicación breve y acceso al código.
 *   2. Community frente a Cloud, ANTES de comparar importes.
 *   3. Las cuatro tarjetas cloud (app/components/landing/PlanesCloud), con la
 *      unidad que se cobra junto a cada precio y las CTA de siempre: Measure →
 *      alta; Pro y Team → alta con `next=/{locale}/dashboard?plan=…`;
 *      Enterprise → correo. Aquí no hay checkout.
 *   4. Las condiciones completas de cada plan, del asiento, del exceso, de los
 *      impuestos y de cómo se gestiona la suscripción — sin plegar.
 *   5. La modalidad histórica con comisión en un bloque APARTE, cerrado a
 *      nuevas altas: todas sus condiciones, ninguna CTA, y no es una quinta
 *      tarjeta.
 * Las anclas (#plans #medir #pro #team #enterprise #seat #commission
 * #calibration #exemption #statement) no cambian.
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
  const social = tarjetaSocial(locale, title);

  return {
    title,
    description,
    alternates: { canonical: url, languages: languageAlternates("pricing") },
    openGraph: { title, description, url, siteName: "BiVelio Savings Layer", type: "article", ...social.openGraph },
    twitter: { ...social.twitter, title, description },
  };
}

export default async function PricingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("pricingPage");
  const tn = await getTranslations("nav");
  const p = terminosDePrecio(locale, await preciosDelPlan());
  const planes = terminosDeLosPlanes(locale, await tarifasDeLosPlanes());
  const b = (c: ReactNode) => <b>{c}</b>;
  // Los límites de Measure salen de la constante que aplica la ingesta.
  const medir = {
    seats: LIMITES_MEDIR.asientos,
    requests: LIMITES_MEDIR.peticionesDiarias.toLocaleString(locale),
    version: VERSION_MINIMA_MEDIR,
  };
  const nombres = {
    medir: t("plans.medir.name"),
    pro: t("plans.pro.name"),
    team: t("plans.team.name"),
    enterprise: t("plans.enterprise.name"),
  };

  return (
    <div className="lp terms-page precios">
      <main className="wrap">
        {/* FIRMA DE CAMPAÑA: cielo cian detrás de la rejilla, acento en serif
            con marcador y mosaico de llamadas al pie de la cabecera. */}
        <HeroeDeCampana pagina="pricing">
        <GridBackground className="doc-fondo">
        <section className="terms-hero precios-hero">
          <Migas actual={tn("pricing")} />
          <span className="eyebrow">{t("eyebrow")}</span>
          <h1>
            {t("title")}{" "}
            <span className="serif-accent heroe-acento">
              <Marcado texto={t("titleAccent")} marca={t("titleMark")} />
            </span>
          </h1>
          <p className="lede">{t("lede")}</p>
          {/* Tres salidas (dueño, 21-11-2026): instalar gratis (lo que ahorra,
              sin clave) es la principal; Measure, la segunda; el código, la
              tercera. Cada posición conserva sus clases: solo cambian texto,
              destino y orden. */}
          <div className="precios-acciones">
            <Link className="btn" href="/#sdk-install">
              {t("access.install")}
            </Link>
            <Link className="btn ghost" href="/signup">
              {t("cards.medir.cta")}
            </Link>
            <a className="btn btn-quiet" href={URL_DEL_CODIGO} target="_blank" rel="noopener noreferrer">
              {t("access.code")}
              <span className="sr-only"> {tn("newTab")}</span>
            </a>
          </div>
          <p className="terms-governs">{t.rich("governs", etiquetasQueRigen(locale))}</p>
        </section>
        </GridBackground>
        </HeroeDeCampana>

        {/* COMMUNITY FRENTE A CLOUD, antes de ningún importe: el motor es
            gratis y no es un plan; lo que tiene precio es la nube opcional. */}
        <section className="precios-modos" aria-labelledby="modes">
          <h2 id="modes" className="precios-h2">
            {t("modes.title")}
          </h2>
          <div className="modos">
            <article className="modo">
              <span className="modo-etiqueta">{t("modes.community.tag")}</span>
              <h3>{t("modes.community.name")}</h3>
              <p>{t("modes.community.body")}</p>
            </article>
            <article className="modo" data-cloud="">
              <span className="modo-etiqueta">{t("modes.cloud.tag")}</span>
              <h3>{t("modes.cloud.name")}</h3>
              <p>{t("modes.cloud.body", { horas: HORAS_SIN_RESPUESTA_CON_CLAVE })}</p>
            </article>
          </div>
        </section>

        <section className="precios-planes" aria-labelledby="plans">
          <h2 id="plans" className="precios-h2">
            {t("plans.title")}
          </h2>
          <p className="precios-intro">{t("plans.intro")}</p>
          <PlanesCloud
            enPrecios
            grupo="periodo-precios"
            planes={planes}
            medir={medir}
            nombres={nombres}
            destinos={{
              pro: { pathname: "/signup", query: { next: `/${locale}/dashboard?plan=pro` } },
              team: { pathname: "/signup", query: { next: `/${locale}/dashboard?plan=equipo` } },
            }}
          />
        </section>

        <div className="precios-doc">
          <nav className="precios-indice" aria-label={t("toc.label")}>
            <p className="precios-indice-t">{t("toc.label")}</p>
            <ul>
              <li>
                <a href="#terms">{t("plans.termsTitle")}</a>
              </li>
              <li>
                <a href="#seat">{t("seat.title")}</a>
              </li>
              <li>
                <a href="#manage">{t("seat.manageTitle")}</a>
              </li>
              <li>
                <a href="#legacy">{t("legacy.title")}</a>
              </li>
            </ul>
          </nav>

          <div className="precios-cuerpo">
            <section className="terms-sec" aria-labelledby="terms">
              <h2 id="terms">{t("plans.termsTitle")}</h2>

              {/* «Measure»: la licencia gratuita (docs/LICENCIA-MEDIR.md). Sin
                  cifras en el texto: sus topes y su versión mínima llegan por
                  parámetro desde lib/license/medir-publico.ts, las constantes
                  que aplica la ingesta. */}
              <h3 id="medir">{nombres.medir}</h3>
              <p>
                {t.rich("plans.medir.body", {
                  b,
                  seats: medir.seats,
                  requests: medir.requests,
                  version: medir.version,
                  saves: VERSION_MEDIR_AHORRA,
                })}
              </p>

              <h3 id="pro">{nombres.pro}</h3>
              <p className="terms-amount">
                {t.rich("plans.pro.amount", { b, monthly: planes.pro.mensual, yearly: planes.pro.anual, currency: planes.moneda })}
              </p>
              <p>{t.rich("plans.pro.body", { b })}</p>

              <h3 id="team">{nombres.team}</h3>
              <p className="terms-amount">
                {t.rich("plans.team.amount", {
                  b,
                  monthly: planes.equipo.mensual,
                  yearly: planes.equipo.anual,
                  included: planes.equipo.incluidos,
                  perSeat: planes.equipo.porAsiento,
                  currency: planes.moneda,
                })}
              </p>
              <p>{t("plans.team.extra", { monthly: planes.equipo.extraMensual, yearly: planes.equipo.extraAnual })}</p>
              <p>{t.rich("plans.team.body", { b })}</p>

              <h3 id="enterprise">{nombres.enterprise}</h3>
              <p>
                {t.rich("plans.enterprise.body", {
                  b,
                  contact: (c) => <a href="mailto:support@bivelio.com">{c}</a>,
                })}
              </p>
            </section>

            <section className="terms-sec" aria-labelledby="seat">
              <h2 id="seat">{t("seat.title")}</h2>
              {/* El ciclo del asiento es el de la suscripción de Stripe (el checkout no
                  fija `billing_cycle_anchor`): empieza el día que empieza ella, y es
                  mensual o anual. El mes natural (UTC) es solo el de la comisión. */}
              <p>{t("seat.cycle")}</p>
              <p>{t.rich("seat.paidAlways", { b })}</p>
              <p>{t("seat.provider")}</p>
              <p>{t("seat.vat")}</p>
              <h3>{t("seat.whatTitle")}</h3>
              <p>{t.rich("seat.what", { b, max: p.maxAsientos })}</p>
              <p>{t("seat.counted", { dias: p.diasActivos })}</p>
              {/* EL EXCESO SE COBRA (decisión del dueño, 2026-09-30): lo hace el cron
                  cobrar-asientos sobre el mes cerrado, una vez, al precio del plan. */}
              <p>{t("seat.overage")}</p>
              <p>
                {t.rich("seat.identifier", {
                  privacy: (c) => <Link href="/privacy">{c}</Link>,
                })}
              </p>
              {/* La suscripción se cambia donde se contrató: la cuenta del panel,
                  que abre el portal de pago. Esta página no cobra nada. */}
              <h3 id="manage">{t("seat.manageTitle")}</h3>
              <p>
                {t.rich("seat.manage", {
                  account: (c) => <Link href="/dashboard/account">{c}</Link>,
                })}
              </p>
            </section>

            {/* LA MODALIDAD CON COMISIÓN, CERRADA A CLIENTES NUEVOS (2026-09-29). Sus
                condiciones siguen publicadas porque rigen las suscripciones que la
                conservan (LICENSE §6: «only if your subscription is on a plan that
                the Published Pricing lists as carrying a commission»), pero no se
                vende: ni checkout, ni calculadora, ni CTA. Va en su propio bloque,
                separado de los planes vigentes. */}
            <div className="precios-legado" id="legacy" role="group" aria-labelledby="legacy-t">
              <p className="precios-legado-insignia" id="legacy-t">
                <Badge tone="warning" dot>
                  {t("legacy.title")}
                </Badge>
              </p>
              <p className="precios-legado-n">{t("legacy.note")}</p>

              <section className="terms-sec" aria-labelledby="commission">
                <h2 id="commission">{t("commission.title")}</h2>
                <p>{t.rich("commission.optional", { b })}</p>
                <p className="terms-amount">
                  {t.rich("commission.seat", { b, monthly: p.mensual, yearly: p.anual, currency: p.monedaCuota })}
                </p>
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
                {/* Los tramos, en la Data Table de affectUI bifurcada a SOLO
                    LECTURA: una cifra publicada no puede parecer editable. */}
                <DataTable
                  className="precios-tramos"
                  label={t("commission.tiersTitle")}
                  rowHeader
                  columns={[
                    { key: "tramo", label: t("commission.colBand") },
                    { key: "tipo", label: t("commission.colRate"), align: "end", mono: true },
                  ]}
                  rows={p.tramos.map((tr) => ({
                    id: `${tr.forma}-${tr.desde}`,
                    cells: {
                      tramo:
                        tr.forma === "hasta"
                          ? t("commission.bandUpTo", { hasta: tr.hasta })
                          : tr.forma === "entre"
                            ? t("commission.bandBetween", { desde: tr.desde, hasta: tr.hasta })
                            : t("commission.bandAbove", { desde: tr.desde }),
                      tipo: tr.tipo,
                    },
                  }))}
                />
                <p>{t.rich("commission.ceiling", { b, max: p.tipoMaximo, garantia: p.garantia })}</p>
                <p>{t("commission.fx")}</p>
                <p>{t("commission.rounding", { minimo: p.minimoFacturable })}</p>
                <p>{t.rich("commission.zero", { b })}</p>
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
            </div>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
