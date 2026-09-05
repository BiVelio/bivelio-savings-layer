"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";

import type { UsageRollup, ModelDia } from "../data";
import { money, intfmt, compact, pct0 } from "../format";
import {
  cortarPorPeriodo,
  serieDiaria,
  serieAcumulada,
  agregarPorModelo,
  topConResto,
  PERIODOS,
  type Metrica,
  type Vista,
  type Periodo,
} from "../explorer-datos";

/**
 * Explorador de uso configurable (pedido del dueño, 04-09): uso segregado POR
 * DÍA, periodo elegible, y desglose por MODELO. Todo en el cliente sobre las
 * ≤120 filas que el servidor ya trae — el corte de periodo, el toggle de métrica
 * y la vista por modelo son instantáneos, sin navegación ni refetch.
 *
 * Honestidad: los "días de uso" son solo días con fila (no se rellenan huecos);
 * el desglose por modelo sale vacío ("acumulando") hasta que la migración 0022
 * esté en prod y entre tráfico nuevo — jamás una fila de modelo inventada.
 */
const W = 640;
const H = 170;
const P = 8;
const TOP_MODELOS = 6;

export function UsageExplorer({ usage, porModelo }: { usage: UsageRollup[]; porModelo: ModelDia[] }) {
  const t = useTranslations("dashboard");
  const [periodo, setPeriodo] = useState<Periodo>(30);
  const [metrica, setMetrica] = useState<Metrica>("neto");
  const [vista, setVista] = useState<Vista>("dia");

  // Etiqueta de barra: dinero para el ahorro neto, exacto para peticiones (un
  // recuento pequeño se quiere entero), compacto para tokens (millones). El
  // número EXACTO viaja en el tooltip vía `fmtExact`, nunca se pierde.
  const fmt = (v: number): string =>
    metrica === "neto" ? money(v) : metrica === "peticiones" ? intfmt(v) : compact(v);
  const fmtExact = (v: number): string => (metrica === "neto" ? money(v) : intfmt(v));

  const usageCortado = useMemo(() => cortarPorPeriodo(usage, periodo), [usage, periodo]);
  const modeloCortado = useMemo(() => cortarPorPeriodo(porModelo, periodo), [porModelo, periodo]);

  const diaria = useMemo(() => serieDiaria(usageCortado, metrica), [usageCortado, metrica]);
  const acumulada = useMemo(() => serieAcumulada(usageCortado, metrica), [usageCortado, metrica]);
  const modelosTodos = useMemo(() => agregarPorModelo(modeloCortado, metrica), [modeloCortado, metrica]);
  const barras = useMemo(
    () => topConResto(modelosTodos, TOP_MODELOS, t("usageExplorer.modelOther")),
    [modelosTodos, t],
  );

  const seg = <T extends string | number>(
    grupo: string,
    valor: T,
    set: (v: T) => void,
    opciones: { v: T; label: string }[],
  ) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span className="ck-eyebrow" style={{ fontSize: 11 }}>{grupo}</span>
      <div role="group" aria-label={grupo} style={{ display: "inline-flex", flexWrap: "wrap", gap: 4 }}>
        {opciones.map((o) => {
          const activo = o.v === valor;
          return (
            <button
              key={o.v}
              type="button"
              aria-pressed={activo}
              onClick={() => set(o.v)}
              style={{
                padding: "4px 10px",
                fontSize: 12,
                borderRadius: 7,
                cursor: "pointer",
                border: "1px solid var(--border)",
                background: activo ? "var(--brand)" : "transparent",
                color: activo ? "#fff" : "var(--muted)",
                fontWeight: activo ? 600 : 500,
              }}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 18, marginBottom: 14 }}>
        {seg<Periodo>(
          t("usageExplorer.period"),
          periodo,
          setPeriodo,
          PERIODOS.map((p) => ({ v: p, label: String(p) })),
        )}
        {seg<Metrica>(t("usageExplorer.metric"), metrica, setMetrica, [
          { v: "neto", label: t("usageExplorer.metricNet") },
          { v: "peticiones", label: t("usageExplorer.metricRequests") },
          { v: "tokensEntrada", label: t("usageExplorer.metricInputTokens") },
        ])}
        {seg<Vista>(t("usageExplorer.view"), vista, setVista, [
          { v: "dia", label: t("usageExplorer.viewDaily") },
          { v: "acumulado", label: t("usageExplorer.viewCumulative") },
          { v: "modelo", label: t("usageExplorer.viewModel") },
        ])}
      </div>

      {vista === "modelo" ? (
        <VistaModelo
          barras={barras}
          totalModelos={modelosTodos.length}
          metrica={metrica}
          fmt={fmt}
          fmtExact={fmtExact}
          t={t}
        />
      ) : vista === "acumulado" ? (
        <VistaAcumulada puntos={acumulada} metrica={metrica} fmt={fmt} t={t} />
      ) : (
        <VistaDiaria puntos={diaria} metrica={metrica} fmt={fmt} fmtExact={fmtExact} t={t} />
      )}
    </div>
  );
}

type T = ReturnType<typeof useTranslations>;

/** Barras por día — solo días con fila (no se rellenan huecos). */
function VistaDiaria({
  puntos,
  metrica,
  fmt,
  fmtExact,
  t,
}: {
  puntos: { day: string; valor: number }[];
  metrica: Metrica;
  fmt: (v: number) => string;
  fmtExact: (v: number) => string;
  t: T;
}) {
  if (puntos.length === 0) return <p className="ck-note">{t("usageExplorer.emptyPeriod")}</p>;
  const vals = puntos.map((p) => p.valor);
  const domMax = Math.max(...vals, 0);
  const domMin = Math.min(...vals, 0);
  const span = domMax - domMin || 1;
  const y = (v: number) => H - P - ((v - domMin) / span) * (H - 2 * P);
  const zeroY = y(0);
  const slot = (W - 2 * P) / puntos.length;
  const bw = Math.max(1, slot * 0.7);
  const total = vals.reduce((s, v) => s + v, 0);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={t("usageExplorer.dailyAria")}>
        <line x1={P} y1={zeroY} x2={W - P} y2={zeroY} stroke="var(--border)" strokeWidth="1" />
        {puntos.map((p, i) => {
          const yv = y(p.valor);
          const top = Math.min(yv, zeroY);
          const alto = Math.max(1, Math.abs(yv - zeroY));
          const positivo = p.valor >= 0;
          const fill = metrica === "neto" ? (positivo ? "var(--success)" : "var(--amber)") : "var(--brand)";
          return (
            <rect
              key={p.day}
              x={(P + i * slot + (slot - bw) / 2).toFixed(1)}
              y={top.toFixed(1)}
              width={bw.toFixed(1)}
              height={alto.toFixed(1)}
              rx={bw > 3 ? 1.5 : 0}
              fill={fill}
            >
              <title>{`${p.day} · ${fmtExact(p.valor)}`}</title>
            </rect>
          );
        })}
      </svg>
      {puntos.length >= 2 && (
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2 }}>
          <span className="mono" style={{ fontSize: 10.5, color: "var(--muted)" }}>{puntos[0]!.day}</span>
          <span className="mono" style={{ fontSize: 10.5, color: "var(--muted)" }}>
            {puntos[puntos.length - 1]!.day}
          </span>
        </div>
      )}
      <p className="ck-note">{t("usageExplorer.summaryDays", { value: fmt(total), days: puntos.length })}</p>
    </div>
  );
}

