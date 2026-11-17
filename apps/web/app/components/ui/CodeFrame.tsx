import type { ReactNode } from "react";

import { CopiarCodigo } from "./CopiarCodigo";
import { cx } from "./cx";

/**
 * MARCO DE CÓDIGO — el acabado del Code Block de affectUI alrededor del
 * contenido de siempre.
 *
 *  - Cabecera discreta: etiqueta o nombre de fichero, hueco para pestañas
 *    (el selector de sistema operativo, p. ej.) y copiar.
 *  - Cuerpo: pinta `children` TAL CUAL. Los tests fijan el marcado interior
 *    (`<span className="k">bvsala</span> …`), así que aquí no se tokeniza ni
 *    se reescribe nada. El scroll horizontal queda DENTRO del bloque.
 *  - Pie opcional con la salida esperada, junto al comando.
 *  - Números de línea solo para ejemplos largos (`lineas`); una instalación
 *    de una línea sigue siendo compacta.
 *
 * Es de servidor; solo el botón de copiar es una isla de cliente. Para un
 * ejemplo LARGO que necesita coloreado automático o una línea resaltada, pon
 * dentro `<pre><CodeLines code language /></pre>`, el motor de la pieza
 * vendorizada `@/vendor/affectui/code-block-clean` (también de servidor).
 */
export type CodeFrameProps = {
  children: ReactNode;
  /** Etiqueta o nombre de fichero de la cabecera. */
  etiqueta?: string;
  /** Hueco de pestañas en la cabecera (sustituye visualmente a la etiqueta si no hay sitio). */
  pestanas?: ReactNode;
  /** Activa el botón de copiar. `texto` es lo que se copia, exactamente. */
  copiar?: { texto: string; etiqueta: string; etiquetaCopiado: string };
  /** Salida esperada, al pie. */
  salida?: { etiqueta: string; contenido: ReactNode };
  /** Número de líneas a numerar. Sin él, no hay columna de números. */
  lineas?: number;
  /** Las líneas largas parten en vez de hacer scroll. */
  ajustar?: boolean;
  /** Nombre accesible de la región con scroll. Por defecto, la etiqueta. */
  ariaLabel?: string;
  className?: string;
};

export function CodeFrame({ children, etiqueta, pestanas, copiar, salida, lineas, ajustar = false, ariaLabel, className }: CodeFrameProps) {
  const conCabecera = Boolean(etiqueta || pestanas || copiar);
  const nombre = ariaLabel ?? etiqueta;
  const numeros = lineas && lineas > 1 ? Array.from({ length: lineas }, (_, i) => i + 1).join("\n") : null;

  return (
    <figure className={cx("codeframe", ajustar && "codeframe--wrap", className)}>
      {conCabecera ? (
        <figcaption className="codeframe-head">
          {etiqueta ? <span className="codeframe-label">{etiqueta}</span> : null}
          {pestanas ? <div className="codeframe-tabs">{pestanas}</div> : <span className="codeframe-spacer" />}
          {copiar ? <CopiarCodigo {...copiar} /> : null}
        </figcaption>
      ) : null}
      {/* tabIndex: una región con scroll debe poder recorrerse con el teclado. */}
      <div className="codeframe-body" tabIndex={0} role="group" aria-label={nombre}>
        {numeros ? (
          <pre className="codeframe-nums" aria-hidden>
            {numeros}
          </pre>
        ) : null}
        <div className="codeframe-code">{children}</div>
      </div>
      {salida ? (
        <div className="codeframe-out">
          <span className="codeframe-out-k">{salida.etiqueta}</span>
          <div className="codeframe-out-v">{salida.contenido}</div>
        </div>
      ) : null}
    </figure>
  );
}
