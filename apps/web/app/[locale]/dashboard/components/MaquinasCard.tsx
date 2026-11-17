import { getLocale, getTranslations } from "next-intl/server";

import { AlertIcon, MachinesIcon } from "@/app/components/icons";
import { EmptyState, EvidenceBadge } from "@/app/components/ui";
import { COMISIONAR_REFERENCIA } from "@/lib/billing/tarifa";
import { Badge, type BadgeTone } from "@/vendor/affectui/badge-clean";
import { DataTable } from "@/vendor/affectui/data-table-clean";
import { Tooltip } from "@/vendor/affectui/tooltip-clean";
import { UsageMeter } from "@/vendor/affectui/usage-meter";
import { estadoVersion, type AsientoVisto } from "@/lib/version/aviso-version";

import { money, pct0Floor } from "../format";

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
 *
 * «ESPECTACULAR» 2026-11 — tres piezas de affectUI, y ninguna editable:
 *  · Data Table en SOLO LECTURA: se ordena por columna (id, superficie, última
 *    actividad, ahorro) y nada más. Sin celdas que parezcan editables.
 *  · Usage Meter reducido a ASIENTOS: en uso frente a pagados, la misma
 *    lectura del raíl (`medirAsientos` + `ctx.seats`). Sin esa lectura, sin
 *    plan activo o con cero en uso no hay medidor: no se pinta un «0 de N» ni
 *    un «N de M pagados» a quien no paga. No hay créditos ni cuotas que enseñar.
 *  · Tooltip con el id entero cuando la celda lo recorta, y Badge para el
 *    estado de versión (con palabras, además del tono).
 */
const MAX_FILAS = 12;

const sinPrefijo = (v: string) => v.replace(/^(gateway|sdk)\//, "");

export async function MaquinasCard({
  asientos,
  fallo = false,
  seats,
}: {
  asientos: AsientoVisto[];
  /** La lectura de asientos falló: no es «sin máquinas». */
  fallo?: boolean;
  /** Asientos en uso y pagados este mes. Sin lectura, sin plan activo o con uso
   *  cero (días 1 y 2 del mes), `undefined`: no hay medidor. Lo decide la página. */
  seats?: { used: number; seats: number; /** Se rotó una clave este mes: el recuento puede venir inflado. */ rotated?: boolean };
}) {
  const t = await getTranslations("dashboard.maquinas");
  const u = await getTranslations("ui");
  if (asientos.length === 0) {
    return (
      <div className="card card-pad ox-card" id="maquinas">
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
  const chip = (a: AsientoVisto): { texto: string; tono: BadgeTone } | null => {
    if (a.surface === "sdk") return null;
    switch (estadoVersion(a)) {
      case "alDia":
        return { texto: t("chipOk"), tono: "success" };
      case "desactualizada":
        return { texto: t("chipOutdated"), tono: "warning" };
      case "desconocida":
        // Sin versión alguna la columna ya lo dice; el chip solo aporta cuando
        // hay versión Y algún registro de 7 días llegó sin ella.
        return a.versionMin === null ? null : { texto: t("chipMixed"), tono: "warning" };
    }
  };
  const p = await getTranslations("dashboard.panel");
  // Usar todos los asientos pagados no es un error (aviso); pasarse sí se marca.
  const estadoAsientos = !seats ? "ok" : seats.used > seats.seats ? "over" : seats.used === seats.seats ? "full" : "ok";

  return (
    <div className="card card-pad ox-card" id="maquinas">
      <div className="card-head">
        <div className="n">{t("title")}</div>
        <EvidenceBadge tipo="tus-datos" label={u("evidence.tusDatos")} pequeno />
      </div>
      {seats && seats.seats > 0 && seats.used > 0 ? (
        <UsageMeter
          className="ox-seats"
          size="sm"
          headingAs="p"
          title={t("seatsTitle")}
          used={seats.used}
          limit={seats.seats}
          figure={String(seats.used)}
          figureLabel={t("seatsOf", { seats: seats.seats })}
          share={pct0Floor(Math.min(1, seats.used / seats.seats))}
          state={estadoAsientos}
          stateLabel={seats.used > seats.seats ? t("seatsOver") : t("seatsFull")}
          note={seats.rotated ? `${t("seatsNote")} ${t("seatsRotated")}` : t("seatsNote")}
        />
      ) : null}
      <DataTable
        flat
        pinFirst
        label={t("title")}
        sortLabel={p("sortBy", { column: "{column}" })}
        minWidth="620px"
        columns={[
          { key: "seat", label: t("colSeat"), mono: true, nowrap: true, sortable: true },
          { key: "surface", label: t("colSurface"), sortable: true },
          { key: "version", label: t("colVersion"), mono: true, nowrap: true },
          { key: "state", label: t("colState") },
          { key: "last", label: t("colLastSeen"), nowrap: true, sortable: true },
          { key: "saved", label: t("colSavings7d"), align: "end", mono: true, sortable: true },
        ]}
        rows={maquinas.map((a) => {
          const c = chip(a);
          const corto = a.seatId.length > 14;
          const visto = Date.parse(a.lastSeenAt);
          return {
            id: a.seatId,
            // Un dato que falta ordena SIEMPRE al final (null), nunca como cero.
            sort: { seat: a.seatId, surface: a.surface ?? null, last: Number.isNaN(visto) ? null : visto, saved: a.ahorroMedido7dUsd },
            quiet: [...(a.surface ? [] : ["surface"]), ...(a.versionMin === null ? ["version"] : [])],
            cells: {
              seat: corto ? (
                <Tooltip content={a.seatId} toggleOnClick delay={200} align="start">
                  <button type="button" className="ox-id">{`${a.seatId.slice(0, 10)}…`}</button>
                </Tooltip>
              ) : (
                a.seatId
              ),
              surface: a.surface ?? "—",
              version: version(a),
              state: c ? <Badge tone={c.tono} dot>{c.texto}</Badge> : null,
              last: fecha(a.lastSeenAt),
              saved: money(a.ahorroMedido7dUsd),
            },
          };
        })}
        summary={ci.length > 0 ? { label: t("ciRow", { n: ci.length }), value: money(ciAhorro) } : undefined}
      />
      <p className="ck-note ox-foot">{t("hint")}</p>
      {COMISIONAR_REFERENCIA && asientos.some((a) => a.ahorroReferencia7dUsd > 0) ? (
        <p className="ck-note ox-foot">{t("referenceHint")}</p>
      ) : null}
    </div>
  );
}
