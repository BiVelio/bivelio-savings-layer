/**
 * DETECTIVE seat identity for usage metering. A "seat" is a distinct MACHINE /
 * service identity — NEVER a human. `deriveSeatId` produces a stable, opaque,
 * per-account id by HMAC-ing a machine fingerprint with the service-account key:
 *   - stable across restarts on the same machine (same billable seat),
 *   - never reveals the fingerprint (HMAC keyed by the secret SA key),
 *   - different accounts on the same machine get different ids.
 *
 * Universal + dependency-free: uses only WebCrypto (`globalThis.crypto.subtle`)
 * and ambient `process` env, both guarded — so this module carries NO Node builtin
 * import and is safe in the browser bundle (where it simply yields no seat id).
 */

type ProcLike = {
  platform?: string;
  arch?: string;
  execPath?: string;
  env?: Record<string, string | undefined>;
};

function proc(): ProcLike | undefined {
  return (globalThis as { process?: ProcLike }).process;
}

/** Stable-ish per-machine+user fingerprint from ambient process info (Node). */
function machineFingerprint(): string | undefined {
  const p = proc();
  if (!p || !p.env) return undefined;
  const e = p.env;
  const parts = [
    p.platform,
    p.arch,
    p.execPath,
    e["HOSTNAME"] ?? e["COMPUTERNAME"],
    e["USER"] ?? e["USERNAME"] ?? e["LOGNAME"],
    e["HOME"] ?? e["USERPROFILE"],
  ].filter((x): x is string => typeof x === "string" && x.length > 0);
  return parts.length ? parts.join("|") : undefined;
}

/** Env vars that mark a CI / ephemeral runner (excluded from BILLABLE seats). */
const CI_ENV_KEYS = [
  "CI",
  "CONTINUOUS_INTEGRATION",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "CIRCLECI",
  "TRAVIS",
  "JENKINS_URL",
  "BUILDKITE",
  "TF_BUILD",
  "TEAMCITY_VERSION",
  "BITBUCKET_BUILD_NUMBER",
  "CODEBUILD_BUILD_ID",
  "HEROKU_TEST_RUN_ID",
  "DRONE",
] as const;

/** True when running in a CI / ephemeral environment. */
export function detectCi(): boolean {
  const e = proc()?.env;
  if (!e) return false;
  for (const k of CI_ENV_KEYS) {
    const v = e[k];
    if (v && v !== "false" && v !== "0") return true;
  }
  return false;
}

// Structural view of WebCrypto (the SDK tsconfig has no DOM lib, mirroring how
// util/id.ts declares its own `CryptoLike` instead of the ambient `Crypto` type).
type SubtleLike = {
  importKey(
    format: "raw",
    keyData: Uint8Array,
    algorithm: { name: "HMAC"; hash: "SHA-256" },
    extractable: boolean,
    keyUsages: string[],
  ): Promise<unknown>;
  sign(algorithm: "HMAC", key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
};
type CryptoLike = { subtle?: SubtleLike };

async function hmacSha256Hex(key: string, data: string): Promise<string | undefined> {
  const c = (globalThis as { crypto?: CryptoLike }).crypto;
  const enc = new TextEncoder();
  if (c?.subtle) {
    try {
      const k = await c.subtle.importKey(
        "raw",
        enc.encode(key),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const sig = await c.subtle.sign("HMAC", k, enc.encode(data));
      return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch {
      /* fall through to the non-crypto fallback */
    }
  }
  // Fallback (FNV-1a) — stability only, used if WebCrypto is unavailable. Not a
  // security primitive; the seat id is an opaque grouping key, not a secret.
  let h = 0x811c9dc5;
  const s = `${key}|${data}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Derive the machine seat id for a service-account key. Resolves to `undefined`
 * when no machine fingerprint is available (e.g. a browser) — the caller then
 * reports no seatId and the server counts the request under an "unknown" seat.
 * The id (`m-<32 hex>`) matches the control plane's identity charset.
 */
export async function deriveSeatId(serviceAccountKey: string): Promise<string | undefined> {
  const fp = machineFingerprint();
  if (!fp) return undefined;
  const hex = await hmacSha256Hex(serviceAccountKey, fp);
  if (!hex) return undefined;
  return `m-${hex.slice(0, 32)}`;
}
