import { describe, it, expect } from "vitest";
import {
  LicenseClient,
  signLicense,
  verifyLicenseToken,
  generateLicenseKeypair,
  createLicenseGate,
} from "../src/index.js";
import type { LicensePayload } from "@bivelio/protocol";

const { publicKey, privateKey } = generateLicenseKeypair();
const other = generateLicenseKeypair();

const DAY = 86400;
const BASE = 1_800_000_000; // fixed epoch seconds for deterministic tests

function payload(overrides: Partial<LicensePayload> = {}): LicensePayload {
  return {
    jti: "lic_1",
    org_id: "org_123",
    plan: "pro",
    seats: 25,
    features: ["semantic_cache", "dashboards"],
    issued_at: BASE,
    expires_at: BASE + 30 * DAY,
    grace_days: 14,
    ...overrides,
  };
}

describe("license token", () => {
  it("signs and verifies a valid token", () => {
    const token = signLicense(payload(), privateKey);
    const v = verifyLicenseToken(token, publicKey);
    expect(v.signatureValid).toBe(true);
    expect(v.payload?.org_id).toBe("org_123");
  });

  it("rejects a token signed by a different key", () => {
    const token = signLicense(payload(), other.privateKey);
    expect(verifyLicenseToken(token, publicKey).signatureValid).toBe(false);
  });

  it("rejects a tampered payload", () => {
    const token = signLicense(payload(), privateKey);
    const [h, , s] = token.split(".");
    const forged = Buffer.from(JSON.stringify(payload({ seats: 9999 }))).toString("base64url");
    expect(verifyLicenseToken(`${h}.${forged}.${s}`, publicKey).signatureValid).toBe(false);
  });

  it("rejects malformed tokens", () => {
    expect(verifyLicenseToken("not-a-token", publicKey).signatureValid).toBe(false);
  });
});

describe("LicenseClient status + grace", () => {
  const client = (nowSeconds: number, revoked?: string[]) =>
    new LicenseClient({ publicKey, nowSeconds: () => nowSeconds, ...(revoked ? { revoked } : {}) });

  it("is active before expiry and grants features", () => {
    const c = client(BASE + 10 * DAY);
    const r = c.load(signLicense(payload(), privateKey));
    expect(r.status).toBe("active");
    expect(c.isEntitled("semantic_cache")).toBe(true);
    expect(c.isEntitled("cross_tenant_optimization")).toBe(false);
  });

  it("enters grace after expiry but still grants features", () => {
    const c = client(BASE + 35 * DAY); // 5 days past 30-day expiry, grace 14
    const r = c.load(signLicense(payload(), privateKey));
    expect(r.status).toBe("grace");
    expect(c.isEntitled("semantic_cache")).toBe(true);
  });

  it("expires past the grace window and drops to free tier", () => {
    const c = client(BASE + 50 * DAY); // past expiry + 14d grace
    const r = c.load(signLicense(payload(), privateKey));
    expect(r.status).toBe("expired");
    expect(r.entitlements.plan).toBe("free");
    expect(c.isEntitled("semantic_cache")).toBe(false);
  });

  it("honors revocation", () => {
    const c = client(BASE + 10 * DAY, ["lic_1"]);
    const r = c.load(signLicense(payload(), privateKey));
    expect(r.status).toBe("revoked");
    expect(c.isEntitled("semantic_cache")).toBe(false);
  });

  it("treats an unloaded client as free tier", () => {
    const c = client(BASE);
    expect(c.status()).toBe("expired");
    expect(c.entitlements().plan).toBe("free");
  });
});

describe("createLicenseGate", () => {
  it("produces an SDK-compatible gate", () => {
    const c = new LicenseClient({ publicKey, nowSeconds: () => BASE + DAY });
    c.load(signLicense(payload({ features: ["semantic_cache"] }), privateKey));
    const gate = createLicenseGate(c);
    expect(gate.isEntitled("semantic_cache")).toBe(true);
    expect(gate.isEntitled("dashboards")).toBe(false);
  });
});
