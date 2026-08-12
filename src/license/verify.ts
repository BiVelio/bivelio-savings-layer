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

/**
 * `stale` NO es una licencia caducada: es una licencia PAGADA Y VIGENTE que no ha
 * podido confirmar su estado contra el control plane dentro de la ventana de
 * frescura — típicamente porque la salida de red está bloqueada.
 *
 * Existe porque antes ese caso reutilizaba `expired` "para que el union y todos
 * los consumidores siguieran igual", y el ahorro de tipo se pagaba con el peor
 * mensaje posible del producto: a un cliente al día, cuyo único problema era un
 * cortafuegos, se le decía *"license is not active (expired). Renew your
 * subscription"*. Le mandábamos a pagar otra vez algo que ya había pagado, y a
 * mirar donde no estaba el problema.
 *
 * El comportamiento no cambia —sigue siendo fail-closed, `granted()` no lo
 * concede— pero ahora el mensaje puede decir la verdad.
 */
export type LicenseStatus = "active" | "grace" | "expired" | "invalid" | "revoked" | "stale";

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
 * A pinned set of Ed25519 public keys addressed by key-id (`kid`), enabling signing
 * key ROTATION without breaking already-deployed SDKs: new keys are added as extra
 * map entries, and tokens carry the `kid` they were signed with. `defaultKid` is the
 * key used for legacy tokens that carry NO `kid` (so today's single-key tokens keep
 * verifying unchanged). Verification FAILS CLOSED on a `kid` not in the map.
 */
export interface LicenseKeyset {
  /** kid → SPKI PEM. */
  keys: Record<string, string>;
  /** kid used for tokens without a `kid` header (the current/legacy key). */
  defaultKid: string;
}

/** Narrow a verification key to a {@link LicenseKeyset} (vs a bare SPKI PEM string). */
export function isKeyset(k: string | LicenseKeyset): k is LicenseKeyset {
  return typeof k === "object" && k !== null && "keys" in k;
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
export function verifyCompactSignature(
  token: string,
  publicKey: string | LicenseKeyset,
): CompactVerification {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed token" };
  const head = parts[0]!;
  const body = parts[1]!;
  const sig = parts[2]!;

  // Parse the header BEFORE resolving the key so a keyset can select the pinned key
  // by `kid` (JWS semantics). Reading the not-yet-verified kid is safe: it can only
  // SELECT among pinned keys, never inject one, and an unknown kid fails closed below.
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(dec.decode(base64urlToBytes(head))) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "header is not valid JSON" };
  }

  // Resolve the verification key. A plain string is used as-is (kid ignored) —
  // byte-identical to the pre-keyset behavior for every existing caller, so an
  // already-deployed single-key SDK still verifies a kid-stamped token. A keyset
  // selects by the token's kid (defaulting to defaultKid for legacy no-kid tokens)
  // and FAILS CLOSED on an unknown kid — never a silent fallback that would mask a
  // rotation misconfig.
  let publicKeyPem: string;
  if (isKeyset(publicKey)) {
    const kid = typeof header["kid"] === "string" ? (header["kid"] as string) : publicKey.defaultKid;
    const pem = publicKey.keys[kid];
    if (!pem) return { ok: false, reason: `unknown key id "${kid}"` };
    publicKeyPem = pem;
  } else {
    if (!publicKey) return { ok: false, reason: "no verification key" };
    publicKeyPem = publicKey;
  }

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

  return { ok: true, header, payloadBytes: base64urlToBytes(body) };
}

/** Verify a token's signature and decode its payload. Does not check expiry. */
export function verifyLicenseToken(
  token: string,
  publicKey: string | LicenseKeyset,
): { signatureValid: boolean; payload?: LicenseTokenPayload; reason?: string } {
  const v = verifyCompactSignature(token, publicKey);
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
  publicKey: string | LicenseKeyset,
  opts: { nowSeconds?: number; revoked?: ReadonlySet<string> } = {},
): ResolvedLicense {
  const v = verifyLicenseToken(token, publicKey);
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
