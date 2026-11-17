import { getTranslations } from "next-intl/server";

import { EmptyState } from "@/app/components/ui";

import type { UsageRollup } from "../data";
import { intfmt } from "../format";

/** Avoided-vs-ran split + per-model mix. Honest placeholder until metered —
 *  no invented model rows. */
export async function TrafficModelMix({ usage }: { usage: UsageRollup[] }) {
  const t = await getTranslations("dashboard");
  if (usage.length === 0) {
    return <EmptyState compacto sinCaja alInicio como="p" titulo={t("trafficModelMix.empty")} />;
  }
  const avoided = usage.reduce((n, r) => n + r.avoidedLlm, 0);
  const ran = usage.reduce((n, r) => n + r.actualLlm, 0);
  const total = avoided + ran || 1;
  const avoidedPct = (avoided / total) * 100;
  return (
    <div className="ox-mix">
      <p className="ox-k">{t("trafficModelMix.title")}</p>
      {/* Barra APILADA: evitadas (verde) + ejecutadas (neutro de baseline), que
          suman el 100%. A 0% evitadas la barra queda llena de neutro ("todo
          ejecutado, nada evitado aún") en vez de vacía y con aspecto de rota. */}
      <div className="ox-mix-bar" aria-hidden>
        <i className="win" style={{ width: `${avoidedPct}%` }} />
        <i style={{ width: `${100 - avoidedPct}%` }} />
      </div>
      <p className="ox-sub">
        {t("trafficModelMix.split", {
          avoided: intfmt(avoided),
          ran: intfmt(ran),
          pct: avoidedPct.toFixed(0),
        })}
      </p>
    </div>
  );
}
