import { generateKeyPairSync, sign } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { verifyLicenseToken, type LicenseKeyset } from "../src/license/verify.js";
import {
  createSavingsLayer,
  createMockProvider,
  LicenseError,
  RevocationSnapshot,
  RevocationPoller,
  computeNextDelay,
  liveGateFromKey,
  verifyRevocationList,
  type SavingsRequest,
} from "../src/index.js";

/**
 * Revocation call-home + live enforcement. BV-SALA is fail-closed; the suite runs
 * dev-open (vitest.config.ts), so this file turns that OFF to assert real denial,
 * then restores it. Tokens + signed revocation lists are minted in-process with an
 * ed25519 keypair, mirroring test/license-gate.test.ts.
 */
let savedDevOpen: string | undefined;
beforeAll(() => {
  savedDevOpen = process.env.BVSALA_DEV_OPEN;
  delete process.env.BVSALA_DEV_OPEN;
});
afterAll(() => {
  if (savedDevOpen !== undefined) process.env.BVSALA_DEV_OPEN = savedDevOpen;
});

const BASE = 1_800_000_000; // unix seconds
const DAY = 86400;
const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
function signCompact(header: object, payload: object, privateKeyPem: string): string {
  const head = b64url(JSON.stringify(header));
  const body = b64url(JSON.stringify(payload));
  const sig = sign(null, Buffer.from(`${head}.${body}`), privateKeyPem);
  return `${head}.${body}.${b64url(sig)}`;
}

const kp = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const wrongKp = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const publicKey = kp.publicKey;
const privateKey = kp.privateKey;

const LICENSE_HEADER = { alg: "EdDSA", typ: "BVL", v: 1 };
const REVOC_HEADER = { alg: "EdDSA", typ: "BVSALA-REVOC", v: 1 };

const licenseToken = (over: Record<string, unknown> = {}): string =>
  signCompact(
    LICENSE_HEADER,
    { jti: "lic_r", org_id: "o", plan: "pro", seats: 3, features: ["semantic_cache"], issued_at: BASE, expires_at: BASE + 30 * DAY, grace_days: 14, ...over },
    privateKey,
  );
const revocList = (over: Record<string, unknown> = {}, key = privateKey): string =>
  signCompact(REVOC_HEADER, { v: 1, asOf: BASE, seq: 0, revoked: [], ...over }, key);

const req: SavingsRequest = {
  model: "m",
  messages: [{ role: "user", content: "a neutral public factual question about geography" }],
  context: { tenantId: "o" },
};
const nowMs = () => BASE * 1000; // the SDK's clock is in ms

describe("verifyRevocationList", () => {
  it("accepts a correctly-signed list", () => {
    const v = verifyRevocationList(revocList({ seq: 2, revoked: ["a", "b"] }), publicKey, { nowSeconds: BASE });
    expect(v.ok).toBe(true);
    expect(v.seq).toBe(2);
    expect([...v.revoked].sort()).toEqual(["a", "b"]);
  });
  it("rejects a flipped signature", () => {
    const t = revocList({ seq: 1 });
    expect(verifyRevocationList(`${t.slice(0, -6)}AAAAAA`, publicKey, { nowSeconds: BASE }).ok).toBe(false);
  });
  it("rejects the wrong public key", () => {
    expect(verifyRevocationList(revocList({ seq: 1 }), wrongKp.publicKey, { nowSeconds: BASE }).ok).toBe(false);
  });
  it("rejects a tampered body", () => {
    const [h, , s] = revocList({ seq: 1, revoked: ["a"] }).split(".");
    const forged = b64url(JSON.stringify({ v: 1, asOf: BASE, seq: 1, revoked: ["a", "evil"] }));
    expect(verifyRevocationList(`${h}.${forged}.${s}`, publicKey, { nowSeconds: BASE }).ok).toBe(false);
  });
  it("rejects a license token replayed as a revocation list (typ domain separation)", () => {
    const v = verifyRevocationList(licenseToken(), publicKey, { nowSeconds: BASE });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/type/i);
  });
  it("rejects a rolled-back list (seq < minSeq)", () => {
    expect(verifyRevocationList(revocList({ seq: 3 }), publicKey, { minSeq: 5, nowSeconds: BASE }).ok).toBe(false);
  });
  it("rejects a future-dated list (asOf skew)", () => {
    expect(verifyRevocationList(revocList({ seq: 1, asOf: BASE + 3600 }), publicKey, { nowSeconds: BASE, maxSkewSeconds: 300 }).ok).toBe(false);
  });
});

