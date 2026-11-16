"use client";

import type { ReactNode } from "react";

/**
 * «Imprimir o guardar como PDF»: abre el diálogo de impresión del navegador,
 * que es la forma de llevarse en PDF la edición que se está leyendo (la hoja
 * de estilos ya tiene su `@media print`).
 */
export function BotonImprimir({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <button type="button" className={className} onClick={() => window.print()}>
      {children}
    </button>
  );
}
