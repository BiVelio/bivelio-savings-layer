import { ed25519 } from "@noble/curves/ed25519.js";

import { vigenciaEfectiva } from "./vigencia.js";

/**
 * Offline license verification for the paid SDK.
 *
 * A license is a compact signed token `base64url(header).base64url(payload).
 * base64url(sig)`, the exact format BiVelio's licensing service mints. We verify
 * the Ed25519 signature against BiVelio's public key, decode the payload, and
 * apply the same grace policy the issuer applies. Verification is
 * **browser-safe**: it uses
 * `@noble/curves` (pure JS) + Web primitives (`atob`, `TextEncoder`) rather than
 * `node:crypto`, so the shared entry point still compiles into the browser
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
 *
 * `none` means "there is no key": what is left after `normalizeLicenseKey` is
 * EMPTY. It is the same value `LicenseError.status` already carries when nothing
 * was configured, because it is the same problem with the same fix: a
 * `licenseKey: "   "` (an empty environment variable, a blank secret file) used
 * to tell the customer their key "does not verify" — there was no key.
 */
export type LicenseStatus = "active" | "grace" | "expired" | "invalid" | "revoked" | "stale" | "none";

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
  /** Measure licenses only: the REAL term (see `vigenciaEfectiva` in ./vigencia.ts). */
  measure_expires_at?: number;
  measure_grace_days?: number;
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
 * Normalize a license key the way it arrives from the real world — ONCE, at the
 * entry point, never inside the verifier.
 *
 * The README says `export BIVELIO_LICENSE_KEY=…` and dotenv trims, so that path
 * never showed it. But anyone reading the key from a file (`readFileSync`), from
 * a Docker/Kubernetes secret (mounted as a file, trailing newline included) or
 * copying it out of an `Authorization` header handed over a CORRECT key with a
 * `\n` after it, a space before it, quotes around it or a `Bearer ` in front —
 * and the SDK answered "does not verify, check you pasted the WHOLE key". A
 * wrong diagnosis on a good key is the worst possible hint: it sends the
 * customer to look where the problem is not.
 *
 * Worse, it was INCONSISTENT: `tok + "\r\n"` passed and `tok + "\n"` did not,
 * because `atob` ignores ASCII whitespace while the padding was computed from a
 * length that included it, and two extra characters give the same remainder
 * modulo 4 as zero. Behavior that depends on which editor saved the file is not
 * behavior.
 *
 * Only OUTER wrapping is removed — whitespace, one pair of single or double
 * quotes, a `Bearer` prefix in any capitalization — in that order, in one pass.
 * Anything INSIDE the key is left alone: an interior space is not wrapping, it
 * is a broken key, and {@link licenseKeyShape} reports it as `malformed`.
 */
export function normalizeLicenseKey(raw: string): string {
  let k = raw.trim();
  // Comillas envolventes: un `.env` leído sin dotenv, un valor sacado de JSON.
  const conComillas = /^(["'])([\s\S]*)\1$/.exec(k);
  if (conComillas) k = conComillas[2]!.trim();
  // Prefijo `Bearer`: quien copió la cabecera entera de un ejemplo de curl.
  k = k.replace(/^bearer\s+/i, "");
  return k.trim();
}

/**
 * The SHAPE of an already-normalized key, so the error message can tell apart
 * three problems that used to get the same text:
 *
 *   · `empty`     — there is no key (only whitespace, or nothing at all).
 *   · `malformed` — not even the shape of a token: not three dot-separated
 *                   base64url segments. This is where the `bvk_` service key
 *                   pasted where the license goes lands, as does arbitrary text
 *                   or a token with a line break in the middle.
 *   · `token`     — has the shape; whether it verifies is up to the signature.
 *
 * It is the SAME shape rule {@link verifyCompactSignature} enforces, so that "has
 * the shape" and "verification was attempted" mean the same thing.
 */
export type LicenseKeyShape = "empty" | "malformed" | "token";

/** Un segmento base64url: lo ÚNICO que emite el acuñador (`toString("base64url")`,
 *  sin relleno). Todo lo demás —espacios, `=`, `+`, `/`— es que no es nuestro. */
const SEGMENTO_BASE64URL = /^[A-Za-z0-9_-]+$/;

function tieneFormaDeTokenCompacto(token: string): boolean {
  const parts = token.split(".");
  return parts.length === 3 && parts.every((p) => SEGMENTO_BASE64URL.test(p));
}

/** Classify a normalized key. See {@link LicenseKeyShape}. */
export function licenseKeyShape(normalizedKey: string): LicenseKeyShape {
  if (normalizedKey === "") return "empty";
  return tieneFormaDeTokenCompacto(normalizedKey) ? "token" : "malformed";
}

/**
 * Verify the Ed25519 signature of any BV-SALA compact token
 * (`base64url(header).base64url(body).base64url(sig)`, sig over `${head}.${body}`)
 * and return the decoded header + raw payload bytes. This is the single shared
 * crypto primitive: license tokens AND signed revocation lists both go through it,
 * so the browser (`@noble/curves`) and node (`node:crypto`) sides agree byte-for-byte
 * and there is no bespoke per-message verification path to keep in sync. It does NOT
 * interpret the payload or the header `typ` — callers do that.
 *
 * Shape is checked SEGMENT by segment, not just by counting dots. Three parts
 * used to be enough and the rest was left to `atob`, which ignores whitespace:
 * that is how a token with `\r\n` after it verified while the same token with
 * `\n` did not (see {@link normalizeLicenseKey}). The shared primitive must give
 * the same answer to the same input, always; a caller that wants to tolerate
 * wrapping normalizes BEFORE calling.
 */
export function verifyCompactSignature(
  token: string,
  publicKey: string | LicenseKeyset,
): CompactVerification {
  if (!tieneFormaDeTokenCompacto(token)) return { ok: false, reason: "malformed token" };
  const parts = token.split(".");
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
    return { signatureValid: true, payload: vigenciaEfectiva(payload) };
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
 * Verify + apply the grace policy → a resolved status. Mirrors what the issuing
 * control plane resolves for the same token. Bad signature / malformed
 * → invalid; otherwise the status comes from {@link deriveStatus}.
 *
 * A public entry point, so it normalizes like the others (gate and refresher):
 * the same key must resolve the same whichever way it comes in.
 */
export function resolveLicense(
  token: string,
  publicKey: string | LicenseKeyset,
  opts: { nowSeconds?: number; revoked?: ReadonlySet<string> } = {},
): ResolvedLicense {
  const key = normalizeLicenseKey(token);
  const shape = licenseKeyShape(key);
  if (shape === "empty") return { status: "none", reason: "empty" };
  const v = verifyLicenseToken(key, publicKey);
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