describe("RevocationSnapshot (sticky + monotonic)", () => {
  it("rejects a lower seq and keeps prior state", () => {
    const s = new RevocationSnapshot();
    expect(s.apply({ seq: 2, asOf: BASE, revoked: new Set(["a"]) })).toBe(true);
    expect(s.apply({ seq: 1, asOf: BASE, revoked: new Set(["b"]) })).toBe(false);
    expect(s.has("a")).toBe(true);
    expect(s.has("b")).toBe(false);
    expect(s.seq).toBe(2);
  });
  it("is sticky: a later list omitting a jti does not un-revoke it", () => {
    const s = new RevocationSnapshot();
    s.apply({ seq: 1, asOf: BASE, revoked: new Set(["a"]) });
    s.apply({ seq: 2, asOf: BASE + 1, revoked: new Set<string>() });
    expect(s.has("a")).toBe(true);
    expect(s.seq).toBe(2);
  });
});

describe("revocation reaches enforcement (live gate → LicenseError)", () => {
  it("flips generate() from ALLOWED to DENIED when the jti is revoked", async () => {
    const snapshot = new RevocationSnapshot();
    const gate = liveGateFromKey(licenseToken({ jti: "lic_r" }), publicKey, { revocation: snapshot, now: nowMs });
    const layer = createSavingsLayer({ provider: createMockProvider({ answer: "ok" }), licenseGate: gate });

    const first = await layer.generate(req);
    expect(first.report).toBeTruthy();
    expect(gate.status()).toBe("active");

    // Simulate a successful poll delivering the revocation.
    snapshot.apply({ seq: 1, asOf: BASE, revoked: new Set(["lic_r"]) });
    expect(gate.status()).toBe("revoked");
    await expect(layer.generate(req)).rejects.toBeInstanceOf(LicenseError);
    layer.close();
  });
});

describe("online staleness gate (closes the block-egress fail-open)", () => {
  it("stops granting after maxStalenessSeconds with no confirmed heartbeat, and recovers on one", () => {
    let ms = BASE * 1000;
    const snapshot = new RevocationSnapshot();
    const gate = liveGateFromKey(licenseToken({ jti: "lic_stale" }), publicKey, {
      revocation: snapshot,
      now: () => ms,
      maxStalenessSeconds: 3600, // 1h ceiling
      startedAt: BASE, // boot anchor
    });
    expect(gate.isActive()).toBe(true); // fresh at boot
    // 2h pass with egress blocked (no 304 / verified list) → fail CLOSED, not fail-open.
    ms = (BASE + 2 * 3600) * 1000;
    // "stale", not "expired": the license is paid and unexpired — the ONLY problem
    // is that egress is blocked. Naming it "expired" made the customer-facing
    // message tell a paying customer to renew a subscription they already had.
    expect(gate.status()).toBe("stale");
    expect(gate.isActive()).toBe(false);
    // A confirmed authorized heartbeat (poll 304 / verified list) restores it.
    snapshot.markContact(BASE + 2 * 3600);
    expect(gate.isActive()).toBe(true);
  });

  it("the offline gate (no maxStalenessSeconds) never fails closed on staleness", () => {
    let ms = BASE * 1000;
    const snapshot = new RevocationSnapshot();
    const gate = liveGateFromKey(
      licenseToken({ jti: "lic_off", expires_at: BASE + 365 * DAY }),
      publicKey,
      { revocation: snapshot, now: () => ms }, // offline path: no staleness ceiling
    );
    ms = (BASE + 10 * 3600) * 1000; // 10h, zero heartbeats
    expect(gate.isActive()).toBe(true);
  });
});

