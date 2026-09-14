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
 * - DESNUDO sobre fondo claro. El SVG ya trae su propio campo blanco, su marco
 *   negro y su aire (el marco empieza a 25 unidades de un viewBox de 500), así
 *   que la tarjeta blanca con borde, padding y sombra de la primera versión
 *   dibujaba un marco dentro de otro — la revisión del 2026-09-14 la quitó.
 *   `.nvi-badge` es un enlace sin fondo, sin borde y sin padding.
 * - Sobre fondo OSCURO la guía sí pide una tarjeta blanca bajo el logotipo, y
 *   `onDark` la pone (`.nvi-badge--card`: #FFF literal, borde #DEE4E7 literal,
 *   12 px de aire, radio pequeño). Hoy nada en la home es oscuro; la
 *   modificadora existe para que la próxima banda oscura no lo haga mal.
 * - Tamaño mínimo en pantalla: 120 px de ancho. Los anchos que se usan (136 en
 *   el héroe, 150 en la banda, 124 en el pie) y los que fija la hoja de estilos
 *   en móvil y en portátil corto (136 y 120) no bajan de ahí.
 * - Se presenta como PERTENENCIA al programa, no como aval de NVIDIA: el texto
 *   siempre dice «Miembro del…», nunca «respaldado por», «avalado» ni «partner».
 * - Siempre «NVIDIA Inception Program», con «Program», en el alt y en la copia.
 * - Enlace a la página del programa, en pestaña nueva y con noopener.
 *
 * `nvidia-inception.test.ts` lee todo eso del SVG, de este componente, de la
 * hoja de estilos y de los doce catálogos.
 */

export const NVIDIA_INCEPTION_URL = "https://www.nvidia.com/en-us/startups/";
export const NVIDIA_BADGE_SRC = "/nvidia-inception-program.svg";

/** viewBox del SVG oficial (500.4288 × 216): el alto se deriva del ancho para
 *  que el navegador reserve el hueco antes de que cargue la imagen. */
const RATIO = 216 / 500.4288;

/** El distintivo, enlazado. `width` es el ancho del logotipo en píxeles CSS;
 *  `onDark` añade la tarjeta blanca que la guía exige sobre fondo oscuro. */
export function NvidiaInceptionBadge({ width = 136, onDark = false }: { width?: number; onDark?: boolean }) {
  return (
    <a
      className={onDark ? "nvi-badge nvi-badge--card" : "nvi-badge"}
      href={NVIDIA_INCEPTION_URL}
      target="_blank"
      rel="noopener noreferrer"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- SVG estático del
          propio sitio; next/image no aporta nada y no puede tocar el logotipo. */}
      <img
        src={NVIDIA_BADGE_SRC}
        width={width}
        height={Math.round(width * RATIO)}
        alt="NVIDIA Inception Program"
        loading="lazy"
        decoding="async"
      />
    </a>
  );
}
