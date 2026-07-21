import { getTranslations } from "next-intl/server";

import type { AbArtifact } from "../data";
import { pct, money, LEDGER_COLOR } from "../format";

/** The four REFERENCE ledgers (never summed). Note: these are the reference
 *  levers — the live rail measures a different four (provider_cached replaces
 *  output_restriction), so we never map one onto the other. */
export async function ReferenceLedgerCards({ ab }: { ab: AbArtifact }) {
  const t = await getTranslations("dashboard");
  return (
    <>
      <div className="kpis">
        {ab.ledgers.map((l) => {
          const pos = l.savings.point >= 0;
          return (
            <div key={l.ledger} className="kpi">
              <div className="n">
                <span className="ltag" style={{ background: LEDGER_COLOR[l.ledger] ?? "var(--muted)" }} />
                {l.ledger}
              </div>
              <div className={`v ${pos ? "pos" : "neg"}`}>{pct(l.savings.point)}</div>
              <div className="lo">95% ≥ {pct(l.savings.lower)} · Δ {money(l.deltaCost)}</div>
              <div className="sub">{ab.mode === "LIVE" ? (l.proven ? t("referenceLedgerCards.proven") : t("referenceLedgerCards.notProven")) : t("referenceLedgerCards.estimatedMock")}</div>
            </div>
          );
        })}
      </div>
      <p className="footnote">
        {t.rich("referenceLedgerCards.footnoteMain", { b: (chunks) => <b>{chunks}</b> })}{" "}
        {ab.reconciliation.reconciled
          ? t("referenceLedgerCards.reconciledNote")
          : t("referenceLedgerCards.residualNote", { residual: money(ab.reconciliation.residual) })}{" "}
        {t.rich("referenceLedgerCards.footnoteReference", { b: (chunks) => <b>{chunks}</b> })}
      </p>
    </>
  );
}
