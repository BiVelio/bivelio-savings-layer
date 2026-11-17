"use client";

import { useEffect, useId, useState, type ReactNode } from "react";

import { BlurCrossfade } from "@/vendor/affectui/blur-crossfade";
import { SegmentedControl } from "@/vendor/affectui/segmented-control";

/**
 * Pestañas por sistema operativo para bloques de comandos. Los comandos NO son
 * iguales en todas partes: `export VAR=…` (y el prefijo `VAR=valor comando`)
 * son POSIX; en Windows la sesión se fija con `$env:VAR = "…"` (PowerShell).
 *
 * Detecta el sistema del visitante y preselecciona su pestaña — detección de
 * cliente, así que el primer render (servidor) enseña macOS/Linux y se ajusta
 * al hidratar; el visitante siempre puede cambiar a mano.
 *
 * El selector es el Segmented Control de affectUI en modo pestañas (flechas,
 * Inicio y Fin; 44 px en táctil) y el bloque cambia con su Blur Crossfade, que
 * respeta `prefers-reduced-motion`. Los nombres de los sistemas son nombres
 * propios: no se traducen.
 */
export type Sistema = "unix" | "windows";

function sistemaDelNavegador(): Sistema {
  if (typeof navigator === "undefined") return "unix";
  const ua = (navigator.userAgent || "").toLowerCase();
  const plataforma = (
    (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    ""
  ).toLowerCase();
  return plataforma.includes("win") || ua.includes("windows") ? "windows" : "unix";
}

export function SnippetPorSistema({
  unix,
  windows,
  etiqueta,
}: {
  unix: ReactNode;
  windows: ReactNode;
  /** Nombre accesible del selector (p. ej. «Terminal»). */
  etiqueta?: string;
}) {
  const [sistema, setSistema] = useState<Sistema>("unix");
  useEffect(() => setSistema(sistemaDelNavegador()), []);
  const panel = `${useId()}-so`;
  return (
    <div className="so-snippet">
      <SegmentedControl<Sistema>
        className="so-seg"
        kind="tabs"
        variant="tray"
        size="lg"
        aria-label={etiqueta}
        value={sistema}
        onChange={setSistema}
        options={[
          { value: "unix", label: "macOS / Linux", controls: panel },
          { value: "windows", label: "Windows", controls: panel },
        ]}
      />
      <div id={panel} role="tabpanel">
        <BlurCrossfade id={sistema} duration={220} blur={6}>
          {sistema === "unix" ? unix : windows}
        </BlurCrossfade>
      </div>
    </div>
  );
}
