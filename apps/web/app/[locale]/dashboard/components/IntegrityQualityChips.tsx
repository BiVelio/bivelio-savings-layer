import { getTranslations } from "next-intl/server";

import type { AbArtifact } from "../data";
import { pct0, money } from "../format";

/** Trust signals from the A/B run — surfaced, including proven:false. */
export async function IntegrityQualityChips({ ab }: { ab: AbArtifact }) {
  const t = await getTranslations("dashboard");
  const cache = ab.scenarios.find((s) => s.amortization);
  return (
    <div className="chips">
      <span className="chip2 good">
        {t.rich("integrityQualityChips.qualityGate", {
          b: (chunks) => <b>{chunks}</b>,
          rate: pct0(ab.aggregate.qualityPassRate),
        })}
      </span>
      <span className={`chip2 ${ab.reconciliation.reconciled ? "good" : "warn"}`}>
        {ab.reconciliation.reconciled
          ? t("integrityQualityChips.ledgersReconcile")
          : t("integrityQualityChips.ledgersMismatch")}
        {!ab.reconciliation.reconciled ? <> · {money(ab.reconciliation.residual)}</> : null}
      </span>
      <span className={`chip2 ${ab.fingerprintStable ? "good" : "warn"}`}>
        {ab.fingerprintStable
          ? t("integrityQualityChips.fingerprintStable")
          : t("integrityQualityChips.fingerprintChanged")}
      </span>
      {cache?.amortization?.breakEvenK != null ? (
        <span className="chip2">
          {t.rich("integrityQualityChips.cacheBreakEven", {
            b: (chunks) => <b>{chunks}</b>,
            k: cache.amortization.breakEvenK,
          })}
        </span>
      ) : null}
      <span className={`chip2 ${ab.aggregate.proven ? "good" : "warn"}`}>
        {ab.aggregate.proven ? t("integrityQualityChips.provenAt95") : t("integrityQualityChips.unprovenMock")}
      </span>
      <span className="chip2">{t("integrityQualityChips.regressedVoids")}</span>
    </div>
  );
}
