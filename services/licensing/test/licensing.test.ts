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
