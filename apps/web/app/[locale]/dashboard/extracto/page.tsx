import { getLocale, getTranslations } from "next-intl/server";

import { extractoEnSombra, periodoDe } from "@/lib/billing/extracto-sombra";
import { loadDashboard } from "../load";

/**
 * EL EXTRACTO EN SOMBRA — la pantalla del mes de calibración del plan maestro.
 *
 * Enseña, desde el primer día, el documento exacto que la futura factura
 * variable producirá: base medida, ahorro medido, ratio, rampa, tramos y la
 * comisión resultante — con la etiqueta que corresponda (calibración: 0 €).
 * Nada de esta pantalla cobra: es la sombra. La única fuente de cálculo es
 * `construirExtracto`; aquí solo se pinta.
 */
export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "dashboard" });
  return { title: t("extracto.metaTitle") };
}

export default async function ExtractoPage() {
  const t = await getTranslations("dashboard");
  const locale = await getLocale();
  const { usage, usageFailed } = await loadDashboard();

  const periodo = periodoDe(new Date());
  const e = extractoEnSombra("panel", usage, periodo);

  const eur = (n: number) => n.toLocaleString(locale, { style: "currency", currency: "EUR" });
  const usd = (n: number) => n.toLocaleString(locale, { style: "currency", currency: "USD" });
  const pct = (n: number) => (n * 100).toLocaleString(locale, { maximumFractionDigits: 1 }) + "%";

  return (
    <>
      <div className="app-head">
        <p className="ck-eyebrow">{t("extracto.eyebrow")}</p>
        <h1>{t("extracto.title")}</h1>
        <p>{t("extracto.intro", { cero: (0).toLocaleString(locale, { style: "currency", currency: "EUR" }) })}</p>
      </div>

      <section className="ck-sec">
        <div className="ck-head">
          <div>
            <h2>{t("extracto.periodo", { periodo })}</h2>
          </div>
          <span className="est-tag">{e.esCalibracion ? t("extracto.badgeCalibracion") : t("extracto.badgeSombra")}</span>
        </div>

        {usageFailed ? (
          <p className="ck-note" style={{ color: "var(--danger)" }}>{t("extracto.lecturaFallo")}</p>
        ) : null}

        <div className="kpi" style={{ minHeight: "auto", marginBottom: 14 }}>
          <div className="n">{t("extracto.kpiTitulo")}</div>
          <div className="v pos ck-num">{eur(e.cargoEur)}</div>
          <div className="sub">
            {e.esCalibracion
              ? t("extracto.notaCalibracion", { habria: eur(e.comision.comisionEur) })
              : t("extracto.notaSombra", { comision: eur(e.comision.comisionEur) })}
          </div>
        </div>

        <div className="hiw-two">
          <div className="hiw-mcard">
            <span className="k">{t("extracto.baseMedida")}</span>
            <div className="v">{eur(e.baseMedidaEur)}</div>
            <p>
              {t("extracto.enUsd", { usd: usd(e.baseMedidaUsd) })} · {t("extracto.requests", { n: e.requestsMedidas.toLocaleString(locale) })}
            </p>
          </div>
          <div className="hiw-mcard">
            <span className="k">{t("extracto.ahorroMedido")}</span>
            <div className="v real">{eur(e.ahorroMedidoEur)}</div>
            <p>
              {t("extracto.ratio", { pct: pct(e.comision.ratio) })} · {t("extracto.rampa", { pct: pct(e.comision.factorRampa) })}
            </p>
          </div>
        </div>

        <h3 style={{ margin: "18px 0 6px", fontSize: "1rem" }}>{t("extracto.tramosTitulo")}</h3>
        {e.comision.tramos.length === 0 ? (
          <p className="ck-note">{t("extracto.sinAhorro")}</p>
        ) : (
          <div className="tbl-scroll">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t("extracto.colTramo")}</th>
                  <th>{t("extracto.colTipo")}</th>
                  <th>{t("extracto.colBase")}</th>
                  <th>{t("extracto.colComision")}</th>
                </tr>
              </thead>
              <tbody>
                {e.comision.tramos.map((tr) => (
                  <tr key={tr.desdeEur}>
                    <td className="ck-num">
                      {eur(tr.desdeEur)} – {Number.isFinite(tr.hastaEur) ? eur(tr.hastaEur) : "∞"}
                    </td>
                    <td className="ck-num">{pct(tr.tipo)}</td>
                    <td className="ck-num">{eur(tr.baseEur)}</td>
                    <td className="ck-num">{eur(tr.comisionEur)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="ck-note" style={{ marginTop: 14 }}>
          {t("extracto.estimadoExcluido", { usd: usd(e.ahorroEstimadoExcluidoUsd) })}
        </p>
        <p className="ck-note">
          {t("extracto.parametros", {
            version: e.parametros.versionPrecios,
            // La unidad y la fuente van construidas AQUÍ: los ficheros de
            // mensajes tienen prohibido llevar EUR/USD a mano (parity.test.ts).
            fx: `${e.parametros.fx.eurPorUsd.toLocaleString(locale)} EUR/USD — ${e.parametros.fx.fuente}`,
            umbral: pct(e.parametros.umbralRatio),
          })}
        </p>
        <p className="ck-note">
          <b>{t("extracto.mismaFacturaTitulo")}</b> {t("extracto.mismaFactura")}
        </p>
      </section>
    </>
  );
}
