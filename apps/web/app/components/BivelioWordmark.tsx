/* El logotipo «BiVelio.» — puerto literal del <BvWordmark> de bivelio.com
   (repo bivelio-site, components/brand-mark.tsx), que es la fuente de verdad
   de la marca.

   NO es una imagen a propósito, igual que en el original: es texto en la
   display de la marca (Space Grotesk, ya self-hosted aquí como --font-heading)
   con los puntos pintados a mano. Un mapa de bits nos daría un recorte con
   fondo que limpiar, bordes blandos en pantallas retina y bytes que descargar;
   así el logotipo es nítido a cualquier tamaño, hereda el color del texto que
   lo rodea (tinta en el botón fantasma del nav) y pesa cero.

   El truco es la «ı» sin punto: el punto que trae el glifo de una «i» no se
   puede recolorear, así que se usa la latina sin punto y se le pone encima un
   círculo propio con el hex exacto de cada punto del logotipo. */

// Los tres colores exactos del logotipo, del azul al cian.
const PUNTO_PRIMERO = "#00B3FC"; // el punto de la primera i
const PUNTO_CENTRO = "#0073FF"; // el punto de la segunda i
const PUNTO_FINAL = "#00CBF2"; // el punto final

function Punto(style: React.CSSProperties) {
  return <span aria-hidden style={{ borderRadius: "50%", ...style }} />;
}

/** Una «ı» sin punto con nuestro propio punto de color encima.
 *
 *  La geometría NO es a ojo, está medida sobre Space Grotesk 600 (2026-08-29):
 *  con `line-height: 1` la línea base cae a 0.845em del borde superior de la
 *  caja, y la tinta de la «ı» sube 0.494em sobre la base — o sea que el asta
 *  empieza en 0.351em. El punto ocupa de `top` a `top + 0.17em`, así que:
 *
 *      hueco = 0.351 − (top + 0.17)
 *
 *  El original de bivelio.com usa `top: 0.38em`, que da hueco NEGATIVO: el
 *  punto se mete dentro del asta. Con 0.22em sigue solapando (−0.039em). A
 *  0.08em quedan 0.101em de aire — 1,9px a 19px, 1,5px a 15px— que es el hueco
 *  que el logotipo oficial sí tiene.
 *
 *  El `lineHeight: 1` del envoltorio NO es decorativo: sin él la posición de la
 *  línea base depende del interlineado que herede de fuera, y el mismo valor de
 *  `top` cae en sitios distintos. Con 1.25 heredado, por ejemplo, 0.22em parecía
 *  correcto y en el nav real se solapaba. Fijarlo hace la geometría
 *  determinista a cualquier tamaño y en cualquier contenedor. */
function IConPunto({ color }: { color: string }) {
  return (
    <span style={{ position: "relative", display: "inline-block", lineHeight: 1 }}>
      {"ı"}
      {Punto({
        position: "absolute",
        left: "50%",
        top: "0.08em",
        width: "0.17em",
        height: "0.17em",
        transform: "translateX(-50%)",
        background: color,
      })}
    </span>
  );
}

export function BivelioWordmark({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <span
      className={className}
      style={{ fontFamily: "var(--font-heading)", lineHeight: 1, ...style }}
      aria-label="BiVelio"
    >
      <span aria-hidden>
        B<IConPunto color={PUNTO_PRIMERO} />Vel<IConPunto color={PUNTO_CENTRO} />o
        {Punto({
          display: "inline-block",
          width: "0.19em",
          height: "0.19em",
          marginLeft: "0.04em",
          verticalAlign: "0.02em",
          background: PUNTO_FINAL,
        })}
      </span>
    </span>
  );
}
