import { getTranslations } from "next-intl/server";

import type { ShadowModelDia, ShadowReadStatus, UsageRollup } from "../data";
import { intfmt, money, moneySigned, pctFloor } from "../format";
import { deriveOpportunities } from "../opportunities";
import type { Rango } from "../rango";

export async function ShadowOpportunitiesCard({
  rows,
  usage,
  status,
  rango,
}: {
  rows: ShadowModelDia[];
  usage: UsageRollup[];
  status: ShadowReadStatus;
  rango: Rango;
}) {
  const t = await getTranslations("dashboard.shadowOpportunities");
  const summary = deriveOpportunities(rows, usage);
  const historical = rows.length === 0 && summary.dailyShadowAvailable && summary.totalShadowRequests > 0;
  const canExport = (status === "data" || status === "empty") && summary.dailyShadowAvailable;
  const celda = { padding: "6px 8px" } as const;

  return (
    <section className="card card-pad" aria-labelledby="shadow-opportunities-title">
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <h3 className="n card-title" id="shadow-opportunities-title">{t("title")}</h3>
        <span className="pill">{t("badge")}</span>
      </div>
      <p className="sub">{t("intro")}</p>

      {status === "error" ? <p role="alert" className="ck-note">{t("error")}</p> : null}
      {status === "hidden" ? <p role="alert" className="ck-note">{t("hidden")}</p> : null}
      {status === "unavailable" ? <p className="ck-note">{t("unavailable")}</p> : null}
      {(status === "data" || status === "empty") && historical ? <p className="ck-note">{t("historical")}</p> : null}
      {(status === "data" || status === "empty") && !historical && summary.rows.length === 0 ? (
        <p className="ck-note">{t("empty")}</p>
      ) : null}

      {summary.rows.length > 0 && (status === "data" || status === "empty") ? (
        <>
          <div className="tbl-scroll">
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", opacity: 0.65 }}>
                  <th style={{ ...celda, fontWeight: 500 }}>{t("colModel")}</th>
                  <th style={{ ...celda, fontWeight: 500 }}>{t("colRequests")}</th>
                  <th style={{ ...celda, fontWeight: 500 }}>{t("colBaseline")}</th>
                  <th style={{ ...celda, fontWeight: 500 }}>{t("colActual")}</th>
                  <th style={{ ...celda, fontWeight: 500 }}>{t("colSavings")}</th>
                  <th style={{ ...celda, fontWeight: 500 }}>{t("colCoverage")}</th>
                </tr>
              </thead>
              <tbody>
                {summary.rows.map((row) => (
                  <tr key={row.model} style={{ borderTop: "1px solid var(--line)" }}>
                    <td style={{ ...celda, fontFamily: "var(--mono)", fontSize: 12 }}>{row.model}</td>
                    <td style={celda}>{intfmt(row.shadowRequests)}</td>
                    <td style={celda}>{money(row.baselineCost)}</td>
                    <td style={celda}>{money(row.actualCost)}</td>
                    <td style={celda}>{moneySigned(row.hypotheticalSavings)}</td>
                    <td style={celda}>{row.coverageRatio === null ? "—" : pctFloor(row.coverageRatio)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {summary.coverageRatio !== null ? (
            <p className="ck-note">
              {t(summary.partialCoverage ? "coveragePartial" : "coverage", {
                coverage: pctFloor(summary.coverageRatio),
                attributed: intfmt(summary.attributedShadowRequests),
                total: intfmt(summary.totalShadowRequests),
              })}
            </p>
          ) : (
            <p className="ck-note">{t("coverageUnavailable")}</p>
          )}
        </>
      ) : null}

      <p className="ck-note">{t("note")}</p>
      <p className="ck-note">{t("action")}</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <a className="btn" href="/dashboard/account">{t("accountCta")}</a>
        <a className="btn" href="/dashboard/install">{t("installCta")}</a>
        {canExport ? (
          <>
            <a className="btn" href={`/api/org/shadow-opportunities?format=csv&range=${rango}`}>{t("exportCsv")}</a>
            <a className="btn" href={`/api/org/shadow-opportunities?format=json&range=${rango}`}>{t("exportJson")}</a>
          </>
        ) : null}
      </div>
      <div className="src" style={{ marginTop: 8 }}>usage_daily_shadow_by_model · 0037 · basis=shadow</div>
    </section>
  );
}
