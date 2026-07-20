import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { verifyRevocationList } from "@bivelio/license-client";
import {
  createLicensingService,
  InMemoryRevocationStore,
  loadAuthConfig,
} from "../src/index.js";
import { createRequestHandler } from "../src/app.js";

const BASE = 1_800_000_000;

describe("signedRevocationList (service core)", () => {
  it("is verifiable by the service public key and lists a jti after revoke()", () => {
    const svc = createLicensingService({ nowSeconds: () => BASE });
    const { payload } = svc.issue({ orgId: "o", plan: "pro", seats: 1, features: [] });
    svc.revoke(payload.jti);

    const token = svc.signedRevocationList();
    const v = verifyRevocationList(token, svc.publicKey);
    expect(v.valid).toBe(true);
    expect(v.payload?.revoked).toContain(payload.jti);
    expect(v.payload?.asOf).toBe(BASE);
    expect(v.payload?.seq).toBe(1);
    expect(v.payload?.iss).toBe("bivelio-licensing");
  });

  it("revision increments on a genuinely-new jti but NOT on an idempotent re-revoke", () => {
    const svc = createLicensingService({ nowSeconds: () => BASE });
    expect(svc.revocationRevision()).toBe(0);
    const a = svc.issue({ orgId: "o", plan: "pro", seats: 1, features: [] }).payload;
    const b = svc.issue({ orgId: "o", plan: "pro", seats: 1, features: [] }).payload;

    svc.revoke(a.jti);
    expect(svc.revocationRevision()).toBe(1);
    svc.revoke(a.jti); // idempotent — must NOT inflate seq
    expect(svc.revocationRevision()).toBe(1);
    svc.revoke(b.jti);
    expect(svc.revocationRevision()).toBe(2);
  });

  it("rejects a list signed by a different service instance (wrong key)", () => {
    const a = createLicensingService();
    const b = createLicensingService();
    const list = a.signedRevocationList();
    expect(verifyRevocationList(list, b.publicKey).valid).toBe(false);
  });

  it("does NOT accept a license token as a revocation list (domain separation)", () => {
    const svc = createLicensingService();
    const { token } = svc.issue({ orgId: "o", plan: "pro", seats: 1, features: [] });
    const v = verifyRevocationList(token, svc.publicKey);
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/type/i);
  });
});

describe("GET /licenses/revocations (HTTP, public)", () => {
  let server: Server;
  let baseUrl: string;
  let svc: ReturnType<typeof createLicensingService>;

  beforeAll(async () => {
    svc = createLicensingService({ nowSeconds: () => BASE, revocationStore: new InMemoryRevocationStore() });
    const handler = createRequestHandler(svc, loadAuthConfig({} as NodeJS.ProcessEnv));
    server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns 200 { list } (signed, verifiable) with no auth, and honors If-None-Match → 304", async () => {
    const { payload } = svc.issue({ orgId: "o", plan: "pro", seats: 1, features: [] });
    svc.revoke(payload.jti);

    const res = await fetch(`${baseUrl}/licenses/revocations`);
    expect(res.status).toBe(200);
    const etag = res.headers.get("etag");
    expect(etag).toBe(`W/"revoc-${svc.revocationRevision()}"`);

    const { list } = (await res.json()) as { list: string };
    const v = verifyRevocationList(list, svc.publicKey);
    expect(v.valid).toBe(true);
    expect(v.payload?.revoked).toContain(payload.jti);

    // Unchanged revision → conditional request short-circuits to 304 (no body).
    const res304 = await fetch(`${baseUrl}/licenses/revocations`, {
      headers: { "if-none-match": etag! },
    });
    expect(res304.status).toBe(304);
    expect(await res304.text()).toBe("");
  });
});
