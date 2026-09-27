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
 *
 * En cualquiera de los tres, la palanca NO se aplica y el cuerpo viaja intacto,
 * byte a byte: es la regla de siempre («ante la duda, passthrough»), con la duda
 * medida en vez de supuesta. Las claves duplicadas no se miran: JSON.parse se
 * queda con la última en la posición de la primera, que es lo mismo que hace
 * cualquier parser del otro lado.
 *
 * Coste: una pasada lineal por el texto, del orden de un JSON.parse (4 ms para
 * un cuerpo de 4 MB medido en local). Solo corre cuando una palanca está armada.
 */

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

function esBlanco(c: number): boolean {
  return c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;
}

/**
 * ¿`JSON.stringify(JSON.parse(texto))` conserva todo lo que el proveedor puede
 * ver? Es decir: ningún número deja de escribirse igual y ninguna clave cambia
 * de sitio. Presupone un JSON ya validado (quien llama parsea antes); aun así,
 * ante un texto truncado termina y devuelve false.
 */
export function reserializacionFiel(texto: string): boolean {
  const n = texto.length;
  let i = 0;
  while (i < n) {
    const c = texto.charCodeAt(i);
    if (c === 0x22) {
      // Una cadena: se salta entera, y si va seguida de «:» es una clave.
      const inicio = i;
      let conEscape = false;
      i++;
      for (;;) {
        if (i >= n) return false;
        const d = texto.charCodeAt(i);
        if (d === 0x5c) {
          conEscape = true;
          i += 2;
          continue;
        }
        if (d === 0x22) break;
        i++;
      }
      i++;
      let j = i;
      while (j < n && esBlanco(texto.charCodeAt(j))) j++;
      if (j < n && texto.charCodeAt(j) === 0x3a) {
        let clave = texto.slice(inicio + 1, i - 1);
        if (conEscape) {
          try {
            clave = JSON.parse(texto.slice(inicio, i)) as string;
          } catch {
            return false;
          }
        }
        if (esClaveDeIndice(clave)) return false;
      }
      continue;
    }
    if (c === 0x2d || (c >= 0x30 && c <= 0x39)) {
      // Un número: tiene que escribirse exactamente como lo escribiría JavaScript.
      const inicio = i;
      i++;
      while (i < n) {
        const d = texto.charCodeAt(i);
        if ((d >= 0x30 && d <= 0x39) || d === 0x2e || d === 0x65 || d === 0x45 || d === 0x2b || d === 0x2d) i++;
        else break;
      }
      const literal = texto.slice(inicio, i);
      if (String(Number(literal)) !== literal) return false;
      continue;
    }
    i++;
  }
  return true;
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
