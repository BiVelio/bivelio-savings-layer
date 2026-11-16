import type { ReactNode } from "react";

/**
 * DOS MANERAS DE USAR SAVINGS — Community (el motor open source, en tu
 * infraestructura) frente a Savings Cloud (opcional). Guía §2.1 y §6, bloque 3.
 *
 * Son dos EJES distintos de «SDK o gateway»: aquí se compara dónde corre,
 * si hace falta cuenta, qué telemetría sale y cómo se gestiona. Las mismas
 * cuatro preguntas en las dos columnas, alineadas fila a fila (subgrid) para
 * que se comparen de un vistazo; en móvil, una tarjeta debajo de la otra.
 *
 * El camino local NO termina en el alta: sus acciones son instalar y leer el
 * código. Presentacional: todo el texto llega traducido.
 */
export type ManeraDeUso = {
  nombre: string;
  etiqueta: string;
  resumen: string;
  /** Las respuestas, en el MISMO orden que `preguntas`. */
  respuestas: string[];
  acciones: ReactNode;
  destacada?: boolean;
};

export function DosManeras({ preguntas, maneras }: { preguntas: string[]; maneras: [ManeraDeUso, ManeraDeUso] }) {
  return (
    <div className="maneras">
      {maneras.map((m) => (
        <article className="manera rv" key={m.nombre} data-cloud={m.destacada ? "" : undefined}>
          <header className="manera-cabeza">
            <span className="manera-etiqueta">{m.etiqueta}</span>
            <h3 className="manera-nombre">{m.nombre}</h3>
            <p className="manera-resumen">{m.resumen}</p>
          </header>
          <dl className="manera-filas">
            {preguntas.map((p, i) => (
              <div className="manera-fila" key={p}>
                <dt>{p}</dt>
                <dd>{m.respuestas[i]}</dd>
              </div>
            ))}
          </dl>
          <div className="manera-acciones">{m.acciones}</div>
        </article>
      ))}
    </div>
  );
}
