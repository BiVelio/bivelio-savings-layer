import type { UsageRollup } from "../data";
import { pct, money } from "../format";
import { ProvenancePill } from "./ProvenancePill";

/** Two-state hero, SAME slot: the big number is the customer's OWN net savings
 *  or ABSENT (—) — never borrowed from the reference, never a fabricated 0. */
export function VerdictHero({ usage }: { usage: UsageRollup[] }) {
  const live = usage.length > 0;
  const baseline = usage.reduce((n, r) => n + r.baselineCost, 0);
  const actual = usage.reduce((n, r) => n + r.actualCost, 0);
  const net = baseline > 0 ? 1 - actual / baseline : 0;
  const saved = baseline - actual;

  return (
    <div className="verdict">
      <div>
        <p className="ck-eyebrow">Your savings · metered by the SDK</p>
        {live ? (
          <>
            <div className="big pos ck-num">{pct(net)}</div>
            <div className="cap">
              of your LLM spend kept this period · <b>{money(saved)}</b> saved (baseline − actual, at your prices).
            </div>
          </>
        ) : (
          <>
            <div className="big empty ck-num">—</div>
            <div className="cap">
              Not measuring your traffic yet — 0 requests seen. Install the SDK and your net savings appears
              here — your prices, your workload. Never a borrowed or fabricated number.
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
