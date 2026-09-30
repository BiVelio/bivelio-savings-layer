import { getTranslations } from "next-intl/server";

import type { ModelDia, UsageRollup } from "../data";
import { deriveAhorroNativo } from "../derive";
import { intfmt, money, moneySigned } from "../format";

/**
 * «AHORRO NATIVO ACTIVADO» (migración 0032): lo que la caché de prefijo DEL
 * PROVEEDOR le quitó a la factura del período (Anthropic con `cache_control`,
 * OpenAI automática, Gemini implícita), neto de la prima de escritura que el
 * proveedor cobró. Decisión del dueño: «mostrar el ahorro de la caché de prefijo
 * del proveedor aparte, sin comisión».
 *
 * Doctrina, y la tarjeta la dice en voz alta:
 *   · APARTE del ahorro acreditado. El titular (VerdictHero) no lo suma, el
 *     extracto no lo lee y la comisión no lo ve: el descuento lo factura el
 *     proveedor. Está aquí para que lo que el cliente ve cuadre con su factura.
 *   · El NETO puede ser negativo (escrituras en frío que nadie leyó) y se pinta
 *     tal cual, con sus dos piezas al lado para que la resta se vea.
 *   · Sin columnas (proyecto por detrás de 0032) o sin caché: no hay tarjeta.
 */
export async function AhorroNativoCard({ usage, porModelo }: { usage: UsageRollup[]; porModelo: ModelDia[] }) {
  const nativo = deriveAhorroNativo(usage, porModelo);
  const t = await getTranslations("dashboard");
  if (nativo.kind !== "ok") {
    return (
      <div className="card card-pad">
        <div className="n card-title">{t("ahorroNativo.title")}</div>
        <div className="sub">{t("ahorroNativo.vacio")}</div>
      </div>
    );
  }
  const tono = nativo.net >= 0 ? "pos" : "neg";
  return (
    <div className="card card-pad">
      <div className="n card-title">{t("ahorroNativo.title")}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: "12px", flexWrap: "wrap" }}>
        <div className={`big ck-num ${tono}`} style={{ fontSize: 28 }}>{moneySigned(nativo.net)}</div>
        <div className="sub ck-num">
          {t("ahorroNativo.detalle", {
            requests: intfmt(nativo.requests),
            lectura: money(nativo.readUsd),
            prima: money(nativo.premiumUsd),
          })}
        </div>
      </div>
      {nativo.byProvider.length > 0 ? (
        <div className="sub ck-num" style={{ marginTop: "6px" }}>
          {nativo.byProvider
            .map((p) => `${t(`ahorroNativo.proveedor.${p.provider}`)} ${moneySigned(p.net)}`)
            .join(" · ")}
        </div>
      ) : null}
      <div className="sub" style={{ marginTop: "8px" }}>{t("ahorroNativo.nota")}</div>
      <div className="src" style={{ marginTop: "6px" }}>usage_daily · 0032 · native_cache_read_savings − native_cache_write_premium</div>
    </div>
  );
}
