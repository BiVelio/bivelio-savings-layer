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

const cryptoRef = (globalThis as { crypto?: CryptoLike }).crypto;

export function randomId(): string {
  if (cryptoRef?.randomUUID) return cryptoRef.randomUUID();

  const bytes = new Uint8Array(16);
  if (cryptoRef?.getRandomValues) {
    cryptoRef.getRandomValues(bytes);
  } else {
    // Last-resort fallback (no secure RNG available). Trace IDs are not secrets.
    for (let i = 0; i < 16; i++) bytes[i] = (i * 2654435761) & 0xff;
    bytes[0]! ^= (Date.now ? Date.now() : 0) & 0xff;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) hex.push(bytes[i]!.toString(16).padStart(2, "0"));
  return `${hex[0]}${hex[1]}${hex[2]}${hex[3]}-${hex[4]}${hex[5]}-${hex[6]}${hex[7]}-${hex[8]}${hex[9]}-${hex[10]}${hex[11]}${hex[12]}${hex[13]}${hex[14]}${hex[15]}`;
}
