"use client";

import type { ReactNode } from "react";

import { Tooltip } from "@/vendor/affectui/tooltip";

/**
 * UN TÉRMINO DEL PANEL CON SU DEFINICIÓN A MANO. «Acreditado», «sombra»,
 * «línea base», «referencia»… son palabras con un significado preciso aquí, y
 * hasta ahora había que ir a Cómo funciona para saberlo. Esto pone la
 * definición donde aparece la palabra: el Tooltip de affectUI, con ratón (al
 * posarse), con teclado (al enfocar) y con el dedo (un toque abre, otro
 * cierra).
 *
 * La definición NUNCA es el único sitio donde se dice algo necesario: la base
 * de cada cifra sigue escrita debajo. Es un botón sin acción —solo explica— y
 * por eso se marca con subrayado de puntos, no como un enlace.
 */
export function Termino({
  definicion,
  children,
  desnudo = false,
}: {
  definicion: string;
  children: ReactNode;
  /** Lo que envuelve ya es una pieza con su forma (una insignia): sin subrayado. */
  desnudo?: boolean;
}) {
  return (
    <Tooltip content={definicion} kind="definition" tapToggles delay={200} side="top" align="start">
      <button type="button" className={desnudo ? "termino termino-desnudo" : "termino"}>
        {children}
      </button>
    </Tooltip>
  );
}
