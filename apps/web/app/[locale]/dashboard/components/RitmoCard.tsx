import { getLocale, getTranslations } from "next-intl/server";

import { esPeriodoDeCalibracion, FX_SOMBRA, periodoDe } from "@/lib/billing/extracto-sombra";
import { calcularRitmo, DIAS_MINIMOS_PARA_PROYECTAR, VENTANA_RITMO_DIAS } from "@/lib/billing/ritmo";

import { Badge } from "@/vendor/affectui/badge-clean";

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

  const avance = Math.round((r.diasTranscurridos / r.diasDelPeriodo) * 100);

  return (
    <div className="card card-pad ox-card ritmo">
      <div className="card-head">
        <div className="n">{t("ritmo.title")}</div>
        <Badge tone={p ? "warning" : "success"} dot>{p ? t("ritmo.badgeEstimacion") : t("ritmo.badgeMedido")}</Badge>
      </div>

      <div className="ox-ritmo">
        <div className="ox-ritmo-main">
          {p ? (
            <>
              <p className="ox-k">{t("ritmo.proyeccionTitulo", { periodo })}</p>
              <p className={`ox-fig ${p.ahorroEur >= 0 ? "pos" : "neg"}`}>{eur(p.ahorroEur)}</p>
              <p className="ox-sub">{t("ritmo.proyeccionNota", { dias: VENTANA_RITMO_DIAS, restantes: r.diasRestantes })}</p>
            </>
          ) : (
            <p className="ox-sub">
              {r.estado === "cerrado"
                ? t("ritmo.cerrado")
                : t("ritmo.pocosDias", { min: DIAS_MINIMOS_PARA_PROYECTAR, n: r.diasDeRitmo })}
            </p>
          )}
          {/* La barra del mes: cuánta pista queda es la mitad de la pregunta. */}
          <div className="ox-month">
            <div className="ox-month-track" aria-hidden>
              <i style={{ width: `${avance}%` }} />
            </div>
            <div className="ox-month-legend">
              <span>{t("ritmo.diaDeMes", { n: r.diasTranscurridos, total: r.diasDelPeriodo })}</span>
              <span>{t("ritmo.diasRestantes", { n: r.diasRestantes })}</span>
            </div>
          </div>
        </div>
        <dl className="ox-stats">
          <div>
            <dt>{t("ritmo.medido")}</dt>
            <dd className="pos">{money(r.ahorroHastaLaFechaUsd)}</dd>
          </div>
          <div>
            <dt>{t("ritmo.ritmoLabel", { dias: VENTANA_RITMO_DIAS })}</dt>
            <dd>{t("ritmo.porDia", { importe: money(r.ahorroPorDiaRecienteUsd) })}</dd>
          </div>
        </dl>
      </div>

      {p ? (
        <p className="ck-note ox-foot">
          {t("ritmo.comision")}: <span className="ox-mono">{eur(p.comision.comisionEur)}</span>
          {" — "}
          {enCalibracion ? t("ritmo.comisionCalibracion") : t("ritmo.comisionNota", { pct: pct(p.comision.ratio) })}
        </p>
      ) : null}
    </div>
  );
}
