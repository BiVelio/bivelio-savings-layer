import type { UsageRollup } from "../data";
import { intfmt } from "../format";

/** Avoided-vs-ran split + per-model mix. Honest placeholder until metered —
 *  no invented model rows. */
export function TrafficModelMix({ usage }: { usage: UsageRollup[] }) {
  if (usage.length === 0) {
    return (
      <div className="skeleton" style={{ height: "90px" }}>
        No requests metered yet — your avoided-vs-ran split and per-model mix appear once the SDK reports.
      </div>
    );
  }
  const avoided = usage.reduce((n, r) => n + r.avoidedLlm, 0);
  const ran = usage.reduce((n, r) => n + r.actualLlm, 0);
  const total = avoided + ran || 1;
  return (
    <div className="kpi" style={{ minHeight: "auto" }}>
      <div className="n">llm calls · avoided vs ran</div>
      <div className="track2" style={{ height: "16px", marginTop: "10px" }}>
        <div className="fill2 win" style={{ width: `${(avoided / total) * 100}%` }} />
      </div>
      <div className="ck-note">
        {intfmt(avoided)} avoided · {intfmt(ran)} ran ({((avoided / total) * 100).toFixed(0)}% avoided)
      </div>
    </div>
  );
}
