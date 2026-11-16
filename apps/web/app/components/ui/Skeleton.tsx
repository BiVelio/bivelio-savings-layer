import type { CSSProperties, ReactNode } from "react";

import { cx } from "./cx";

/**
 * ESQUELETO DE CARGA. Reserva el MISMO hueco que el contenido que sustituye,
 * para que al llegar no haya saltos. Es decorativo (`aria-hidden`): el estado
 * «cargando» lo anuncia el contenedor con `<SkeletonGroup label="…">`.
 */
export function Skeleton({
  ancho = "100%",
  alto,
  radio,
  linea = false,
  circulo = false,
  className,
  style,
}: {
  ancho?: number | string;
  /** Alto en px (o cualquier longitud CSS). Con `linea`, sale de la tipografía. */
  alto?: number | string;
  radio?: number | string;
  /** Una línea de texto: su alto sigue al tamaño de letra del contenedor. */
  linea?: boolean;
  circulo?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      aria-hidden
      className={cx("skel", linea && "skel--line", circulo && "skel--circle", className)}
      style={{ width: ancho, height: linea ? undefined : (alto ?? 12), borderRadius: radio, ...style }}
    />
  );
}

/** Varias líneas de texto; la última, más corta. */
export function SkeletonText({ lineas = 3, className }: { lineas?: number; className?: string }) {
  return (
    <span className={cx("skel-stack", className)} aria-hidden>
      {Array.from({ length: lineas }, (_, i) => (
        <Skeleton key={i} linea ancho={i === lineas - 1 && lineas > 1 ? "62%" : "100%"} />
      ))}
    </span>
  );
}

/** El contenedor que anuncia la carga: `role="status"` + `aria-busy`. */
export function SkeletonGroup({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={className} role="status" aria-busy="true" aria-label={label}>
      {children}
    </div>
  );
}