/** Línea acumulada — hereda la vista de SavingsTrendChart, ahora por métrica. */
function VistaAcumulada({
  puntos,
  metrica,
  fmt,
  t,
}: {
  puntos: { day: string; acumulado: number }[];
  metrica: Metrica;
  fmt: (v: number) => string;
  t: T;
}) {
  if (puntos.length < 2) return <p className="ck-note">{t("usageExplorer.emptyPeriod")}</p>;
  const pts = puntos.map((p, i) => ({
    x: (i / (puntos.length - 1)) * (W - 2 * P) + P,
    v: p.acumulado,
  }));
  const max = Math.max(...pts.map((p) => p.v), 1);
  const min = Math.min(...pts.map((p) => p.v), 0);
  const span = max - min || 1;
  const y = (v: number) => H - P - ((v - min) / span) * (H - 2 * P);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const area = `${line} L${pts[pts.length - 1]!.x.toFixed(1)},${H - P} L${pts[0]!.x.toFixed(1)},${H - P} Z`;
  const final = puntos[puntos.length - 1]!.acumulado;
  // Verde solo para el ahorro neto acumulado (un "win"); azul de marca para
  // peticiones y tokens acumulados, que son consumo, no ahorro.
  const color = metrica === "neto" ? "var(--success)" : "var(--brand)";
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={t("savingsTrendChart.chartAria")}>
        <path d={area} fill={`color-mix(in srgb, ${color} 14%, transparent)`} />
        <path d={line} fill="none" stroke={color} strokeWidth="2" />
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2 }}>
        <span className="mono" style={{ fontSize: 10.5, color: "var(--muted)" }}>{puntos[0]!.day}</span>
        <span className="mono" style={{ fontSize: 10.5, color: "var(--muted)" }}>
          {puntos[puntos.length - 1]!.day}
        </span>
      </div>
      <p className="ck-note">{t("usageExplorer.summaryDays", { value: fmt(final), days: puntos.length })}</p>
    </div>
  );
}