describe("signing-key rotation via kid (backward-compatible)", () => {
  const kidToken = (kid: string | undefined, over: Record<string, unknown> = {}): string =>
    signCompact(
      { alg: "EdDSA", typ: "BVL", v: 1, ...(kid ? { kid } : {}) },
      { jti: "lic_kid", org_id: "o", plan: "pro", seats: 1, features: [], issued_at: BASE, expires_at: BASE + DAY, grace_days: 0, ...over },
      privateKey,
    );
  // defaultKid pins the real key; a second kid pins a DIFFERENT (wrong) key.
  const keyset: LicenseKeyset = { keys: { "2026-07": publicKey, "2027-01": wrongKp.publicKey }, defaultKid: "2026-07" };

  it("a legacy NO-kid token verifies with a plain string key (unchanged path)", () => {
    expect(verifyLicenseToken(kidToken(undefined), publicKey).signatureValid).toBe(true);
  });
  it("a legacy NO-kid token verifies with a keyset via defaultKid", () => {
    expect(verifyLicenseToken(kidToken(undefined), keyset).signatureValid).toBe(true);
  });
  it("a kid-stamped token verifies with a keyset pinning that kid", () => {
    expect(verifyLicenseToken(kidToken("2026-07"), keyset).signatureValid).toBe(true);
  });
  it("a kid-stamped token STILL verifies with a plain string key (deployed-SDK compat)", () => {
    // The crux: an already-shipped single-string-key SDK ignores kid and verifies normally.
    expect(verifyLicenseToken(kidToken("2026-07"), publicKey).signatureValid).toBe(true);
  });
  it("fails CLOSED on an unknown kid (never silently falls back to defaultKid)", () => {
    expect(verifyLicenseToken(kidToken("no-such-kid"), keyset).signatureValid).toBe(false);
  });
  it("rejects when the kid pins the wrong key (signature mismatch)", () => {
    // Signed by privateKey, but kid 2027-01 pins wrongKp.publicKey → bad signature.
    expect(verifyLicenseToken(kidToken("2027-01"), keyset).signatureValid).toBe(false);
  });
});

describe("offline live-clock gate (decision 2)", () => {
  it("an expired license stops working mid-process with NO network", async () => {
    let ms = BASE * 1000;
    const layer = createSavingsLayer({
      provider: createMockProvider({ answer: "ok" }),
      licenseKey: licenseToken({ jti: "lic_e", expires_at: BASE + 10, grace_days: 0 }),
      licensePublicKey: publicKey,
      now: () => ms,
    });
    expect((await layer.generate(req)).report).toBeTruthy(); // active
    ms = (BASE + 100) * 1000; // past expiry + grace(0)
    await expect(layer.generate(req)).rejects.toBeInstanceOf(LicenseError);
    layer.close();
  });
});

describe("never-brick under a down control plane", () => {
  it("a failing poll never bubbles and a valid non-revoked license keeps serving", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("network down");
    });
    const layer = createSavingsLayer({
      provider: createMockProvider({ answer: "ok" }),
      licenseKey: licenseToken({ jti: "lic_ok" }),
      licensePublicKey: publicKey,
      licenseServerUrl: "https://cp.example",
      licenseFetch: fetchSpy as unknown as typeof fetch,
      now: nowMs,
    });
    expect(fetchSpy).toHaveBeenCalled(); // warm poll fired (and failed internally)
    expect((await layer.generate(req)).report).toBeTruthy();
    layer.close();
  });

  it("a warm poll that never resolves does not block generate(), and close() aborts it", async () => {
    let captured: AbortSignal | undefined;
    const fetchSpy = vi.fn((_url: unknown, init: { signal?: AbortSignal } = {}) => {
      captured = init.signal;
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    const layer = createSavingsLayer({
      provider: createMockProvider({ answer: "ok" }),
      licenseKey: licenseToken({ jti: "lic_h" }),
      licensePublicKey: publicKey,
      licenseServerUrl: "https://cp.example",
      licenseFetch: fetchSpy as unknown as typeof fetch,
      now: nowMs,
    });
    const res = await layer.generate(req);
    expect(res.report).toBeTruthy();
    layer.close();
    expect(captured?.aborted).toBe(true); // close() aborts the in-flight request
  });
});

