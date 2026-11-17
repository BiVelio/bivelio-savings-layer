/**
 * EL MOSAICO DE LLAMADAS — la franja de píxeles cian, turquesa y menta del pie
 * de la pieza promocional («Measured on every call»). Aquí cada casilla es una
 * llamada y unas pocas se encienden y se apagan, despacio: medir cada llamada,
 * dicho sin palabras. Es decoración (`aria-hidden`) y no lleva ninguna cifra.
 *
 * Por qué es así:
 *  · SVG EN LÍNEA, no una imagen de fondo: un `background-image` grande puede
 *    ser el LCP de la página; las formas de un SVG en línea no lo son. Y sin
 *    petición aparte.
 *  · DETERMINISTA: un generador con semilla (mulberry32). El servidor y el
 *    navegador pintan las mismas casillas, sin JavaScript en el cliente.
 *  · BARATO: las casillas quietas se agrupan en un `<path>` por color y
 *    opacidad (≈ 20 trazados por franja, no cientos de nodos); solo las que se
 *    encienden son `<rect>` sueltos, porque cada una lleva su retardo.
 *  · TAMAÑO FIJO EN PÍXELES y centrado: el SVG mide siempre ANCHO px y el CSS
 *    lo centra y recorta (`.mosaico`), así la casilla mide lo mismo en un móvil
 *    y en un monitor ancho; lo que sobra a los lados se recorta, no se encoge.
 *    (Sin coordenadas negativas: un `<svg>` anidado las recorta en Chrome.)
 *  · MOVIMIENTO: solo bajo `prefers-reduced-motion: no-preference` (globals.css,
 *    bloque «FIRMA DE CAMPAÑA»); si no, las casillas encendidas quedan quietas.
 */

/** Paleta de la pieza: cian, turquesa, cielo, menta y un azul claro. */
const PALETA = ["#7FD6EE", "#62D3C6", "#BEE8F6", "#97E3C6", "#A9D4FF"] as const;
/** Las que se encienden: los mismos tonos, más vivos. */
const PALETA_VIVA = ["#38BDF8", "#2DD4BF", "#0EA5E9", "#34D399"] as const;
const OPACIDADES = [0.16, 0.28, 0.44, 0.66] as const;

const PASO = 16; // casilla de 12 px + 4 px de junta
const LADO = 10.5; // + trazo de 1,5 px con unión redonda = 12 px con esquinas suaves
const COLUMNAS = 136; // 136 × 16 = 2176 px: cubre una pantalla de 1920 centrada
export const ANCHO_DEL_MOSAICO = COLUMNAS * PASO;

function mulberry32(semilla: number) {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Encendida = { x: number; y: number; color: string; retardo: number; duracion: number };

/** Las casillas de una franja. Exportada para la prueba de determinismo. */
export function casillasDelMosaico(semilla: number, filas: number) {
  const azar = mulberry32(semilla);
  const quietas = new Map<string, string[]>();
  const encendidas: Encendida[] = [];
  for (let f = 0; f < filas; f++) {
    // Más densa abajo, rala arriba: la franja «sube» desde el borde.
    const densidad = filas === 1 ? 0.6 : 0.2 + 0.52 * (f / (filas - 1));
    for (let c = 0; c < COLUMNAS; c++) {
      if (azar() > densidad) continue;
      const x = c * PASO + 1;
      const y = f * PASO;
      if (azar() < 0.05) {
        encendidas.push({
          x,
          y,
          color: PALETA_VIVA[Math.floor(azar() * PALETA_VIVA.length)],
          retardo: -Math.round(azar() * 90) / 10,
          duracion: 4 + Math.round(azar() * 40) / 10,
        });
        continue;
      }
      const color = PALETA[Math.floor(azar() * PALETA.length)];
      const opacidad = OPACIDADES[Math.floor(azar() * OPACIDADES.length)];
      const clave = `${color}|${opacidad}`;
      const lista = quietas.get(clave) ?? [];
      lista.push(`M${x} ${y}h${LADO}v${LADO}h-${LADO}z`);
      quietas.set(clave, lista);
    }
  }
  return { quietas, encendidas };
}

export function MosaicoDeLlamadas({ semilla = 7, filas = 5, className }: { semilla?: number; filas?: number; className?: string }) {
  const { quietas, encendidas } = casillasDelMosaico(semilla, filas);
  const alto = (filas - 1) * PASO + LADO + 2;
  return (
    <div className={className ? `mosaico ${className}` : "mosaico"} aria-hidden="true">
      <svg width={ANCHO_DEL_MOSAICO} height={alto} viewBox={`0 -1 ${ANCHO_DEL_MOSAICO} ${alto}`} focusable="false">
        <g>
          {[...quietas].map(([clave, trazos]) => {
            const [color, opacidad] = clave.split("|");
            return (
              <path
                key={clave}
                d={trazos.join("")}
                fill={color}
                stroke={color}
                strokeWidth={1.5}
                strokeLinejoin="round"
                opacity={opacidad}
              />
            );
          })}
          {encendidas.map((e, i) => (
            <rect
              key={i}
              className="mz-on"
              x={e.x - 0.75}
              y={e.y - 0.75}
              width={LADO + 1.5}
              height={LADO + 1.5}
              rx={2}
              fill={e.color}
              style={{ animationDelay: `${e.retardo}s`, animationDuration: `${e.duracion}s` }}
            />
          ))}
        </g>
      </svg>
    </div>
  );
}
