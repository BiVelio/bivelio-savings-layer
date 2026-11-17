"use client";

import { useEffect } from "react";

/**
 * EN MÓVIL LA TIRA DEL RAÍL SE NOTA DESLIZABLE (dueño, 2026-11-17): un
 * difuminado en el borde por el que queda más menú. Esto solo dice POR CUÁL:
 * escribe `data-bordes` en `.app-nav` («fin», «ini», «ambos» o «ninguno») y el
 * CSS de `panel.css` pone la máscara. Sin JavaScript —o antes de hidratar— la
 * tira lleva el difuminado del final, que es el caso de casi todo móvil.
 *
 * No pinta nada. En escritorio el raíl es una columna sin desplazamiento
 * horizontal y el atributo sale «ninguno», que no casa con ninguna máscara.
 */
export function BordesDeLaTira() {
  useEffect(() => {
    const tira = document.querySelector<HTMLElement>(".app-nav");
    if (!tira) return;
    const mide = () => {
      const sobra = tira.scrollWidth - tira.clientWidth;
      const ini = tira.scrollLeft > 4;
      const fin = sobra > 4 && tira.scrollLeft < sobra - 4;
      tira.dataset.bordes = ini && fin ? "ambos" : ini ? "ini" : fin ? "fin" : "ninguno";
    };
    mide();
    tira.addEventListener("scroll", mide, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(mide);
    ro?.observe(tira);
    return () => {
      tira.removeEventListener("scroll", mide);
      ro?.disconnect();
    };
  }, []);
  return null;
}
