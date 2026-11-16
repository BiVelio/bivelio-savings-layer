import type { ReactNode } from "react";

import { cx } from "./cx";

/**
 * CABECERA DE PÁGINA DE MARKETING (precios, resultados, privacidad, paper…).
 *
 * Antetítulo con filete azul, titular editorial (Plus Jakarta Sans 800) con un
 * énfasis opcional en Instrument Serif cursiva, entradilla y acciones.
 *
 * `acento` es SOLO para dos o tres palabras de texto: nunca una cifra, un
 * precio ni un porcentaje. NO usar en el panel: allí la cabecera es `PageHead`
 * (Geist 600).
 */
export type PageHeaderProps = {
  eyebrow?: string;
  titulo: ReactNode;
  /** Énfasis breve en serif cursiva, pintado tras el título. */
  acento?: string;
  /** El acento va en su propia línea. */
  acentoEnLinea?: boolean;
  lede?: ReactNode;
  acciones?: ReactNode;
  centrado?: boolean;
  /** Tamaño del titular: `xl` solo para la portada. */
  tamano?: "lg" | "xl";
  /** Nivel del titular. Una página tiene UN h1. */
  como?: "h1" | "h2";
  id?: string;
  className?: string;
};

export function PageHeader({ eyebrow, titulo, acento, acentoEnLinea = false, lede, acciones, centrado = false, tamano = "lg", como: Titular = "h1", id, className }: PageHeaderProps) {
  return (
    <header className={cx("page-header", centrado && "page-header--center", className)}>
      {eyebrow ? <p className="kicker">{eyebrow}</p> : null}
      <Titular id={id} className={cx("editorial-title", tamano === "xl" ? "editorial-title--xl" : "editorial-title--lg")}>
        {titulo}
        {acento ? (
          <>
            {acentoEnLinea ? <br /> : " "}
            <span className="serif-accent">{acento}</span>
          </>
        ) : null}
      </Titular>
      {lede ? <p className="lede-text">{lede}</p> : null}
      {acciones ? <div className="page-header-actions">{acciones}</div> : null}
    </header>
  );
}
