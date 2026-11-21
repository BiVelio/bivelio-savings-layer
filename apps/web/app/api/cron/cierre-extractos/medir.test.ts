import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/cron/cierre-extractos con organizaciones «Medir» que AHORRAN DE VERDAD.
 *
 * Desde la 1.2.4 el ahorro medido de una organización con la licencia gratuita
 * se guarda en usage_daily (antes llegaba a cero). Este test fija que el cierre
 * mensual NO lo convierte en comisión, y que no cambia nada para nadie más:
 *
 *  · MEDIR      — solo licencia Medir: ahorro medido real → cargo 0, exenta;
 *  · EX_PRO     — Medir + una suscripción Pro cancelada: cargo 0, exenta;
 *  · LEGADO     — modalidad con comisión viva, sin Medir: cargo de siempre;
 *  · EX_LEGADO  — modalidad con comisión cancelada + Medir (volvió a Medir):
 *                 NO exenta — su último mes se cierra como siempre (y su
 *                 ingesta en Medir sigue neutralizada, ver usage/medir.test.ts).
 */

const MEDIR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EX_PRO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LEGADO = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const EX_LEGADO = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const uso = (org_id: string) => ({
  org_id,
  day: "2026-11-10",
  requests: 5000,
  baseline_cost: 4000,
  actual_cost: 1000,
  measured_requests: 5000,
  measured_baseline_cost: 4000,
  measured_actual_cost: 1000,
  reference_requests: 0,
  reference_baseline_cost: 0,
  reference_actual_cost: 0,
});

const LICENCIAS_MEDIR = [MEDIR, EX_PRO, EX_LEGADO].map((org_id, i) => ({ id: `lic-${i}`, org_id, issued_at: "2026-11-02T09:00:00Z" }));
const SUSCRIPCIONES = [
  { id: "s1", org_id: EX_PRO, price_id: "price_pro_m", status: "canceled" },
  { id: "s2", org_id: LEGADO, price_id: "price_comision_antiguo", status: "active" },
  { id: "s3", org_id: EX_LEGADO, price_id: "price_comision_antiguo", status: "canceled" },
];

let upsert: Array<Record<string, unknown>> | null = null;
let fallarLicencias = false;
const leidas: string[] = [];

function builder(tabla: string) {
  const filtros: Record<string, unknown> = {};
  const b: Record<string, unknown> = {};
  const encadenar = () => b;
  Object.assign(b, {
    select: encadenar,
    eq: (col: string, v: unknown) => {
      filtros[col] = v;
      return b;
    },
    in: (col: string, v: unknown) => {
      filtros[`in:${col}`] = v;
      return b;
    },
    gte: encadenar,
    lt: encadenar,
    order: encadenar,
    limit: encadenar,
    range: async () => {
      leidas.push(tabla);
      if (tabla === "usage_daily") return { data: [MEDIR, EX_PRO, LEGADO, EX_LEGADO].map(uso), error: null };
      if (tabla === "organizations") return { data: [], error: null };
      if (tabla === "licenses") {
        if (fallarLicencias) return { data: null, error: { message: "boom" } };
        return { data: filtros["plan"] === "measure" ? LICENCIAS_MEDIR : [], error: null };
      }
      if (tabla === "subscriptions") {
        // La consulta de planes sin comisión (viva + price de Pro/Equipo) y la de historia (todas).
        const estados = filtros["in:status"] as string[] | undefined;
        const precios = filtros["in:price_id"] as string[] | undefined;
        return {
          data: SUSCRIPCIONES.filter((s) => (!estados || estados.includes(s.status)) && (!precios || precios.includes(s.price_id))),
          error: null,
        };
      }
      return { data: [], error: null };
    },
    maybeSingle: async () => ({ data: { day: "2026-08-01" }, error: null }),
    upsert: async (filas: Array<Record<string, unknown>>) => {
      upsert = filas;
      return { error: null, count: filas.length };
    },
  });
  return b;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ schema: () => ({ from: (t: string) => builder(t) }) }),
}));
vi.mock("@/lib/billing/fx", () => ({ obtenerFxCierre: async () => ({ eurPorUsd: 0.9, fuente: "BCE (test)" }) }));
vi.mock("@/lib/observabilidad/alerta", () => ({ alertar: async () => {} }));
vi.mock("@/lib/stripe/env", () => ({ preciosSinComision: () => ({ pro: ["price_pro_m"], equipo: ["price_team_m"] }) }));

import { GET } from "./route";

const peticion = () =>
  new Request("https://savings.bivelio.com/api/cron/cierre-extractos?periodo=2026-11", {
    headers: { authorization: "Bearer secreto-de-prueba" },
  });

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "secreto-de-prueba");
  upsert = null;
  fallarLicencias = false;
  leidas.length = 0;
});
afterEach(() => vi.unstubAllEnvs());

const fila = (org: string) => upsert!.find((f) => f["org_id"] === org)!;

describe("cierre-extractos · la licencia Medir nunca lleva comisión", () => {
  it("una org Medir con ahorro medido REAL se cierra con cargo 0 y exenta; su ahorro queda en el extracto", async () => {
    const res = await GET(peticion());
    expect(res.status).toBe(200);
    expect(fila(MEDIR)).toMatchObject({ es_exento: true, cargo_eur: 0, ahorro_medido_usd: 3000 });
    expect(fila(EX_PRO)).toMatchObject({ es_exento: true, cargo_eur: 0 });
  });

  it("la modalidad con comisión NO cambia: viva o cancelada-y-vuelta-a-Medir, el mismo cargo de siempre", async () => {
    await GET(peticion());
    expect(fila(LEGADO)["es_exento"]).toBe(false);
    expect(Number(fila(LEGADO)["cargo_eur"])).toBeGreaterThan(0);
    expect(fila(EX_LEGADO)["es_exento"]).toBe(false);
    expect(fila(EX_LEGADO)["cargo_eur"]).toBe(fila(LEGADO)["cargo_eur"]);
  });

  it("FALLA CERRADO: si no se pueden leer las licencias Medir, el cierre se aplaza (500) y no sella nada", async () => {
    fallarLicencias = true;
    const res = await GET(peticion());
    expect(res.status).toBe(500);
    expect(upsert).toBeNull();
  });
});
