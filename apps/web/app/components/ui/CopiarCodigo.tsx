"use client";

import { useEffect, useState } from "react";

/**
 * Botón de copiar del marco de código. Mismo comportamiento que el
 * `CopyButton` del panel (portapapeles + confirmación breve), con dos
 * diferencias: las etiquetas llegan por props —así sirve en cualquier espacio
 * de mensajes— y la confirmación se anuncia en una región viva, porque el
 * cambio de nombre de un botón no lo lee ningún lector de pantalla.
 *
 * NO es el contenedor de una credencial: una service key real conserva su
 * control propio de copia y visibilidad única.
 */
export function CopiarCodigo({ texto, etiqueta, etiquetaCopiado }: { texto: string; etiqueta: string; etiquetaCopiado: string }) {
  const [copiado, setCopiado] = useState(false);

  useEffect(() => {
    if (!copiado) return;
    const t = window.setTimeout(() => setCopiado(false), 1600);
    return () => window.clearTimeout(t);
  }, [copiado]);

  return (
    <>
      <button
        type="button"
        className="codeframe-copy"
        data-copied={copiado ? "" : undefined}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(texto);
            setCopiado(true);
          } catch {
            /* portapapeles no disponible: el texto sigue seleccionable */
          }
        }}
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
          {copiado ? (
            <path d="M3.5 8.4 6.6 11.3 12.5 4.9" />
          ) : (
            <>
              <rect x="5.5" y="5.5" width="8.5" height="8.5" rx="2" />
              <path d="M10.5 3.75v-.25A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h.25" />
            </>
          )}
        </svg>
        {copiado ? etiquetaCopiado : etiqueta}
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {copiado ? etiquetaCopiado : ""}
      </span>
    </>
  );
}
