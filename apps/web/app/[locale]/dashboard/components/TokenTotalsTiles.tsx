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

  const titulo = <div className="n card-title">{t("panel.cards.tokens")}</div>;

  if (tok.kind === "unavailable") {
    return (
      <div className="card card-pad ox-card">
        {titulo}
        <dl className="ox-tiles two">
          <div>
            <dt>{t("tokenTotals.spentLabel")}</dt>
            <dd className="empty">—</dd>
            <dd className="ox-what">{t("tokenTotals.unavailable")}</dd>
          </div>
          <div>
            <dt>{t("tokenTotals.savedLabel")}</dt>
            <dd className="empty">—</dd>
            <dd className="ox-what">{t("tokenTotals.unavailable")}</dd>
          </div>
        </dl>
      </div>
    );
  }

  const vacio = tok.kind === "empty";
  // La parte ahorrada frente a lo que habría entrado sin la capa: solo se
  // dibuja con una fracción legible entre 0 y 1; fuera de ahí, la cifra basta.
  const parte = !vacio && tok.fraction > 0 && tok.fraction <= 1 ? tok.fraction : null;

  return (
    <div className="card card-pad ox-card">
      {titulo}
      <dl className="ox-tiles two">
        <div>
          <dt>{t("tokenTotals.spentLabel")}</dt>
          <dd className={vacio ? "empty" : undefined}>{vacio ? "—" : intfmt(tok.spent)}</dd>
          <dd className="ox-what">{t("tokenTotals.spentWhat")}</dd>
        </div>
        <div>
          <dt>{t("tokenTotals.savedLabel")}</dt>
          <dd className={vacio ? "empty" : tok.tone}>{vacio ? "—" : intfmt(tok.saved)}</dd>
          <dd className="ox-what">
            {vacio
              ? t("tokenTotals.savedWhat")
              : t("tokenTotals.savedBreakdown", {
                  fraction: pct(tok.fraction),
                  input: intfmt(tok.savedInput),
                  output: intfmt(tok.savedOutput),
                })}
          </dd>
          {parte !== null ? (
            <dd className="ox-part" aria-hidden>
              <i style={{ width: `${Math.max(2, parte * 100)}%` }} />
            </dd>
          ) : null}
        </div>
      </dl>
      {/* Sin tráfico no hay nada que explicar: la nota sobre el ahorro de salida
          y los totales negativos habla de cifras que aún no existen. */}
      {vacio ? null : (
        <p className="ck-note ox-foot">
          {t.rich("tokenTotals.footnote", { b: (chunks) => <b>{chunks}</b> })}
        </p>
      )}
    </div>
  );
}
