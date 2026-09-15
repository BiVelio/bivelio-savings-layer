/**
 * El distintivo del NVIDIA Inception Program.
 *
 * BiVelio forma parte del programa y lo dice en tres sitios de la web (héroe,
 * banda «Compañía y ecosistema» y pie). Lo que hay que respetar de la guía de
 * marca de NVIDIA, y por qué el componente es como es:
 *
 * - SOLO el logotipo oficial, tal cual: el SVG se copió byte a byte a
 *   `public/nvidia-inception-program.svg` y se sirve desde el propio dominio
 *   (la CSP es `img-src 'self'`; un CDN externo se bloquearía en silencio).
 *   No se recolorea, no se recorta, no se recrea con trazados propios como
 *   los logos de LogoProveedor — por eso es un <img> y no un SVG en línea.
 * - DESNUDO sobre fondo claro en el héroe. El SVG ya trae su propio campo
 *   blanco, su marco negro y su aire (el marco empieza a 25 unidades de un
 *   viewBox de 500), así que la tarjeta blanca con borde, padding y sombra de
 *   la primera versión dibujaba un marco dentro de otro — la revisión del
 *   2026-09-14 la quitó. `.nvi-badge` es un enlace sin fondo, sin borde y sin
 *   padding.
 * - En la BANDA va como en bivelio.com (captura aprobada el 2026-09-15): el
 *   arte a 224 px dentro de una caja blanca literal con borde, radio 8, sombra
 *   y 6 px de aire — bivelio.com pone 12 pero recorta su SVG al marco; el
 *   nuestro es el oficial sin recortar, con ≈11 px de aire transparente a
 *   224, así que 6 + 11 da el mismo aire visual.
 * - En el PIE va también como en bivelio.com (aprobado por el CEO el
 *   2026-09-15 con captura): cierra la columna de marca, después del dock
 *   social, como credencial de la COMPAÑÍA. Un único enlace que apila la
 *   tarjeta blanca literal (borde, radio 12, el arte a 150 px con 4 px de
 *   aire — bivelio.com pone 10 con su SVG recortado; 4 + los ≈7,5 px de aire
 *   transparente del oficial a 150 dan lo mismo) y, debajo, la frase de
 *   pertenencia a 11 px (`landing.nvidia.title`, la misma de la banda) con
 *   «BiVelio» en BvBrandWord. Nunca el sello a secas: la frase es el contexto
 *   que la guía pide y lo que impide leerlo como un aval.
 * - Sobre fondo OSCURO la guía sí pide una tarjeta blanca bajo el logotipo, y
 *   `onDark` la pone (`.nvi-badge--card`: #FFF literal, borde #DEE4E7 literal,
 *   12 px de aire, radio pequeño). Hoy nada en la home es oscuro; la
 *   modificadora existe para que la próxima banda oscura no lo haga mal.
 * - Tamaño mínimo en pantalla: 120 px de ancho. Los anchos que se usan (150 en
 *   el héroe, 224 en la banda, 150 en el pie) y el que fija la hoja de estilos
 *   en portátil corto (120) no bajan de ahí.
 * - Se presenta como PERTENENCIA al programa, no como aval de NVIDIA: el texto
 *   siempre dice «Miembro del…», nunca «respaldado por», «avalado» ni «partner».
 * - Siempre «NVIDIA Inception Program», con «Program», en el alt y en la copia.
 * - Enlace a la página del programa, en pestaña nueva y con noopener.
 *
 * `nvidia-inception.test.ts` lee todo eso del SVG, de este componente, de la
 * hoja de estilos y de los doce catálogos.
 */
import { BvBrandWord } from "./BivelioWordmark";

export const NVIDIA_INCEPTION_URL = "https://www.nvidia.com/en-us/startups/";
export const NVIDIA_BADGE_SRC = "/nvidia-inception-program.svg";

/** viewBox del SVG oficial (500.4288 × 216): el alto se deriva del ancho para
 *  que el navegador reserve el hueco antes de que cargue la imagen. */
const RATIO = 216 / 500.4288;

/** Parte una frase por la PRIMERA aparición de «BiVelio» para darle el
 *  tratamiento de marca en render, sin tocar el copy traducido:
 *  `[antes, "BiVelio", después]`. Si la frase no nombra la marca (o la nombra
 *  con otra grafía) devuelve null y el texto se pinta tal cual. El trozo
 *  central lo pinta `BvBrandWord` (letras en navy, las íes con su punto de
 *  color), no el texto: por eso `partes[1]` no se renderiza. */
export function partirMarca(texto: string, marca = "BiVelio"): [string, string, string] | null {
  const i = texto.indexOf(marca);
  if (i === -1) return null;
  return [texto.slice(0, i), marca, texto.slice(i + marca.length)];
}

