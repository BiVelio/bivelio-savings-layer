import { getTranslations } from "next-intl/server";

import type { UsageRollup } from "../data";
import { money } from "../format";

/** Cumulative $ saved over time. Dashed skeleton until enough metered days
 *  exist — never a flat zero line implying $0 saved. (SVG, server-rendered.) */
export async function SavingsTrendChart({ usage }: { usage: UsageRollup[] }) {
  const t = await getTranslations("dashboard");
  if (usage.length < 2) {
    return <div className="skeleton">{t("savingsTrendChart.skeleton")}</div>;
  }
  const W = 640, H = 150, P = 8;
  let cum = 0;
  const pts = usage.map((r, i) => {
    cum += r.baselineCost - r.actualCost;
    return { x: (i / (usage.length - 1)) * (W - 2 * P) + P, saved: cum };
  });
  const max = Math.max(...pts.map((p) => p.saved), 1);
  const y = (v: number) => H - P - (v / max) * (H - 2 * P);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${y(p.saved).toFixed(1)}`).join(" ");
  const area = `${line} L${pts[pts.length - 1]!.x},${H - P} L${pts[0]!.x},${H - P} Z`;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={t("savingsTrendChart.chartAria")}>
        <path d={area} fill="color-mix(in srgb, var(--success) 14%, transparent)" />
        <path d={line} fill="none" stroke="var(--success)" strokeWidth="2" />
      </svg>
      <p className="ck-note">{t("savingsTrendChart.cumulativeNote", { money: money(cum), days: usage.length })}</p>
    </div>
  );
}
