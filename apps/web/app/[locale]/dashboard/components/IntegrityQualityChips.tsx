import { getTranslations } from "next-intl/server";

import { Badge } from "@/vendor/affectui/badge";

import type { AbArtifact } from "../data";
import { pct0, money } from "../format";

/**
 * Trust signals from the A/B run — surfaced, including proven:false.
 *
 * Cada señal es una Badge de affectUI: el color dice el tono (verde = pasó,
 * ámbar = no pasó, gris = regla o dato neutro) y el TEXTO dice qué pasó; un
 * punto delante marca las que son comprobaciones con resultado.
 */
export async function IntegrityQualityChips({ ab }: { ab: AbArtifact }) {
  const t = await getTranslations("dashboard");
  const cache = ab.scenarios.find((s) => s.amortization);
  return (
    <div className="iq">
      <p className="iq-t">{t("integrityQualityChips.title")}</p>
      <ul className="chips iq-l">
        <li>
          <Badge size="md" tone="success" dot>
            {t.rich("integrityQualityChips.qualityGate", {
              b: (chunks) => <b>{chunks}</b>,
              rate: pct0(ab.aggregate.qualityPassRate),
            })}
          </Badge>
        </li>
        <li>
          <Badge size="md" tone={ab.reconciliation.reconciled ? "success" : "danger"} dot>
            {ab.reconciliation.reconciled
              ? t("integrityQualityChips.ledgersReconcile")
              : t("integrityQualityChips.ledgersMismatch")}
            {!ab.reconciliation.reconciled ? <> · {money(ab.reconciliation.residual)}</> : null}
          </Badge>
        </li>
        <li>
          <Badge size="md" tone={ab.modelStable ? "success" : "danger"} dot>
            {ab.modelStable
              ? t("integrityQualityChips.modelStable")
              : t("integrityQualityChips.modelChanged")}
          </Badge>
        </li>
        <li>
          <Badge size="md" tone={ab.aggregate.proven ? "success" : "warning"} dot>
            {ab.aggregate.proven ? t("integrityQualityChips.provenAt95") : t("integrityQualityChips.unprovenMock")}
          </Badge>
        </li>
        {cache?.amortization?.breakEvenK != null ? (
          <li>
            <Badge size="md">
              {t.rich("integrityQualityChips.cacheBreakEven", {
                b: (chunks) => <b>{chunks}</b>,
                k: cache.amortization.breakEvenK,
              })}
            </Badge>
          </li>
        ) : null}
        <li>
          <Badge size="md">{t("integrityQualityChips.regressedVoids")}</Badge>
        </li>
      </ul>
    </div>
  );
}