/** El arte oficial, sin tocar. Manda el ancho; el alto sale de la proporción
 *  real para que no se deforme ni salte al cargar. */
function NvidiaInceptionArt({ width }: { width: number }) {
  return (
    /* eslint-disable-next-line @next/next/no-img-element -- SVG estático del
       propio sitio; next/image no aporta nada y no puede tocar el logotipo. */
    <img
      src={NVIDIA_BADGE_SRC}
      width={width}
      height={Math.round(width * RATIO)}
      alt="NVIDIA Inception Program"
      loading="lazy"
      decoding="async"
    />
  );
}

/** El distintivo, enlazado y desnudo. `width` es el ancho del logotipo en
 *  píxeles CSS; `onDark` añade la tarjeta blanca que la guía exige sobre
 *  fondo oscuro. */
export function NvidiaInceptionBadge({ width = 150, onDark = false }: { width?: number; onDark?: boolean }) {
  return (
    <a
      className={onDark ? "nvi-badge nvi-badge--card" : "nvi-badge"}
      href={NVIDIA_INCEPTION_URL}
      target="_blank"
      rel="noopener noreferrer"
    >
      <NvidiaInceptionArt width={width} />
    </a>
  );
}

/** Chevron «›» del enlace de la banda: 14 px, hereda el color, se desplaza
 *  2 px al hover (CSS). El mismo `ChevronRight` de lucide que usa bivelio.com. */
function Chevron() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

/** La banda «Compañía y ecosistema» — la MISMA que cierra el héroe de
 *  bivelio.com (InceptionEcosystemBand), traducida de Tailwind a la hoja de
 *  estilos del sitio: a la izquierda kicker + título + sub + CTA; a la derecha
 *  el arte a 224 px en su caja blanca. Va a sangre completa (fuera de
 *  `main.wrap`, con su propio `.wrap` dentro) con el hairline superior. El
 *  copy llega ya traducido desde la página: son las cuatro claves
 *  `landing.nvidia.{kicker,title,sub,cta}`, verbatim de bivelio.com. En el
 *  título, «BiVelio» va como en bivelio.com y en privacy: `BvBrandWord` — las
 *  letras en el navy del logotipo y las dos íes con su punto de color, al peso
 *  del título (600), no en el azul de acento ni en negrita. */
export function NvidiaEcosystemBand({ kicker, title, sub, cta }: { kicker: string; title: string; sub: string; cta: string }) {
  const partes = partirMarca(title);
  return (
    <section className="nvi-band" aria-labelledby="nvi-band-title">
      <div className="wrap">
        <div className="nvi-band-text">
          <span className="nvi-band-k">{kicker}</span>
          <p className="nvi-band-t" id="nvi-band-title">
            {partes ? (
              <>
                {partes[0]}
                <strong className="nvi-brand">
                  <BvBrandWord />
                </strong>
                {partes[2]}
              </>
            ) : (
              title
            )}
          </p>
          <p className="nvi-band-s">{sub}</p>
          <a className="nvi-band-cta" href={NVIDIA_INCEPTION_URL} target="_blank" rel="noopener noreferrer">
            {cta}
            <Chevron />
          </a>
        </div>
        <a className="nvi-band-art" href={NVIDIA_INCEPTION_URL} target="_blank" rel="noopener noreferrer">
          <span className="nvi-band-box">
            <NvidiaInceptionArt width={224} />
          </span>
        </a>
      </div>
    </section>
  );
}

/** El bloque del PIE — el mismo que cierra la columna de marca de bivelio.com
 *  (apps/website/components/layout/footer.tsx), traducido de Tailwind: un
 *  único enlace al programa que apila la TARJETA BLANCA (el arte a 150 px
 *  dentro de una caja blanca literal con borde y radio 12) y, debajo, la
 *  FRASE de pertenencia pequeña. `line` llega ya traducida desde el pie: es
 *  `landing.nvidia.title` («BiVelio es miembro del NVIDIA Inception
 *  Program.»), la misma clave de la banda, así que el pie no duplica copy en
 *  doce catálogos. «BiVelio» va con el tratamiento de marca (BvBrandWord:
 *  navy y las íes con su punto) por el mismo partidor que la banda; sin marca
 *  en la frase, va tal cual. */
export function NvidiaFooterCard({ line }: { line: string }) {
  const partes = partirMarca(line);
  return (
    <a className="nvi-foot" href={NVIDIA_INCEPTION_URL} target="_blank" rel="noopener noreferrer">
      <span className="nvi-foot-box">
        <NvidiaInceptionArt width={150} />
      </span>
      <span className="nvi-foot-line">
        {partes ? (
          <>
            {partes[0]}
            <span className="nvi-brand">
              <BvBrandWord />
            </span>
            {partes[2]}
          </>
        ) : (
          line
        )}
      </span>
    </a>
  );
}
