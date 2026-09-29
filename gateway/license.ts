import {
  EMBEDDED_PUBLIC_KEY,
  deriveStatus,
  isKeyset,
  licenseKeyShape,
  liveGateFromKey,
  normalizeLicenseKey,
  verifyCompactSignature,
  vigenciaEfectiva,
  type LicenseKeyset,
  type LicenseStatus,
  type LicenseTokenPayload,
  type ResolvedGate,
  type RevocationPollerOptions,
  type RevocationSnapshot,
} from "../src/license/index.js";

/**
 * LA LICENCIA DE LA PASARELA (LICENSE §2: «The Software requires a valid, active
 * License Key and does not operate without one»).
 *
 * Hasta 0.4.22 el gateway arrancaba y reenviaba sin licencia, y sin clave de
 * servicio ni siquiera medía: un free tier que el README y la LICENSE niegan.
 * Este módulo pone las dos verjas que faltaban, y NINGUNA más:
 *
 *   · AL ARRANCAR (`resolveStartupLicense`): la licencia se recoge SIEMPRE con la
 *     `bvk_` en /api/license/current, que la ata a la org de esa clave, y se
 *     verifica contra la clave pública EMBEBIDA. `BIVELIO_LICENSE_KEY` es solo el
 *     respaldo cuando savings.bivelio.com no responde. Sin licencia: exit 1.
 *   · POR PETICIÓN NUEVA (`licenseVerdict`): la caducidad con reloj vivo, la
 *     revocación por jti (RevocationPoller) y el bloqueo que declare el control
 *     plane (el `reason` del canal de entitlements). Si corta, un 402 JSON ANTES
 *     de leer el cuerpo o tocar el upstream. Lo que ya pasó la verja termina
 *     siempre: jamás se corta una petición en vuelo.
 *
 * El candado de COBRO sigue siendo el servidor (ingesta y canal), que no se
 * puede parchear; esto es cumplimiento y experiencia: que el cliente sepa
 * exactamente qué le falta y dónde se arregla.
 *
 * Todo lo que ve el cliente va en INGLÉS y en ASCII puro (sin «…» ni «—»), y
 * jamás lleva el valor de la `bvk_` ni del token.
 */

export const LICENSE_SERVER_URL = "https://savings.bivelio.com";
export const ACCOUNT_URL = "https://savings.bivelio.com/dashboard/account";
export const INSTALL_URL = "https://savings.bivelio.com/dashboard/install";
export const STARTUP_TIMEOUT_MS = 10_000;
export const STARTUP_TIMEOUT_WITH_FALLBACK_MS = 3_000;
export const FORCED_RENEWAL_MIN_INTERVAL_MS = 60_000;
export const RENEWAL_INTERVAL_MS = 3_600_000;
export const RENEWAL_LEAD_SECONDS = 7 * 86_400;
export const RENEWAL_TIMEOUT_MS = 30_000;

const DIA = 86_400;
const TYP_LICENCIA = "BVL";

// ── La clave de verificación ────────────────────────────────────────────────

declare const __BV_SALA_ALLOW_DEV_OPEN__: boolean | undefined;

/**
 * The verification key actually used for a caller-supplied one: in the
 * published build it is always the embedded key.
 */
export function effectivePublicKey(injected: string | LicenseKeyset): string | LicenseKeyset {
  // El MISMO patrón que create.ts con `licenseGate`: en el paquete PUBLICADO
  // (`__BV_SALA_ALLOW_DEV_OPEN__` compilado a `false`) la única clave que vale es
  // la EMBEBIDA, venga lo que venga del llamante; si no, quien trajera su propia
  // pública firmaría licencias con su privada y abriría el gateway. Desde el
  // fuente (tests, arnés con tsx) la bandera es undefined y la embebida es "":
  // entonces, y solo entonces, se acepta la inyectada, que es como los tests
  // montan su par de prueba.
  const buildPublicado =
    typeof __BV_SALA_ALLOW_DEV_OPEN__ !== "undefined" && __BV_SALA_ALLOW_DEV_OPEN__ === false;
  if (buildPublicado) return EMBEDDED_PUBLIC_KEY;
  return EMBEDDED_PUBLIC_KEY || injected;
}

function claveVacia(k: string | LicenseKeyset): boolean {
  if (isKeyset(k)) return Object.keys(k.keys ?? {}).length === 0;
  return typeof k !== "string" || k.trim() === "";
}

// ── Verificación de un token ────────────────────────────────────────────────

