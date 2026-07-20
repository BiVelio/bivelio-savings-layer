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

/** Result of verifying a compact `head.body.sig` token's signature. */
export interface CompactVerification {
  /** True only if the signature is valid for the given public key. */
  ok: boolean;
  /** Decoded header (present when `ok`), e.g. `{ alg, typ, v }`. */
  header?: Record<string, unknown>;
  /** Raw payload bytes (present when `ok`); the caller decodes/parses them. */
  payloadBytes?: Uint8Array;
  reason?: string;
}

/**
 * Verify the Ed25519 signature of any BV-SALA compact token
 * (`base64url(header).base64url(body).base64url(sig)`, sig over `${head}.${body}`)
 * and return the decoded header + raw payload bytes. This is the single shared
 * crypto primitive: license tokens AND signed revocation lists both go through it,
 * so the browser (`@noble/curves`) and node (`node:crypto`) sides agree byte-for-byte
 * and there is no bespoke per-message verification path to keep in sync. It does NOT
 * interpret the payload or the header `typ` — callers do that.
 */
export function verifyCompactSignature(token: string, publicKeyPem: string): CompactVerification {
  if (!publicKeyPem) return { ok: false, reason: "no verification key" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed token" };
  const head = parts[0]!;
  const body = parts[1]!;
  const sig = parts[2]!;

  let rawKey: Uint8Array;
  try {
    rawKey = rawKeyFromSpkiPem(publicKeyPem);
    if (rawKey.length !== 32) return { ok: false, reason: "invalid public key" };
  } catch {
    return { ok: false, reason: "invalid public key" };
  }

  let ok = false;
  try {
    ok = ed25519.verify(base64urlToBytes(sig), enc.encode(`${head}.${body}`), rawKey);
  } catch {
    return { ok: false, reason: "signature verification error" };
  }
  if (!ok) return { ok: false, reason: "bad signature" };

  let header: Record<string, unknown>;
  try {
    header = JSON.parse(dec.decode(base64urlToBytes(head))) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "header is not valid JSON" };
  }
  return { ok: true, header, payloadBytes: base64urlToBytes(body) };
}

/** Verify a token's signature and decode its payload. Does not check expiry. */
export function verifyLicenseToken(
  token: string,
  publicKeyPem: string,
): { signatureValid: boolean; payload?: LicenseTokenPayload; reason?: string } {
  const v = verifyCompactSignature(token, publicKeyPem);
  if (!v.ok || !v.payloadBytes) {
    return { signatureValid: false, ...(v.reason ? { reason: v.reason } : {}) };
  }
  try {
    const payload = JSON.parse(dec.decode(v.payloadBytes)) as LicenseTokenPayload;
    return { signatureValid: true, payload };
  } catch {
    return { signatureValid: false, reason: "payload is not valid JSON" };
  }
}

/**
 * Apply the grace + revocation policy to an already-decoded payload → a status.
 * Pure and clock-injected, so a LIVE gate can call it on every request to pick up
 * both revocation (jti in the set) AND expiry transitions without re-verifying the
 * signature. Revocation takes precedence over the time-based status.
 *   jti on the revocation set            → revoked
 *   now <= expires_at                    → active
 *   expires_at < now <= +grace_days      → grace (still entitled)
 *   now > expires_at + grace_days        → expired
 */
export function deriveStatus(
  payload: { jti: string; expires_at: number; grace_days: number },
  nowSeconds: number,
  revoked?: ReadonlySet<string>,
): LicenseStatus {
  if (revoked?.has(payload.jti)) return "revoked";
  const graceEnd = payload.expires_at + payload.grace_days * 86400;
  if (nowSeconds <= payload.expires_at) return "active";
  if (nowSeconds <= graceEnd) return "grace";
  return "expired";
}

/**
 * Verify + apply the grace policy → a resolved status. Mirrors
 * `@bivelio/license-client`'s `LicenseClient.resolve`. Bad signature / malformed
 * → invalid; otherwise the status comes from {@link deriveStatus}.
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
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const status = deriveStatus(p, now, opts.revoked);
  if (status === "revoked") {
    return { status, payload: p, reason: "license revoked" };
  }
  return { status, payload: p };
}
