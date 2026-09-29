import {
  sign as cryptoSign,
  verify as cryptoVerify,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import type { LicensePayload, RevocationListPayload } from "@bivelio/protocol";
import { REVOCATION_HEADER, effectiveTerm } from "@bivelio/protocol";

/**
 * Compact signed license token: `base64url(header).base64url(payload).base64url(sig)`.
 *
 * Signed with Ed25519 so verification is fast, offline, and needs only the
 * public key. The private signing key lives ONLY in the licensing service
 * (control plane) — never shipped. This module also exposes a dev/service
 * helper to mint tokens and generate a keypair.
 */
const HEADER = { alg: "EdDSA", typ: "BVL", v: 1 } as const;

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function fromB64url(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

export interface TokenVerification {
  /** True only if the signature is valid for the given public key. */
  signatureValid: boolean;
  payload?: LicensePayload;
  reason?: string;
}

/** Mint a signed license token (control-plane / test helper). */
export function signLicense(
  payload: LicensePayload,
  privateKey: string | KeyObject,
): string {
  const key = typeof privateKey === "string" ? createPrivateKey(privateKey) : privateKey;
  const head = b64url(JSON.stringify(HEADER));
  const body = b64url(JSON.stringify(payload));
  const signingInput = `${head}.${body}`;
  const signature = cryptoSign(null, Buffer.from(signingInput), key);
  return `${signingInput}.${b64url(signature)}`;
}

/** Verify signature and decode the payload. Does NOT check expiry (that's the client's job). */
export function verifyLicenseToken(
  token: string,
  publicKey: string | KeyObject,
): TokenVerification {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { signatureValid: false, reason: "malformed token (expected 3 segments)" };
  }
  const [head, body, sig] = parts as [string, string, string];

  let key: KeyObject;
  try {
    key = typeof publicKey === "string" ? createPublicKey(publicKey) : publicKey;
  } catch {
    return { signatureValid: false, reason: "invalid public key" };
  }

  let signatureValid = false;
  try {
    signatureValid = cryptoVerify(
      null,
      Buffer.from(`${head}.${body}`),
      key,
      fromB64url(sig),
    );
  } catch {
    return { signatureValid: false, reason: "signature verification error" };
  }
  if (!signatureValid) return { signatureValid: false, reason: "bad signature" };

  try {
    const payload = JSON.parse(fromB64url(body).toString("utf8")) as LicensePayload;
    // Licencia Medir: su vigencia real va en campos propios (effectiveTerm).
    return { signatureValid: true, payload: effectiveTerm(payload) };
  } catch {
    return { signatureValid: false, reason: "payload is not valid JSON" };
  }
}

/** Generate an Ed25519 keypair (PEM). Use to bootstrap the licensing service. */
export function generateLicenseKeypair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKey, privateKey };
}

export interface RevocationListVerification {
  /** True only if the signature is valid AND the header typ is a revocation list. */
  valid: boolean;
  payload?: RevocationListPayload;
  reason?: string;
}

/**
 * Mint a signed revocation-list token (control-plane helper). Identical Ed25519
 * wire format to a license token — `base64url(header).base64url(body).
 * base64url(sig)` over `${head}.${body}` — but stamped with {@link REVOCATION_HEADER}
 * (`typ:"BVSALA-REVOC"`) so it can never be confused with, or replayed as, a
 * license token. The private signing key lives ONLY in the control plane.
 */
export function signRevocationList(
  payload: RevocationListPayload,
  privateKey: string | KeyObject,
): string {
  const key = typeof privateKey === "string" ? createPrivateKey(privateKey) : privateKey;
  const head = b64url(JSON.stringify(REVOCATION_HEADER));
  const body = b64url(JSON.stringify(payload));
  const signingInput = `${head}.${body}`;
  const signature = cryptoSign(null, Buffer.from(signingInput), key);
  return `${signingInput}.${b64url(signature)}`;
}

/**
 * Verify a revocation-list token's signature and decode its payload. Asserts the
 * header `typ` is {@link REVOCATION_HEADER}'s (domain separation) BEFORE trusting
 * the body, so a valid license token presented as a revocation list is rejected.
 * Does NOT enforce `seq`/`asOf` policy — that is the client's monotonic/skew check.
 */
export function verifyRevocationList(
  token: string,
  publicKey: string | KeyObject,
): RevocationListVerification {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { valid: false, reason: "malformed token (expected 3 segments)" };
  }
  const [head, body, sig] = parts as [string, string, string];

  let header: { typ?: string };
  try {
    header = JSON.parse(fromB64url(head).toString("utf8")) as { typ?: string };
  } catch {
    return { valid: false, reason: "malformed header" };
  }
  if (header.typ !== REVOCATION_HEADER.typ) {
    return {
      valid: false,
      reason: `unexpected token type "${header.typ ?? ""}" (want ${REVOCATION_HEADER.typ})`,
    };
  }

  let key: KeyObject;
  try {
    key = typeof publicKey === "string" ? createPublicKey(publicKey) : publicKey;
  } catch {
    return { valid: false, reason: "invalid public key" };
  }

  let ok = false;
  try {
    ok = cryptoVerify(null, Buffer.from(`${head}.${body}`), key, fromB64url(sig));
  } catch {
    return { valid: false, reason: "signature verification error" };
  }
  if (!ok) return { valid: false, reason: "bad signature" };

  try {
    const payload = JSON.parse(fromB64url(body).toString("utf8")) as RevocationListPayload;
    return { valid: true, payload };
  } catch {
    return { valid: false, reason: "payload is not valid JSON" };
  }
}
