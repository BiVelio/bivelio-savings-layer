import type { ReactNode } from "react";

/**
 * LA CABECERA DE PÁGINA DEL PANEL CON LA FIRMA DE CAMPAÑA (dirección A,
 * elegida por el dueño el 2026-11-17). Sustituye a `PageHead` pantalla a
 * pantalla: rótulo espaciado entre filetes («CUENTA ────»), titular en Plus
 * Jakarta Sans 800 con el MARCADOR cian detrás de su última palabra, y la
 * entradilla en Instrument Serif cursiva.
 *
 * EL MARCADOR NO SE ESCRIBE EN LOS TEXTOS. Va detrás de la última palabra del
 * título, sin la puntuación final, y se calcula aquí (`partirTitular`): así
 * vale en los doce idiomas sin tocar un catálogo, y un traductor no puede
 * romperlo. Si el título no es una cadena (ya trae marcado propio), se pinta
 * tal cual.
 *
 * El cielo cian NO va aquí: es del área de contenido entera y lo pone el
 * layout del panel (`.pfc-cielo`), detrás de todo.
 */
export function CabeceraDePagina({
  rotulo,
  titulo,
  entradilla,
  aside,
  children,
  role,
  id,
}: {
  /** El rótulo entre filetes. Va en TODAS las ramas de una pantalla. */
  rotulo?: ReactNode;
  /** El titular. Una cadena para que lleve el marcador en su última palabra. */
  titulo: ReactNode;
  /** La entradilla en serif cursiva. */
  entradilla?: ReactNode;
  /** Lo que se alinea a la derecha del rótulo (controles, una píldora). */
  aside?: ReactNode;
  /** Lo que sigue a la entradilla dentro de la cabecera (avisos, acciones). */
  children?: ReactNode;
  role?: "alert";
  /** Para `aria-labelledby` desde fuera. */
  id?: string;
}) {
  return (
    <header className="pfc-cab" role={role}>
      {rotulo || aside ? (
        <div className={aside ? "pfc-cab-arriba" : undefined}>
          {rotulo ? <p className="pfc-rotulo">{rotulo}</p> : null}
          {aside ? <div className="pfc-cab-aside">{aside}</div> : null}
        </div>
      ) : null}
      <h1 className="pfc-titular" id={id}>
        {typeof titulo === "string" ? <TitularMarcado texto={titulo} /> : titulo}
      </h1>
      {entradilla ? <p className="pfc-entradilla">{entradilla}</p> : null}
      {children}
    </header>
  );
}

/** El titular con el marcador detrás de su última palabra. */
export function TitularMarcado({ texto }: { texto: string }) {
  const { antes, marcada, despues } = partirTitular(texto);
  if (!marcada) return <>{texto}</>;
  return (
    <>
      {antes}
      <span className="mk">{marcada}</span>
      {despues}
    </>
  );
}

/**
 * Parte un titular en `antes` + `marcada` + `despues`: la marcada es la última
 * palabra (separada por espacio), sin la puntuación que la cierra («.», «…»,
 * «!», «?», «:», «»», «)»…), que va en `despues`. Los doce idiomas del panel
 * separan las palabras con espacios; un título sin espacios se marca entero.
 * Un título de solo puntuación o vacío no se marca.
 */
export function partirTitular(texto: string): { antes: string; marcada: string; despues: string } {
  // Lo que cierra el titular: puntuación de cierre o final («.», «…», «!»,
  // «?», «:», «»», «)»…) y los espacios entre medias («Prêt ?» en francés).
  const cola = /[\s\p{Po}\p{Pe}\p{Pf}]*$/u.exec(texto)?.[0] ?? "";
  const cuerpo = texto.slice(0, texto.length - cola.length);
  const corte = cuerpo.search(/\S+$/u);
  if (corte < 0) return { antes: texto, marcada: "", despues: "" };
  // Un signo de apertura pegado a la palabra («¿», «¡», «(», «"») se queda fuera del bloque.
  const palabra = cuerpo.slice(corte);
  const apertura = /^[\p{Ps}\p{Pi}\p{Po}]*/u.exec(palabra)?.[0] ?? "";
  const marcada = palabra.slice(apertura.length);
  if (!/[\p{L}\p{N}]/u.test(marcada)) return { antes: texto, marcada: "", despues: "" };
  return { antes: cuerpo.slice(0, corte) + apertura, marcada, despues: cola };
}
