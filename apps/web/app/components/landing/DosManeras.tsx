import type { ReactNode } from "react";

/**
 * DOS MANERAS DE USAR SAVINGS — Community (el motor open source, en tu
 * infraestructura) frente a Savings Cloud (opcional). Guía §2.1 y §6, bloque 3.
 *
 * Son dos EJES distintos de «SDK o gateway»: aquí se compara dónde corre, si
 * hace falta cuenta, qué telemetría sale y cómo se gestiona. Dos tarjetas
 * ricas (landing v2): icono, una ilustración pequeña —un terminal para el
 * motor local, un panel al que llegan tres máquinas para Cloud—, tres
 * requisitos en pastillas y las mismas cuatro preguntas alineadas fila a fila
 * (subgrid) para que se comparen de un vistazo.
 *
 * Las ilustraciones son decorativas (`aria-hidden`) y no llevan ninguna cifra:
 * el terminal enseña el comando real del paquete; el panel, solo formas.
 *
 * El camino local NO termina en el alta: sus acciones son instalar y leer el
 * código. Presentacional: todo el texto llega traducido.
 */
export type ManeraDeUso = {
  variante: "community" | "cloud";
  nombre: string;
  etiqueta: string;
  resumen: string;
  /** Tres requisitos cortos, en pastillas. */
  pastillas: string[];
  /** Las respuestas, en el MISMO orden que `preguntas`. */
  respuestas: string[];
  acciones: ReactNode;
};

const trazo = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" } as const;

/** Un icono por pregunta, en su orden: dónde corre, cuenta, telemetría, gestión. */
const ICONO_DE_PREGUNTA = [
  "M4 5.5h12v4H4zM4 11.5h12v4H4zM6.5 7.5h.01M6.5 13.5h.01",
  "M10 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM4.5 16.5a5.5 5.5 0 0 1 11 0",
  "M4 13.5a8.5 8.5 0 0 1 12 0M6.5 16a5 5 0 0 1 7 0M10 4v6",
  "M4 6h7M14 6h2M4 14h2M9 14h7M11 4.5v3M6 12.5v3",
] as const;

function Icono({ variante }: { variante: ManeraDeUso["variante"] }) {
  return (
    <span className="dm-icono" aria-hidden>
      <svg viewBox="0 0 24 24" width="22" height="22" {...trazo}>
        {variante === "community" ? (
          <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9zM4.5 7.8 12 12l7.5-4.2M12 12v8.6" />
        ) : (
          <path d="M7 18.5a4.5 4.5 0 0 1-.7-8.95 6 6 0 0 1 11.6 1.2A3.9 3.9 0 0 1 17 18.5zM9.5 15v-2M12 15v-4M14.5 15v-3" />
        )}
      </svg>
    </span>
  );
}

/** El motor en local: un terminal con el comando real del paquete. */
function Terminal() {
  return (
    <div className="dm-visual dm-term" aria-hidden>
      <div className="dm-term-barra">
        <i />
        <i />
        <i />
      </div>
      <pre className="dm-term-codigo">
        <span className="dm-term-p">$</span>
        {" pnpm add @bivelio/savings-layer\n"}
        <span className="dm-term-ok">✓</span>
        {" createSavingsLayer({ provider })\n"}
        <span className="dm-term-ok">✓</span>
        {" report.cost.netSavingsRatio"}
      </pre>
    </div>
  );
}

/** Cloud: tres máquinas que informan a un panel. Formas, sin cifras. */
function Panel() {
  return (
    <div className="dm-visual dm-panel" aria-hidden>
      <svg viewBox="0 0 320 96" preserveAspectRatio="xMidYMid meet" focusable="false">
        <g className="dm-panel-lineas">
          <path d="M58 20C96 20 100 48 138 48" />
          <path d="M58 48h80" />
          <path d="M58 76c38 0 42-28 80-28" />
        </g>
        <g className="dm-panel-nodos">
          <rect x="22" y="8" width="36" height="24" rx="7" />
          <rect x="22" y="36" width="36" height="24" rx="7" />
          <rect x="22" y="64" width="36" height="24" rx="7" />
        </g>
        <g className="dm-panel-puntos">
          <circle cx="40" cy="20" r="3" />
          <circle cx="40" cy="48" r="3" />
          <circle cx="40" cy="76" r="3" />
        </g>
        <rect className="dm-panel-hoja" x="138" y="8" width="160" height="80" rx="10" />
        <g className="dm-panel-filas">
          <rect x="152" y="22" width="52" height="6" rx="3" />
          <rect x="152" y="40" width="132" height="5" rx="2.5" />
          <rect x="152" y="53" width="104" height="5" rx="2.5" />
          <rect x="152" y="66" width="120" height="5" rx="2.5" />
        </g>
        <rect className="dm-panel-marca" x="262" y="20" width="22" height="10" rx="5" />
      </svg>
    </div>
  );
}

export function DosManeras({ preguntas, maneras }: { preguntas: string[]; maneras: [ManeraDeUso, ManeraDeUso] }) {
  return (
    <div className="dm">
      {maneras.map((m) => (
        <article className="dm-tarjeta rv" key={m.nombre} data-variante={m.variante}>
          <header className="dm-cabeza">
            <div className="dm-cabeza-fila">
              <Icono variante={m.variante} />
              <span className="dm-etiqueta">{m.etiqueta}</span>
            </div>
            <h3 className="dm-nombre">{m.nombre}</h3>
            <p className="dm-resumen">{m.resumen}</p>
          </header>
          {m.variante === "community" ? <Terminal /> : <Panel />}
          <ul className="dm-pastillas">
            {m.pastillas.map((p) => (
              <li key={p}>
                <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden focusable="false" {...trazo} strokeWidth={1.8}>
                  <path d="m3.5 8.5 3 3 6-7" />
                </svg>
                {p}
              </li>
            ))}
          </ul>
          <dl className="dm-filas">
            {preguntas.map((p, i) => (
              <div className="dm-fila" key={p}>
                <dt>
                  <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden focusable="false" {...trazo}>
                    <path d={ICONO_DE_PREGUNTA[i % ICONO_DE_PREGUNTA.length]} />
                  </svg>
                  {p}
                </dt>
                <dd>{m.respuestas[i]}</dd>
              </div>
            ))}
          </dl>
          <div className="dm-acciones">{m.acciones}</div>
        </article>
      ))}
    </div>
  );
}
