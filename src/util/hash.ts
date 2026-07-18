/**
 * Environment-agnostic, synchronous SHA-256.
 * ---------------------------------------------------------------------------
 * The canonicalizer needs a *synchronous* content hash to build cache and
 * singleflight keys. Node's `node:crypto` is synchronous but does not exist in
 * the browser, and the Web Crypto API (`crypto.subtle.digest`) is async — which
 * would force the whole key-building path to become async. To keep BV-SALA
 * runnable identically in Node, the browser, Deno and edge runtimes (so the
 * marketing verifier computes the *exact same numbers* the SDK ships), we use a
 * small dependency-free SHA-256 that only relies on `TextEncoder` (universally
 * available). Output is lowercase hex, byte-for-byte compatible with
 * `createHash("sha256")`.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const encoder = /* @__PURE__ */ new TextEncoder();

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

export function sha256(input: string): string {
  const bytes = encoder.encode(input);
  const bitLen = bytes.length * 8;

  // Pad: append 0x80, then zeros, then 64-bit big-endian bit length.
  const withPad = ((bytes.length + 8) >> 6) + 1; // number of 64-byte blocks
  const buf = new Uint8Array(withPad * 64);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  // Bit length is stored in the last 8 bytes (big-endian). JS bit ops are
  // 32-bit, so split into high/low words; inputs here never exceed 2^32 bits.
  const dv = new DataView(buf.buffer);
  dv.setUint32(buf.length - 8, Math.floor(bitLen / 0x100000000));
  dv.setUint32(buf.length - 4, bitLen >>> 0);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  // All index reads below are provably in-bounds (fixed loop limits, 64-word
  // schedule), so non-null assertions are correct under noUncheckedIndexedAccess.
  for (let off = 0; off < buf.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15]!, w2 = w[i - 2]!;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }

    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, hh = h[7]!;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i]! + w[i]!) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }

    h[0] = (h[0]! + a) | 0; h[1] = (h[1]! + b) | 0; h[2] = (h[2]! + c) | 0; h[3] = (h[3]! + d) | 0;
    h[4] = (h[4]! + e) | 0; h[5] = (h[5]! + f) | 0; h[6] = (h[6]! + g) | 0; h[7] = (h[7]! + hh) | 0;
  }

  let hex = "";
  for (let i = 0; i < 8; i++) hex += (h[i]! >>> 0).toString(16).padStart(8, "0");
  return hex;
}
