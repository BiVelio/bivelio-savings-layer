import type { ReactNode } from "react";

import { cx } from "./cx";

/**
 * CABECERA DE SECCIÓN (marketing): antetítulo, titular editorial y entradilla,
 * con un lateral opcional (un enlace «ver todo», un selector) que en escritorio
 * se alinea a la derecha, sobre la línea base del texto.
 */
export type SectionHeadProps = {
  eyebrow?: string;
  titulo: ReactNode;
  /** Énfasis breve en serif cursiva tras el título. Nunca cifras. */
  acento?: string;
  lede?: ReactNode;
  lateral?: ReactNode;
  centrado?: boolean;
  /** Titular un punto más pequeño (subsecciones). */
  pequeno?: boolean;
  como?: "h2" | "h3";
  id?: string;
  className?: string;
};

export function SectionHead({ eyebrow, titulo, acento, lede, lateral, centrado = false, pequeno = false, como: Titular = "h2", id, className }: SectionHeadProps) {
  return (
    <div className={cx("section-head", centrado && "section-head--center", lateral ? "section-head--split" : null, className)}>
      <div className="section-head-main">
        {eyebrow ? <p className="kicker">{eyebrow}</p> : null}
        <Titular id={id} className={cx("editorial-title", pequeno && "editorial-title--sm")}>
          {titulo}
          {acento ? (
            <>
              {" "}
              <span className="serif-accent">{acento}</span>
            </>
          ) : null}
        </Titular>
        {lede ? <p className="lede-text">{lede}</p> : null}
      </div>
      {lateral ? <div className="section-head-aside">{lateral}</div> : null}
    </div>
  );
}
