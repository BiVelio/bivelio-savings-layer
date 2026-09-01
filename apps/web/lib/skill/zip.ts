/**
 * Un escritor de ZIP mínimo, SOLO almacenado (método 0, sin compresión), para
 * servir el skill como zip sin meter un binario en el repo ni una dependencia
 * en el paquete: el contenido es un fichero de texto de ~2 KB — comprimirlo no
 * paga y almacenado tiene una virtud extra: los bytes del SKILL.md aparecen
 * VERBATIM dentro del zip, así que la verja de deriva puede comprobarlo con un
 * `includes` sin descomprimir nada.
 *
 * Determinista a propósito (fecha DOS fija): el mismo contenido produce el
 * mismo zip byte a byte, en cualquier build.
 */

const TABLA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(datos: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < datos.length; i++) c = TABLA_CRC[(c ^ datos[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Fecha DOS fija (2026-09-01 00:00): determinismo antes que exactitud. */
const FECHA_DOS = ((2026 - 1980) << 9) | (9 << 5) | 1;

function u16(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff];
}
function u32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

/** Un zip con UNA entrada almacenada. Suficiente y a propósito: el formato que
 *  claude.ai espera es «carpeta con su SKILL.md en la raíz del zip». */
export function zipDeUnFichero(nombre: string, contenido: string): Uint8Array {
  const datos = new TextEncoder().encode(contenido);
  const nombreBytes = new TextEncoder().encode(nombre);
  const crc = crc32(datos);

  const cabeceraLocal = [
    ...u32(0x04034b50), // firma LFH
    ...u16(20), // versión necesaria
    ...u16(0x0800), // flags: nombres en UTF-8
    ...u16(0), // método: almacenado
    ...u16(0), // hora DOS
    ...u16(FECHA_DOS),
    ...u32(crc),
    ...u32(datos.length), // comprimido = sin comprimir (almacenado)
    ...u32(datos.length),
    ...u16(nombreBytes.length),
    ...u16(0), // extra
  ];

  const offsetCentral = cabeceraLocal.length + nombreBytes.length + datos.length;
  const central = [
    ...u32(0x02014b50), // firma CD
    ...u16(20), // hecha por
    ...u16(20), // necesaria
    ...u16(0x0800),
    ...u16(0),
    ...u16(0),
    ...u16(FECHA_DOS),
    ...u32(crc),
    ...u32(datos.length),
    ...u32(datos.length),
    ...u16(nombreBytes.length),
    ...u16(0), // extra
    ...u16(0), // comentario
    ...u16(0), // disco
    ...u16(0), // atributos internos
    ...u32(0), // atributos externos
    ...u32(0), // offset del LFH
  ];

  const finCentral = [
    ...u32(0x06054b50), // firma EOCD
    ...u16(0),
    ...u16(0),
    ...u16(1), // entradas en este disco
    ...u16(1), // entradas totales
    ...u32(central.length + nombreBytes.length),
    ...u32(offsetCentral),
    ...u16(0), // comentario
  ];

  return new Uint8Array([
    ...cabeceraLocal,
    ...nombreBytes,
    ...datos,
    ...central,
    ...nombreBytes,
    ...finCentral,
  ]);
}
