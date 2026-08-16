"use client";

import { useState } from "react";

/**
 * Selector de modelo sobre las cifras medidas.
 *
 * POR QUE EXISTE: un porcentaje sin su modelo al lado no significa nada, y esto
 * no es teoria — la misma palanca (el codebook de salida) se midio el mismo dia
 * en -8,2% con gpt-4o-mini y +8,0% con gpt-4o. Enseñar una sola cifra obligaba a
 * elegir un modelo y callar los otros dos.
 *
 * Solo pinta modelos con tirada PROBADA. Uno cuya verja de calidad no paso no se
 * puede anunciar como ahorro, asi que no entra en el selector: aparece en la
 * lista de lo medido-pero-no-publicable, con su motivo.
 */
export interface LibroMedido {
  ledger: string;
  savings: { point: number; lower: number; upper: number };
}
export interface ModeloMedido {
  model: string;
  marca: string;
  aggregate: { savings: { point: number; lower: number; upper: number }; proven: boolean; qualityPassRate: number };
  ledgers: LibroMedido[];
}

const pct = (n: number): string => `${(n * 100).toFixed(1).replace(".", ",")} %`;

export function SelectorDeModelo({
  modelos,
  etiquetas,
}: {
  modelos: ModeloMedido[];
  etiquetas: { titular: string; suelo: string; calidad: string; libro: Record<string, string>; sinLibro: string };
}) {
  const [i, setI] = useState(0);
  if (modelos.length === 0) return null;
  const m = modelos[Math.min(i, modelos.length - 1)]!;

  return (
    <div className="selmod">
      <div className="selmod-tabs" role="tablist" aria-label="modelo">
        {modelos.map((x, k) => (
          <button
            key={x.model}
            role="tab"
            aria-selected={k === i}
            className={`selmod-tab${k === i ? " on" : ""}`}
            onClick={() => setI(k)}
            type="button"
          >
            <b>{x.marca}</b>
            <code>{x.model.replace(/^[^/]+\//, "")}</code>
          </button>
        ))}
      </div>

      <div className="selmod-panel" role="tabpanel">
        <div className="selmod-titular">
          <span className="selmod-n">{pct(m.aggregate.savings.lower)}</span>
          <span className="selmod-q">
            {etiquetas.titular}
            <em>
              {etiquetas.suelo} · {etiquetas.calidad.replace("{n}", pct(m.aggregate.qualityPassRate))}
            </em>
          </span>
        </div>

        <div className="selmod-libros">
          {m.ledgers.filter((l) => l.savings.lower > 0).map((l) => (
            <div className="selmod-libro" key={l.ledger}>
              <span className="lb-n">{pct(l.savings.lower)}</span>
              <span className="lb-t">{etiquetas.libro[l.ledger] ?? l.ledger}</span>
            </div>
          ))}
          {m.ledgers.filter((l) => l.savings.lower > 0).length === 0 && (
            <p className="selmod-vacio">{etiquetas.sinLibro}</p>
          )}
        </div>
      </div>
    </div>
  );
}
