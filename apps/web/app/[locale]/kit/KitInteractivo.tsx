"use client";

import { useState } from "react";

import { ExperimentCard } from "@/vendor/affectui/experiment-card";
import { NumberTicker } from "@/vendor/affectui/number-ticker";

/**
 * Las piezas vendorizadas de affectUI que necesitan cliente, con datos de
 * MUESTRA. Solo se monta en el muestrario de desarrollo (/kit).
 */
export function KitInteractivo({ locale }: { locale: string }) {
  const [rango, setRango] = useState("30");
  const valor = rango === "7" ? 1284 : rango === "30" ? 5120 : 14890;

  return (
    <div style={{ display: "grid", gap: 24, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))", alignItems: "start" }}>
      <div style={{ display: "grid", gap: 16 }}>
        {/* El rango: tres botones de muestra. En el panel el rango es un enlace
            (`RangeSwitch`); aquí solo hace falta cambiar el valor para ver rodar la cifra. */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }} role="group" aria-label="Rango">
          {(["7", "30", "90"] as const).map((r) => (
            <button key={r} type="button" className={r === rango ? "btn btn-primary" : "btn btn-ghost"} aria-pressed={r === rango} onClick={() => setRango(r)}>
              {r} días
            </button>
          ))}
        </div>
        <p className="tnum" style={{ margin: 0, fontSize: 32, fontWeight: 600, letterSpacing: "-.02em" }}>
          <NumberTicker value={valor} locale={locale} />
        </p>
      </div>
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
