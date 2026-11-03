import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createSavingsLayer,
  createMockProvider,
  InMemorySemanticCache,
  LicenseError,
  type LicenseGate,
  type SavingsRequest,
} from "../src/index.js";

/**
 * The OPEN-CORE contract: with no `licenseKey` (and no injected gate) the layer
 * runs on the COMMUNITY gate — every local lever on, zero telemetry. The
 * fail-closed enforcement that remains protects the PAID surfaces: an invalid,
 * expired or inactive key still throws. The suite as a whole runs dev-open (see
 * vitest.config.ts); this file turns that OFF so it can assert the real paths.
 */
let savedDevOpen: string | undefined;
beforeAll(() => {
  savedDevOpen = process.env.BVSALA_DEV_OPEN;
  delete process.env.BVSALA_DEV_OPEN;
});
afterAll(() => {
  if (savedDevOpen !== undefined) process.env.BVSALA_DEV_OPEN = savedDevOpen;
});

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
function signToken(payload: Record<string, unknown>, privateKeyPem: string): string {
  const head = b64url(JSON.stringify({ alg: "EdDSA", typ: "BVL", v: 1 }));
  const body = b64url(JSON.stringify(payload));
  const sig = sign(null, Buffer.from(`${head}.${body}`), privateKeyPem);
  return `${head}.${body}.${b64url(sig)}`;
}
const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const now = Math.floor(Date.now() / 1000);
const tokenFor = (over: Record<string, unknown> = {}) =>
  signToken(
    { jti: "lic_t", org_id: "t1", plan: "pro", seats: 3, features: ["semantic_cache"], issued_at: now, expires_at: now + 3600, grace_days: 7, ...over },
    privateKey,
  );

const embed = (t: string) =>
  Array.from({ length: 4 }, (_, i) => [...t].filter((c) => c.charCodeAt(0) % 4 === i).length);

function layer(opts: {
  gate?: LicenseGate;
  licenseKey?: string;
  devUnlicensed?: boolean;
}) {
  const semanticCache = new InMemorySemanticCache({ embed, similarityThreshold: 0.3, acceptThreshold: 0.3 });
  return createSavingsLayer({
    provider: createMockProvider({ answer: "answer" }),
    semanticCacheStore: semanticCache,
    licensePublicKey: publicKey,
    ...(opts.gate ? { licenseGate: opts.gate } : {}),
    ...(opts.licenseKey ? { licenseKey: opts.licenseKey } : {}),
    ...(opts.devUnlicensed ? { devUnlicensed: true } : {}),
    generateId: (() => { let n = 0; return () => `r${n++}`; })(),
  });
}

const req: SavingsRequest = {
  model: "m",
  messages: [{ role: "user", content: "a neutral public factual question about geography" }],
  savings: { semanticCache: "safe-only" },
  context: { tenantId: "t1", knowledgeEpoch: "e1" },
};

describe("fail-closed license enforcement", () => {
  it("RUNS with no license configured — the Community gate (open core)", async () => {
    const res = await layer({}).generate(req);
    expect(res.report.requestId).toBeTruthy();
    // Community grants every local feature: the semantic cache must not degrade.
    const traces = res.report.traces.map((t) => `${t.stage}:${t.outcome}`);
    expect(traces.some((t) => t.startsWith("semantic-cache:degraded"))).toBe(false);
  });

  it("DENIES an expired license", async () => {
    const expired = tokenFor({ jti: "lic_exp", expires_at: now - 86400, grace_days: 0 });
    await expect(layer({ licenseKey: expired }).generate(req)).rejects.toBeInstanceOf(LicenseError);
  });

  it("DENIES a tampered token (bad signature)", async () => {
    const bad = `${tokenFor().slice(0, -6)}AAAAAA`;
    await expect(layer({ licenseKey: bad }).generate(req)).rejects.toBeInstanceOf(LicenseError);
  });

  it("ALLOWS a valid license key and unlocks its features", async () => {
    const first = await layer({ licenseKey: tokenFor() }).generate(req);
    const traces = first.report.traces.map((t) => `${t.stage}:${t.outcome}`);
    // semantic_cache is in the token's grant → the degrade trace must NOT appear
    expect(traces.some((t) => t.startsWith("semantic-cache:degraded"))).toBe(false);
    expect(traces.some((t) => t.startsWith("semantic-cache"))).toBe(true);
  });

  it("runs ungated with devUnlicensed", async () => {
    const res = await layer({ devUnlicensed: true }).generate(req);
    expect(res.report).toBeTruthy();
  });
});

describe("per-feature gating under an active license", () => {
  it("degrades semantic cache when the active gate denies that feature", async () => {
    const gate: LicenseGate = { isEntitled: () => false, isActive: () => true, status: () => "active" };
    const first = await layer({ gate }).generate(req);
    const traces = first.report.traces.map((t) => `${t.stage}:${t.outcome}`);
    expect(traces.some((t) => t.startsWith("semantic-cache:degraded"))).toBe(true);
  });

  it("allows semantic cache when the active gate grants it", async () => {
    const gate: LicenseGate = { isEntitled: (f) => f === "semantic_cache", isActive: () => true, status: () => "active" };
    const first = await layer({ gate }).generate(req);
    const traces = first.report.traces.map((t) => `${t.stage}:${t.outcome}`);
    expect(traces.some((t) => t.startsWith("semantic-cache:degraded"))).toBe(false);
    expect(traces.some((t) => t.startsWith("semantic-cache"))).toBe(true);
  });
});

/**
 * El bypass del paywall que tenía el paquete publicado en npm.
 *
 * `assertLicensed` sólo exigía licencia si el gate inyectado TENÍA `isActive`.
 * Si faltaba —y la interfaz lo declaraba OPCIONAL, así que TypeScript lo
 * bendecía— avisaba una vez por consola y hacía `return`: cualquier objeto con
 * un `isEntitled` bastaba para ejecutar el producto entero gratis.
 */
describe("paywall: un gate sin isActive() no abre el producto", () => {
  it("rechaza un gate estructural al que le falta isActive()", async () => {
    // Exactamente la forma que se colaba: sin isActive, y con isEntitled
    // devolviendo true para que ninguna otra puerta lo pare antes.
    const gateSinIsActive = { isEntitled: () => true } as unknown as LicenseGate;
    await expect(layer({ gate: gateSinIsActive }).generate(req)).rejects.toThrow(/isActive/i);
  });

  it("sigue rechazando cuando el gate sí lo implementa pero devuelve false", async () => {
    const gateInactivo: LicenseGate = {
      isEntitled: () => true,
      isActive: () => false,
      status: () => "expired",
    };
    await expect(layer({ gate: gateInactivo }).generate(req)).rejects.toThrow(/not active/i);
  });

  it("y deja pasar al que lo implementa y está activo (control positivo)", async () => {
    const gateActivo: LicenseGate = {
      isEntitled: () => true,
      isActive: () => true,
      status: () => "active",
    };
    const res = await layer({ gate: gateActivo }).generate(req);
    expect(res.report.requestId).toBeTruthy();
  });
});
