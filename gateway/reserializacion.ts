/**
 * LA RESERIALIZACIÓN FIEL — la verja que hace verdad «solo cambia lo que la
 * palanca declara».
 *
 * Las palancas que tocan el cuerpo (TTL, esfuerzo, hermano, diales) lo PARSEAN
 * y lo vuelven a escribir con `JSON.stringify`. Para un cuerpo normal, lo que
 * sale es el mismo valor JSON que entró más el cambio declarado; los espacios y
 * la forma de escapar una cadena cambian, pero el proveedor parsea el JSON y ve
 * exactamente las mismas cadenas. Hay tres casos, sin embargo, en los que la
 * vuelta por JavaScript cambia algo MÁS que la palanca no declara:
 *
 *  1. Números no canónicos. `1.0` sale como `1`, `1e5` como `100000`, `-0` como
 *     `0`, y un entero de más de 2^53 pierde precisión. Para un proveedor que
 *     distingue entero de coma flotante al renderizar un esquema de herramienta,
 *     eso es otro prompt: otra caché.
 *  2. Claves con forma de índice (`"0"`, `"12"`). JavaScript las ordena delante
 *     del resto al serializar. El orden de las claves de un `input_schema` es
 *     parte del prompt renderizado: el turno reescrito y el siguiente sin
 *     reescribir tendrían prefijos distintos y la caché se perdería entera.
 *  3. UTF-8 inválido. `Buffer.toString` lo sustituye por U+FFFD en silencio: se
 *     reenviaría un contenido distinto del que mandó el cliente.
 *  4. Claves duplicadas en un mismo objeto. JSON.parse se queda con el último
 *     valor y reescribir borraría los demás; qué hace el parser del proveedor
 *     no lo sabemos: «When the names within an object are not unique, the
 *     behavior of software that receives such an object is unpredictable»
 *     (RFC 8259 §4).
 *
 * En cualquiera de los cuatro, la palanca NO se aplica y el cuerpo viaja
 * intacto, byte a byte: es la regla de siempre («ante la duda, passthrough»),
 * con la duda medida en vez de supuesta.
 *
 * Coste: una pasada lineal por el texto, unas dos veces un JSON.parse (de 5 a
 * 8 ms para un cuerpo de 4 MB, medido en local el 2026-09-27 con la cuenta de
 * claves duplicadas ya dentro). Solo corre cuando una palanca está armada.
 */

import { recorrerJsonEstricto } from "../src/util/json-estricto.js";

// `ignoreBOM: true` CONSERVA una BOM inicial en el texto: así JSON.parse la
// rechaza, como hacía `Buffer.toString`, en vez de quitarla en silencio.
const decodificador = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** El texto del cuerpo si es UTF-8 válido; null si no (la palanca no debe tocarlo). */
export function textoUtf8Estricto(cuerpo: Buffer): string | null {
  try {
    return decodificador.decode(cuerpo);
  } catch {
    return null;
  }
}

/** Una clave que JavaScript trata como índice de array (entero < 2^32 − 1) y por eso ordena delante del resto. */
function esClaveDeIndice(clave: string): boolean {
  return /^(?:0|[1-9]\d{0,9})$/.test(clave) && Number(clave) < 4_294_967_295;
}

/**
 * ¿`JSON.stringify(JSON.parse(texto))` conserva todo lo que el proveedor puede
 * ver? Es decir: ningún número deja de escribirse igual, ninguna clave cambia
 * de sitio y ninguna desaparece por repetida. El recorrido es el mismo que usa
 * la compactación sin pérdida del SDK (`src/util/json-estricto.ts`): UN
 * analizador para los dos, así que «duplicada» significa lo mismo en el cable
 * y en la cola. Un texto que no sea JSON estricto (truncado, con comas finales…)
 * también da false.
 */
export function reserializacionFiel(texto: string): boolean {
  return recorrerJsonEstricto(texto, {
    clave: (clave) => !esClaveDeIndice(clave),
    // Un número tiene que escribirse exactamente como lo escribiría JavaScript.
    numero: (literal) => String(Number(literal)) === literal,
  }).ok;
}

/**
 * El cuerpo parseado, SOLO si una palanca puede reescribirlo sin cambiar nada
 * que no declare; null en otro caso (comprimido, UTF-8 inválido, no-JSON, o
 * una reserialización que no sería fiel). Es la puerta común de las palancas.
 */
export function parsearParaReescribir(cuerpo: Buffer, codificacion?: string): unknown {
  if (codificacion !== undefined && codificacion !== "" && codificacion !== "identity") return null;
  const texto = textoUtf8Estricto(cuerpo);
  if (texto === null) return null;
  let valor: unknown;
  try {
    valor = JSON.parse(texto);
  } catch {
    return null;
  }
  return reserializacionFiel(texto) ? valor : null;
}
