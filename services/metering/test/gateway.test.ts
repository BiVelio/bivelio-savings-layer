import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  createMeteringService,
  resolveCaller,
  ingest,
  summary,
  loadAuthConfig,
  type MeteringAuthConfig,
} from "../src/index.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function cfg(over: Partial<MeteringAuthConfig> = {}): MeteringAuthConfig {
  return { serviceAccounts: new Map([[sha256("tok-acme"), "acme"]]), adminToken: "admin-secret", devOpen: false, ...over };
}

function record(over: Record<string, unknown> = {}) {
  return {
    requestId: "r1", model: "m", at: 1, avoidedLlm: 0, actualLlm: 1,
    baselineInputTokens: 100, actualInputTokens: 60, eliminatedInputTokens: 0, compressedInputTokens: 40,
    baselineOutputTokens: 80, actualOutputTokens: 20, providerCachedInputTokens: 0,
    cacheResult: "miss", baselineCost: 0.001, actualCost: 0.0004, netSavings: 0.6, ...over,
  };
}

describe("metering gateway — auth is fail-closed", () => {
  it("refuses when no credential resolves", () => {
    expect(resolveCaller(undefined, cfg())).toBeNull();
    expect(resolveCaller("Bearer wrong", cfg())).toBeNull();
    expect(resolveCaller("Bearer tok-acme", cfg({ serviceAccounts: new Map() }))).toBeNull();
  });

  it("does NOT open when no accounts are configured (unless dev-open is explicit)", () => {
    const empty = { serviceAccounts: new Map<string, string>(), devOpen: false };
    expect(resolveCaller("Bearer anything", empty)).toBeNull();
    expect(resolveCaller("Bearer anything", { ...empty, devOpen: true })?.admin).toBe(true);
  });

  it("resolves a service account to its org (not admin)", () => {
    const c = resolveCaller("Bearer tok-acme", cfg());
    expect(c).toEqual({ orgId: "acme", admin: false });
  });
});

describe("metering gateway — tenant is server-derived, never client-supplied", () => {
  it("books usage to the authenticated org even if the body claims another", () => {
    const svc = createMeteringService();
    const caller = resolveCaller("Bearer tok-acme", cfg())!;
    const res = ingest(caller, [record({ orgId: "victim" }), record()], svc);
    expect(res.status).toBe(202);
    expect(svc.summary("acme").requests).toBe(2);
    expect(svc.summary("victim").requests).toBe(0); // spoofed org got nothing
  });

  it("rejects a content field on ingest (privacy backstop) with 400", () => {
    const svc = createMeteringService();
    const caller = resolveCaller("Bearer tok-acme", cfg())!;
    const res = ingest(caller, [record({ prompt: "leak me" })], svc);
    expect(res.status).toBe(400);
    expect(svc.totalRecords()).toBe(0);
  });

  it("refuses ingest without auth (401) and refuses admin-token ingest (400, no home org)", () => {
    const svc = createMeteringService();
    expect(ingest(null, [record()], svc).status).toBe(401);
    const admin = resolveCaller("Bearer admin-secret", cfg())!;
    expect(ingest(admin, [record()], svc).status).toBe(400);
  });
});

describe("metering gateway — summary read is authorized", () => {
  it("blocks cross-tenant reads (403) and unauthenticated reads (401)", () => {
    const svc = createMeteringService();
    svc.ingest([{ orgId: "acme", requestId: "r", model: "m", at: 1, avoidedLlm: 0, actualLlm: 1, baselineInputTokens: 1, actualInputTokens: 1, eliminatedInputTokens: 0, compressedInputTokens: 0, baselineOutputTokens: 1, actualOutputTokens: 1, providerCachedInputTokens: 0, cacheResult: "miss", baselineCost: 0, actualCost: 0, netSavings: 0 }]);
    const acme = resolveCaller("Bearer tok-acme", cfg())!;
    expect(summary(null, "acme", svc).status).toBe(401);
    expect(summary(acme, "other-org", svc).status).toBe(403);
    expect(summary(acme, "acme", svc).status).toBe(200);
  });

  it("admin may read any org", () => {
    const svc = createMeteringService();
    const admin = resolveCaller("Bearer admin-secret", cfg())!;
    expect(summary(admin, "any-org", svc).status).toBe(200);
  });
});

describe("metering gateway — loadAuthConfig", () => {
  it("binds a single INGEST_TOKEN to INGEST_ORG_ID and stays closed otherwise", () => {
    const c = loadAuthConfig({ INGEST_TOKEN: "t", INGEST_ORG_ID: "org1" } as NodeJS.ProcessEnv);
    expect(resolveCaller("Bearer t", c)).toEqual({ orgId: "org1", admin: false });
    expect(resolveCaller("Bearer other", c)).toBeNull();
    const none = loadAuthConfig({} as NodeJS.ProcessEnv);
    expect(none.serviceAccounts.size).toBe(0);
    expect(resolveCaller("Bearer x", none)).toBeNull();
  });
});
