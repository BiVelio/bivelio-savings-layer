"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * El marco de «Savings Layer, en acción»: la única parte con script.
 *
 * Toda la ilustración es HTML del servidor y se anima con CSS; aquí solo vive
 * lo que CSS no puede decidir: el botón de pausa (WCAG 2.2.2) y parar el bucle
 * cuando la figura sale de pantalla. Los dos se expresan como atributos
 * (`data-pausa`, `data-fuera`) que la hoja traduce a `animation-play-state`.
 * Sin script la figura se anima igual y se detiene al pasar el ratón o al
 * enfocarla con el teclado; con `prefers-reduced-motion` no hay bucle y el
 * botón no se pinta.
 */
export function CapaMarco({
  etiqueta,
  pausar,
  reanudar,
  pasos,
  children,
}: {
  etiqueta: string;
  pausar: string;
  reanudar: string;
  /** La lista ordenada de pasos: va en la cabecera, junto al botón. */
  pasos: ReactNode;
  children: ReactNode;
}) {
  const figura = useRef<HTMLElement>(null);
  const [pausa, setPausa] = useState(false);

  useEffect(() => {
    const el = figura.current;
    if (!el || !("IntersectionObserver" in window)) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e) el.toggleAttribute("data-fuera", !e.isIntersecting);
      },
      { threshold: 0.05 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <figure ref={figura} className="capa rv" aria-label={etiqueta} data-pausa={pausa ? "" : undefined}>
      <div className="capa-cabeza">
        {pasos}
        <button type="button" className="capa-pausa" onClick={() => setPausa((p) => !p)}>
          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true" focusable="false">
            {pausa ? <path d="M4.5 2.8v10.4a.6.6 0 0 0 .92.5l8.1-5.2a.6.6 0 0 0 0-1l-8.1-5.2a.6.6 0 0 0-.92.5Z" /> : <path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z" />}
          </svg>
          {pausa ? reanudar : pausar}
        </button>
      </div>
      {children}
    </figure>
  );
}
