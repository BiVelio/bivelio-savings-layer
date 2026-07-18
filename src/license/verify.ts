import { ed25519 } from "@noble/curves/ed25519.js";

/**
 * Offline license verification for the paid SDK.
 *
 * A license is a compact signed token `base64url(header).base64url(payload).
 * base64url(sig)` (the exact format the licensing service mints in
 * `@bivelio/license-client`'s `signLicense`). We verify the Ed25519 signature
 * against BiVelio's public key, decode the payload, and apply the same grace
 * policy the license-client uses. Verification is **browser-safe**: it uses
 * `@noble/curves` (pure JS) + Web primitives (`atob`, `TextEncoder`) rather than
 * `node:crypto`, so the shared `src/index.ts` still compiles into the browser
 * demo bundle. The private signing key never leaves the control plane; only the
 * public key is embedded here, so a token cannot be forged or tampered with.
 */

export type LicenseStatus = "active" | "grace" | "expired" | "invalid" | "revoked";

/** Decoded license token body (mirror of `@bivelio/protocol`'s LicensePayload,
 *  declared locally so the SDK stays free of a control-plane dependency). */
export interface LicenseTokenPayload {
  jti: string;
  org_id: string;
  plan: string;
  seats: number;
  features: string[];
  issued_at: number;
  expires_at: number;
  grace_days: number;
  iss?: string;
}

export interface ResolvedLicense {
  status: LicenseStatus;
  payload?: LicenseTokenPayload;
  reason?: string;
}

/** Public verification key baked in at build time (tsup `define`). Empty when
 *  running from source (tsx) — callers then pass `licensePublicKey` explicitly. */
declare const __BV_SALA_PUBLIC_KEY__: string | undefined;
export const EMBEDDED_PUBLIC_KEY: string =
  typeof __BV_SALA_PUBLIC_KEY__ !== "undefined" ? __BV_SALA_PUBLIC_KEY__ : "";

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
  return base64ToBytes(b64 + pad);
}

/** Extract the raw 32-byte Ed25519 public key from an SPKI PEM (12-byte DER
 *  prefix + 32-byte key). Matches keys minted by `generateLicenseKeypair()`. */
function rawKeyFromSpkiPem(pem: string): Uint8Array {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = base64ToBytes(b64);
  return der.subarray(der.length - 32);
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Verify a token's signature and decode its payload. Does not check expiry. */
export function verifyLicenseToken(
  token: string,
  publicKeyPem: string,
): { signatureValid: boolean; payload?: LicenseTokenPayload; reason?: string } {
  if (!publicKeyPem) return { signatureValid: false, reason: "no verification key" };
  const parts = token.split(".");
  if (parts.length !== 3) return { signatureValid: false, reason: "malformed token" };
  const head = parts[0]!;
  const body = parts[1]!;
  const sig = parts[2]!;

  let rawKey: Uint8Array;
  try {
    rawKey = rawKeyFromSpkiPem(publicKeyPem);
    if (rawKey.length !== 32) return { signatureValid: false, reason: "invalid public key" };
  } catch {
    return { signatureValid: false, reason: "invalid public key" };
  }

  let ok = false;
  try {
    ok = ed25519.verify(base64urlToBytes(sig), enc.encode(`${head}.${body}`), rawKey);
  } catch {
    return { signatureValid: false, reason: "signature verification error" };
  }
  if (!ok) return { signatureValid: false, reason: "bad signature" };

  try {
    const payload = JSON.parse(dec.decode(base64urlToBytes(body))) as LicenseTokenPayload;
    return { signatureValid: true, payload };
  } catch {
    return { signatureValid: false, reason: "payload is not valid JSON" };
  }
}

/**
 * Verify + apply the grace policy → a resolved status. Mirrors
 * `@bivelio/license-client`'s `LicenseClient.resolve`:
 *   now <= expires_at                    → active
 *   expires_at < now <= +grace_days      → grace (still entitled)
 *   now > expires_at + grace_days        → expired
 *   bad signature / malformed            → invalid
 *   jti on the revocation set            → revoked
 */
export function resolveLicense(
  token: string,
  publicKeyPem: string,
  opts: { nowSeconds?: number; revoked?: ReadonlySet<string> } = {},
): ResolvedLicense {
  const v = verifyLicenseToken(token, publicKeyPem);
  if (!v.signatureValid || !v.payload) {
    return { status: "invalid", ...(v.reason ? { reason: v.reason } : {}) };
  }
  const p = v.payload;
  if (opts.revoked?.has(p.jti)) {
    return { status: "revoked", payload: p, reason: "license revoked" };
  }
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const graceEnd = p.expires_at + p.grace_days * 86400;
  let status: LicenseStatus;
  if (now <= p.expires_at) status = "active";
  else if (now <= graceEnd) status = "grace";
  else status = "expired";
  return { status, payload: p };
}
