import { getLocale, getTranslations } from "next-intl/server";

import { estadoVersion, type AsientoVisto } from "@/lib/version/aviso-version";

import { money } from "../format";

/**
 * Una fila por máquina que reporta uso (seat_activity, 0024): superficie,
 * versión declarada, última actividad, ahorro medido de 7 días y el chip de
 * versión. Solo aparece cuando HAY asientos: sin migración o sin tráfico, la
 * tarjeta no existe (misma regla que SesionesCard).
 *
 * Los ids de asiento son identidades OPACAS de máquina — jamás una persona. Los
 * asientos de CI (uno por job: hostnames efímeros) se agrupan en UNA fila para
 * que no entierren a las máquinas reales.
 *
 * El chip habla SOLO de la versión (al día / actualiza / parte sin declarar) y
 * nada del dinero: el dinero tiene su propia columna. Un SDK no lleva palanca de
 * tarifa, así que no se le pone chip.
 */
const MAX_FILAS = 12;

const sinPrefijo = (v: string) => v.replace(/^(gateway|sdk)\//, "");

export async function MaquinasCard({ asientos }: { asientos: AsientoVisto[] }) {
  if (asientos.length === 0) return null;
  const t = await getTranslations("dashboard.maquinas");
  const locale = await getLocale();
  // Fecha formateada en SERVIDOR y bajada como cadena (regla de
  // BillingStateBanner: formatear en los dos lados reabre la hidratación #418).
  const fmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
  const fecha = (iso: string) => (Number.isNaN(Date.parse(iso)) ? "—" : fmt.format(new Date(iso)));

  const maquinas = asientos.filter((a) => !a.isCi).slice(0, MAX_FILAS);
  const ci = asientos.filter((a) => a.isCi);
  const ciAhorro = ci.reduce((s, a) => s + a.ahorroMedido7dUsd, 0);

  const version = (a: AsientoVisto): string => {
    if (a.versionMin === null) return t("undeclared");
    if (a.versionMax !== null && a.versionMax !== a.versionMin) return `${sinPrefijo(a.versionMin)}–${sinPrefijo(a.versionMax)}`;
    return sinPrefijo(a.versionMin);
  };
  const chip = (a: AsientoVisto): { texto: string; color: string } | null => {
    if (a.surface === "sdk") return null;
    switch (estadoVersion(a)) {
      case "alDia":
        return { texto: t("chipOk"), color: "var(--ink-soft)" };
      case "desactualizada":
        return { texto: t("chipOutdated"), color: "var(--amber)" };
      case "desconocida":
        // Sin versión alguna la columna ya lo dice; el chip solo aporta cuando
        // hay versión Y algún registro de 7 días llegó sin ella.
        return a.versionMin === null ? null : { texto: t("chipMixed"), color: "var(--amber)" };
    }
  };

  const celda = { padding: "6px 8px" } as const;
  const mono = { fontFamily: "var(--mono)", fontSize: 12 } as const;

  return (
    <div className="card card-pad" id="maquinas">
      <div className="n" style={{ marginBottom: "10px" }}>{t("title")}</div>
      <div className="tbl-scroll">
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", opacity: 0.65 }}>
              <th style={{ padding: "4px 8px 4px 0", fontWeight: 500 }}>{t("colSeat")}</th>
              <th style={{ ...celda, fontWeight: 500 }}>{t("colSurface")}</th>
              <th style={{ ...celda, fontWeight: 500 }}>{t("colVersion")}</th>
              <th style={{ ...celda, fontWeight: 500 }}>{t("colState")}</th>
              <th style={{ ...celda, fontWeight: 500 }}>{t("colLastSeen")}</th>
              <th style={{ padding: "4px 0 4px 8px", fontWeight: 500, textAlign: "right" }}>{t("colSavings7d")}</th>
            </tr>
          </thead>
          <tbody>
            {maquinas.map((a) => {
              const c = chip(a);
              return (
                <tr key={a.seatId} style={{ borderTop: "1px solid var(--line)" }}>
                  <td style={{ padding: "6px 8px 6px 0", ...mono }}>{a.seatId.length > 14 ? `${a.seatId.slice(0, 10)}…` : a.seatId}</td>
                  <td style={celda}>{a.surface ?? "—"}</td>
                  <td style={{ ...celda, ...mono }}>{version(a)}</td>
                  <td style={celda}>{c ? <span style={{ color: c.color, fontSize: 12 }}>{c.texto}</span> : null}</td>
                  <td style={celda}>{fecha(a.lastSeenAt)}</td>
                  <td style={{ padding: "6px 0 6px 8px", textAlign: "right", ...mono }}>{money(a.ahorroMedido7dUsd)}</td>
                </tr>
              );
            })}
            {ci.length > 0 ? (
              <tr style={{ borderTop: "1px solid var(--line)", opacity: 0.75 }}>
                <td style={{ padding: "6px 8px 6px 0" }} colSpan={5}>{t("ciRow", { n: ci.length })}</td>
                <td style={{ padding: "6px 0 6px 8px", textAlign: "right", ...mono }}>{money(ciAhorro)}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <p className="ck-note" style={{ marginTop: 8, marginBottom: 0 }}>{t("hint")}</p>
    </div>
  );
}
