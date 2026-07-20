import { sign, createPrivateKey } from "node:crypto";

/**
 * Server-side signing helpers for the control-plane license surface. Same compact
 * Ed25519 wire format the SDK verifies offline (`src/license/verify.ts`). The PRIVATE
 * key lives ONLY server-side (`LICENSE_PRIVATE_KEY_B64` / `LICENSE_PRIVATE_KEY`).
 */
const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** Load the Ed25519 private key (PEM) from the environment; null if unset. */
export function loadPrivateKey(): string | null {
  const b64 = process.env.LICENSE_PRIVATE_KEY_B64;
  if (b64) return Buffer.from(b64, "base64").toString("utf8");
  const raw = process.env.LICENSE_PRIVATE_KEY;
  return raw ? raw.replace(/\\n/g, "\n") : null;
}

/** Sign a compact `base64url(header).base64url(body).base64url(sig)` token. */
export function signCompact(header: object, payload: object, privateKeyPem: string): string {
  const head = b64url(JSON.stringify(header));
  const body = b64url(JSON.stringify(payload));
  const sig = sign(null, Buffer.from(`${head}.${body}`), createPrivateKey(privateKeyPem));
  return `${head}.${body}.${b64url(sig)}`;
}

export interface RevocationList {
  /** Unix seconds when signed. */
  asOf: number;
  /** Monotonic revision (published from the ledger's max seq). */
  seq: number;
  /** Revoked license ids (jti). */
  revoked: string[];
}

/**
 * Sign a revocation list. Header `typ:"BVSALA-REVOC"` gives domain separation from
 * license tokens — the SDK's `verifyRevocationList` rejects anything else.
 */
export function signRevocationList(list: RevocationList, privateKeyPem: string): string {
  return signCompact(
    { alg: "EdDSA", typ: "BVSALA-REVOC", v: 1 },
    { v: 1, asOf: list.asOf, seq: list.seq, revoked: list.revoked, iss: "bivelio-licensing" },
    privateKeyPem,
  );
}

/** Weak ETag keyed on the monotonic revision — mirrors services/licensing app.ts. */
export const revocationEtag = (seq: number): string => `W/"revoc-${seq}"`;
