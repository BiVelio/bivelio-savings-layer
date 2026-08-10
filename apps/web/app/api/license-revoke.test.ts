import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * La ruta admin de revocación escribía SOLO el ledger (`revocations`) y nunca
 * marcaba `licenses.revoked`. De esa columna dependen los DOS candados del
 * servidor: `/api/license/current` filtra `.eq("revoked", false)` — así que
 * RE-ENTREGABA la credencial revocada — y `decideEntitlement` la lee para
 * bloquear el ingest. Una revocación manual (fraude, chargeback, token
 * filtrado) solo la aplicaba el poller del SDK del cliente, que es parcheable.
 * El fix: la ruta pasa por `revokeLicense()`, que hace ledger + fila.
 */

const revocar = vi.fn(async (..._a: unknown[]) => {});
vi.mock("@/lib/license/issue", () => ({
  revokeLicense: (...a: unknown[]) => revocar(...a),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({}),
}));

const peticion = (token: string, cuerpo: unknown) =>
  new Request("https://savings.bivelio.com/api/license/revoke", {
    method: "POST",
    body: JSON.stringify(cuerpo),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });

describe("POST /api/license/revoke — la revocación admin activa el candado del servidor", () => {
  beforeEach(() => {
    process.env.LICENSE_ADMIN_TOKEN = "token-admin-de-test";
    revocar.mockClear();
  });
  afterEach(() => {
    delete process.env.LICENSE_ADMIN_TOKEN;
  });

  it("pasa por revokeLicense (ledger + licenses.revoked), no por un upsert crudo", async () => {
    const { POST } = await import("./license/revoke/route.js");
    const res = await POST(peticion("token-admin-de-test", { jti: "jti-123", reason: "chargeback" }));
    expect(res.status).toBe(200);
    expect(revocar).toHaveBeenCalledTimes(1);
    expect(revocar.mock.calls[0]![1]).toBe("jti-123");
    expect(revocar.mock.calls[0]![2]).toBe("chargeback");
  });

  it("401 con token equivocado, sin tocar nada", async () => {
    const { POST } = await import("./license/revoke/route.js");
    expect((await POST(peticion("intruso", { jti: "x" }))).status).toBe(401);
    expect(revocar).not.toHaveBeenCalled();
  });

  it("si revokeLicense falla, 500 — nunca un 200 con la licencia viva", async () => {
    revocar.mockRejectedValueOnce(new Error("db down"));
    const { POST } = await import("./license/revoke/route.js");
    expect((await POST(peticion("token-admin-de-test", { jti: "x" }))).status).toBe(500);
  });
});
