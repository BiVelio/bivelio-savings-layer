"use client";

import { useEffect, useRef } from "react";

/**
 * Animación explicativa de la sección «En palabras normales»: un MP4 corto,
 * mudo y en bucle que solo se reproduce mientras está a la vista.
 *
 * Sin `autoPlay` a secas a propósito: cuatro vídeos arrancando a la vez en el
 * primer pintado castigan al móvil y a quien nunca baja hasta la sección. El
 * IntersectionObserver arranca/pausa cada uno según entra o sale del viewport,
 * y `preload="metadata"` + póster mantienen la carga inicial en un puñado de KB.
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
          if (e.isIntersecting) void video.play().catch(() => {});
          else video.pause();
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
      preload="metadata"
      aria-label={etiqueta}
    />
  );
}
