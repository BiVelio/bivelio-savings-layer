import type { ReactNode } from "react";

import { GradientFloor } from "@/vendor/affectui/gradient-floor";

/**
 * EL CIERRE (guía §6, bloque 10): empezar con Measure + acceso al repositorio,
 * sobre el Gradient Floor de affectUI — un resplandor tenue, pegado al borde
 * inferior y casi quieto (`speed={0}`: la forma no se mueve; solo deriva de lado
 * muy despacio, y nada con movimiento reducido). Es la única animación
 * ambiental de este tramo de la página y no hay ninguna cifra encima.
 */
export function CierreMeasure({ titulo, acento, texto, acciones, nota }: { titulo: string; acento?: string; texto: string; acciones: ReactNode; nota?: ReactNode }) {
  return (
    <GradientFloor speed={0} className="cierre">
      <div className="cierre-in">
        <h2 className="cierre-titulo">
          {titulo}
          {acento ? (
            <>
              {" "}
              <span className="serif-accent">{acento}</span>
            </>
          ) : null}
        </h2>
        <p className="cierre-texto">{texto}</p>
        <div className="cierre-acciones">{acciones}</div>
        {nota ? <p className="cierre-nota">{nota}</p> : null}
      </div>
    </GradientFloor>
  );
}
