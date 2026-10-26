import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "22222222-2222-4222-8222-222222222222";
let usuario: { id: string } | null = { id: "user-1" };
let guardia: { ok: true; orgId: string; role: string } | { ok: false; status: number; error: string } = {
  ok: true,
  orgId: ORG,
  role: "member",
};
let uso: { rows: unknown[]; failed: boolean };
let sombra: { rows: unknown[]; status: string; failed: boolean };
let organizaciones: string[] = [];

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: usuario } }) } }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/org/guardia", () => ({
  contextoDeLaOrg: async (_admin: unknown, _uid: string, accion: string) => {
    expect(accion).toBe("ver_panel");
    return guardia;
  },
}));
vi.mock("@/app/[locale]/dashboard/data", () => ({
  getUsageRollups: async (_client: unknown, orgId: string) => {
    organizaciones.push(orgId);
    return uso;
  },
  getShadowByModel: async (_client: unknown, orgId: string, admin: unknown) => {
    expect(admin).toBeDefined();
    organizaciones.push(orgId);
    return sombra;
  },
}));

import { GET } from "./route";

const pedir = (query = "format=csv&range=30") => GET(new Request(`https://savings.bivelio.com/api/org/shadow-opportunities?${query}`));
const hoy = () => new Date().toISOString().slice(0, 10);

beforeEach(() => {
  usuario = { id: "user-1" };
  guardia = { ok: true, orgId: ORG, role: "member" };
  organizaciones = [];
  uso = { rows: [{ day: hoy(), shadowRequests: 4 }], failed: false };
  sombra = {
    rows: [{ day: hoy(), model: "gpt-5", shadowRequests: 1, shadowBaselineCost: 2, shadowActualCost: 1.25 }],
    status: "data",
    failed: false,
  };
});

describe("GET /api/org/shadow-opportunities — auth, RLS y formato", () => {
  it("valida formato y rango sin tocar auth ni base", async () => {
    for (const query of ["format=xml", "range=7", "range=all", "range=30x"]) {
      expect((await pedir(query)).status, query).toBe(400);
    }
    expect(organizaciones).toEqual([]);
  });

  it("sin sesión 401 y sin permiso conserva el status del guardia", async () => {
    usuario = null;
    expect((await pedir()).status).toBe(401);
    usuario = { id: "user-1" };
    guardia = { ok: false, status: 403, error: "No autorizado" };
    expect((await pedir()).status).toBe(403);
    expect(organizaciones).toEqual([]);
  });

  it("CSV autenticado, filtrado por org, privado y con cobertura parcial", async () => {
    const res = await pedir();
    expect(res.status).toBe(200);
    expect(organizaciones).toEqual([ORG, ORG]);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="shadow-opportunities-30d.csv"');
    const csv = await res.text();
    expect(csv).toContain("# basis=SHADOW");
    expect(csv).toContain("# partial_coverage=true");
    expect(csv).toContain("# coverage_ratio=0.25");
    expect(csv).toContain("gpt-5,1,2,1.25,0.75,0.25");
  });

  it("JSON declara estimado, cobertura y solo las filas de oportunidad", async () => {
    const res = await pedir("format=json&range=120");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const body = await res.json();
    expect(body).toMatchObject({
      basis: "shadow",
      estimated: true,
      rangeDays: 120,
      partialCoverage: true,
      coverageRatio: 0.25,
      totalShadowRequests: 4,
      attributedShadowRequests: 1,
    });
    expect(body.rows).toEqual([{
      model: "gpt-5",
      shadowRequests: 1,
      baselineCost: 2,
      actualCost: 1.25,
      hypotheticalSavings: 0.75,
      coverageRatio: 0.25,
    }]);
    expect(JSON.stringify(body)).not.toMatch(/prompt|completion/i);
  });

  it("recorta al rango pedido y no exporta historia fuera de él", async () => {
    sombra.rows = [{ day: "2000-01-01", model: "viejo", shadowRequests: 1, shadowBaselineCost: 1, shadowActualCost: 1 }];
    uso.rows = [{ day: "2000-01-01", shadowRequests: 1 }];
    const body = await (await pedir("format=json&range=30")).json();
    expect(body.rows).toEqual([]);
    expect(body.totalShadowRequests).toBe(0);
    expect(body.coverageRatio).toBeNull();
  });
});

describe("GET /api/org/shadow-opportunities — nunca un fichero vacío por error", () => {
  it("migración ausente = 503 explícito", async () => {
    sombra = { rows: [], status: "unavailable", failed: false };
    const res = await pedir();
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("shadow_by_model_unavailable");
  });

  it.each(["error", "hidden"])("sombra %s = 503", async (status) => {
    sombra = { rows: [], status, failed: status === "error" };
    expect((await pedir()).status).toBe(503);
  });

  it("uso diario failed = 503", async () => {
    uso.failed = true;
    expect((await pedir()).status).toBe(503);
  });
});
