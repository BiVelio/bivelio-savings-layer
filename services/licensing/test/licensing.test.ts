import { describe, it, expect } from "vitest";
import { createLicensingService } from "../src/index.js";

const DAY = 86400;
const BASE = 1_800_000_000;

describe("LicensingService", () => {
  it("issues a license that validates as active and entitled", () => {
    const svc = createLicensingService({ nowSeconds: () => BASE });
    const { token, payload } = svc.issue({
      orgId: "org_1",
      plan: "pro",
      seats: 10,
      features: ["semantic_cache", "dashboards"],
    });
    expect(payload.org_id).toBe("org_1");

    const resolved = svc.validate(token);
    expect(resolved.status).toBe("active");
    expect(resolved.entitlements.features).toContain("semantic_cache");
    expect(resolved.entitlements.seats).toBe(10);
  });

  it("revokes a license", () => {
    const svc = createLicensingService({ nowSeconds: () => BASE });
    const { token, payload } = svc.issue({ orgId: "org_1", plan: "pro", seats: 1, features: [] });
    expect(svc.validate(token).status).toBe("active");
    svc.revoke(payload.jti);
    expect(svc.validate(token).status).toBe("revoked");
    expect(svc.revocationList()).toContain(payload.jti);
  });

  it("moves a license through grace then expiry as time advances", () => {
    let now = BASE;
    const svc = createLicensingService({ nowSeconds: () => now });
    const { token } = svc.issue({
      orgId: "org_1",
      plan: "team",
      seats: 5,
      features: ["semantic_cache"],
      termDays: 30,
      graceDays: 14,
    });
    now = BASE + 35 * DAY; // within grace
    expect(svc.validate(token).status).toBe("grace");
    now = BASE + 50 * DAY; // past grace
    const expired = svc.validate(token);
    expect(expired.status).toBe("expired");
    expect(expired.entitlements.plan).toBe("free");
  });

  it("rejects a token signed by a different service instance", () => {
    const a = createLicensingService({ nowSeconds: () => BASE });
    const b = createLicensingService({ nowSeconds: () => BASE });
    const { token } = a.issue({ orgId: "org_1", plan: "pro", seats: 1, features: [] });
    expect(b.validate(token).status).toBe("invalid");
  });
});

describe("LicensingService · la licencia Medir (measure)", () => {
  it("issueMeasure firma una licencia sin features, con el tope de asientos y el plazo largo", async () => {
    const { MEASURE_LIMITS } = await import("@bivelio/protocol");
    const svc = createLicensingService({ nowSeconds: () => BASE });
    const { token, payload } = svc.issueMeasure("org_m");
    expect(payload.plan).toBe("measure");
    expect(payload.features).toEqual([]);
    expect(payload.seats).toBe(MEASURE_LIMITS.seats);
    // Firmada «caducada» para los verificadores que no conocen el plan…
    expect(payload.expires_at).toBe(BASE);
    expect(payload.grace_days).toBe(0);
    // …con la vigencia real en sus campos propios.
    expect(payload.measure_expires_at).toBe(BASE + MEASURE_LIMITS.termDays * DAY);
    expect(payload.measure_grace_days).toBe(MEASURE_LIMITS.graceDays);
    const resolved = svc.validate(token);
    expect(resolved.status).toBe("active");
    expect(resolved.entitlements.plan).toBe("measure");
    expect(resolved.entitlements.features).toEqual([]);
  });

  it("issue() normaliza un plan measure que llegue con features o asientos de más", () => {
    const svc = createLicensingService({ nowSeconds: () => BASE });
    const { payload } = svc.issue({
      orgId: "org_m",
      plan: "measure",
      seats: 500,
      features: ["semantic_cache", "context_elision"],
      termDays: 1,
    });
    expect(payload.features).toEqual([]);
    expect(payload.seats).toBe(5);
    expect(payload.measure_expires_at! - payload.issued_at).toBeGreaterThan(365 * DAY);
  });

  it("sigue activa pasado un año (la vigencia real manda), y caduca al final de la suya", () => {
    let now = BASE;
    const svc = createLicensingService({ nowSeconds: () => now });
    const { token } = svc.issueMeasure("org_m");
    now = BASE + 400 * DAY;
    expect(svc.validate(token).status).toBe("active");
    now = BASE + (3650 + 31) * DAY;
    expect(svc.validate(token).status).toBe("expired");
  });

  it("una licencia measure es revocable como cualquier otra", () => {
    const svc = createLicensingService({ nowSeconds: () => BASE });
    const { token, payload } = svc.issueMeasure("org_m");
    svc.revoke(payload.jti);
    expect(svc.validate(token).status).toBe("revoked");
  });
});