describe("poller endpoint URL", () => {
  it("appends /licenses/revocations to the configured base URL (trailing slash normalized)", async () => {
    let calledUrl: string | undefined;
    const fetchSpy = vi.fn(async (url: unknown) => {
      calledUrl = String(url);
      return new Response(JSON.stringify({ list: revocList({ seq: 0 }) }), { status: 200 });
    });
    const layer = createSavingsLayer({
      provider: createMockProvider({ answer: "ok" }),
      licenseKey: licenseToken({ jti: "lic_u" }),
      licensePublicKey: publicKey,
      licenseServerUrl: "https://cp.example/", // base URL, trailing slash on purpose
      licenseFetch: fetchSpy as unknown as typeof fetch,
      now: nowMs,
    });
    expect(fetchSpy).toHaveBeenCalled();
    expect(calledUrl).toBe("https://cp.example/licenses/revocations");
    layer.close();
  });
});

describe("offline path is unchanged (no licenseServerUrl → no network)", () => {
  it("never constructs a fetch even when licenseFetch is provided", async () => {
    const fetchSpy = vi.fn();
    const layer = createSavingsLayer({
      provider: createMockProvider({ answer: "ok" }),
      licenseKey: licenseToken({ jti: "lic_f" }),
      licensePublicKey: publicKey,
      licenseFetch: fetchSpy as unknown as typeof fetch,
      now: nowMs,
    });
    await layer.generate(req);
    expect(fetchSpy).not.toHaveBeenCalled();
    layer.close(); // no-op, must not throw
  });
});

describe("close() stops the poller", () => {
  it("no polls fire after close()", async () => {
    vi.useFakeTimers();
    try {
      const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ list: revocList({ seq: 0 }) }), { status: 200 }));
      const layer = createSavingsLayer({
        provider: createMockProvider({ answer: "ok" }),
        licenseKey: licenseToken({ jti: "lic_c" }),
        licensePublicKey: publicKey,
        licenseServerUrl: "https://cp.example",
        licenseFetch: fetchSpy as unknown as typeof fetch,
        now: () => BASE * 1000,
        licensePollIntervalSeconds: 900,
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1); // warm poll
      layer.close();
      await vi.advanceTimersByTimeAsync(5_000_000);
      expect(fetchSpy).toHaveBeenCalledTimes(1); // none after close
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("RevocationPoller conditional requests (ETag / 304)", () => {
  it("captures the 200 ETag, sends If-None-Match next, and a 304 keeps the sticky snapshot", async () => {
    const snapshot = new RevocationSnapshot();
    const seen: Array<string | undefined> = [];
    let call = 0;
    const fetchSpy = vi.fn(async (_url: unknown, init: { headers?: Record<string, string> } = {}) => {
      seen.push(init.headers?.["if-none-match"]);
      call++;
      if (call === 1) {
        return new Response(JSON.stringify({ list: revocList({ seq: 1, revoked: ["x"] }) }), {
          status: 200,
          headers: { etag: 'W/"revoc-1"' },
        });
      }
      return new Response(null, { status: 304 });
    });
    const poller = new RevocationPoller({
      url: "https://cp.example/licenses/revocations",
      publicKeyPem: publicKey,
      snapshot,
      fetchImpl: fetchSpy as unknown as typeof fetch,
      nowSeconds: () => BASE,
    });
    await poller.pollOnce();
    expect(snapshot.has("x")).toBe(true);
    expect(snapshot.seq).toBe(1);
    await poller.pollOnce();
    expect(seen[0]).toBeUndefined(); // first poll: no conditional header
    expect(seen[1]).toBe('W/"revoc-1"'); // second poll echoes the captured ETag
    expect(snapshot.has("x")).toBe(true); // 304 → snapshot untouched (sticky)
    poller.stop();
  });
});

describe("clock wiring (ms → seconds through the poller)", () => {
  it("rejects a future-dated (skewed) list delivered via createSavingsLayer — the ms→s conversion is correct", async () => {
    // The list is 1h in the future; default maxSkew is 300s. If create.ts passed
    // config.now (ms) to the poller without /1000, now≫asOf and the skew check would
    // wrongly ACCEPT it, applying the jti and revoking the license.
    const jti = "lic_skew";
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ list: revocList({ seq: 1, asOf: BASE + 3600, revoked: [jti] }) }), { status: 200 }),
    );
    const layer = createSavingsLayer({
      provider: createMockProvider({ answer: "ok" }),
      licenseKey: licenseToken({ jti }),
      licensePublicKey: publicKey,
      licenseServerUrl: "https://cp.example",
      licenseFetch: fetchSpy as unknown as typeof fetch,
      now: nowMs,
    });
    await new Promise((r) => setTimeout(r, 20)); // let the warm poll fully settle
    expect(fetchSpy).toHaveBeenCalled();
    // Skew-rejected → jti never applied → license stays active → generate() succeeds.
    expect((await layer.generate(req)).report).toBeTruthy();
    layer.close();
  });
});

