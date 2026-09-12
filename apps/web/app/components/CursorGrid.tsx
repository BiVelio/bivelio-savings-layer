"use client";

import { useEffect, useRef } from "react";

/**
 * Retícula de marca que solo se revela en un círculo alrededor del cursor —
 * el mismo efecto que el `<CursorGrid>` de bivelio.com, portado sin la
 * dependencia de motion/react: una máscara radial en CSS y un único listener
 * pasivo de `pointermove` que mueve dos variables.
 *
 * Fija y detrás del contenido; solo con puntero fino (ratón/trackpad), nunca
 * en táctil; y apagada bajo prefers-reduced-motion. Hasta que el puntero se
 * mueve, la máscara está fuera de pantalla y no se ve nada.
 */
export function CursorGrid() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof window === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (!window.matchMedia("(pointer: fine)").matches) return;
    el.classList.add("on");
    const move = (e: PointerEvent) => {
      el.style.setProperty("--gx", `${e.clientX}px`);
      el.style.setProperty("--gy", `${e.clientY}px`);
    };
    window.addEventListener("pointermove", move, { passive: true });
    return () => window.removeEventListener("pointermove", move);
  }, []);

  return <div ref={ref} aria-hidden="true" className="lp-grid" />;
}
