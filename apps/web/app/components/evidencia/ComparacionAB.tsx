"use client";

import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { useTranslations } from "next-intl";

import { EvidenceBadge } from "@/app/components/ui";
import { BlurCrossfade } from "@/vendor/affectui/blur-crossfade";
import { ExperimentCard, type ExperimentCardLabels, type ExperimentMetric, type ExperimentVariant } from "@/vendor/affectui/experiment-card";

import { Termino } from "./Termino";

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
 *
 * EL SELECTOR ES LA PROPIA EVIDENCIA (2026-11): en vez de un desplegable, todos
 * los modelos medidos a la vez, cada uno con su intervalo del 95 % dibujado a
 * la MISMA escala (el punto es la estimación, la barra el intervalo, la raya el
 * cero). Es un grupo de radios: flechas, Inicio y Fin cambian de modelo. El
 * color sale del intervalo, igual que la insignia de la tarjeta, y cada fila
 * lleva sus cifras escritas: la barra nunca es el único sitio donde está el dato.
 * La lectura de la derecha cambia con un fundido (Blur Crossfade de affectUI) y
 * sus términos llevan definición (Tooltip).
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
  /** El intervalo en crudo (fracciones), para dibujarlo; y sus dos mitades ya formateadas. */
  intervalo: { inf: number; punto: number; sup: number };
  punto: string;
  rango: string;
  exactitud: string;
  tirada: string;
};

const TONO = { ahorro: "green", cero: "gray", sobrecoste: "red" } as const;

export function ComparacionAB({ filas, locale, etiquetaAb }: { filas: readonly FilaAB[]; locale: string; etiquetaAb: string }) {
  const t = useTranslations("benchmarksPage");
  const idTitulo = useId();
  const lista = useRef<HTMLDivElement>(null);
  const [modelo, setModelo] = useState(filas[0]?.modelo ?? "");
  const fila = filas.find((f) => f.modelo === modelo) ?? filas[0];

  const { usd, pct, pct0 } = useMemo(() => {
    const u = new Intl.NumberFormat(locale, { style: "currency", currency: "USD", minimumFractionDigits: 4, maximumFractionDigits: 4 });
    const p = new Intl.NumberFormat(locale, { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });
    const p0 = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
    return { usd: (x: number) => u.format(x), pct: (x: number) => p.format(x), pct0: (x: number) => p0.format(x) };
  }, [locale]);

  // La escala común: del cero (o del intervalo más bajo, si alguno baja de cero)
  // al décimo siguiente al intervalo más alto.
  const escala = useMemo(() => {
    const min = Math.min(0, ...filas.map((f) => f.intervalo.inf));
    const max = Math.max(0.1, ...filas.map((f) => f.intervalo.sup));
    const abajo = Math.floor(min * 10 - 1e-9) / 10;
    const arriba = Math.ceil(max * 10 - 1e-9) / 10;
    const x = (v: number) => Math.max(0, Math.min(100, ((v - abajo) / (arriba - abajo)) * 100));
    const marcas: number[] = [];
    const paso = arriba - abajo > 0.6 ? 0.2 : 0.1;
    for (let v = abajo; v <= arriba + 1e-9; v += paso) marcas.push(Math.round(v * 10) / 10);
    return { x, marcas };
  }, [filas]);

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

  // Grupo de radios: las flechas mueven la selección y el foco a la vez.
  const alTeclear = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = filas.findIndex((f) => f.modelo === fila.modelo);
    let j = -1;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") j = (i + 1) % filas.length;
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") j = (i - 1 + filas.length) % filas.length;
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = filas.length - 1;
    if (j < 0) return;
    e.preventDefault();
    setModelo(filas[j]!.modelo);
    lista.current?.querySelectorAll<HTMLButtonElement>("button[role=radio]")[j]?.focus();
  };

  return (
    <div className="evc-ab">
      <div className="evc-ab-head">
        <h3>{t("ab.title")}</h3>
        <p>{t("ab.intro")}</p>
      </div>
      <div className="evc-ab-body">
        <div className="evc-forest">
          <div className="evc-forest-head">
            <p className="evc-forest-t" id={idTitulo}>
              {t("ab.forestTitle")}
            </p>
            <EvidenceBadge tipo="ab-sdk" label={etiquetaAb} pequeno />
          </div>
          <div className="evc-forest-list" role="radiogroup" aria-labelledby={idTitulo} ref={lista} onKeyDown={alTeclear}>
            {filas.map((f) => {
              const elegido = f.modelo === fila.modelo;
              return (
                <button key={f.modelo} type="button" role="radio" aria-checked={elegido} tabIndex={elegido ? 0 : -1} className="evc-forest-row" data-veredicto={f.veredicto} onClick={() => setModelo(f.modelo)}>
                  <span className="evc-forest-m">{f.modelo}</span>
                  <span className="evc-forest-track" aria-hidden>
                    {escala.marcas.map((m) => (
                      <i key={m} className="evc-forest-grid" data-cero={m === 0 || undefined} style={{ left: `${escala.x(m)}%` }} />
                    ))}
                    <i className="evc-forest-ci" style={{ left: `${escala.x(f.intervalo.inf)}%`, width: `${Math.max(0.6, escala.x(f.intervalo.sup) - escala.x(f.intervalo.inf))}%` }} />
                    <i className="evc-forest-pt" style={{ left: `${escala.x(f.intervalo.punto)}%` }} />
                  </span>
                  <span className="evc-forest-v">
                    <b>{f.punto}</b>
                    <small>{f.rango}</small>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="evc-forest-axis" aria-hidden>
            <span />
            <span className="evc-forest-ticks">
              {escala.marcas.map((m) => (
                <i key={m} style={{ left: `${escala.x(m)}%` }}>
                  {pct0(m)}
                </i>
              ))}
            </span>
            <span />
          </div>
          <p className="evc-forest-hint">{t("ab.forestHint")}</p>
        </div>

        <div className="evc-ab-card">
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
          <BlurCrossfade id={fila.modelo} className="evc-ab-swap">
            <dl className="evc-ab-reading">
              <div>
                <dt>
                  <Termino definicion={t("terms.interval")}>{t("th.savings")}</Termino>
                </dt>
                <dd>
                  <span className="evc-ab-figure">{fila.ahorro}</span> <EvidenceBadge tipo="ab-sdk" label={etiquetaAb} pequeno />
                </dd>
              </div>
              <div>
                <dt>
                  <Termino definicion={t("terms.sample")}>{t("ab.sample")}</Termino>
                </dt>
                <dd>{fila.muestra}</dd>
              </div>
              <div>
                <dt>
                  <Termino definicion={t("terms.accuracy")}>{t("th.accuracy")}</Termino>
                </dt>
                <dd>{fila.exactitud}</dd>
              </div>
              <div>
                <dt>
                  <Termino definicion={t("terms.run")}>{t("th.run")}</Termino>
                </dt>
                <dd>{fila.tirada}</dd>
              </div>
            </dl>
          </BlurCrossfade>
        </div>
      </div>
      <p className="evc-ab-foot">
        {t("ab.note")} <a href="#method">{t("ab.method")}</a>
      </p>
    </div>
  );
}
