import type { ReactNode } from "react";

import { cx } from "./cx";

/**
 * AVISO. Cuatro tonos; el tono lo dicen el icono y el texto, no solo el color.
 *
 * `role`:
 *  - `"status"` (por defecto en info/ok): se anuncia sin interrumpir.
 *  - `"alert"`: interrumpe. Solo para errores que bloquean lo que el usuario
 *    estaba haciendo (por defecto en `danger`).
 *  - `"note"`: contenido estático que ya estaba en la página; no se anuncia.
 */
export type TonoDeAviso = "info" | "ok" | "warn" | "danger";

const TRAZO = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" } as const;

const ICONOS: Record<TonoDeAviso, ReactNode> = {
  info: <path {...TRAZO} d="M10 17.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15zM10 9.2v4.3M10 6.5v.01" />,
  ok: <path {...TRAZO} d="M10 17.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15zM6.9 10.2l2.2 2.2 4-4.4" />,
  warn: <path {...TRAZO} d="M10 3.2 2.6 16h14.8L10 3.2zM10 8.3v3.6M10 14.1v.01" />,
  danger: <path {...TRAZO} d="M10 17.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15zM7.6 7.6l4.8 4.8M12.4 7.6l-4.8 4.8" />,
};

export type NoticeProps = {
  tono?: TonoDeAviso;
  titulo?: string;
  children?: ReactNode;
  /** Botones o enlaces bajo el texto. */
  acciones?: ReactNode;
  role?: "status" | "alert" | "note";
  className?: string;
};

export function Notice({ tono = "info", titulo, children, acciones, role, className }: NoticeProps) {
  const papel = role ?? (tono === "danger" ? "alert" : tono === "warn" ? "note" : "status");
  return (
    <div className={cx("notice", className)} data-tone={tono} role={papel}>
      <span className="notice-icon" aria-hidden>
        <svg viewBox="0 0 20 20" focusable="false">
          {ICONOS[tono]}
        </svg>
      </span>
      <div className="notice-body">
        {titulo ? <p className="notice-title">{titulo}</p> : null}
        {typeof children === "string" ? <p>{children}</p> : children}
        {acciones ? <div className="notice-actions">{acciones}</div> : null}
      </div>
    </div>
  );
}
