import { getTranslations } from "next-intl/server";

import type { UsageRollup } from "../data";
import { deriveElisionProveedor } from "../derive";
import { intfmt } from "../format";

/**
 * El BORRADO DEL PROVEEDOR causado por nuestros diales (migración 0025): las
 * peticiones en las que el gateway cambió los diales de `context_management`
 * y el proveedor devolvió `applied_edits` (clear_tool_uses) — acreditadas.
 * NO se enseña el conteo de tokens: `eliminated_input_tokens` es una columna
 * COMPARTIDA (el SDK escribe ahí su libro 2 —ToolSelector y elisión local— y el
 * gateway el contador del proveedor), así que atribuirlo al proveedor mentiría
 * con un cliente del SDK. El grano por petición llega con B2.
 *
 * Doctrina, y la tarjeta la dice en voz alta:
 *   · SOLO EL CONTEO. El dólar suelo (precio de lectura de caché) se GUARDA en
 *     usage_daily.eliminated_floor_cost y viaja hasta aquí en `floorUsd`, pero
 *     NO SE PINTA: es el BRUTO del turno sin restar la invalidación de prefijo
 *     del mismo corte, y la evidencia congelada da opus-4-8 NETO negativo.
 *     Enseñar un dólar que la consola del cliente puede desmentir viola la
 *     doctrina del recibo. Se pintará cuando el NETO por modelo esté medido con
 *     el mecanismo real.
 *   · Jamás entra en el titular ni en la comisión (COMISIONAR_ELISION_SUELO).
 *   · Solo aparece con acreditadas > 0: sin ellas no hay tarjeta.
 */
export async function ElisionProveedorCard({ usage }: { usage: UsageRollup[] }) {
  const elision = deriveElisionProveedor(usage);
  if (elision.kind !== "ok") return null;
  const t = await getTranslations("dashboard");

  return (
    <div className="card elision-proveedor" style={{ padding: "16px" }}>
      <div className="n" style={{ marginBottom: "6px" }}>{t("elisionProveedor.title")}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: "12px", flexWrap: "wrap" }}>
        <div className="big ck-num" style={{ fontSize: 28 }}>{intfmt(elision.requests)}</div>
        <div className="sub ck-num">
          {t("elisionProveedor.detalle", { requests: intfmt(elision.requests) })}
        </div>
      </div>
      <div className="sub" style={{ marginTop: "8px" }}>{t("elisionProveedor.nota")}</div>
      <div className="src" style={{ marginTop: "6px" }}>usage_daily · 0025 · eliminated_credited_requests</div>
    </div>
  );
}
