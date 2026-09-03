import { getTranslations } from "next-intl/server";

import type { UsageRollup } from "../data";
import { deriveSombra } from "../derive";
import { intfmt, money, pct } from "../format";

/**
 * El carril SOMBRA de la elisión (S2, migración 0021): qué habría ahorrado la
 * política v0 con el mismo tráfico, calculado por el gateway SIN tocar un byte.
 *
 * Doctrina en dos reglas, y la tarjeta las dice en voz alta:
 *   · HIPOTÉTICO. Jamás se suma al titular ni entra en la comisión — por eso
 *     la cifra vive en su propia tarjeta y no en el VerdictHero.
 *   · Solo aparece cuando HAY datos de sombra (gateway con la bandera S2
 *     encendida). Sin datos, nada: una tarjeta vacía prometería una palanca
 *     que el cliente no tiene corriendo.
 *
 * Y puede salir en ROJO: una política puede perder dinero (la invalidación de
 * caché de prefijo se come el ahorro — v2 lo demostró en el replay). Este
 * carril existe exactamente para ver eso ANTES de encender nada.
 */
export async function SombraElisionCard({ usage }: { usage: UsageRollup[] }) {
  const sombra = deriveSombra(usage);
  if (sombra.kind !== "ok") return null;
  const t = await getTranslations("dashboard");

  return (
    <div className="card" style={{ padding: "16px" }}>
      <div className="n" style={{ marginBottom: "6px" }}>{t("sombraElision.title")}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: "12px", flexWrap: "wrap" }}>
        <div className={`big ${sombra.tone} ck-num`} style={{ fontSize: 28 }}>{pct(sombra.net)}</div>
        <div className="sub ck-num">
          {t("sombraElision.detalle", { usd: money(Math.abs(sombra.savedUsd)), requests: intfmt(sombra.requests) })}
        </div>
      </div>
      <div className="sub" style={{ marginTop: "8px" }}>
        {sombra.tone === "neg" ? t("sombraElision.notaNegativa") : t("sombraElision.nota")}
      </div>
      <div className="src" style={{ marginTop: "6px" }}>usage_daily · 0021 · basis: shadow</div>
    </div>
  );
}
