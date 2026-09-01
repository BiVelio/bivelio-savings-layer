"use client";

import { useState, type ReactNode } from "react";

/**
 * Pestañas por SUPERFICIE para el skill savings-mode: Claude Code (comando),
 * claude.ai (zip) y ChatGPT (adaptación honesta — allí no hay skills y los
 * topes cuentan mensajes). Nombres propios sin traducir, como las pestañas de
 * sistema operativo; reutiliza los estilos .so-snippet/.so-tabs.
 *
 * Sin detección de cliente a propósito: no hay señal fiable de qué superficie
 * usa el visitante, así que manda el orden (Claude Code primero, donde el
 * skill es un solo comando).
 */
export function SkillPorSuperficie({ pestanas }: { pestanas: { id: string; etiqueta: string; panel: ReactNode }[] }) {
  const [activa, setActiva] = useState(0);
  return (
    <div className="so-snippet">
      <div className="so-tabs" role="tablist">
        {pestanas.map((p, i) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={i === activa}
            className={i === activa ? "on" : ""}
            onClick={() => setActiva(i)}
          >
            {p.etiqueta}
          </button>
        ))}
      </div>
      {pestanas[activa]!.panel}
    </div>
  );
}