/** A normalized, verified license token and its validated payload. */
export interface VerifiedLicense {
  token: string;
  payload: LicenseTokenPayload;
}

export type LicenseCheck =
  | { ok: true; license: VerifiedLicense }
  | { ok: false; shape: "empty" | "malformed" | "token"; reason: string };

const noVacia = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const finito = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Whether a decoded payload has every license field with the right type. */
export function isLicensePayload(p: unknown): p is LicenseTokenPayload {
  if (p === null || typeof p !== "object" || Array.isArray(p)) return false;
  const o = p as Record<string, unknown>;
  return (
    noVacia(o.jti) &&
    noVacia(o.org_id) &&
    noVacia(o.plan) &&
    finito(o.seats) &&
    finito(o.issued_at) &&
    finito(o.expires_at) &&
    finito(o.grace_days) &&
    (o.grace_days as number) >= 0 &&
    Array.isArray(o.features) &&
    o.features.every((f) => typeof f === "string")
  );
}

/**
 * Verify a license key for the gateway: shape, Ed25519 signature, header
 * `typ`, JSON payload and field types. Never throws.
 */
export function verifyGatewayLicense(raw: string, publicKey: string | LicenseKeyset): LicenseCheck {
  try {
    // Misma normalización que el SDK: un `\n` final, comillas o un `Bearer `
    // delante no convierten una clave buena en una mala.
    const key = normalizeLicenseKey(typeof raw === "string" ? raw : "");
    const shape = licenseKeyShape(key);
    if (shape === "empty") return { ok: false, shape: "empty", reason: "empty" };
    if (shape === "malformed") return { ok: false, shape: "malformed", reason: "malformed" };
    const v = verifyCompactSignature(key, publicKey);
    if (!v.ok || !v.payloadBytes) return { ok: false, shape: "token", reason: ascii(v.reason ?? "bad signature") };
    // SEPARACIÓN DE DOMINIO: `verifyLicenseToken` no mira `typ`, así que una
    // lista de revocaciones firmada (typ BVSALA-REVOC) pasaría por licencia.
    const typ = v.header?.["typ"];
    if (typ !== TYP_LICENCIA) {
      return { ok: false, shape: "token", reason: `not a license token (typ ${ascii(String(typ ?? "none"))})` };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(v.payloadBytes));
    } catch {
      return { ok: false, shape: "token", reason: "payload is not valid JSON" };
    }
    if (!isLicensePayload(payload)) {
      return { ok: false, shape: "token", reason: "license payload has the wrong field types" };
    }
    // Licencia Medir: la vigencia real va en sus campos propios (ver vigenciaEfectiva).
    return { ok: true, license: { token: key, payload: vigenciaEfectiva(payload) } };
  } catch (err) {
    return { ok: false, shape: "token", reason: `verification error: ${ascii(String(err))}` };
  }
}

/** The license status at `nowMs` (the revoked set is optional). */
export function licenseState(
  payload: LicenseTokenPayload,
  nowMs: number,
  revoked?: ReadonlySet<string>,
): LicenseStatus {
  return deriveStatus(payload, Math.floor(nowMs / 1000), revoked);
}

const concede = (s: LicenseStatus): s is "active" | "grace" => s === "active" || s === "grace";

// ── La recogida online ──────────────────────────────────────────────────────

export type Collection =
  | { kind: "token"; license: VerifiedLicense }
  | { kind: "not-verifying"; reason: string }
  | { kind: "key-unknown" }
  | { kind: "no-license" }
  | { kind: "unreachable"; cause: string };

/** Solo ASCII imprimible y acotado: lo que llega de fuera (un error de red, un
 *  motivo del verificador) acaba en una línea de terminal. */
function ascii(s: string, max = 200): string {
  const limpio = s.replace(/[^\x20-\x7E]/g, "?");
  return limpio.length > max ? `${limpio.slice(0, max)}...` : limpio;
}

function segundos(ms: number): string {
  return `${Number((ms / 1000).toFixed(3))} s`;
}

/** El fallo de un fetch con su causa: undici lo envuelve todo en «fetch failed». */
function describirFalloDeRed(err: unknown): string {
  const e = err as { message?: unknown; cause?: unknown } | null;
  const mensaje = typeof e?.message === "string" && e.message !== "" ? e.message : String(err);
  const causa = e?.cause as { code?: unknown; message?: unknown } | undefined;
  const codigo =
    causa && typeof causa.code === "string"
      ? causa.code
      : causa && typeof causa.message === "string"
        ? causa.message
        : undefined;
  return codigo ? `${mensaje} (${codigo})` : mensaje;
}

