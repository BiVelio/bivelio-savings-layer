import {
  sign as cryptoSign,
  verify as cryptoVerify,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import type { LicensePayload } from "@bivelio/protocol";

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
    return { signatureValid: true, payload };
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
