import { Fragment, type CSSProperties } from "react";

/**
 * Titular cinético: cada palabra sube y se desenfoca al cargar, escalonada
 * (el `<KineticText>` de bivelio.com, en CSS puro). Componente de servidor:
 * el texto completo va en el HTML, así que el LCP no espera a ningún script,
 * y la cadena íntegra queda en `aria-label` mientras las palabras sueltas
 * quedan ocultas al lector de pantalla.
 *
 * El espacio entre palabras va FUERA del recorte: dentro de un inline-block el
 * espacio final se colapsa y las palabras salían pegadas.
 */
export function KineticTitle({ text, start = 0, className = "" }: { text: string; start?: number; className?: string }) {
  const palabras = text.split(" ");
  return (
    <span className={className} aria-label={text}>
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
