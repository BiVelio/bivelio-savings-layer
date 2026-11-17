import type { ReactNode } from "react";

import { Marcado } from "@/app/components/campana/Marcado";
import { MosaicoDeLlamadas } from "@/app/components/campana/MosaicoDeLlamadas";
import { GradientFloor } from "@/vendor/affectui/gradient-floor";

/**
 * EL CIERRE (guía §6, bloque 10): empezar con Measure + acceso al repositorio,
 * sobre el Gradient Floor de affectUI — un resplandor tenue, pegado al borde
 * inferior y casi quieto (`speed={0}`: la forma no se mueve; solo deriva de lado
 * muy despacio, y nada con movimiento reducido). Es la única animación
 * ambiental de este tramo de la página y no hay ninguna cifra encima.
 *
 * FIRMA DE CAMPAÑA (2026-11-17): la tarjeta adopta la composición de la pieza
 * promocional — el acento en serif con su marcador cian, un filete con el
 * dominio a la izquierda y la píldora de precio a la derecha (`firma`), y el
 * mosaico de llamadas pegado al borde inferior, sobre el resplandor.
 */
export function CierreMeasure({
  titulo,
  acento,
  marca,
  texto,
  acciones,
  nota,
  firma,
}: {
  titulo: string;
  acento?: string;
  /** La palabra del acento que lleva el marcador (por defecto, la última). */
  marca?: string;
  texto: string;
  acciones: ReactNode;
  nota?: ReactNode;
  /** El lado derecho de la firma (la píldora de precio). Sin él no hay firma. */
  firma?: ReactNode;
}) {
  return (
    <GradientFloor speed={0} className="cierre">
      <div className="cierre-in">
        <h2 className="cierre-titulo">
          {titulo}
          {acento ? (
            <>
              {" "}
              <span className="serif-accent">
                <Marcado texto={acento} marca={marca} />
              </span>
            </>
          ) : null}
        </h2>
        <p className="cierre-texto">{texto}</p>
        <div className="cierre-acciones">{acciones}</div>
        {nota ? <p className="cierre-nota">{nota}</p> : null}
        {firma ? (
          <div className="firma-campana cierre-firma">
            <span className="firma-dominio">savings.bivelio.com</span>
            {firma}
          </div>
        ) : null}
      </div>
      <MosaicoDeLlamadas semilla={23} filas={5} className="cierre-mosaico" />
    </GradientFloor>
  );
}