describe("computeNextDelay", () => {
  const common = { nowSeconds: BASE, floorSeconds: 300, pollIntervalSeconds: 900, maxIntervalSeconds: 3600, jitterRatio: 0.1 };
  it("steady state caps at the poll interval when the refresh horizon is far", () => {
    expect(computeNextDelay({ ...common, refreshAfter: BASE + 100000, consecutiveFailures: 0, random: () => 0.5 })).toBe(900);
  });
  it("tightens as the refresh horizon approaches", () => {
    expect(computeNextDelay({ ...common, refreshAfter: BASE + 400, consecutiveFailures: 0, random: () => 0.5 })).toBe(400);
  });
  it("never returns below the floor", () => {
    expect(computeNextDelay({ ...common, refreshAfter: BASE, consecutiveFailures: 0, random: () => 0 })).toBe(300);
  });
  it("backs off exponentially on failures, capped at maxInterval", () => {
    const j = () => 0.5; // jitter factor 1
    expect(computeNextDelay({ ...common, consecutiveFailures: 1, random: j })).toBe(600);
    expect(computeNextDelay({ ...common, consecutiveFailures: 2, random: j })).toBe(1200);
    expect(computeNextDelay({ ...common, consecutiveFailures: 3, random: j })).toBe(2400);
    expect(computeNextDelay({ ...common, consecutiveFailures: 10, random: j })).toBe(3600);
  });
  it("applies bounded jitter (±ratio)", () => {
    expect(computeNextDelay({ ...common, refreshAfter: BASE + 100000, consecutiveFailures: 0, random: () => 1 })).toBeCloseTo(990, 5);
  });
  it("falls back to the steady interval once the refresh horizon is in the past (expired license)", () => {
    // refreshAfter < now (license expired mid-process) must NOT pin polling to the floor forever.
    expect(computeNextDelay({ ...common, refreshAfter: BASE - 10000, consecutiveFailures: 0, random: () => 0.5 })).toBe(900);
  });
});

describe("browser-safety invariant", () => {
  it("no file under src/ imports node: or @bivelio/license-client", () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(join(process.cwd(), "src"));
    const BUILTINS = [
      "assert", "buffer", "child_process", "cluster", "crypto", "dgram", "dns", "events", "fs",
      "http", "http2", "https", "net", "os", "path", "perf_hooks", "process", "punycode",
      "querystring", "readline", "stream", "string_decoder", "tls", "tty", "url", "util", "v8",
      "vm", "worker_threads", "zlib",
    ].join("|");
    // Catches static (`from "x"`), side-effect (`import "x"`), dynamic (`import("x")`) and
    // require() forms of any node: or unprefixed builtin, plus the control-plane package.
    const importOffender = new RegExp(
      `(?:from\\s+|import\\s*\\(?\\s*|require\\s*\\(\\s*)["'](?:node:(?:${BUILTINS})|(?:${BUILTINS})|@bivelio/license-client)(?:/[^"']*)?["']`,
    );
    // Node-only globals that resolve in Node (tests) but are absent in the browser bundle.
    const globalOffender = /\b(?:Buffer|setImmediate|__dirname|__filename)\b|\brequire\s*\(/;
    const offenders = files.filter((f) => {
      const src = readFileSync(f, "utf8");
      if (importOffender.test(src) || globalOffender.test(src)) return true;
      // Bare `process.` use is only allowed inside the `typeof process` guard idiom.
      return src.split("\n").some((ln) => /\bprocess\./.test(ln) && !/typeof\s+process/.test(ln));
    });
    expect(offenders).toEqual([]);
  });
});

