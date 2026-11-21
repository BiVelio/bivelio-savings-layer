import { getTranslations } from "next-intl/server";

import { LIMITES_MEDIR } from "@/lib/license/medir";

import type { UsageRollup } from "../data";
import { intfmt, money } from "../format";
import { ahorroEnSombra, ahorroRealDeMedir } from "../medir";

/**
 * LA TARJETA DE LA LICENCIA GRATUITA MEDIR.
 *
 * Solo se pinta para una organización `solo-medir`. Desde la 1.2.4 Medir aplica
 * las palancas, así que lo primero que enseña es el AHORRO REAL: lo medido con
 * el contador del proveedor y, aparte, lo estimado (las llamadas evitadas).
 *
 * «Esto habrías ahorrado» —el carril SOMBRA (shadow_*)— se enseña SOLO si hay
 * registros de sombra: los mandan los clientes ≤ 1.2.3 (que con Medir siguen en
 * sombra hasta actualizar) y quien enciende la sombra opcional. HIPOTÉTICO: va
 * con su etiqueta y jamás se suma a lo real.
 *
 * Nada de esta tarjeta se factura: Medir no lleva comisión.
 */
export async function MedirSavingsCard({ usage }: { usage: UsageRollup[] }) {
  const t = await getTranslations("dashboard.measurePlan");
  const s = ahorroEnSombra(usage);
  const real = ahorroRealDeMedir(usage);
  const haySombra = s.habriasAhorradoUsd != null && s.habriasAhorradoUsd > 0;
  return (
    <section className="card card-pad" data-testid="medir-savings-card">
      <p className="eyebrow">{t("card.eyebrow")}</p>
      <div className="n card-title">{t("card.title")}</div>
      {real.hay ? (
        <div data-testid="medir-ahorro-real">
          {real.medidoUsd >= 0.00005 ? <h3 className="t-section">{t("card.realMeasured", { amount: money(real.medidoUsd) })}</h3> : null}
          {real.estimadoUsd >= 0.00005 ? (
            <h3 className="t-section">{t("card.realEstimated", { amount: money(real.estimadoUsd) })}</h3>
          ) : null}
          <p className="ck-note">{t("card.realContext", { spend: money(s.gastoUsd), requests: intfmt(s.peticiones) })}</p>
        </div>
      ) : null}
      {haySombra ? (
        <div data-testid="medir-ahorro-sombra">
          <div className="n card-title">{t("card.shadowTitle")}</div>
          <h3 className="t-section">{t("card.amount", { amount: money(s.habriasAhorradoUsd ?? 0) })}</h3>
          <p className="ck-note">{t("card.context", { spend: money(s.gastoUsd), requests: intfmt(s.peticiones) })}</p>
        </div>
      ) : null}
      {!real.hay && !haySombra ? <p className="ck-note">{t("card.empty")}</p> : null}
      <p className="ck-note">
        {t("card.limits", { seats: LIMITES_MEDIR.asientos, requests: intfmt(LIMITES_MEDIR.peticionesDiarias) })}
      </p>
      <a className="btn btn-primary" href="/dashboard/account" style={{ display: "inline-block", marginTop: 8 }}>
        {t("card.cta")}
      </a>
    </section>
  );
}
