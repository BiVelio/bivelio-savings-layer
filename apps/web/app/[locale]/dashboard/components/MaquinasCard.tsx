import { getLocale, getTranslations } from "next-intl/server";

import { AlertIcon, MachinesIcon } from "@/app/components/icons";
import { EmptyState, EvidenceBadge } from "@/app/components/ui";
import { COMISIONAR_REFERENCIA } from "@/lib/billing/tarifa";
import { estadoVersion, type AsientoVisto } from "@/lib/version/aviso-version";

import { money } from "../format";

/**
 * Una fila por máquina que reporta uso (seat_activity, 0024): superficie,
 * versión declarada, última actividad, ahorro medido de 7 días y el chip de
 * versión.
 *
 * EL ANCLA `#maquinas` EXISTE SIEMPRE (2026-11). La entrada «Máquinas» del
 * raíl apunta aquí, y antes la tarjeta desaparecía sin asientos: el enlace no
 * llevaba a ninguna parte. Ahora, sin filas, la tarjeta se queda con su
 * estado vacío —o con el de lectura fallida, que no es lo mismo— y el destino
 * es estable. Cuando el cliente OCULTA la tarjeta, el ancla la pone
 * `PanelEditable` con la acción de volver a mostrarla.
 *
 * El ahorro de la columna es de 7 DÍAS y así se rotula: no es «del periodo»
 * del titular, que mira 30, 90 o 120.
 *
 * Los ids de asiento son identidades OPACAS de máquina — jamás una persona. Los
 * asientos de CI (uno por job: hostnames efímeros) se agrupan en UNA fila para
 * que no entierren a las máquinas reales.
 *
 * El chip habla SOLO de la versión (al día / actualiza / parte sin declarar) y
 * nada del dinero: el dinero tiene su propia columna. Un SDK no lleva palanca de
 * tarifa, así que no se le pone chip.
 *
 * La columna de dinero es lo MEDIDO de 7 días con la regla del titular: lo de
 * la propia petición más lo medido por referencia (0031) cuando
 * COMISIONAR_REFERENCIA lo comisiona. Si alguna máquina tiene referencia en la
 * semana, una nota lo dice: que nadie lea esa cifra como solo contador propio.
 */
const MAX_FILAS = 12;

const sinPrefijo = (v: string) => v.replace(/^(gateway|sdk)\//, "");

export async function MaquinasCard({ asientos, fallo = false }: { asientos: AsientoVisto[]; /** La lectura de asientos falló: no es «sin máquinas». */ fallo?: boolean }) {
  const t = await getTranslations("dashboard.maquinas");
  const u = await getTranslations("ui");
  if (asientos.length === 0) {
    return (
      <div className="card card-pad" id="maquinas">
        <div className="n card-title">{t("title")}</div>
        {fallo ? (
          <EmptyState compacto como="p" icono={<AlertIcon />} titulo={t("failedTitle")} texto={t("failedBody")} />
        ) : (
          <EmptyState
            compacto
            como="p"
            icono={<MachinesIcon />}
            titulo={t("emptyTitle")}
            texto={t("emptyBody")}
            acciones={
              <a className="btn btn-ghost btn-sm" href="/dashboard/install#gateway">
                {t("emptyCta")}
              </a>
            }
          />
        )}
      </div>
    );
  }
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
        return { texto: t("chipOutdated"), color: "var(--warn)" };
      case "desconocida":
        // Sin versión alguna la columna ya lo dice; el chip solo aporta cuando
        // hay versión Y algún registro de 7 días llegó sin ella.
        return a.versionMin === null ? null : { texto: t("chipMixed"), color: "var(--warn)" };
    }
  };

  return (
    <div className="card card-pad" id="maquinas">
      <div className="card-head">
        <div className="n">{t("title")}</div>
        <EvidenceBadge tipo="tus-datos" label={u("evidence.tusDatos")} pequeno />
      </div>
      <div className="tbl-scroll">
        <table className="dt">
          <thead>
            <tr>
              <th scope="col">{t("colSeat")}</th>
              <th scope="col">{t("colSurface")}</th>
              <th scope="col">{t("colVersion")}</th>
              <th scope="col">{t("colState")}</th>
              <th scope="col">{t("colLastSeen")}</th>
              <th scope="col" className="dt-num">{t("colSavings7d")}</th>
            </tr>
          </thead>
          <tbody>
            {maquinas.map((a) => {
              const c = chip(a);
              return (
                <tr key={a.seatId}>
                  <td className="dt-mono">{a.seatId.length > 14 ? `${a.seatId.slice(0, 10)}…` : a.seatId}</td>
                  <td>{a.surface ?? "—"}</td>
                  <td className="dt-mono">{version(a)}</td>
                  <td>{c ? <span className="dt-chip" style={{ color: c.color }}>{c.texto}</span> : null}</td>
                  <td>{fecha(a.lastSeenAt)}</td>
                  <td className="dt-num dt-mono">{money(a.ahorroMedido7dUsd)}</td>
                </tr>
              );
            })}
            {ci.length > 0 ? (
              <tr className="dt-soft">
                <td colSpan={5}>{t("ciRow", { n: ci.length })}</td>
                <td className="dt-num dt-mono">{money(ciAhorro)}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <p className="ck-note" style={{ marginTop: 8, marginBottom: 0 }}>{t("hint")}</p>
      {COMISIONAR_REFERENCIA && asientos.some((a) => a.ahorroReferencia7dUsd > 0) ? (
        <p className="ck-note" style={{ marginTop: 6, marginBottom: 0 }}>{t("referenceHint")}</p>
      ) : null}
    </div>
  );
}
