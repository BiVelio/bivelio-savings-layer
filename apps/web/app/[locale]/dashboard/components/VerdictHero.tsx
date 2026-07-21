import { getTranslations } from "next-intl/server";

import type { UsageRollup } from "../data";
import { pct, money } from "../format";
import { ProvenancePill } from "./ProvenancePill";

/** Two-state hero, SAME slot: the big number is the customer's OWN net savings
 *  or ABSENT (—) — never borrowed from the reference, never a fabricated 0. */
export async function VerdictHero({ usage }: { usage: UsageRollup[] }) {
  const t = await getTranslations("dashboard");
  const live = usage.length > 0;
  const baseline = usage.reduce((n, r) => n + r.baselineCost, 0);
  const actual = usage.reduce((n, r) => n + r.actualCost, 0);
  const net = baseline > 0 ? 1 - actual / baseline : 0;
  const saved = baseline - actual;

  return (
    <div className="verdict">
      <div>
        <p className="ck-eyebrow">{t("verdictHero.eyebrow")}</p>
        {live ? (
          <>
            <div className="big pos ck-num">{pct(net)}</div>
            <div className="cap">
              {t.rich("verdictHero.savedLine", {
                money: money(saved),
                b: (chunks) => <b>{chunks}</b>,
              })}
            </div>
          </>
        ) : (
          <>
            <div className="big empty ck-num">—</div>
            <div className="cap">
              {t("verdictHero.emptyCap")}
            </div>
          </>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "12px", alignItems: "flex-end" }}>
        <ProvenancePill kind={live ? "live" : "await"} />
        <div className="seg" aria-hidden>
          <button disabled>30d</button>
          <button disabled>90d</button>
          <button disabled>all</button>
        </div>
      </div>
    </div>
  );
}
