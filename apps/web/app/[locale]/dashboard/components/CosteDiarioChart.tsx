"use client";

import type { ReactNode } from "react";

import { KpiChart } from "@/vendor/affectui/kpi-chart";

import { money, moneySigned } from "../format";

/**
 * El puente de cliente del gráfico diario: el servidor baja las series ya
 * calculadas (números o `null`) y los textos; aquí solo se le da al KPI Chart
 * el formateador de dinero del panel (`money`, determinista: mismo texto en
 * servidor y navegador), que una función no puede cruzar como prop.
 */
export function CosteDiarioChart({
  title,
  aside,
  labels,
  tooltipLabels,
  base,
  real,
  ahorro,
  textos,
  footer,
}: {
  title: string;
  aside?: ReactNode;
  labels: string[];
  tooltipLabels: string[];
  base: (number | null)[];
  real: (number | null)[];
  ahorro: (number | null)[];
  textos: { base: string; real: string; ahorro: string; banda: string; plot: string; vacio: string; hueco: string };
  footer?: ReactNode;
}) {
  return (
    <KpiChart
      className="ov-chart"
      title={title}
      aside={aside}
      labels={labels}
      tooltipLabels={tooltipLabels}
      series={[
        { label: textos.base, color: "var(--ink-soft)", values: base, dashed: true },
        { label: textos.real, color: "var(--brand)", values: real },
        { label: textos.ahorro, color: "var(--mint)", values: ahorro, tooltipOnly: true },
      ]}
      band={{ between: [0, 1], color: "var(--mint)", label: textos.banda }}
      format={(n) => (n < 0 ? moneySigned(n) : money(n))}
      plotLabel={textos.plot}
      emptyText={textos.vacio}
      gapText={textos.hueco}
      footer={footer}
    />
  );
}
