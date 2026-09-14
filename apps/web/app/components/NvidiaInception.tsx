/**
 * El distintivo del NVIDIA Inception Program.
 *
 * BiVelio forma parte del programa y lo dice en tres sitios de la web (héroe,
 * banda de ecosistema y pie). Lo que hay que respetar de la guía de marca de
 * NVIDIA, y por qué el componente es como es:
 *
 * - SOLO el logotipo oficial, tal cual: el SVG se copió byte a byte a
 *   `public/nvidia-inception-program.svg` y se sirve desde el propio dominio
 *   (la CSP es `img-src 'self'`; un CDN externo se bloquearía en silencio).
 *   No se recolorea, no se recorta, no se recrea con trazados propios como
 *   los logos de LogoProveedor — por eso es un <img> y no un SVG en línea.
 * - Aire alrededor de al menos la altura de la «N»: la tarjeta lleva 12 px de
 *   padding además del margen que ya trae el propio marco del distintivo.
 * - Tamaño mínimo en pantalla: 120 px de ancho. Los dos anchos que se usan
 *   (150 en el héroe, 180 en la banda) caben en un móvil de 400 px.
 * - Va sobre tarjeta blanca con radio pequeño, nunca invertido: la web es solo
 *   clara (`color-scheme: light`), pero la tarjeta se pinta en #FFF explícito
 *   por si algún día el fondo cambia.
 * - Se presenta como PERTENENCIA al programa, no como aval de NVIDIA: el texto
 *   siempre dice «Parte del…» / «Miembro del…», nunca «respaldado por».
 * - Siempre «NVIDIA Inception Program», con «Program», en el alt y en la copia.
 * - Enlace a la página del programa, en pestaña nueva y con noopener.
 */

export const NVIDIA_INCEPTION_URL = "https://www.nvidia.com/en-us/startups/";

/** viewBox del SVG oficial (500.4288 × 216): el alto se deriva del ancho para
 *  que el navegador reserve el hueco antes de que cargue la imagen. */
const RATIO = 216 / 500.4288;

export function NvidiaInceptionBadge({ width = 150 }: { width?: number }) {
  return (
    <a
      className="nvi-badge"
      href={NVIDIA_INCEPTION_URL}
      target="_blank"
      rel="noopener noreferrer"
      style={{ "--nvi-w": `${width}px` } as React.CSSProperties}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- SVG estático del
          propio sitio; next/image no aporta nada y no puede tocar el logotipo. */}
      <img
        src="/nvidia-inception-program.svg"
        width={width}
        height={Math.round(width * RATIO)}
        alt="NVIDIA Inception Program"
        loading="lazy"
        decoding="async"
      />
    </a>
  );
}
