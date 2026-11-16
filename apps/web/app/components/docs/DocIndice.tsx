import { IndiceActivo, type EntradaDeIndice } from "./IndiceActivo";

/**
 * EL ÍNDICE DE UNA PÁGINA DE LECTURA (paper, guía de migración, privacidad).
 *
 * Dos presentaciones del MISMO índice, y la hoja de estilos enseña una sola:
 *  · desde 1100px, un carril fijo a la izquierda que marca la sección actual;
 *  · por debajo, un `<details>` plegado al principio del texto, para que en un
 *    móvil el índice no empuje el contenido dos pantallas hacia abajo.
 * La que no toca va con `display: none`, así que tampoco existe para un lector
 * de pantalla: nunca hay dos navegaciones iguales a la vez.
 *
 * `lang` es el idioma de las ENTRADAS (los títulos del documento), que puede no
 * ser el de la interfaz: el paper y la guía están en inglés en los doce idiomas.
 */
export function DocIndice({
  titulo,
  entradas,
  lang,
}: {
  /** «Contenido», ya traducido al idioma de la interfaz. */
  titulo: string;
  entradas: readonly EntradaDeIndice[];
  lang?: string;
}) {
  return (
    <>
      <nav className="doc-toc doc-toc--carril" aria-label={titulo}>
        <p className="doc-toc-t">{titulo}</p>
        <IndiceActivo entradas={entradas} lang={lang} />
      </nav>
      <nav className="doc-toc doc-toc--plegable" aria-label={titulo}>
        <details>
          <summary>{titulo}</summary>
          <ol className="doc-toc-lista" lang={lang}>
            {entradas.map((e) => (
              <li key={e.id}>
                <a href={`#${e.id}`}>{e.texto}</a>
              </li>
            ))}
          </ol>
        </details>
      </nav>
    </>
  );
}
