import { describe, it, expect } from "vitest";
import {
  authorizeAdmin,
  loadAuthConfig,
  createLicensingService,
  InMemoryRevocationStore,
  type RevocationStore,
} from "../src/index.js";

describe("licensing auth — fail-closed", () => {
  it("with an admin token, requires an exact Bearer match", () => {
    const cfg = { adminToken: "s3cret" };
    expect(authorizeAdmin("Bearer s3cret", cfg)).toBe(true);
    expect(authorizeAdmin("Bearer wrong", cfg)).toBe(false);
    expect(authorizeAdmin(undefined, cfg)).toBe(false);
    expect(authorizeAdmin("s3cret", cfg)).toBe(false); // missing Bearer prefix
  });

  it("with NO admin token, refuses unless dev-open is explicit (never silently open)", () => {
    expect(authorizeAdmin("Bearer anything", {})).toBe(false);
    expect(authorizeAdmin(undefined, {})).toBe(false);
    expect(authorizeAdmin("Bearer anything", { devOpen: true })).toBe(true);
  });

  it("loadAuthConfig reflects the environment", () => {
    expect(loadAuthConfig({ ADMIN_TOKEN: "a" } as NodeJS.ProcessEnv)).toEqual({ adminToken: "a", devOpen: false });
    expect(loadAuthConfig({ BVSALA_DEV_OPEN: "1" } as NodeJS.ProcessEnv)).toEqual({ devOpen: true });
    expect(loadAuthConfig({} as NodeJS.ProcessEnv).adminToken).toBeUndefined();
  });
});

describe("licensing — revocation persists via an injected store (survives 'cold start')", () => {
  it("a durable store keeps a revocation across service instances", () => {
    // The shared store is what a Postgres-backed deployment injects; the keypair
    // is irrelevant to revocation persistence, so each instance may have its own.
    const store: RevocationStore = new InMemoryRevocationStore();
    const svcA = createLicensingService({ revocationStore: store });
    const { payload } = svcA.issue({ orgId: "o", plan: "pro", seats: 3, features: [] });
    svcA.revoke(payload.jti);
    expect(svcA.isRevoked(payload.jti)).toBe(true);

    // A brand-new service instance sharing the SAME store still sees the revocation.
    const svcB = createLicensingService({ revocationStore: store });
    expect(svcB.isRevoked(payload.jti)).toBe(true);
    expect(svcB.revocationList()).toContain(payload.jti);
  });

  it("the default in-memory store does NOT share state between instances (the cold-start bug it guards against)", () => {
    const a = createLicensingService();
    const { payload } = a.issue({ orgId: "o", plan: "pro", seats: 1, features: [] });
    a.revoke(payload.jti);
    const b = createLicensingService(); // fresh default store
    expect(b.isRevoked(payload.jti)).toBe(false); // this is exactly why prod must inject a durable store
  });
});
