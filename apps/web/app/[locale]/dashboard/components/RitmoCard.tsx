import { getLocale, getTranslations } from "next-intl/server";

import { esPeriodoDeCalibracion, FX_SOMBRA, periodoDe } from "@/lib/billing/extracto-sombra";
import { calcularRitmo, DIAS_MINIMOS_PARA_PROYECTAR, VENTANA_RITMO_DIAS } from "@/lib/billing/ritmo";

import type { UsageRollup } from "../data";
import { money } from "../format";

/**
 * RITMO Y PROYECCIÓN — «¿a cuánto voy y en cuánto acabo el mes?».
 *
 * El panel sabía decir cuánto llevas ahorrado; no sabía decir a qué velocidad
 * ni dónde acaba. Esta tarjeta lo dice, con la línea que separa las dos cosas
 * dibujada a la vista:
 *
 *   · lo MEDIDO va sin adornos — es la misma base que el extracto;
 *   · lo PROYECTADO lleva su etiqueta de estimación y su aritmética escrita
 *     debajo («medido + ritmo de N días × días que quedan»), para que quien
 *     mire pueda rehacerla de cabeza.
 *
 * Y calla cuando no sabe: sin días completos suficientes no se pinta una recta
 * (`pocos_dias`), y sin una sola fila medida la tarjeta no existe.
 */
export async function RitmoCard({ usage }: { usage: UsageRollup[] }) {
  const periodo = periodoDe(new Date());
  const r = calcularRitmo({
    rows: usage,
    periodo,
    hoyIso: new Date().toISOString().slice(0, 10),
    eurPorUsd: FX_SOMBRA.eurPorUsd,
  });
  if (r.estado === "sin_datos") return null;

  const t = await getTranslations("dashboard");
  const locale = await getLocale();
  // EUR con el locale (igual que el extracto); USD con `money`, el formateador
  // determinista del cockpit — `toLocaleString` sin locale fijo ya rompió una
  // hidratación aquí (ver format.ts).
  const eur = (n: number) => n.toLocaleString(locale, { style: "currency", currency: "EUR" });
  const pct = (n: number) => (n * 100).toFixed(1) + "%";
  const enCalibracion = esPeriodoDeCalibracion(usage, periodo);
  const p = r.proyeccion;

  return (
    <div className="card ritmo" style={{ padding: "16px" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}>
        <div className="n">{t("ritmo.title")}</div>
        <span className="est-tag">{p ? t("ritmo.badgeEstimacion") : t("ritmo.badgeMedido")}</span>
      </div>

      {p ? (
        <>
          <div style={{ marginTop: "10px" }}>
            <div className="sub">{t("ritmo.proyeccionTitulo", { periodo })}</div>
            <div className={`big ${p.ahorroEur >= 0 ? "pos" : "neg"} ck-num`}>
              {eur(p.ahorroEur)}
            </div>
            <div className="sub">
              {t("ritmo.proyeccionNota", { dias: VENTANA_RITMO_DIAS, restantes: r.diasRestantes })}
            </div>
          </div>
          <div className="sub" style={{ marginTop: "10px" }}>
            {t("ritmo.comision")}: <span className="ck-num">{eur(p.comision.comisionEur)}</span>
            {" — "}
            {enCalibracion
              ? t("ritmo.comisionCalibracion")
              : t("ritmo.comisionNota", { pct: pct(p.comision.ratio) })}
          </div>
        </>
      ) : (
        <p className="ck-note" style={{ marginTop: "10px" }}>
          {r.estado === "cerrado"
            ? t("ritmo.cerrado")
            : t("ritmo.pocosDias", { min: DIAS_MINIMOS_PARA_PROYECTAR, n: r.diasDeRitmo })}
        </p>
      )}

      {/* La barra del mes: cuánta pista queda es la mitad de la pregunta. */}
      <div
        aria-hidden
        style={{
          marginTop: "12px",
          height: "6px",
          borderRadius: "3px",
          background: "var(--line, rgba(0,0,0,.10))",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${Math.round((r.diasTranscurridos / r.diasDelPeriodo) * 100)}%`,
            height: "100%",
            background: "var(--brand)",
          }}
        />
      </div>

      <div className="hiw-two" style={{ marginTop: "12px" }}>
        <div className="hiw-mcard">
          <span className="k">{t("ritmo.medido")}</span>
          <div className="v real ck-num">{money(r.ahorroHastaLaFechaUsd)}</div>
          <p>{t("ritmo.diaDeMes", { n: r.diasTranscurridos, total: r.diasDelPeriodo })}</p>
        </div>
        <div className="hiw-mcard">
          <span className="k">{t("ritmo.ritmoLabel", { dias: VENTANA_RITMO_DIAS })}</span>
          <div className="v ck-num">{t("ritmo.porDia", { importe: money(r.ahorroPorDiaRecienteUsd) })}</div>
          <p>{t("ritmo.diasRestantes", { n: r.diasRestantes })}</p>
        </div>
      </div>

      <div className="src" style={{ marginTop: "8px" }}>usage_daily · measured · {r.diasDeRitmo}d</div>
    </div>
  );
}
