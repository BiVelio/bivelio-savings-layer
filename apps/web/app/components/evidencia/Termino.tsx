"use client";

import type { ReactNode } from "react";

import { HoverCard } from "@/vendor/affectui/hover-card";
import { Tooltip } from "@/vendor/affectui/tooltip";

/**
 * UN TÉRMINO ESTADÍSTICO CON SU DEFINICIÓN — el Tooltip de affectUI, usado
 * donde una palabra («intervalo», «muestra», «cobertura») decide cómo se lee
 * una cifra.
 *
 * El término es un botón de verdad: se alcanza con el tabulador (la definición
 * aparece al enfocarlo), con el ratón al pasar y, a diferencia del tooltip de
 * fábrica, también al TOCARLO: en un móvil no hay «pasar por encima» y una
 * definición que solo existe para quien tiene ratón no explica nada.
 *
 * La definición nunca es el único sitio donde está un dato: es texto de apoyo.
 */
export function Termino({ children, definicion }: { children: ReactNode; definicion: ReactNode }) {
  return (
    <Tooltip content={definicion} toggleOnClick delay={200} className="termino-tip">
      <button type="button" className="termino">
        {children}
      </button>
    </Tooltip>
  );
}

/** La misma definición detrás de un «?» pequeño, para una cabecera cuyo texto ya es un botón (ordenar). */
export function AyudaDeTermino({ etiqueta, definicion }: { etiqueta: string; definicion: ReactNode }) {
  return (
    <Tooltip content={definicion} toggleOnClick delay={200} className="termino-tip">
      <button type="button" className="termino-q" aria-label={etiqueta}>
        <svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="7" cy="7" r="5.6" />
          <path d="M5.5 5.5a1.6 1.6 0 1 1 2.3 1.4c-.5.3-.8.6-.8 1.2M7 10.1v.1" />
        </svg>
      </button>
    </Tooltip>
  );
}

/**
 * EL DETALLE DE UNA FILA O DE UN LIBRO — la Hover Card de affectUI. Se abre al
 * pasar, al enfocar y al tocar (el disparador es un botón sin otra acción), y
 * su contenido es siempre un RESUMEN de algo que la página ya enseña en otra
 * parte: nada vive solo dentro de la tarjeta.
 */
export function Detalle({ children, contenido, nombre, className }: { children: ReactNode; contenido: ReactNode; nombre: string; className?: string }) {
  return (
    <HoverCard content={contenido} label={nombre} toggleOnClick openDelay={250} closeDelay={200} width={300}>
      <button type="button" className={className ? `detalle ${className}` : "detalle"}>
        {children}
        <svg className="detalle-ic" viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M3 4.5 6 7.5 9 4.5" />
        </svg>
      </button>
    </HoverCard>
  );
}
