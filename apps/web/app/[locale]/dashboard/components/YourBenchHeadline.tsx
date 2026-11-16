import type { ReactNode } from "react";
import { getLocale, getTranslations } from "next-intl/server";

import { Termino } from "@/app/components/evidencia/Termino";
import { EvidenceBadge } from "@/app/components/ui";
import { ExperimentReadout } from "@/vendor/affectui/experiment-readout";

import { NIVEL, POR_CADA, type InformeDelBancoPropio } from "@/lib/verificacion/banco-propio";
import { intfmt, moneySigned, pct, pct0, pct0Floor, pctFloor } from "../format";

/**
 * EL TITULAR DE «TU PROPIO BANCO»: el SUELO del IC de la fracción ahorrada
 * (nunca la estimación puntual), con las mismas clases que la banda del banco
 * publicado. Justo debajo, la diferencia media por cada mil peticiones con su
 * intervalo, la base (pares, cobertura, tasa lograda) y, si se calculó sobre un
 * subconjunto, que lo diga.
 *
 * El pie dice SOBRE QUÉ habla la cifra: los pares que de verdad entran en el
 * cálculo (no los leídos) y, si algún grupo de peticiones elegibles no tiene
 * ningún par, que la cifra no lo abarca y qué parte sí. El suelo se pinta
 * redondeado HACIA ABAJO y la cobertura también: una cifra de suelo que sube
 * al pintarse deja de ser un suelo.
 */
export async function YourBenchHeadline({
  informe,
  desde,
  hasta,
}: {
  informe: InformeDelBancoPropio;
  /** La ventana UTC del informe (YYYY-MM-DD), para decir de QUÉ periodo es la cifra. */
  desde?: string;
  hasta?: string;
}) {
  const t = await getTranslations("dashboard");
  const tu = await getTranslations("ui");
  const locale = await getLocale();
  const f = informe.titular!.fraccion;
  const d = informe.titular!.diferencia;
  const dmin = Math.min(-0.05, f.lower - 0.05);
  const dmax = Math.max(0.6, f.upper + 0.05);
  const xp = (v: number) => Math.max(0, Math.min(100, ((v - dmin) / (dmax - dmin)) * 100));
  const nivel = pct0(NIVEL);
  const completa = informe.cobertura >= 1;
  const pie = {
    b: (chunks: ReactNode) => <b>{chunks}</b>,
    pairs: intfmt(informe.paresEnTitular),
    level: nivel,
    point: pct(f.point),
    upper: pct(f.upper),
  };
  // EL ESTADO, CON PALABRAS: un intervalo que cruza el cero es un resultado
  // INCONCLUSO, no un ahorro pequeño; uno entero por debajo, un coste.
  const estado =
    f.lower >= 0
      ? ({ label: t("yourBench.readout.statusPositive"), tone: "green" } as const)
      : f.upper > 0
        ? ({ label: t("yourBench.readout.statusInconclusive"), tone: "amber" } as const)
        : ({ label: t("yourBench.readout.statusNegative"), tone: "red" } as const);
  // EL COLOR DE LA CIFRA DICE LO MISMO QUE LA ETIQUETA, con los mismos cortes:
  // verde solo si el intervalo entero es ahorro, rojo solo si entero es coste;
  // si cruza el cero la cifra va en tinta, sin veredicto de color.
  const tono = estado.tone === "green" ? "positive" : estado.tone === "red" ? "negative" : "neutral";
  const dia = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));
  const periodo = desde && hasta ? `${dia(desde)} – ${dia(hasta)}` : null;
  // B frente a A: el coste con la capa como parte del coste sin ella, según la
  // estimación PUNTUAL (la barra); el titular de arriba sigue siendo el suelo.
  const cambio = (f.point > 0 ? "−" : f.point < 0 ? "+" : "") + pct(Math.abs(f.point));
  return (
    <>
      <ExperimentReadout
        title={t("yourBench.readout.title")}
        status={estado}
        note={periodo ?? undefined}
        badge={<EvidenceBadge tipo="tus-datos" label={tu("evidence.tusDatos")} />}
        figure={<>≥ {pctFloor(f.lower)}</>}
        figureTone={tono}
        caption={
          completa
            ? t.rich("yourBench.headlineCaption", pie)
            : t.rich("yourBench.headlineCaptionPartial", { ...pie, coverage: pct0Floor(informe.cobertura) })
        }
        variants={[
          {
            key: "A",
            name: t("yourBench.readout.armA"),
            hint: t("yourBench.readout.armAHint"),
            value: t("yourBench.readout.armAValue"),
            share: 1,
            control: true,
          },
          {
            key: "B",
            name: t("yourBench.readout.armB"),
            hint: t("yourBench.readout.armBHint"),
            value: t("yourBench.readout.armBValue", { change: cambio }),
            share: 1 - f.point,
          },
        ]}
        facts={[
          {
            key: "muestra",
            label: <Termino definicion={t("yourBench.terms.sample")}>{t("yourBench.readout.factSample")}</Termino>,
            value: t("yourBench.readout.factSampleValue", { pairs: intfmt(informe.paresEnTitular) }),
          },
          {
            key: "intervalo",
            label: <Termino definicion={t("yourBench.terms.interval")}>{t("yourBench.readout.factInterval", { level: nivel })}</Termino>,
            value: t("yourBench.readout.factIntervalValue", { lower: pctFloor(f.lower), upper: pct(f.upper) }),
          },
          ...(periodo ? [{ key: "periodo", label: t("yourBench.readout.factPeriod"), value: periodo }] : []),
          {
            key: "cobertura",
            label: <Termino definicion={t("yourBench.terms.coverage")}>{t("yourBench.readout.factCoverage")}</Termino>,
            value: t("yourBench.readout.factCoverageValue", { coverage: pct0Floor(informe.cobertura) }),
          },
        ]}
        action={
          <a className="btn btn-ghost btn-sm" href="#yb-metodo">
            {t("yourBench.readout.methodLink")}
          </a>
        }
      >
        <div className="ci-track2" data-tono={tono}>
          <div className="ci-fill2" style={{ left: `${xp(f.lower)}%`, width: `${xp(f.upper) - xp(f.lower)}%` }} />
          <div className="ci-zero2" style={{ left: `${xp(0)}%` }} />
          <div className="ci-lo" style={{ left: `${xp(f.lower)}%` }} />
          <div className="ci-pt" style={{ left: `${xp(f.point)}%` }} />
        </div>
        <div className="ci-legend2">
          <span>{pct(dmin)}</span>
          <span>{pct(0)}</span>
          <span>{pct(dmax)}</span>
        </div>
      </ExperimentReadout>
      <div className="yb-notas">
        <p className="ck-note">
          {t("yourBench.meanDiff", {
            per: intfmt(POR_CADA),
            point: moneySigned(d.point * POR_CADA),
            lower: moneySigned(d.lower * POR_CADA),
            upper: moneySigned(d.upper * POR_CADA),
            level: nivel,
          })}
        </p>
        <p className="ck-note">
          {t("yourBench.basis", {
            pairs: intfmt(informe.paresEnTitular),
            coverage: pct0Floor(informe.cobertura),
            eligible: intfmt(informe.elegibles),
            rate: pct(informe.tasaLograda),
          })}
        </p>
        {informe.submuestreado ? (
          <p className="ck-note">{t("yourBench.subsampled", { n: intfmt(informe.paresLeidos), total: intfmt(informe.paresTotales) })}</p>
        ) : null}
      </div>
    </>
  );
}
