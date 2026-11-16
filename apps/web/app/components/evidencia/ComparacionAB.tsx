"use client";

import { useId, useMemo, useState } from "react";

import { useTranslations } from "next-intl";

import { EvidenceBadge } from "@/app/components/ui";
import { ExperimentCard, type ExperimentCardLabels, type ExperimentMetric, type ExperimentVariant } from "@/vendor/affectui/experiment-card";

/**
 * LOS DOS BRAZOS DE UNA TIRADA, MODELO A MODELO — la Experiment Card de
 * affectUI, adaptada a lo que el banco puede afirmar.
 *
 * La demo de la pieza invita a «elegir un ganador». Aquí no se elige nada:
 *  - `winner={null}` deja la selección sin efecto y `open` la deja siempre
 *    desplegada (los brazos no dependen del hover);
 *  - A es el brazo de referencia (directo al proveedor) y B el que pasa por la
 *    capa; el coste es «menos es mejor»;
 *  - la tarjeta NO calcula confianza, así que no se le pasa ninguna: la lectura
 *    estadística (muestra, intervalo, exactitud, tirada) va AL LADO, en texto,
 *    con su insignia de evidencia y el enlace a la metodología;
 *  - la insignia de estado sale del intervalo, no del punto: si el intervalo
 *    toca el cero, dice «no se distingue de cero» aunque B salga más barato.
 *
 * Todas las cifras llegan del banco (`costeA`, `costeB`, exactitud, n) y los
 * textos largos, ya formateados por el servidor. Cambiar de modelo hace rodar
 * los números porque el lector ha cambiado algo, nunca al entrar.
 */

export type FilaAB = {
  modelo: string;
  n: number;
  costeA: number;
  costeB: number;
  /** Aciertos / n de cada brazo, o null si la tirada no puntuó exactitud. */
  exactitudA: number | null;
  exactitudB: number | null;
  veredicto: "ahorro" | "cero" | "sobrecoste";
  /** Ya formateados en el idioma de la página. */
  muestra: string;
  ahorro: string;
  exactitud: string;
  tirada: string;
};

const TONO = { ahorro: "green", cero: "gray", sobrecoste: "red" } as const;

export function ComparacionAB({ filas, locale, etiquetaAb }: { filas: readonly FilaAB[]; locale: string; etiquetaAb: string }) {
  const t = useTranslations("benchmarksPage");
  const idSelector = useId();
  const [modelo, setModelo] = useState(filas[0]?.modelo ?? "");
  const fila = filas.find((f) => f.modelo === modelo) ?? filas[0];

  const { usd, pct } = useMemo(() => {
    const u = new Intl.NumberFormat(locale, { style: "currency", currency: "USD", minimumFractionDigits: 4, maximumFractionDigits: 4 });
    const p = new Intl.NumberFormat(locale, { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });
    return { usd: (x: number) => u.format(x), pct: (x: number) => p.format(x) };
  }, [locale]);

  if (!fila) return null;

  const conExactitud = fila.exactitudA !== null && fila.exactitudB !== null;
  const metricas: ExperimentMetric[] = [
    { id: "coste", label: t("ab.metricCost"), format: usd, lowerIsBetter: true },
    ...(conExactitud ? [{ id: "exactitud", label: t("ab.metricAccuracy"), format: pct }] : []),
  ];
  const variantes: ExperimentVariant[] = [
    { id: "a", key: "A", name: t("ab.armA"), control: true, visitors: fila.n, values: { coste: fila.costeA, ...(conExactitud ? { exactitud: fila.exactitudA! } : {}) } },
    { id: "b", key: "B", name: t("ab.armB"), visitors: fila.n, values: { coste: fila.costeB, ...(conExactitud ? { exactitud: fila.exactitudB! } : {}) }, color: "var(--brand)" },
  ];
  const labels: ExperimentCardLabels = {
    pickWinner: t("ab.hint"),
    noLift: t("ab.noLift"),
    base: t("ab.base"),
    baseline: t("ab.baseline"),
    visitors: (formateado) => t("ab.requests", { n: formateado }),
    confidence: () => "",
    picked: (nombre) => nombre,
    metric: t("ab.metric"),
    winner: t("ab.arms"),
    ahead: (nombre, porcentaje) => t("ab.ahead", { nombre, porcentaje }),
    noValue: t("ab.noValue"),
    change: (porcentaje, sube) => t(sube ? "ab.up" : "ab.down", { porcentaje }),
  };

  return (
    <div className="evc-ab">
      <div className="evc-ab-head">
        <h3>{t("ab.title")}</h3>
        <p>{t("ab.intro")}</p>
      </div>
      <div className="evc-ab-body">
        <div className="evc-ab-card">
          <label className="evc-ab-label" htmlFor={idSelector}>
            {t("th.model")}
          </label>
          <select id={idSelector} className="evc-select" value={fila.modelo} onChange={(e) => setModelo(e.target.value)}>
            {filas.map((f) => (
              <option key={f.modelo} value={f.modelo}>
                {f.modelo}
              </option>
            ))}
          </select>
          <ExperimentCard
            title={fila.modelo}
            note={fila.tirada}
            status={{ label: t(`noSavings.verdict.${fila.veredicto}`), tone: TONO[fila.veredicto] }}
            variants={variantes}
            metrics={metricas}
            winner={null}
            open
            trigger="click"
            hint={t("ab.hint")}
            labels={labels}
            locale={locale}
          />
        </div>
        <dl className="evc-ab-reading">
          <div>
            <dt>{t("th.savings")}</dt>
            <dd>
              <span className="evc-ab-figure">{fila.ahorro}</span> <EvidenceBadge tipo="ab-sdk" label={etiquetaAb} pequeno />
            </dd>
          </div>
          <div>
            <dt>{t("ab.sample")}</dt>
            <dd>{fila.muestra}</dd>
          </div>
          <div>
            <dt>{t("th.accuracy")}</dt>
            <dd>{fila.exactitud}</dd>
          </div>
          <div>
            <dt>{t("th.run")}</dt>
            <dd>{fila.tirada}</dd>
          </div>
        </dl>
      </div>
      <p className="evc-ab-foot">
        {t("ab.note")} <a href="#method">{t("ab.method")}</a>
      </p>
    </div>
  );
}
