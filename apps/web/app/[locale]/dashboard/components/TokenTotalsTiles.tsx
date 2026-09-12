import { getTranslations } from "next-intl/server";

import type { UsageRollup } from "../data";
import { deriveTokens } from "../derive";
import { intfmt, pct } from "../format";

/**
 * Cuántos tokens has gastado y cuántos te hemos ahorrado.
 *
 * Es la pregunta más elemental que un cliente le hace a su panel, y hasta la
 * migración 0015 la base no la podía contestar: el SDK emitía siete contadores de
 * tokens por petición y `usage_daily` solo persistía tres. Los tres guardados son
 * ATRIBUCIÓN —por qué palanca se ahorró— y no suman el total: mezclarlos es
 * justo la cifra de vanidad que el producto se niega a publicar.
 *
 * TRES ESTADOS, Y LA DIFERENCIA ENTRE LOS DOS PRIMEROS ES LA QUE IMPORTA:
 *
 *   · no disponible — la base aún no trae los contadores. Se dice así. Pintar 0
 *     aquí le estaría afirmando a un cliente con tráfico real que no ahorró nada.
 *   · sin tráfico   — cero legítimo, y se pinta con la raya de los demás vacíos.
 *   · con cifras    — y el ahorro puede salir NEGATIVO, en cuyo caso va en rojo.
 *     Una reparación cuesta una segunda llamada completa cuya entrada NO entra en
 *     el baseline (por doctrina: `estimateCost` la descuenta para que el reintento
 *     no se pague a sí mismo), así que `actual > baseline` es un resultado posible
 *     y real. Se enseña.
 */
export async function TokenTotalsTiles({ usage }: { usage: UsageRollup[] }) {
  const t = await getTranslations("dashboard");
  const tok = deriveTokens(usage);

  if (tok.kind === "unavailable") {
    return (
      <div className="kpis">
        <div className="kpi">
          <div className="n">{t("tokenTotals.spentLabel")}</div>
          <div className="v empty ck-num">—</div>
          <div className="sub">{t("tokenTotals.unavailable")}</div>
        </div>
        <div className="kpi">
          <div className="n">{t("tokenTotals.savedLabel")}</div>
          <div className="v empty ck-num">—</div>
          <div className="sub">{t("tokenTotals.unavailable")}</div>
        </div>
      </div>
    );
  }

  const vacio = tok.kind === "empty";

  return (
    <>
      <div className="kpis">
        <div className="kpi">
          <div className="n">{t("tokenTotals.spentLabel")}</div>
          <div className={vacio ? "v empty ck-num" : "v ck-num"}>
            {vacio ? "—" : intfmt(tok.spent)}
          </div>
          <div className="sub">{t("tokenTotals.spentWhat")}</div>
        </div>

        <div className="kpi">
          <div className="n">{t("tokenTotals.savedLabel")}</div>
          <div className={vacio ? "v empty ck-num" : `v ${tok.tone} ck-num`}>
            {vacio ? "—" : intfmt(tok.saved)}
          </div>
          <div className="sub">
            {vacio
              ? t("tokenTotals.savedWhat")
              : t("tokenTotals.savedBreakdown", {
                  fraction: pct(tok.fraction),
                  input: intfmt(tok.savedInput),
                  output: intfmt(tok.savedOutput),
                })}
          </div>
        </div>
      </div>
      <p className="footnote">
        {t.rich("tokenTotals.footnote", { b: (chunks) => <b>{chunks}</b> })}
      </p>
    </>
  );
}
