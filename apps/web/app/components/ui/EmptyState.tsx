import type { ReactNode } from "react";

import { cx } from "./cx";

/**
 * ESTADO VACÍO. Dice QUÉ falta y QUÉ hacer, con palabras. Un vacío, un error o
 * un límite nunca se pintan como un cero ni como un gráfico plano.
 */
export type EmptyStateProps = {
  titulo: string;
  texto?: ReactNode;
  /** Un SVG de 18px (hereda `currentColor`). Opcional. */
  icono?: ReactNode;
  /** Botones o enlaces (`.btn`, `.btn.ghost`). */
  acciones?: ReactNode;
  /** Nivel del título. Por defecto <h3>. */
  como?: "h2" | "h3" | "h4" | "p";
  compacto?: boolean;
  /** Sin caja punteada: para ir dentro de una tarjeta. */
  sinCaja?: boolean;
  /** Alineado al inicio en vez de centrado. */
  alInicio?: boolean;
  className?: string;
};

export function EmptyState({ titulo, texto, icono, acciones, como: Titulo = "h3", compacto = false, sinCaja = false, alInicio = false, className }: EmptyStateProps) {
  return (
    <div className={cx("empty-state", compacto && "empty-state--compact", sinCaja && "empty-state--bare", alInicio && "empty-state--start", className)}>
      {icono ? (
        <span className="empty-state-icon" aria-hidden>
          {icono}
        </span>
      ) : null}
      <Titulo className="empty-state-title">{titulo}</Titulo>
      {texto ? <p className="empty-state-text">{texto}</p> : null}
      {acciones ? <div className="empty-state-actions">{acciones}</div> : null}
    </div>
  );
}
