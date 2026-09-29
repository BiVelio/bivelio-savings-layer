import { getTranslations } from "next-intl/server";

import { LIMITES_MEDIR } from "@/lib/license/medir";

import type { UsageRollup } from "../data";
import { intfmt, money } from "../format";
import { ahorroEnSombra } from "../medir";

/**
 * «ESTO HABRÍAS AHORRADO» — la tarjeta de la licencia gratuita Medir.
 *
 * Solo se pinta para una organización `solo-medir`. La cifra es el carril
 * SOMBRA (shadow_*): lo que la caché exacta y la coalescencia habrían evitado,
 * valorado con el contador del propio proveedor de cada llamada. HIPOTÉTICA: va
 * con su etiqueta, junto al gasto real que sí se midió, y jamás se suma a nada
 * medido ni entra en un extracto. Debajo, el CTA a pago: es donde se encienden
 * las palancas.
 */
export async function MedirSavingsCard({ usage }: { usage: UsageRollup[] }) {
  const t = await getTranslations("dashboard.measurePlan");
  const s = ahorroEnSombra(usage);
  return (
    <section className="card card-pad" data-testid="medir-savings-card">
      <p className="eyebrow">{t("card.eyebrow")}</p>
      <div className="n card-title">{t("card.title")}</div>
      {s.habriasAhorradoUsd != null && s.habriasAhorradoUsd > 0 ? (
        <>
          <h3 className="t-section">{t("card.amount", { amount: money(s.habriasAhorradoUsd) })}</h3>
          <p className="ck-note">
            {t("card.context", { spend: money(s.gastoUsd), requests: intfmt(s.peticiones) })}
          </p>
        </>
      ) : (
        <p className="ck-note">{t("card.empty")}</p>
      )}
      <p className="ck-note">
        {t("card.limits", { seats: LIMITES_MEDIR.asientos, requests: intfmt(LIMITES_MEDIR.peticionesDiarias) })}
      </p>
      <a className="btn btn-primary" href="/dashboard/account" style={{ display: "inline-block", marginTop: 8 }}>
        {t("card.cta")}
      </a>
    </section>
  );
}