/**
 * Fetch the organization's current license with the service key. Never throws.
 */
export async function collectLicense(opts: {
  licenseServerUrl: string;
  serviceAccountKey: string;
  publicKey: string | LicenseKeyset;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<Collection> {
  const url = `${opts.licenseServerUrl.replace(/\/+$/, "")}/api/license/current`;
  // Una causa jamás lleva la clave: si un error de red la citara, se tapa.
  const sinClave = (s: string): string =>
    opts.serviceAccountKey ? s.split(opts.serviceAccountKey).join("[service key]") : s;
  // Timeout con AbortController + setTimeout (no AbortSignal.timeout): así se
  // puede simular con temporizadores falsos, y el `unref` no retiene el proceso.
  const ctrl = new AbortController();
  let vencido = false;
  const t = setTimeout(() => {
    vencido = true;
    ctrl.abort();
  }, opts.timeoutMs);
  (t as unknown as { unref?: () => void }).unref?.();
  const alAbortar = (): void => ctrl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener("abort", alAbortar, { once: true });
  }
  const inalcanzable = (err: unknown): Collection =>
    vencido
      ? { kind: "unreachable", cause: `timed out after ${segundos(opts.timeoutMs)}` }
      : { kind: "unreachable", cause: ascii(sinClave(`network error: ${describirFalloDeRed(err)}`)) };
  try {
    // Resuelto EN LA LLAMADA: un fetch sustituido después de cargar el módulo
    // (tests, el preámbulo sin red de la sala limpia) es el que se usa.
    const f = opts.fetchImpl ?? globalThis.fetch;
    let res: Response;
    try {
      res = await f(url, {
        method: "GET",
        headers: { authorization: `Bearer ${opts.serviceAccountKey}`, accept: "application/json" },
        signal: ctrl.signal,
      });
    } catch (err) {
      return inalcanzable(err);
    }
    if (res.status === 401) return { kind: "key-unknown" };
    if (res.status === 404) return { kind: "no-license" };
    if (!res.ok) return { kind: "unreachable", cause: `HTTP ${res.status}` };
    let cuerpo: unknown;
    try {
      cuerpo = await res.json();
    } catch (err) {
      if (vencido || ctrl.signal.aborted) return inalcanzable(err);
      return { kind: "unreachable", cause: "unexpected response (no license token)" };
    }
    const token = (cuerpo as { token?: unknown } | null)?.token;
    if (typeof token !== "string" || token.trim() === "") {
      return { kind: "unreachable", cause: "unexpected response (no license token)" };
    }
    const c = verifyGatewayLicense(token, opts.publicKey);
    if (!c.ok) return { kind: "not-verifying", reason: ascii(c.reason) };
    return { kind: "token", license: c.license };
  } catch (err) {
    return inalcanzable(err);
  } finally {
    clearTimeout(t);
    opts.signal?.removeEventListener("abort", alAbortar);
  }
}

// ── El arranque ─────────────────────────────────────────────────────────────

export type StartupFailureCode =
  | "no-public-key"
  | "service-key-missing"
  | "service-key-malformed"
  | "service-key-not-recognised"
  | "no-license"
  | "license-invalid"
  | "license-expired"
  | "unreachable";

export interface StartupInput {
  /** BIVELIO_SERVICE_KEY (trimmed here). */
  serviceAccountKey?: string;
  /** BIVELIO_LICENSE_KEY: the offline fallback. */
  licenseKey?: string;
  licenseServerUrl: string;
  publicKey: string | LicenseKeyset;
  fetchImpl?: typeof fetch;
  /** Clock in milliseconds. */
  now?: () => number;
  /** Replaces the 10 s / 3 s defaults. */
  timeoutMs?: number;
}

export type StartupResult =
  | {
      ok: true;
      license: VerifiedLicense;
      source: "online" | "offline";
      status: "active" | "grace";
      line: string;
      lineIsWarning: boolean;
      warnings: string[];
    }
  | { ok: false; code: StartupFailureCode; message: string };

export interface FailureContext {
  tokenSource?: "BIVELIO_LICENSE_KEY" | "savings.bivelio.com";
  shape?: "malformed" | "token";
  reason?: string;
  /** Unix seconds. */
  expiresAt?: number;
  graceDays?: number;
  cause?: string;
  keyLooksLikeLicense?: boolean;
}

/** UTC YYYY-MM-DD. */
export function isoDay(unixSeconds: number): string {
  try {
    return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
  } catch {
    return "an unknown date";
  }
}

const finDeGracia = (expiresAt: number, graceDays: number): number => expiresAt + graceDays * DIA;

const ORG_MISMATCH =
  "WARNING: BIVELIO_LICENSE_KEY belongs to a different organization than BIVELIO_SERVICE_KEY and is ignored; " +
  "the license of the service key's organization is used. Unset BIVELIO_LICENSE_KEY or replace it with this " +
  "organization's license key.";

const onlineNoVerifica = (reason: string): string =>
  `WARNING: the license served by savings.bivelio.com does not verify against this build's BiVelio key (${reason}); ` +
  "starting with BIVELIO_LICENSE_KEY. Update @bivelio/savings-layer (npm i -g @bivelio/savings-layer).";

/** The customer-facing text of a startup failure (no prefix). */
export function startupFailureMessage(code: StartupFailureCode, ctx: FailureContext = {}): string {
  switch (code) {
    case "no-public-key":
      return (
        "this build has no embedded BiVelio verification key (it is running from source): install the published " +
        "package (npm i -g @bivelio/savings-layer) or run pnpm build first."
      );
    case "service-key-missing":
      return (
        "BIVELIO_SERVICE_KEY is not set. The gateway needs two things and does not start without them: an active " +
        `BiVelio subscription (${ACCOUNT_URL}) and its service key (bvk_..., created at ${INSTALL_URL}, step 2). ` +
        "Export the key and relaunch: the license is collected with it automatically."
      );
    case "service-key-malformed":
      return (
        "BIVELIO_SERVICE_KEY does not look like a service key (service keys start with bvk_)." +
        (ctx.keyLooksLikeLicense ? " It looks like a license key: that one goes in BIVELIO_LICENSE_KEY." : "") +
        ` Create a service key at ${INSTALL_URL} (step 2), export it and relaunch.`
      );
    case "service-key-not-recognised":
      return (
        "BIVELIO_SERVICE_KEY is not recognised by savings.bivelio.com (HTTP 401): it was deleted or rotated, or it " +
        `was copied incompletely. Create a new one at ${INSTALL_URL} (step 2), export it and relaunch.`
      );
    case "no-license":
      return (
        "your organization has no active BiVelio license, and the gateway does not start without one. Get the free " +
        `Measure license (no card; shadow mode: it measures and applies no lever) at ${INSTALL_URL}, or subscribe at ` +
        `${ACCOUNT_URL}, and relaunch; the license is collected automatically with your service key.`
      );
    case "license-expired": {
      const e = ctx.expiresAt ?? 0;
      return (
        `your BiVelio license expired on ${isoDay(e)} and its grace period ended on ` +
        `${isoDay(finDeGracia(e, ctx.graceDays ?? 0))}. Renew at ${ACCOUNT_URL} and relaunch.` +
        (ctx.cause
          ? ` (savings.bivelio.com could not be reached to look for a renewed license: ${ctx.cause})`
          : "")
      );
    }
    case "license-invalid": {
      const reason = ctx.reason ?? "bad signature";
      if (ctx.tokenSource === "savings.bivelio.com") {
        return (
          `the license served by savings.bivelio.com does not verify against this build's BiVelio key (${reason}). ` +
          "Update @bivelio/savings-layer (npm i -g @bivelio/savings-layer); if it persists, write to " +
          "support@bivelio.com."
        );
      }
      if (ctx.shape === "malformed") {
        return (
          "BIVELIO_LICENSE_KEY is not a license key: a license key has three dot-separated parts and several " +
          "hundred characters. Did you paste the bvk_ service key by mistake? That one goes in " +
          `BIVELIO_SERVICE_KEY; the license key is the other value on ${INSTALL_URL}. Or unset ` +
          "BIVELIO_LICENSE_KEY: the gateway collects the license online by itself."
        );
      }
      return (
        `BIVELIO_LICENSE_KEY does not verify against this build's BiVelio key (${reason}). Copy the WHOLE key ` +
        `again from ${INSTALL_URL}, or unset BIVELIO_LICENSE_KEY to collect it online; if it persists, update ` +
        "@bivelio/savings-layer or write to support@bivelio.com."
      );
    }
    case "unreachable":
      return (
        `could not collect your license from savings.bivelio.com (${ctx.cause ?? "unknown cause"}). The gateway ` +
        "does not start without a verified license. Check your connection and relaunch. If savings.bivelio.com is " +
        `down, export BIVELIO_LICENSE_KEY=<your license key> (from ${INSTALL_URL}) as a fallback: it is verified ` +
        "on this machine and used only when savings.bivelio.com cannot be reached, and it must be replaced by hand " +
        "every billing period."
      );
  }
}

/** The startup line that says which license is loaded and where it came from (no prefix). */
export function licenseLine(
  payload: LicenseTokenPayload,
  source: "online" | "offline",
  status: "active" | "grace",
  cause?: string,
): string {
  const plan = payload.plan.toUpperCase();
  const d = payload.grace_days;
  const e = isoDay(payload.expires_at);
  const origen =
    source === "online"
      ? "collected with your service key and verified on this machine"
      : cause
        ? `from BIVELIO_LICENSE_KEY, verified on this machine (savings.bivelio.com unreachable: ${cause})`
        : "from BIVELIO_LICENSE_KEY, verified on this machine";
  if (status === "grace") {
    const g = isoDay(finDeGracia(payload.expires_at, d));
    return `license: ${plan}, IN GRACE: expired on ${e}, keeps working until ${g}. Renew at ${ACCOUNT_URL} (${origen})`;
  }
  return `license: ${plan}, active until ${e} (+${d} ${d === 1 ? "day" : "days"} grace), ${origen}`;
}

const fallo = (code: StartupFailureCode, ctx?: FailureContext): StartupResult => ({
  ok: false,
  code,
  message: startupFailureMessage(code, ctx),
});

/**
 * Resolve the license the gateway starts with, or the exact reason it cannot
 * start. Collects the license online with the service key every time; the
 * offline key is used only when the license server cannot be reached.
 */
export async function resolveStartupLicense(input: StartupInput): Promise<StartupResult> {
  const now = input.now ?? Date.now;
  const publicKey = effectivePublicKey(input.publicKey);

  // E0 · sin clave pública no hay nada que verificar (solo pasa desde el fuente).
  if (claveVacia(publicKey)) return fallo("no-public-key");

  // E1 · la clave de servicio: la identidad de la org, sin red.
  const key = input.serviceAccountKey?.trim();
  if (!key) return fallo("service-key-missing");
  if (!key.startsWith("bvk_")) {
    return fallo("service-key-malformed", {
      keyLooksLikeLicense: licenseKeyShape(normalizeLicenseKey(key)) === "token",
    });
  }

  // E2 · el respaldo offline, si lo hay. Un valor que no verifica se dice YA,
  // sin red: es un error de copia que la red no va a arreglar.
  let offline: VerifiedLicense | null = null;
  if (input.licenseKey !== undefined) {
    const c = verifyGatewayLicense(input.licenseKey, publicKey);
    if (c.ok) offline = c.license;
    else if (c.shape !== "empty") {
      return fallo("license-invalid", { tokenSource: "BIVELIO_LICENSE_KEY", shape: c.shape, reason: c.reason });
    }
  }
  const offlineConcede = offline !== null && concede(licenseState(offline.payload, now()));

  // E3 · SIEMPRE: la licencia de la org de la `bvk_` es la verdad. Con un
  // respaldo que concede, la espera se acorta a 3 s.
  const r = await collectLicense({
    licenseServerUrl: input.licenseServerUrl,
    serviceAccountKey: key,
    publicKey,
    timeoutMs: input.timeoutMs ?? (offlineConcede ? STARTUP_TIMEOUT_WITH_FALLBACK_MS : STARTUP_TIMEOUT_MS),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });

  const conOffline = (cause: string | undefined, warnings: string[]): StartupResult => {
    // Se recalcula: entre E2 y aquí han podido pasar hasta 3 s.
    const s = licenseState(offline!.payload, now());
    if (!concede(s)) {
      return fallo("license-expired", {
        expiresAt: offline!.payload.expires_at,
        graceDays: offline!.payload.grace_days,
        ...(cause ? { cause } : {}),
      });
    }
    return {
      ok: true,
      license: offline!,
      source: "offline",
      status: s,
      line: licenseLine(offline!.payload, "offline", s, cause),
      lineIsWarning: true,
      warnings,
    };
  };

  switch (r.kind) {
    case "key-unknown":
      return fallo("service-key-not-recognised");
    case "no-license":
      return fallo("no-license");
    case "token": {
      const t = r.license;
      const s = licenseState(t.payload, now());
      const warnings = offline && offline.payload.org_id !== t.payload.org_id ? [ORG_MISMATCH] : [];
      // El online manda: si el offline fuera más nuevo, su fila está revocada.
      if (!concede(s)) {
        return fallo("license-expired", { expiresAt: t.payload.expires_at, graceDays: t.payload.grace_days });
      }
      return {
        ok: true,
        license: t,
        source: "online",
        status: s,
        line: licenseLine(t.payload, "online", s),
        lineIsWarning: s === "grace",
        warnings,
      };
    }
    case "not-verifying":
      if (offlineConcede) return conOffline(undefined, [onlineNoVerifica(r.reason)]);
      return fallo("license-invalid", { tokenSource: "savings.bivelio.com", reason: r.reason });
    case "unreachable":
      if (offline) return conOffline(r.cause, []);
      return fallo("unreachable", { cause: r.cause });
  }
}

// ── En vivo ─────────────────────────────────────────────────────────────────

export type GatewayLicenseState = "active" | "grace" | "expired" | "revoked" | "no-license" | "blocked" | "invalid";

export type Verdict =
  | { serve: true; state: "active" | "grace" }
  | { serve: false; state: "expired" | "revoked" | "no-license" | "blocked" | "invalid"; detail: string };

type CutState = Exclude<GatewayLicenseState, "active" | "grace">;

const CORTES: ReadonlySet<GatewayLicenseState> = new Set<GatewayLicenseState>([
  "expired",
  "revoked",
  "no-license",
  "blocked",
  "invalid",
]);

/**
 * Whether a NEW request is served. The control plane's block reason wins
 * (fail-closed); then the live gate decides. Pure.
 */
export function licenseVerdict(
  gate: ResolvedGate,
  blockReason: string | null,
  payload?: LicenseTokenPayload,
): Verdict {
  const razon = typeof blockReason === "string" ? blockReason.trim() : "";
  if (razon !== "") {
    // Contrato del control plane: `reason` presente ⇔ org bloqueada. Cualquier
    // valor corta; los tres conocidos se nombran.
    const detail = "reported by savings.bivelio.com";
    if (razon === "license-revoked") return { serve: false, state: "revoked", detail };
    if (razon === "license-expired") return { serve: false, state: "expired", detail };
    if (razon === "no-license") return { serve: false, state: "no-license", detail };
    return { serve: false, state: "blocked", detail };
  }
  const s = gate.status();
  if (s === "active" || s === "grace") return { serve: true, state: s };
  if (s === "expired") {
    return {
      serve: false,
      state: "expired",
      detail: payload
        ? `grace period ended ${isoDay(finDeGracia(payload.expires_at, payload.grace_days))}`
        : "grace period ended",
    };
  }
  if (s === "revoked") return { serve: false, state: "revoked", detail: "license id revoked" };
  return { serve: false, state: "invalid", detail: "license no longer verifies" };
}

const ASUMIDO = "requests already in flight were not interrupted";

/** The `error.message` of the 402 a refused request receives. */
export function refusalMessage(state: CutState): string {
  switch (state) {
    case "expired":
      return (
        "bvsala gateway: the BiVelio license for this organization has expired. New requests are refused until " +
        `it is renewed at ${ACCOUNT_URL}; ${ASUMIDO}.`
      );
    case "revoked":
      return (
        "bvsala gateway: the BiVelio license for this organization is no longer active (revoked or cancelled). " +
        `New requests are refused; ${ASUMIDO}. Check ${ACCOUNT_URL} or write to support@bivelio.com.`
      );
    case "no-license":
      return (
        "bvsala gateway: this organization has no active BiVelio license. New requests are refused until you " +
        `subscribe at ${ACCOUNT_URL}; ${ASUMIDO}.`
      );
    case "blocked":
      return (
        "bvsala gateway: savings.bivelio.com reports the BiVelio license for this organization as not active. " +
        `New requests are refused; ${ASUMIDO}. Check ${ACCOUNT_URL}.`
      );
    case "invalid":
      return (
        "bvsala gateway: the license loaded by this gateway no longer verifies. New requests are refused; " +
        `${ASUMIDO}. Relaunch the terminal; if it persists, write to support@bivelio.com.`
      );
  }
}

/** The JSON body of the 402: both Anthropic and OpenAI clients show `error.message`. */
export function refusalBody(state: CutState): string {
  return JSON.stringify({
    type: "error",
    error: { type: "license_error", status: state, message: refusalMessage(state) },
  });
}

const REMEDIO: Record<CutState, string> = {
  expired: `Renew at ${ACCOUNT_URL}`,
  revoked: `Check ${ACCOUNT_URL} or write to support@bivelio.com`,
  "no-license": `Subscribe at ${ACCOUNT_URL}`,
  blocked: `Check ${ACCOUNT_URL}`,
  invalid: "Relaunch the terminal; if it persists, write to support@bivelio.com",
};

/**
 * The line announcing a license state change, or null. `from` is the last
 * announced state (null = none yet). Never one line per request.
 */
export function transitionLine(
  from: GatewayLicenseState | null,
  to: Verdict,
  payload: LicenseTokenPayload,
): string | null {
  if (!to.serve) {
    if (from === to.state) return null;
    return (
      `[bvsala gateway] license ${to.state} (${to.detail}): new requests are refused with HTTP 402; requests in ` +
      `flight are not touched. ${REMEDIO[to.state]}`
    );
  }
  const e = isoDay(payload.expires_at);
  const g = isoDay(finDeGracia(payload.expires_at, payload.grace_days));
  if (from !== null && CORTES.has(from)) {
    // Desde un corte a gracia no se puede decir «expires E»: ya caducó.
    if (to.state === "grace") {
      return (
        `[bvsala gateway] license in grace again (it expired on ${e} and keeps working until ${g}): serving new ` +
        `requests. Renew at ${ACCOUNT_URL}`
      );
    }
    return `[bvsala gateway] license ${to.state} again (expires ${e}): serving new requests`;
  }
  if (to.state === "grace" && from !== "grace") {
    return `[bvsala gateway] license in grace: it expired on ${e} and keeps working until ${g}. Renew at ${ACCOUNT_URL}`;
  }
  return null;
}

/** A verified license and the live gate built over it. */
export interface LiveLicense {
  license: VerifiedLicense;
  gate: ResolvedGate;
}

/** A live gate (live clock + shared revocation snapshot) over a verified license. */
export function buildLiveLicense(
  license: VerifiedLicense,
  publicKey: string | LicenseKeyset,
  revocation: RevocationSnapshot,
  now?: () => number,
): LiveLicense {
  // SIN maxStalenessSeconds a propósito: cortaría a clientes al día por una
  // caída NUESTRA de más de 72 h, y lo que protege (la salida bloqueada) ya no
  // le da nada al atacante: sin ingesta ni canal el gateway es un passthrough
  // sin palancas ni panel.
  return {
    license,
    gate: liveGateFromKey(license.token, publicKey, { revocation, ...(now ? { now } : {}) }),
  };
}

/** What `arrancarGateway` receives. Required. */
export interface GatewayLicense {
  token: string;
  publicKey: string | LicenseKeyset;
  /** Control-plane base URL: enables the revocation poller, the entitlements
   *  channel URL and (with a service key) the renewer. Without it: no license calls. */
  licenseServerUrl?: string;
  /** True when startup used the offline key: the renewer checks right away. */
  checkOnStart?: boolean;
  now?: () => number;
  renewal?: { intervalMs?: number; leadSeconds?: number; timeoutMs?: number };
  revocations?: Pick<
    RevocationPollerOptions,
    "pollIntervalSeconds" | "floorSeconds" | "maxIntervalSeconds" | "jitterRatio" | "requestTimeoutMs"
  >;
}

export interface LicenseRenewerOptions {
  licenseServerUrl: string;
  serviceAccountKey: string;
  publicKey: string | LicenseKeyset;
  revocation: RevocationSnapshot;
  current: () => VerifiedLicense;
  onAdopt: (l: VerifiedLicense) => void;
  /** Once per cause and process. */
  onWarning: (line: string) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
  intervalMs?: number;
  leadSeconds?: number;
  timeoutMs?: number;
}

/**
 * Picks up the renewed (or re-issued) license with the service key and hands
 * it to the gateway without a restart.
 */
export class LicenseRenewer {
  // Propio y no el LicenseRefresher del SDK: aquel solo adopta tokens
  // estrictamente más nuevos y de la misma org, y no tiene «forzar». Eso impide
  // curarse tras una revocación (el reemitido puede no ser más nuevo) y corregir
  // un arranque offline con un token de otra org: en el gateway la identidad la
  // da la `bvk_`, no el token.
  private timer: ReturnType<typeof setInterval> | null = null;
  private enVuelo = false;
  private parado = false;
  private ctrl: AbortController | null = null;
  private readonly avisados = new Set<string>();

  constructor(private readonly o: LicenseRenewerOptions) {}

  private ahora(): number {
    return this.o.now ? this.o.now() : Date.now();
  }

  /** Start the hourly check; with `checkNow`, check at once. Idempotent. */
  start(opts: { checkNow?: boolean } = {}): void {
    if (this.parado || this.timer !== null) return;
    this.timer = setInterval(() => void this.check(), this.o.intervalMs ?? RENEWAL_INTERVAL_MS);
    (this.timer as unknown as { unref?: () => void }).unref?.();
    if (opts.checkNow) void this.check({ force: true });
  }

  /** Stop and abort the collection in flight; never adopts afterwards. Idempotent. */
  stop(): void {
    this.parado = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.ctrl?.abort();
  }

  private avisar(causa: string, linea: string): void {
    if (this.avisados.has(causa)) return;
    this.avisados.add(causa);
    this.o.onWarning(linea);
  }

  /** One check. True if a license was adopted. Never throws. */
  async check(opts: { force?: boolean } = {}): Promise<boolean> {
    if (this.enVuelo || this.parado) return false;
    const actual = this.o.current();
    const concedia = concede(licenseState(actual.payload, this.ahora(), this.o.revocation.snapshot()));
    const faltan = actual.payload.expires_at - Math.floor(this.ahora() / 1000);
    // Lejos de la caducidad y concediendo no hay nada que buscar: el token
    // renovado ni existe hasta que se cobra el ciclo siguiente.
    // Con la licencia Medir (diez años) se mira en cada vuelta: lo que hay que
    // recoger es el PASO A PAGO, no una renovación.
    const medir = actual.payload.plan === "measure";
    if (!opts.force && !medir && concedia && faltan > (this.o.leadSeconds ?? RENEWAL_LEAD_SECONDS)) return false;

    this.enVuelo = true;
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    try {
      const r = await collectLicense({
        licenseServerUrl: this.o.licenseServerUrl,
        serviceAccountKey: this.o.serviceAccountKey,
        publicKey: this.o.publicKey,
        timeoutMs: this.o.timeoutMs ?? RENEWAL_TIMEOUT_MS,
        signal: ctrl.signal,
        ...(this.o.fetchImpl ? { fetchImpl: this.o.fetchImpl } : {}),
      });
      // Parado mientras la recogida estaba en vuelo: no se toca un gateway cerrado.
      if (this.parado) return false;
      const g = isoDay(finDeGracia(actual.payload.expires_at, actual.payload.grace_days));
      switch (r.kind) {
        case "token": {
          const c = r.license.payload;
          const snapshot = this.o.revocation.snapshot();
          if (c.jti === actual.payload.jti) return false;
          if (this.o.revocation.has(c.jti)) return false;
          if (!concede(licenseState(c, this.ahora(), snapshot))) return false;
          const concedeAhora = concede(licenseState(actual.payload, this.ahora(), snapshot));
          // Manda la org de la `bvk_`; si no, solo un token más nuevo, o
          // cualquiera válido cuando el actual ya no concede (revocado o caducado).
          const otraOrg = c.org_id !== actual.payload.org_id;
          // Una de pago que sustituye a una Medir manda aunque caduque antes.
          const masNuevo = c.expires_at > actual.payload.expires_at || (medir && c.plan !== "measure");
          if (!otraOrg && !masNuevo && concedeAhora) return false;
          this.o.onAdopt(r.license);
          return true;
        }
        case "key-unknown":
          this.avisar(
            "key-unknown",
            "[bvsala gateway] license renewal: BIVELIO_SERVICE_KEY is no longer recognised (HTTP 401). This " +
              `session keeps its current license until ${g}; create a new key at ${INSTALL_URL} and relaunch.`,
          );
          return false;
        case "no-license":
          this.avisar(
            "no-license",
            "[bvsala gateway] license renewal: savings.bivelio.com reports no active license for this " +
              `organization (HTTP 404). This session keeps its current license until ${g}; subscribe or renew at ` +
              `${ACCOUNT_URL}.`,
          );
          return false;
        case "not-verifying":
          this.avisar(
            `not-verifying:${r.reason}`,
            "[bvsala gateway] license renewal: the license served by savings.bivelio.com does not verify against " +
              `this build's BiVelio key (${r.reason}); update @bivelio/savings-layer.`,
          );
          return false;
        case "unreachable":
          // Best-effort: la licencia vigente sigue mandando; se reintenta.
          return false;
      }
      return false;
    } catch {
      return false;
    } finally {
      if (this.ctrl === ctrl) this.ctrl = null;
      this.enVuelo = false;
    }
  }
}
