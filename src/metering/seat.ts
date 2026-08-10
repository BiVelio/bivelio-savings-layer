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

/**
 * ¿Este nombre de máquina sobrevive a un reinicio?
 *
 * En Docker es el id del contenedor (12 hex) y en Kubernetes lleva el sufijo
 * aleatorio del pod: los dos cambian en CADA arranque. Meterlos en la huella
 * hacía que el asiento fuese nuevo cada vez que el proceso se reiniciaba, y
 * `billable_seats` exige >= 3 días distintos POR asiento
 * (db/migrations/0003_metering.sql): un contenedor que se reinicia a diario
 * nunca acumula tres días con el mismo id, así que la base facturable se
 * desploma a CERO. El docstring de este módulo prometía justo lo contrario.
 */
function esNombreEfimero(h: string): boolean {
  if (/^[0-9a-f]{12}$/.test(h)) return true; // id corto de contenedor Docker
  return /-[0-9a-z]{5,10}-[0-9a-z]{5}$/.test(h); // <deploy>-<rs>-<pod> de k8s
}

/**
 * Lee `os.hostname()` sin que el módulo gane un import de builtin de Node.
 *
 * El especificador se construye en tiempo de ejecución (join, no un literal que
 * esbuild pudiera plegar) para que el bundler NO lo resuelva ni lo meta en el
 * bundle de navegador; en un navegador `proc()?.execPath` no existe y esto ni
 * se intenta, y si algún runtime raro lo intentara igual, el catch lo absorbe.
 */
async function nodeHostname(): Promise<string | undefined> {
  if (!proc()?.execPath) return undefined; // solo un runtime Node-like
  try {
    const especificador = ["node", "os"].join(":");
    const os = (await import(/* @vite-ignore */ especificador)) as {
      hostname?: () => string;
    };
    const h = typeof os.hostname === "function" ? os.hostname() : "";
    return h.length > 0 ? h : undefined;
  } catch {
    return undefined;
  }
}

/**
 * El nombre estable de la máquina, si existe.
 *
 * `HOSTNAME` es una variable de bash INTERACTIVO: bajo systemd, launchd o
 * cualquier gestor de servicios —el despliegue de producción más común— no está
 * en el entorno. Con `host=undefined`, la huella quedaba en
 * platform|arch|execPath|USER|HOME, que es IDÉNTICA en una flota de VMs
 * clonadas: 10 máquinas facturaban como 1 asiento. No era solo un problema de
 * contenedores. De ahí el fallback a `os.hostname()`, que sí existe siempre en
 * Node. Un nombre efímero (contenedor/pod) se sigue descartando venga de donde
 * venga: más vale que varias réplicas compartan asiento a que cada reinicio
 * invente uno nuevo y la facturación no cuente ninguno.
 *
 * Exportada para poder probar la lógica con un lector inyectado; el parámetro
 * tiene el valor real por defecto.
 */
export async function hostDeMaquina(
  e: Record<string, string | undefined>,
  leerHostname: () => Promise<string | undefined> = nodeHostname,
): Promise<string | undefined> {
  if (e["KUBERNETES_SERVICE_HOST"]) return undefined; // pod: sufijo aleatorio
  const candidato = e["HOSTNAME"] ?? e["COMPUTERNAME"] ?? (await leerHostname());
  if (!candidato || esNombreEfimero(candidato)) return undefined;
  return candidato;
}

/** Stable-ish per-machine+user fingerprint from ambient process info (Node). */
async function machineFingerprint(): Promise<string | undefined> {
  const p = proc();
  if (!p || !p.env) return undefined;
  const e = p.env;
  const host = await hostDeMaquina(e);
  const parts = [
    p.platform,
    p.arch,
    p.execPath,
    host,
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
  // Escape explícito, sin tocar código: en un despliegue donde la identidad de
  // máquina no se puede deducir (contenedores, funciones sin estado), basta con
  // fijar BVSALA_SEAT_ID por réplica o por servicio. Es la vía recomendada, y la
  // única que garantiza que el asiento signifique lo que el cliente quiere.
  const env = proc()?.env;
  const explicito = env?.["BVSALA_SEAT_ID"];
  if (explicito && SEAT_ID_PATTERN.test(explicito)) return explicito;

  const fp = await machineFingerprint();
  if (!fp) return undefined;
  const hex = await hmacSha256Hex(serviceAccountKey, fp);
  if (!hex) return undefined;
  return `m-${hex.slice(0, 32)}`;
}

/** Mismo juego de caracteres que exige el plano de control para una identidad. */
const SEAT_ID_PATTERN = /^[A-Za-z0-9._:/-]{1,128}$/;
