import { getTranslations } from "next-intl/server";

import type { UsageRollup } from "../data";
import { intfmt } from "../format";

/** Avoided-vs-ran split + per-model mix. Honest placeholder until metered —
 *  no invented model rows. */
export async function TrafficModelMix({ usage }: { usage: UsageRollup[] }) {
  const t = await getTranslations("dashboard");
  if (usage.length === 0) {
    return (
      <div className="skeleton" style={{ height: "90px" }}>
        {t("trafficModelMix.empty")}
      </div>
    );
  }
  const avoided = usage.reduce((n, r) => n + r.avoidedLlm, 0);
  const ran = usage.reduce((n, r) => n + r.actualLlm, 0);
  const total = avoided + ran || 1;
  const avoidedPct = (avoided / total) * 100;
  return (
    <div className="kpi" style={{ minHeight: "auto" }}>
      <div className="n">{t("trafficModelMix.title")}</div>
      {/* Barra APILADA: evitadas (verde) + ejecutadas (neutro de baseline), que
          suman el 100%. A 0% evitadas la barra queda llena de neutro ("todo
          ejecutado, nada evitado aún") en vez de vacía y con aspecto de rota. */}
      <div className="track2" style={{ height: "16px", marginTop: "10px", display: "flex" }}>
        <div className="fill2 win" style={{ width: `${avoidedPct}%`, borderRadius: 0 }} />
        <div className="fill2" style={{ width: `${100 - avoidedPct}%`, borderRadius: 0 }} />
      </div>
      <div className="ck-note">
        {t("trafficModelMix.split", {
          avoided: intfmt(avoided),
          ran: intfmt(ran),
          pct: avoidedPct.toFixed(0),
        })}
      </div>
    </div>
  );
}