/** Barras horizontales por modelo — vacío honesto hasta acumular tráfico. */
function VistaModelo({
  barras,
  totalModelos,
  metrica,
  fmt,
  fmtExact,
  t,
}: {
  barras: { model: string; valor: number }[];
  totalModelos: number;
  metrica: Metrica;
  fmt: (v: number) => string;
  fmtExact: (v: number) => string;
  t: T;
}) {
  if (barras.length === 0) return <p className="ck-note">{t("usageExplorer.modelEmpty")}</p>;
  const max = Math.max(...barras.map((b) => b.valor), 1);
  const total = barras.reduce((s, b) => s + b.valor, 0);
  // Color semántico, no decorativo: verde solo cuando la métrica ES ahorro; azul
  // de marca para peticiones y tokens (consumo). Antes todas las barras eran
  // verdes ("win"), lo que hacía leer el consumo de tokens como si fuera ahorro.
  const color = metrica === "neto" ? "var(--success)" : "var(--brand)";
  return (
    <div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {barras.map((b) => {
          const cuota = total > 0 ? b.valor / total : 0;
          return (
            <div
              key={b.model}
              style={{ display: "grid", gridTemplateColumns: "minmax(0,150px) 1fr auto", gap: 10, alignItems: "center" }}
            >
              <span
                className="mono"
                title={b.model}
                style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }}
              >
                {b.model}
              </span>
              <div className="track2" title={`${b.model} · ${fmtExact(b.valor)}`}>
                <div className="fill2" style={{ width: `${Math.max(2, (b.valor / max) * 100)}%`, background: color }} />
              </div>
              <span
                className="mono"
                style={{ fontSize: 12, display: "flex", gap: 7, alignItems: "baseline", justifyContent: "flex-end", whiteSpace: "nowrap" }}
              >
                <span>{fmt(b.valor)}</span>
                <span style={{ color: "var(--muted)", fontSize: 11 }}>{pct0(cuota)}</span>
              </span>
            </div>
          );
        })}
      </div>
      <p className="ck-note">{t("usageExplorer.summaryModels", { value: fmt(total), n: totalModelos })}</p>
    </div>
  );
}
