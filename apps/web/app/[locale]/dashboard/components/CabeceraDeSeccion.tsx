import type { ReactNode } from "react";

/**
 * LA CABECERA DE SECCIÓN DEL RESUMEN con la Firma de campaña (dirección A):
 * rótulo entre filetes, título en Plus Jakarta y, si `acento`, la segunda
 * mitad del título en serif cursiva («Lo que estás ahorrando, *medido con tu
 * propio tráfico*»). Lo que va a la derecha del título (`aside`) se alinea con
 * su línea base.
 *
 * EL ACENTO NO SE ESCRIBE EN LOS TEXTOS: se parte el título que ya hay en su
 * pausa —la primera «, » o « — »/« – »—, sin cambiar una letra, así que vale en
 * los doce idiomas sin tocar un catálogo. Sin pausa, el título va entero en
 * una voz.
 */
export function partirEnLaPausa(texto: string): { antes: string; pausa: string; despues: string } | null {
  const m = /^(.+?)(,\s+|\s+[—–]\s+)(\S.*)$/u.exec(texto);
  if (!m) return null;
  return { antes: m[1]!, pausa: m[2]!, despues: m[3]! };
}

export function CabeceraDeSeccion({
  rotulo,
  titulo,
  acento = false,
  aside,
  id,
}: {
  rotulo: ReactNode;
  titulo: string;
  /** Partir el título en su pausa y poner la segunda mitad en serif cursiva. */
  acento?: boolean;
  aside?: ReactNode;
  id?: string;
}) {
  const partes = acento ? partirEnLaPausa(titulo) : null;
  const h2 = (
    <h2 className="pfc-sec-t" id={id}>
      {partes ? (
        <>
          {partes.antes}
          {partes.pausa}
          <em>{partes.despues}</em>
        </>
      ) : (
        titulo
      )}
    </h2>
  );
  return (
    <div className="pfc-sec-cab pfr-sec-cab">
      <p className="pfc-rotulo">{rotulo}</p>
      {aside ? (
        <div className="pfc-sec-fila">
          {h2}
          {aside}
        </div>
      ) : (
        h2
      )}
    </div>
  );
}
