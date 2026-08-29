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

/** Una «ı» sin punto con nuestro propio punto de color encima. */
function IConPunto({ color }: { color: string }) {
  return (
    <span style={{ position: "relative", display: "inline-block" }}>
      {"ı"}
      {Punto({
        position: "absolute",
        left: "50%",
        // 0.22em, no los 0.38em del original: a 0.38em el punto BAJA hasta
        // apoyarse en el asta de la «ı» y los dos SE TOCAN — se ve a simple
        // vista ampliando el logotipo, y es un hueco que el logo oficial sí
        // tiene. 0.22em es el valor que eligió el dueño comparando variantes
        // ampliadas contra el logotipo de referencia (2026-08-29).
        // OJO: bivelio.com arrastra hoy el mismo 0.38em en su propio
        // <BvWordmark> (bivelio-site, components/brand-mark.tsx), así que ahí
        // los puntos también se tocan.
        top: "0.22em",
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
      style={{ fontFamily: "var(--font-heading)", ...style }}
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
