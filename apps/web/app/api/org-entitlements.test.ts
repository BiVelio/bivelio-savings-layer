import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * GET /api/org/entitlements — el canal de la palanca S4a.
 *
 * Contrato con la pasarela (fail-closed del lado del cliente):
 *  · sin bearer o clave desconocida → 401;
 *  · error de BD → 503 (la pasarela apaga; aquí no hay datos que perder);
 *  · org bloqueada (revocada/caducada) → 200 con features VACÍAS — respuesta
 *    definitiva, no error, para que la pasarela cachee el apagado;
 *  · org viva → unión de features de las licencias VIVAS únicamente (una
 *    revocada no aporta aunque siga en la tabla).
 */

interface FilasFalsas {
  service_accounts?: { org_id: string } | null;
  service_accounts_error?: unknown;
  licenses?: unknown[];
  licenses_error?: unknown;
  subscriptions?: unknown[];
}

let filas: FilasFalsas = {};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabla: string) => ({
      select: () => ({
        eq: () => {
          if (tabla === "service_accounts") {
            return {
              maybeSingle: async () => ({
                data: filas.service_accounts ?? null,
                error: filas.service_accounts_error ?? null,
              }),
            };
          }
          if (tabla === "licenses") {
            return Promise.resolve({ data: filas.licenses ?? [], error: filas.licenses_error ?? null });
          }
          return Promise.resolve({ data: filas.subscriptions ?? [], error: null });
        },
      }),
    }),
  }),
}));

const peticion = (token?: string) =>
  new Request("https://savings.bivelio.com/api/org/entitlements", {
    method: "GET",
    headers: token !== undefined ? { authorization: `Bearer ${token}` } : {},
  });

const EN_UN_ANO = new Date(Date.now() + 365 * 86_400_000).toISOString();
const HACE_UN_ANO = new Date(Date.now() - 365 * 86_400_000).toISOString();

describe("GET /api/org/entitlements", () => {
  beforeEach(() => {
    filas = {};
  });

  it("401 sin bearer y 401 con clave desconocida", async () => {
    const { GET } = await import("./org/entitlements/route.js");
    expect((await GET(peticion())).status).toBe(401);
    filas = { service_accounts: null };
    expect((await GET(peticion("bvk_desconocida"))).status).toBe(401);
  });

  it("503 si la BD falla — la pasarela apaga (fail-closed), no adivina", async () => {
    const { GET } = await import("./org/entitlements/route.js");
    filas = { service_accounts: { org_id: "org-1" }, licenses_error: new Error("db down") };
    expect((await GET(peticion("bvk_x"))).status).toBe(503);
  });

  it("org viva: unión de features SOLO de licencias vivas", async () => {
    const { GET } = await import("./org/entitlements/route.js");
    filas = {
      service_accounts: { org_id: "org-1" },
      licenses: [
        { revoked: false, expires_at: EN_UN_ANO, grace_days: 14, features: ["semantic_cache", "context_elision"] },
        // Revocada: sus features NO cuentan aunque la fila exista.
        { revoked: true, expires_at: EN_UN_ANO, grace_days: 14, features: ["cross_tenant_optimization"] },
      ],
      subscriptions: [],
    };
    const res = await GET(peticion("bvk_x"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.features).toEqual(["context_elision", "semantic_cache"]);
    expect(json.refreshAfterSeconds).toBeGreaterThan(0);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("org bloqueada (todas revocadas, sin suscripción): 200 con features vacías", async () => {
    const { GET } = await import("./org/entitlements/route.js");
    filas = {
      service_accounts: { org_id: "org-1" },
      licenses: [{ revoked: true, expires_at: HACE_UN_ANO, grace_days: 0, features: ["context_elision"] }],
      subscriptions: [],
    };
    const res = await GET(peticion("bvk_x"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.features).toEqual([]);
    expect(json.reason).toBe("license-revoked");
  });

  it("licencia caducada pero suscripción activa: la org no está bloqueada, y la caducada no aporta features", async () => {
    const { GET } = await import("./org/entitlements/route.js");
    filas = {
      service_accounts: { org_id: "org-1" },
      licenses: [{ revoked: false, expires_at: HACE_UN_ANO, grace_days: 0, features: ["context_elision"] }],
      subscriptions: [{ status: "active", current_period_end: EN_UN_ANO }],
    };
    const res = await GET(peticion("bvk_x"));
    expect(res.status).toBe(200);
    expect((await res.json()).features).toEqual([]);
  });
});
