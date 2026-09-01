"use client";

import { useEffect, useState, type ReactNode } from "react";

/**
 * Pestañas por sistema operativo para bloques de comandos. Los comandos NO son
 * iguales en todas partes: `export VAR=…` (y el prefijo `VAR=valor comando`)
 * son POSIX; en Windows la sesión se fija con `$env:VAR = "…"` (PowerShell).
 *
 * Detecta el sistema del visitante y preselecciona su pestaña — detección de
 * cliente, así que el primer render (servidor) enseña macOS/Linux y se ajusta
 * al hidratar; el visitante siempre puede cambiar a mano.
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

export function SnippetPorSistema({ unix, windows }: { unix: ReactNode; windows: ReactNode }) {
  const [sistema, setSistema] = useState<Sistema>("unix");
  useEffect(() => setSistema(sistemaDelNavegador()), []);
  return (
    <div className="so-snippet">
      <div className="so-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={sistema === "unix"}
          className={sistema === "unix" ? "on" : ""}
          onClick={() => setSistema("unix")}
        >
          macOS / Linux
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={sistema === "windows"}
          className={sistema === "windows" ? "on" : ""}
          onClick={() => setSistema("windows")}
        >
          Windows
        </button>
      </div>
      {sistema === "unix" ? unix : windows}
    </div>
  );
}
