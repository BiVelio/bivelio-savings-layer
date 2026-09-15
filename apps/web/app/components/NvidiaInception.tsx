/**
 * El distintivo del NVIDIA Inception Program.
 *
 * BiVelio forma parte del programa y lo dice en dos sitios de la web: la
 * banda «Compañía y ecosistema» antes del pie y la tarjeta que cierra la
 * columna de marca del pie. (El distintivo desnudo que iba en el héroe bajo
 * los botones, del 2026-09-14, se fue el 2026-09-15 por decisión del CEO: el
 * héroe vuelve a ser solo la nota de instalación y las líneas de
 * compatibilidad; el sello ya se ve en la banda y en el pie.) Lo que hay que
 * respetar de la guía de marca de NVIDIA, y por qué el componente es como es:
 *
 * - SOLO el logotipo oficial, tal cual: el SVG se copió byte a byte a
 *   `public/nvidia-inception-program.svg` y se sirve desde el propio dominio
 *   (la CSP es `img-src 'self'`; un CDN externo se bloquearía en silencio).
 *   No se recolorea, no se recorta, no se recrea con trazados propios como
 *   los logos de LogoProveedor — por eso es un <img> y no un SVG en línea.
 *   El SVG ya trae su propio campo blanco, su marco negro y su aire (el marco
 *   empieza a 25 unidades de un viewBox de 500): por eso las cajas de la
 *   banda y del pie llevan menos aire que las de bivelio.com, que recorta el
 *   suyo al marco.
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
 * - Las dos cajas son blancas LITERALES (#FFF, no `var(--surface)`): sobre
 *   fondo oscuro la guía exige tarjeta blanca bajo el logotipo, y un token una
 *   paleta oscura lo invertiría.
 * - Tamaño mínimo en pantalla: 120 px de ancho. Los anchos que se usan (224 en
 *   la banda, 150 en el pie) no bajan de ahí, y ninguna regla de la hoja de
 *   estilos los acota.
 * - Se presenta como PERTENENCIA al programa, no como aval de NVIDIA: el texto
 *   siempre dice «Miembro del…», nunca «respaldado por», «avalado» ni «partner».
 * - Siempre «NVIDIA Inception Program», con «Program», en el alt y en la copia.
 * - Enlace a la página del programa, en pestaña nueva y con noopener.
 *
 * `nvidia-inception.test.ts` lee todo eso del SVG, de este componente, de la
 * página, del pie, de la hoja de estilos y de los doce catálogos — y comprueba
 * que el héroe NO lleva el sello.
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

/** El arte oficial, sin tocar: el ÚNICO <img> del logotipo, que comparten la
 *  caja de la banda y la tarjeta del pie. Manda el ancho; el alto sale de la
 *  proporción real para que no se deforme ni salte al cargar. */
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