/**
 * C8 · Los dos fail-opens de la puerta de obsolescencia.
 *
 * La puerta existe para cerrar la ventana en la que alguien bloquea el egress y
 * mantiene viva una licencia revocada hasta su expiración natural. Estas dos
 * cosas la dejaban inerte.
 */
describe("puerta de obsolescencia: el ancla de arranque no es un cheque en blanco", () => {
  const VENTANA = 3600; // 1 h de obsolescencia máxima

  it("una licencia RECIENTE conserva su ventana completa tras arrancar", () => {
    // El caso legítimo: proceso recién arrancado, licencia recién emitida, aún
    // sin contactar. Debe poder trabajar mientras el sondeo caliente va en curso.
    const gate = liveGateFromKey(licenseToken({ issued_at: BASE }), publicKey, {
      revocation: new RevocationSnapshot(),
      now: () => BASE * 1000,
      maxStalenessSeconds: VENTANA,
      startedAt: BASE,
    });
    expect(gate.status()).toBe("active");
  });

  it("una licencia VÁLIDA en serverless frío NO se apaga sola (B1)", () => {
    // CAMBIO DE COMPORTAMIENTO DELIBERADO, no un test que se rompió. La versión
    // anterior acotaba el ancla por `issued_at`, así que esta licencia —emitida
    // hace 10 días pero VÁLIDA hasta dentro de 30— salía `expired` en serverless.
    // Es indistinguible de un cliente que paga arrancando en frío, y lo bloqueaba.
    // El requisito manda: si pagó mensual/anual, funciona hasta su caducidad real.
    //
    // Lo que se pierde: en serverless puro no se puede exigir frescura de
    // revocación desde el cliente (cada invocación arranca "fresca", sin estado
    // que la delate). Esa defensa se mueve al CONTROL PLANE: el ingest/metering
    // rechaza una org revocada. Ver license-lifecycle.test.ts para el ciclo
    // completo mensual/anual.
    const emitida = BASE - 10 * DAY;
    const gate = liveGateFromKey(
      licenseToken({ issued_at: emitida, expires_at: BASE + 30 * DAY }),
      publicKey,
      {
        revocation: new RevocationSnapshot(),
        now: () => BASE * 1000,
        maxStalenessSeconds: VENTANA,
        startedAt: BASE, // serverless: "acabo de arrancar", cada invocación
      },
    );
    expect(gate.status()).toBe("active");
  });

  it("pero la verja SÍ muerde en un proceso de vida larga con egress bloqueado", () => {
    // Donde la defensa de frescura sí es aplicable (desktop, gateway, servidor):
    // un proceso que arrancó hace más de la ventana y nunca pudo contactar se
    // cierra. Esto es lo que impide mantener viva una licencia revocada
    // bloqueando la salida de red. Aquí startedAt es el arranque REAL, en el
    // pasado, no "ahora" de cada request.
    const gate = liveGateFromKey(
      licenseToken({ issued_at: BASE - 10 * DAY, expires_at: BASE + 30 * DAY }),
      publicKey,
      {
        revocation: new RevocationSnapshot(),
        now: () => BASE * 1000,
        maxStalenessSeconds: VENTANA,
        startedAt: BASE - 2 * VENTANA, // arrancó hace 2 h, ventana de 1 h
      },
    );
    // Cierra igual que antes; lo que cambia es CÓMO se llama, porque de ese
    // nombre sale el mensaje que se lleva el cliente.
    expect(gate.isActive()).toBe(false);
    expect(gate.status()).toBe("stale");
  });

  it("un contacto autorizado reciente la mantiene viva, que es su función", () => {
    const snapshot = new RevocationSnapshot();
    snapshot.markContact(BASE - 60); // hace un minuto
    const gate = liveGateFromKey(
      licenseToken({ issued_at: BASE - 10 * DAY, expires_at: BASE + 30 * DAY }),
      publicKey,
      { revocation: snapshot, now: () => BASE * 1000, maxStalenessSeconds: VENTANA, startedAt: BASE },
    );
    expect(gate.status()).toBe("active");
  });
});
