/**
 * EL AVISO DE LA BÚSQUEDA DE HERRAMIENTAS — funciones PURAS que miran un cuerpo
 * /v1/messages y dicen si el cliente está mandando su catálogo entero en cada
 * petición pudiendo no hacerlo.
 *
 * Por qué existe este fichero. Con un `ANTHROPIC_BASE_URL` que no es
 * api.anthropic.com, Claude Code APAGA por defecto la búsqueda de herramientas y
 * manda TODAS las definiciones —MCP incluidas— en el prefijo de cada petición.
 * O sea que el mero hecho de poner un proxy delante, cualquiera, encarece la
 * factura. `bvsala claude` lo reactiva desde la 0.4.19 (envoltorios.ts), y el
 * gateway reenvía los bloques `tool_reference` y la beta intactos.
 *
 * Pero el arreglo solo llega a una VENTANA NUEVA, y eso ya nos ha costado tres
 * sustos en un día: el brazo del A/B que apagaba la palanca A, la versión de npm
 * que no entraba, y esto. Un arreglo mergeado que nadie ejerce vale cero, y no
 * hay forma de notarlo mirando el código. Aquí se nota mirando el TRÁFICO:
 * medido el 2026-09-10 sobre 12.239 peticiones con catálogo, solo CUATRO
 * llevaban `tool_reference`, con una mediana de 142 herramientas declaradas y un
 * máximo de 261. El bloque `tools` es el 24,5 % del dinero de entrada.
 *
 * El aviso no cambia nada de la petición: solo lo dice una vez, en voz alta.
 */

/** Lo que se ve de las herramientas en un cuerpo de petición. */
export interface VistaDeHerramientas {
  /** Definiciones completas declaradas (las que pesan). */
  definiciones: number;
  /** Bloques `tool_reference`: la búsqueda de herramientas EN ACCIÓN. */
  referencias: number;
  /**
   * Definiciones con `defer_loading: true`: la búsqueda de herramientas está
   * ENCENDIDA aunque el modelo aún no haya buscado nada. El proveedor las deja
   * fuera del prefijo y el cliente las manda igual en cada petición (lo pide la
   * doc de tool search), así que no pesan. Opcional para quien construya la
   * vista a mano; `verHerramientas` siempre la rellena.
   */
  diferidas?: number;
}

/**
 * Cuenta definiciones y referencias sin recorrer el cuerpo entero como objeto:
 * un catálogo de 261 herramientas son cientos de kilobytes y esto corre en el
 * camino de cada petición. Se cuenta sobre el texto, que es lo barato.
 */
export function verHerramientas(cuerpo: string): VistaDeHerramientas {
  let definiciones = 0;
  let desde = 0;
  // Una definición de herramienta lleva su esquema de argumentos; una
  // `tool_reference` no. Contar el esquema es contar lo que pesa.
  for (;;) {
    const i = cuerpo.indexOf('"input_schema"', desde);
    if (i < 0) break;
    definiciones += 1;
    desde = i + 14;
  }
  let referencias = 0;
  desde = 0;
  for (;;) {
    const i = cuerpo.indexOf('"tool_reference"', desde);
    if (i < 0) break;
    referencias += 1;
    desde = i + 16;
  }
  // Sobre el texto también, y con el espacio opcional que un cliente que no
  // compacte su JSON pondría tras los dos puntos.
  const diferidas = cuerpo.match(/"defer_loading"\s*:\s*true/g)?.length ?? 0;
  return { definiciones, referencias, diferidas };
}

/**
 * A partir de cuántas definiciones merece la pena decir algo. Por debajo de esto
 * el catálogo no pesa lo suficiente como para molestar a nadie, y la búsqueda de
 * herramientas tampoco tendría mucho que buscar.
 */
export const DEFINICIONES_PARA_AVISAR = 40;

/**
 * El aviso, o null si no hay nada que decir. Es PURO: quien lo llame decide
 * cuándo y cómo enseñarlo (una vez, por consola, ver `avisarUnaVez`).
 *
 * Solo habla cuando el cliente manda MUCHAS definiciones, NINGUNA diferida y
 * NINGUNA referencia: si hay diferidas o referencias, la búsqueda está
 * funcionando y no hay nada que arreglar.
 */
export function avisoDeBusquedaDeHerramientas(v: VistaDeHerramientas): string | null {
  if (v.referencias > 0) return null;
  // Con herramientas diferidas la búsqueda está encendida, aunque el modelo aún
  // no haya buscado (el primer turno de una sesión nunca trae referencias).
  // Sin esto, el aviso saltaba justo en las sesiones que ya lo hacían bien.
  if ((v.diferidas ?? 0) > 0) return null;
  if (v.definiciones < DEFINICIONES_PARA_AVISAR) return null;
  return (
    `[bvsala gateway] your client sends ${v.definiciones} FULL tool definitions in every request ` +
    "and does not use tool search. With a proxy in front, Claude Code turns tool search off by default: " +
    "`bvsala claude` turns it back on, but only in a NEW WINDOW. If you launched the terminal by hand, " +
    "export ENABLE_TOOL_SEARCH=true. In our own corpus that block was 24.5% of input spend."
  );
}
