import type { ReactNode } from "react";

import { cx } from "./cx";

/**
 * DE DÓNDE SALE UNA CIFRA. Va junto a cada cifra de ahorro, sin excepción.
 *
 *  - `ab-sdk`          A/B real con el SDK instalado (grupo de control y tratado).
 *  - `replay-gateway`  Tráfico grabado y repetido a través del gateway.
 *  - `tus-datos`       Medido en la cuenta de quien mira (su propio tráfico).
 *  - `benchmark`       Banco público reproducible (/benchmarks).
 *  - `sintetico`       Carga sintética: forma real, datos de laboratorio.
 *  - `estimacion`      Cálculo, no medición.
 *  - `sombra`          Modo sombra: lo que se habría ahorrado, sin aplicarlo.
 *
 * El texto llega por `label` (traducido por quien lo usa; hay etiquetas listas
 * en el espacio `ui.evidence.*`). El tipo se distingue por color contenido Y
 * por un glifo propio, así que también se lee en gris.
 */
export type TipoDeEvidencia = "ab-sdk" | "replay-gateway" | "sintetico" | "estimacion" | "sombra" | "benchmark" | "tus-datos";

/** La clave de `ui.evidence.*` que corresponde a cada tipo. */
export const CLAVE_DE_EVIDENCIA = {
  "ab-sdk": "abSdk",
  "replay-gateway": "replayGateway",
  sintetico: "sintetico",
  estimacion: "estimacion",
  sombra: "sombra",
  benchmark: "benchmark",
  "tus-datos": "tusDatos",
} as const satisfies Record<TipoDeEvidencia, string>;

const TRAZO = { fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round" } as const;

const GLIFOS: Record<TipoDeEvidencia, ReactNode> = {
  // Dos ramas que salen del mismo punto: control y tratado.
  "ab-sdk": <path {...TRAZO} d="M2 6h2.5M4.5 6c1.5 0 1.5-3 3-3H10M4.5 6c1.5 0 1.5 3 3 3H10" />,
  // Flecha que vuelve sobre sí misma: se repite lo grabado.
  "replay-gateway": <path {...TRAZO} d="M9.6 4.2A4 4 0 1 0 10 6.6M9.8 1.8v2.6H7.2" />,
  // Una persona: es tu tráfico.
  "tus-datos": <path {...TRAZO} d="M6 5.6a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8zM2.4 10.2c.4-1.8 1.8-2.8 3.6-2.8s3.2 1 3.6 2.8" />,
  // Tres barras: banco comparativo.
  benchmark: <path {...TRAZO} d="M2.5 10V6.5M6 10V2.5M9.5 10V5" />,
  // Matraz: laboratorio.
  sintetico: <path {...TRAZO} d="M4.6 1.8h2.8M5.2 1.8v3L2.6 9.4a.6.6 0 0 0 .5.9h5.8a.6.6 0 0 0 .5-.9L6.8 4.8v-3" />,
  // Tilde de «aproximadamente».
  estimacion: <path {...TRAZO} d="M2 4.6c1.3-1.4 2.6-1.4 4 0s2.7 1.4 4 0M2 8c1.3-1.4 2.6-1.4 4 0s2.7 1.4 4 0" />,
  // Círculo a medias: lo que habría pasado.
  sombra: <path {...TRAZO} strokeDasharray="1.6 1.9" d="M6 1.8a4.2 4.2 0 1 0 0 8.4 4.2 4.2 0 0 0 0-8.4z" />,
};

export function EvidenceBadge({
  tipo,
  label,
  pequeno = false,
  title,
  className,
}: {
  tipo: TipoDeEvidencia;
  /** Texto visible, ya traducido. */
  label: string;
  /** Variante de 18px para filas densas (tablas, recibo compacto). */
  pequeno?: boolean;
  /** Explicación larga opcional (tooltip nativo). Nunca la única vía de leerla. */
  title?: string;
  className?: string;
}) {
  return (
    <span className={cx("ev-badge", pequeno && "ev-badge--sm", className)} data-kind={tipo} title={title}>
      <svg viewBox="0 0 12 12" aria-hidden focusable="false">
        {GLIFOS[tipo]}
      </svg>
      {label}
    </span>
  );
}
