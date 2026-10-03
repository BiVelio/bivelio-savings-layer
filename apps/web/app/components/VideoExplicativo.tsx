"use client";

import { useEffect, useRef } from "react";

/**
 * Animación explicativa de la sección «En palabras normales»: un MP4 corto,
 * mudo y en bucle que solo se reproduce mientras está a la vista.
 *
 * NADA SE DESCARGA HASTA QUE EL VÍDEO SE VE. Hasta la 0.5.0 el elemento
 * llevaba `autoPlay` en el HTML, y el autoplay nativo pasa por encima de
 * `preload="metadata"`: los cinco MP4 (~3,4 MB de los ~4,5 MB de la portada)
 * se bajaban enteros al cargar /<idioma>, también en el móvil de quien nunca
 * llega a la sección (Lighthouse móvil, 02-10-2026). Ahora sale con
 * `preload="none"` y solo el póster; el IntersectionObserver es quien, al
 * entrar en el viewport, enciende `autoplay`, pide los datos y llama a play().
 *
 * Se conserva el autoplay NATIVO —encendido por propiedad, no en el HTML—
 * porque el primer play() programático de la página puede rechazarse en
 * silencio (visto en prod); el autoplay de un vídeo silenciado no depende de
 * él. El observer sigue pausando lo que sale de la vista.
 *
 * Los vídeos no llevan texto ni voz: la web se sirve en 12 idiomas y la
 * explicación hablada vive en los mensajes, no dentro del MP4.
 */
export function VideoExplicativo({ src, poster, etiqueta }: { src: string; poster: string; etiqueta: string }) {
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    // React no siempre baja `muted` al atributo en la hidratación (bug viejo de
    // react-dom); sin él, el navegador bloquea el play() sin gesto del usuario.
    video.muted = true;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            video.autoplay = true;
            video.preload = "auto";
            void video.play().catch(() => {});
          } else video.pause();
        }
      },
      { threshold: 0.35 },
    );
    observer.observe(video);
    return () => observer.disconnect();
  }, []);

  return (
    <video
      ref={ref}
      className="explica-video"
      src={src}
      poster={poster}
      muted
      loop
      playsInline
      preload="none"
      aria-label={etiqueta}
    />
  );
}
