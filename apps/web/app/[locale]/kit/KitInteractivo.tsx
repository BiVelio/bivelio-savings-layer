"use client";

import { useState } from "react";

import { CodeBlock } from "@/vendor/affectui/code-block-clean";
import { EmptyState as EmptyStateAui } from "@/vendor/affectui/empty-state-clean";
import { ExperimentCard } from "@/vendor/affectui/experiment-card";
import { NumberTicker } from "@/vendor/affectui/number-ticker";
import { SegmentedControl } from "@/vendor/affectui/segmented-control-clean";
import { Loading, Skeleton as SkeletonAui } from "@/vendor/affectui/skeleton-clean";

/**
 * Las piezas vendorizadas de affectUI que necesitan cliente, con datos de
 * MUESTRA. Solo se monta en el muestrario de desarrollo (/kit).
 */
export function KitInteractivo({ locale, copiar, copiado }: { locale: string; copiar: string; copiado: string }) {
  const [rango, setRango] = useState("30");
  const valor = rango === "7" ? 1284 : rango === "30" ? 5120 : 14890;

  return (
    <div style={{ display: "grid", gap: 24, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))", alignItems: "start" }}>
      <div style={{ display: "grid", gap: 16 }}>
        <SegmentedControl
          aria-label="Rango"
          value={rango}
          onChange={setRango}
          options={[
            { value: "7", label: "7 días" },
            { value: "30", label: "30 días" },
            { value: "90", label: "90 días" },
          ]}
        />
        <p className="tnum" style={{ margin: 0, fontSize: 32, fontWeight: 600, letterSpacing: "-.02em" }}>
          <NumberTicker value={valor} locale={locale} />
        </p>
        <Loading label="Cargando ejemplo" style={{ display: "grid", gap: 8 }}>
          <SkeletonAui width="60%" height={14} />
          <SkeletonAui width="100%" height={10} />
          <SkeletonAui width="85%" height={10} />
        </Loading>
        <EmptyStateAui title="Sin datos todavía" text="Pieza vendorizada empty-state-clean, con los tokens de BiVelio." />
      </div>
      <CodeBlock
        filename="savings.config.ts"
        language="ts"
        showLineNumbers
        highlightLines={[3]}
        labels={{ copy: copiar, copied: copiado, code: "Código" }}
        code={`import { createSavingsLayer } from "@bivelio/savings-layer";

export const layer = createSavingsLayer({
  provider: "openai",
});`}
      />
      <ExperimentCard
        title="Ejemplo ilustrativo"
        locale={locale}
        defaultOpen
        trigger="click"
        status={{ label: "Muestra", tone: "gray" }}
        metrics={[{ id: "coste", label: "Coste", lowerIsBetter: true }]}
        variants={[
          { id: "a", key: "A", name: "Sin optimizar", control: true, visitors: 500, values: { coste: 100 } },
          { id: "b", key: "B", name: "Con Savings", visitors: 500, values: { coste: 80 }, confidence: { coste: 95 } },
        ]}
        labels={{
          pickWinner: "Elige una variante",
          noLift: "Sin diferencia",
          base: "Base",
          baseline: "referencia",
          visitors: (n) => `${n} peticiones`,
          confidence: (p) => `${p} % de confianza`,
          picked: (n) => `${n} elegida`,
          metric: "Métrica",
          winner: "Variante",
          ahead: (n, p) => `${n} va por delante un ${p} %`,
          noValue: "sin valor",
          change: (p, up) => `${up ? "sube" : "baja"} un ${p} %`,
        }}
      />
    </div>
  );
}
