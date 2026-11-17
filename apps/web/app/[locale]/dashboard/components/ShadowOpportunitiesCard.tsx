import { getTranslations } from "next-intl/server";

import { Badge } from "@/vendor/affectui/badge-clean";
import { DataTable } from "@/vendor/affectui/data-table-clean";

import { Termino } from "@/app/components/evidencia/Termino";

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
  const p = await getTranslations("dashboard.panel");
  const legible = status === "data" || status === "empty";

  return (
    <section className="card card-pad ox-card" aria-labelledby="shadow-opportunities-title">
      <div className="card-head">
        <h3 className="n" id="shadow-opportunities-title">{t("title")}</h3>
        <Termino definicion={t("badgeDef")} desnudo>
          <Badge tone="warning" caps>{t("badge")}</Badge>
        </Termino>
      </div>
      <p className="ox-lead">{t("intro")}</p>

      {status === "error" ? <p role="alert" className="ck-note ox-state">{t("error")}</p> : null}
      {status === "hidden" ? <p role="alert" className="ck-note ox-state">{t("hidden")}</p> : null}
      {status === "unavailable" ? <p className="ck-note ox-state">{t("unavailable")}</p> : null}
      {legible && historical ? <p className="ck-note ox-state">{t("historical")}</p> : null}
      {legible && !historical && summary.rows.length === 0 ? <p className="ck-note ox-state">{t("empty")}</p> : null}

      {summary.rows.length > 0 && legible ? (
        <>
          <DataTable
            flat
            pinFirst
            label={t("title")}
            sortLabel={p("sortBy", { column: "{column}" })}
            minWidth="600px"
            columns={[
              { key: "model", label: t("colModel"), mono: true, nowrap: true, sortable: true },
              { key: "requests", label: t("colRequests"), align: "end", mono: true, sortable: true },
              { key: "baseline", label: t("colBaseline"), align: "end", mono: true, sortable: true },
              { key: "actual", label: t("colActual"), align: "end", mono: true, sortable: true },
              { key: "savings", label: t("colSavings"), align: "end", mono: true, sortable: true },
              { key: "coverage", label: t("colCoverage"), align: "end", mono: true, sortable: true },
            ]}
            rows={summary.rows.map((row) => ({
              id: row.model,
              // Sin cobertura medida la celda es «—» y ordena al final: no es un 0 %.
              sort: {
                model: row.model,
                requests: row.shadowRequests,
                baseline: row.baselineCost,
                actual: row.actualCost,
                savings: row.hypotheticalSavings,
                coverage: row.coverageRatio,
              },
              quiet: row.coverageRatio === null ? ["coverage"] : undefined,
              cells: {
                model: row.model,
                requests: intfmt(row.shadowRequests),
                baseline: money(row.baselineCost),
                actual: money(row.actualCost),
                savings: moneySigned(row.hypotheticalSavings),
                coverage: row.coverageRatio === null ? "—" : pctFloor(row.coverageRatio),
              },
            }))}
          />
          {summary.coverageRatio !== null ? (
            <p className="ck-note ox-foot">
              {t(summary.partialCoverage ? "coveragePartial" : "coverage", {
                coverage: pctFloor(summary.coverageRatio),
                attributed: intfmt(summary.attributedShadowRequests),
                total: intfmt(summary.totalShadowRequests),
              })}
            </p>
          ) : (
            <p className="ck-note ox-foot">{t("coverageUnavailable")}</p>
          )}
        </>
      ) : null}

      <div className="ox-aside">
        <p className="ck-note">{t("note")}</p>
        <p className="ck-note">{t("action")}</p>
      </div>
      <div className="ox-actions">
        <a className="btn btn-ghost btn-sm" href="/dashboard/account">{t("accountCta")}</a>
        <a className="btn btn-ghost btn-sm" href="/dashboard/install">{t("installCta")}</a>
        {canExport ? (
          <>
            <a className="btn btn-quiet btn-sm" href={`/api/org/shadow-opportunities?format=csv&range=${rango}`}>{t("exportCsv")}</a>
            <a className="btn btn-quiet btn-sm" href={`/api/org/shadow-opportunities?format=json&range=${rango}`}>{t("exportJson")}</a>
          </>
        ) : null}
      </div>
      <div className="src ox-src">usage_daily_shadow_by_model · 0037 · basis=shadow</div>
    </section>
  );
}
