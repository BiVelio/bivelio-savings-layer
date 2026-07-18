import type { CI } from "../data";
import { pct } from "../format";

/** The headline is the 95% CI LOWER bound (never the point estimate). */
export function NetSavingsCIBand({ savings, mode }: { savings: CI; mode: "LIVE" | "MOCK" }) {
  const dmin = Math.min(-0.05, savings.lower - 0.05);
  const dmax = Math.max(0.6, savings.upper + 0.05);
  const xp = (v: number) => Math.max(0, Math.min(100, ((v - dmin) / (dmax - dmin)) * 100));
  return (
    <div className="verdict" style={{ gridTemplateColumns: "minmax(220px,1fr) 1.3fr" }}>
      <div>
        <div className="big pos ck-num">≥ {pct(savings.lower)}</div>
        <div className="cap">
          net savings, <b>95% CI lower bound</b>. Point estimate {pct(savings.point)}, upper {pct(savings.upper)} —
          we headline the floor{mode === "MOCK" ? " (reference workload, mock provider)" : ""}.
        </div>
      </div>
      <div>
        <div className="ci-track2">
          <div className="ci-fill2" style={{ left: `${xp(savings.lower)}%`, width: `${xp(savings.upper) - xp(savings.lower)}%` }} />
          <div className="ci-zero2" style={{ left: `${xp(0)}%` }} />
          <div className="ci-lo" style={{ left: `${xp(savings.lower)}%` }} />
          <div className="ci-pt" style={{ left: `${xp(savings.point)}%` }} />
        </div>
        <div className="ci-legend2">
          <span>{pct(dmin)}</span>
          <span>0%</span>
          <span>{pct(dmax)}</span>
        </div>
      </div>
    </div>
  );
}
