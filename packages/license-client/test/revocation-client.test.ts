import { describe, it, expect } from "vitest";
import {
  generateLicenseKeypair,
  signLicense,
  LicenseClient,
  createLicenseGate,
} from "../src/index.js";
import type { LicensePayload } from "@bivelio/protocol";

/**
 * The online call-home mutators on LicenseClient — the "advanced" seam the SDK's
 * injected `licenseGate` uses. Once a token is loaded, setRevoked()/refresh()
 * re-resolve it, so a live createLicenseGate() reflects revocation + expiry
 * without reloading.
 */
const BASE = 1_800_000_000;
const DAY = 86400;
const { publicKey, privateKey } = generateLicenseKeypair();

const mint = (over: Partial<LicensePayload> = {}): string =>
  signLicense(
    {
      jti: "lic_1",
      org_id: "o",
      plan: "pro",
      seats: 3,
      features: ["semantic_cache"],
      issued_at: BASE,
      expires_at: BASE + 30 * DAY,
      grace_days: 14,
      ...over,
    },
    privateKey,
  );

describe("LicenseClient.setRevoked / refresh", () => {
  it("setRevoked flips a loaded active client to revoked (sticky) and disables the live gate", () => {
    const client = new LicenseClient({ publicKey, nowSeconds: () => BASE });
    const gate = createLicenseGate(client);
    client.load(mint({ jti: "lic_x" }));
    expect(client.status()).toBe("active");
    expect(gate.isActive()).toBe(true);
    expect(gate.isEntitled("semantic_cache")).toBe(true);

    client.setRevoked(["lic_x"]);
    expect(client.status()).toBe("revoked");
    expect(gate.isActive()).toBe(false);
    expect(gate.isEntitled("semantic_cache")).toBe(false);

    // Sticky: re-resolving later (with lic_x no longer "re-added") keeps it revoked.
    client.refresh();
    expect(client.status()).toBe("revoked");
  });

  it("refresh() re-resolves against the live clock: active → grace → expired", () => {
    let now = BASE;
    const client = new LicenseClient({ publicKey, nowSeconds: () => now });
    client.load(mint({ jti: "lic_y", expires_at: BASE + 10, grace_days: 1 }));
    expect(client.status()).toBe("active");

    now = BASE + 100; // past expiry, within the 1-day grace
    expect(client.refresh()?.status).toBe("grace");

    now = BASE + 2 * DAY; // past grace
    expect(client.refresh()?.status).toBe("expired");
  });

  it("refresh() is a no-op (returns null) before any token is loaded", () => {
    const client = new LicenseClient({ publicKey });
    expect(client.refresh()).toBeNull();
  });
});
