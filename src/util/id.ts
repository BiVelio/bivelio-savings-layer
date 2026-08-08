/**
 * Environment-agnostic UUID generation.
 * ---------------------------------------------------------------------------
 * Trace IDs only need to be unique, not cryptographically unpredictable. We
 * prefer the platform `crypto.randomUUID` (present in modern Node, browsers,
 * Deno and edge runtimes) and fall back to a v4-shaped id when it is absent, so
 * BV-SALA runs everywhere without a `node:crypto` import that breaks bundlers.
 */

type CryptoLike = {
  randomUUID?: () => string;
  getRandomValues?: <T extends ArrayBufferView>(array: T) => T;
};

/**
 * Contador monótono por proceso para el fallback SIN crypto.
 *
 * El fallback anterior era DETERMINISTA (`i * 2654435761 & 0xff`), así que
 * producía uno de 256 ids posibles en el mundo. Y este id NO es solo una traza:
 * por defecto es el `request_id` con el que el ingest de facturación deduplica
 * (`on conflict do nothing`). 256 valores posibles = colisiones = uso legítimo
 * DESCARTADO en silencio. Un contador que sube en cada llamada garantiza
 * unicidad dentro del proceso aunque no haya RNG.
 */
let contadorFallback = 0;

export function randomId(): string {
  // Se lee `globalThis.crypto` en CADA llamada, no al cargar el módulo: un
  // runtime que inicialice crypto después de importar el SDK (algún serverless)
  // se habría quedado con el fallback para siempre.
  const cryptoRef = (globalThis as { crypto?: CryptoLike }).crypto;
  if (cryptoRef?.randomUUID) return cryptoRef.randomUUID();

  const bytes = new Uint8Array(16);
  if (cryptoRef?.getRandomValues) {
    cryptoRef.getRandomValues(bytes);
  } else {
    // Último recurso (sin RNG seguro). No hace falta que sea impredecible, pero
    // SÍ único: contador monótono en los 6 bytes altos + tiempo en los bajos.
    // Así dos llamadas del mismo proceso nunca colisionan aunque compartan ms.
    const n = ++contadorFallback;
    const t = Date.now ? Date.now() : 0;
    for (let i = 0; i < 16; i++) {
      bytes[i] = (i < 6 ? n >>> (i * 8) : t >>> ((i - 6) * 8)) & 0xff;
    }
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) hex.push(bytes[i]!.toString(16).padStart(2, "0"));
  return `${hex[0]}${hex[1]}${hex[2]}${hex[3]}-${hex[4]}${hex[5]}-${hex[6]}${hex[7]}-${hex[8]}${hex[9]}-${hex[10]}${hex[11]}${hex[12]}${hex[13]}${hex[14]}${hex[15]}`;
}
