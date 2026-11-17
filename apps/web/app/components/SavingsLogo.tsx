/* Logo oficial de Savings (by BiVelio) — los PNG recortados de public/brand/.
   Dos variantes: el logotipo horizontal completo (isotipo + «Savings.» + «by
   BiVelio») y el isotipo «S» solo, para huecos estrechos. Las proporciones van
   fijadas en el <img> para que no haya salto de maquetación al cargar.

   AL TAMAÑO JUSTO (17-11-2026). Los PNG de origen (574×160, 61 KB; 256×256,
   48 KB) se pintan a 22–52 px de alto, y React 19 anunciaba los dos en el
   <head> (<link rel="preload"> por cada <img> sin `loading="lazy"`), por
   delante de las hojas de estilo: 109 KB de imagen antes de la primera pintura
   en el móvil, para un logo que no es el LCP. Ahora el navegador elige, por
   densidad de pantalla, una copia WebP casi sin pérdida (error ≤ 4/255 por
   canal) a 1×, 2×, 3× o 4× del tamaño pintado; el PNG queda de reserva para quien no
   lea WebP (y para los enlaces externos). Dentro de <picture> React no
   precarga: el logo de la cabecera lo descubre el escáner del HTML igual de
   pronto, y el que el CSS oculta ya no se descarga (ver `ocultoEn`). */

// Proporción ancho/alto del logotipo recortado (574×160).
const FULL_RATIO = 574 / 160;

/** Los PNG de origen: reserva sin WebP y nombre estable para enlaces externos. */
export const LOGO_PNG = { full: "/brand/savings-logo.png", mark: "/brand/savings-mark.png" } as const;

/** Anchos de las copias al tamaño justo (public/brand/savings-{logo,mark}-<ancho>.webp),
    sacadas de los PNG con sharp: reescaladas a la caja exacta (`fit: "fill"`,
    filtro mitchell; con `object-fit: contain` Chrome también rellena la caja
    entera, 216×60 y no 215,25×60) y WebP `nearLossless` calidad 60, `effort` 6.
    Logotipo: 1× a 4× de la cabecera (108×30) y 1× a 3× del pie (187×52; su 3×
    y su 4× son el original). Isotipo: 2× del mayor uso (32 px), 3× y 4× de la
    cabecera del móvil (28 px) y 3× y 4× del mayor uso. El 4× es para los
    Android de 3,5–4 de densidad y el zoom en Retina: sin él, el navegador
    ampliaba la copia de 3× y el logo salía blando. Si cambia el logo, se
    regeneran todas a la vez. */
export const ANCHOS_WEBP = { full: [108, 187, 216, 324, 374, 432, 574], mark: [64, 84, 96, 112, 128] } as const;

export const rutaWebp = (variant: "full" | "mark", ancho: number) =>
  `/brand/savings-${variant === "full" ? "logo" : "mark"}-${ancho}.webp`;

/**
 * El `srcset` de un uso pintado a `anchoPintado` px: para 1×, 2×, 3× y 4×,
 * la copia más pequeña que llega. Solo esas, para no engordar el HTML (cada
 * srcset va dos veces: en el HTML y en la carga RSC). Con el ancho exacto
 * (108 → 108w, 216w, 324w) el navegador pinta píxel a píxel.
 */
export function srcSetDelLogo(variant: "full" | "mark", anchoPintado: number): string {
  const anchos: readonly number[] = ANCHOS_WEBP[variant];
  const mayor = anchos[anchos.length - 1]!;
  const elegidos = new Set([1, 2, 3, 4].map((d) => anchos.find((w) => w >= d * anchoPintado) ?? mayor));
  return [...elegidos].map((w) => `${rutaWebp(variant, w)} ${w}w`).join(", ");
}

/** GIF transparente de 1×1 en línea: lo que elige <picture> donde el CSS
    oculta el logo, para no pedir nada por la red (la CSP admite img-src data:). */
const PIXEL_VACIO = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

type Props = {
  variant?: "full" | "mark";
  /** Alto en px; el ancho sale de la proporción real del recurso. */
  height?: number;
  className?: string;
  /**
   * La media query en la que el CSS oculta esta variante con `display: none`
   * (la cabecera alterna logotipo e isotipo por ancho). Ahí <picture> elige un
   * píxel vacío en línea y la variante oculta no se descarga. Tiene que ser la
   * MISMA consulta que la del CSS, o un subconjunto: si cubriera un ancho en el
   * que el logo se ve, el logo desaparecería (verja: savings-logo.test.ts).
   */
  ocultoEn?: string;
  /** `lazy` para los usos lejos de la primera pantalla (el pie). */
  loading?: "lazy" | "eager";
};

export function SavingsLogo({ variant = "full", height = 36, className, ocultoEn, loading }: Props) {
  const full = variant === "full";
  const width = full ? Math.round(height * FULL_RATIO) : height;
  return (
    // `display: contents`: <picture> no genera caja; el <img> sigue siendo el
    // hijo que maqueta el contenedor (flex en la cabecera), como antes.
    <picture style={{ display: "contents" }}>
      {ocultoEn ? <source media={ocultoEn} srcSet={PIXEL_VACIO} /> : null}
      <source type="image/webp" srcSet={srcSetDelLogo(variant, width)} sizes={`${width}px`} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className={["savings-logo", className].filter(Boolean).join(" ")}
        src={full ? LOGO_PNG.full : LOGO_PNG.mark}
        alt="Savings by BiVelio"
        width={width}
        height={height}
        style={{ width, height }}
        decoding="async"
        loading={loading}
      />
    </picture>
  );
}
