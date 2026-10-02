import { Fragment, type CSSProperties } from "react";

/**
 * Titular cinético: cada palabra sube y se desenfoca al cargar, escalonada
 * (el `<KineticText>` de bivelio.com, en CSS puro). Componente de servidor:
 * el texto completo va en el HTML, así que el LCP no espera a ningún script.
 * Para el lector de pantalla, la cadena íntegra va en un `sr-only` y las
 * palabras sueltas quedan ocultas. No en `aria-label`: sobre un <span> sin
 * rol está prohibido (axe `aria-prohibited-attr`) y los lectores lo ignoran,
 * así que el titular se leía palabra a palabra o no se leía.
 *
 * El espacio entre palabras va FUERA del recorte: dentro de un inline-block el
 * espacio final se colapsa y las palabras salían pegadas.
 */
export function KineticTitle({ text, start = 0, className = "" }: { text: string; start?: number; className?: string }) {
  const palabras = text.split(" ");
  return (
    <span className={className}>
      <span className="sr-only">{text}</span>
      {palabras.map((p, i) => (
        <Fragment key={i}>
          <span className="kw-clip" aria-hidden="true">
            <span className="kw" style={{ "--d": `${start + i * 55}ms` } as CSSProperties}>
              {p}
            </span>
          </span>
          {i < palabras.length - 1 ? " " : null}
        </Fragment>
      ))}
    </span>
  );
}
