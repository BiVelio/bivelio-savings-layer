import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * GET /api/cron/cierre-extractos — ⛔ QUIÉN CIERRA CON COMISIÓN (2026-11-16).
 *
 * LICENSE-CLOUD §6(b): hay comisión «only if your subscription is on a plan
 * that the Published Pricing lists as carrying a commission». El cierre cobraba
 * a toda organización que no tuviera, el día 1, una suscripción VIVA en Pro o
 * Equipo: quien cancelaba Pro el día 20 recibía una factura de comisión por
 * los días en que estuvo en un plan de cuota fija. Estos casos pasan por la
 * ruta entera (lecturas, decisión, fila sellada) para que la regla no se
 * pueda quedar solo en la función pura.
 */

const CATALOGO = { comision: ["price_legacy_m", "price_legacy_y"], pro: ["price_pro_m"], equipo: ["price_team_m"] };

interface Sub {
  org_id: string;
  price_id: string | null;
  status: string;
  created_at?: string | null;
  canceled_at?: string | null;
  current_period_end?: string | null;
  cancel_at_period_end?: boolean;
}

interface Estado {
  /** org → [base medida, coste real medido] del único día con uso del período. */
  uso: Record<string, [number, number]>;
  exentas: string[];
  subs: Sub[];
  catalogo: typeof CATALOGO;
  falloSubs: boolean;
  /** Lo que el cron pidió a `subscriptions`. */
  consulta: { columnas: string; ids: string[]; filtros: string[] } | null;
  upsert: Array<Record<string, unknown>> | null;
  alertas: Array<{ nivel: string; asunto: string; detalle?: Record<string, unknown> }>;
}
const estado: Estado = { uso: {}, exentas: [], subs: [], catalogo: CATALOGO, falloSubs: false, consulta: null, upsert: null, alertas: [] };

function builder(tabla: string) {
  let columnas = "";
  let ids: string[] | null = null;
  const filtros: string[] = [];
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    select: (c: string) => {
      columnas = c;
      return b;
    },
    eq: (col: string) => {
      filtros.push(`eq:${col}`);
      return b;
    },
    in: (col: string, valores: string[]) => {
      filtros.push(`in:${col}`);
      if (col === "price_id") ids = valores;
      return b;
    },
    gte: () => b,
    lt: () => b,
    order: () => b,
    limit: () => b,
    range: async () => {
      if (tabla === "organizations") return { data: estado.exentas.map((id) => ({ id })), error: null };
      if (tabla === "usage_daily") {
        const filas = Object.entries(estado.uso).map(([org_id, [base, actual]]) => ({
          org_id,
          day: "2026-10-10",
          requests: 10,
          baseline_cost: base,
          actual_cost: actual,
          measured_requests: 10,
          measured_baseline_cost: base,
          measured_actual_cost: actual,
          reference_requests: 0,
          reference_baseline_cost: 0,
          reference_actual_cost: 0,
        }));
        return { data: filas, error: null };
      }
      if (tabla === "subscriptions") {
        estado.consulta = { columnas, ids: ids ?? [], filtros: [...filtros] };
        if (estado.falloSubs) return { data: null, error: { message: "timeout" } };
        return { data: estado.subs.filter((s) => s.price_id !== null && (ids ?? []).includes(s.price_id)), error: null };
      }
      return { data: [], error: null };
    },
    // Primer uso en agosto: octubre NO es calibración para nadie.
    maybeSingle: async () => ({ data: { day: "2026-08-01" }, error: null }),
    upsert: async (filas: Array<Record<string, unknown>>) => {
      estado.upsert = filas;
      return { error: null, count: filas.length };
    },
  });
  return b;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ schema: () => ({ from: (t: string) => builder(t) }) }),
}));
vi.mock("@/lib/stripe/env", () => ({ catalogoDeComision: () => estado.catalogo }));
vi.mock("@/lib/billing/fx", () => ({ obtenerFxCierre: async () => ({ eurPorUsd: 0.9, fuente: "BCE (test)" }) }));
vi.mock("@/lib/observabilidad/alerta", () => ({
  alertar: async (a: Estado["alertas"][number]) => {
    estado.alertas.push(a);
  },
}));

import { GET } from "./route";

const cerrar = (extra = "") =>
  GET(
    new Request(`https://savings.bivelio.com/api/cron/cierre-extractos?periodo=2026-10${extra}`, {
      headers: { authorization: "Bearer secreto-de-prueba" },
    }),
  );

const sub = (org_id: string, price_id: string | null, status: string, mas: Partial<Sub> = {}): Sub => ({
  org_id,
  price_id,
  status,
  created_at: "2026-06-03T09:00:00Z",
  canceled_at: null,
  current_period_end: "2026-11-03T09:00:00Z",
  cancel_at_period_end: false,
  ...mas,
});

/** La fila sellada de una org. */
const fila = (org: string) => estado.upsert!.find((f) => f.org_id === org)!;

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "secreto-de-prueba");
  Object.assign(estado, { uso: {}, exentas: [], subs: [], catalogo: CATALOGO, falloSubs: false, consulta: null, upsert: null, alertas: [] });
});
afterEach(() => vi.unstubAllEnvs());

describe("⛔ el cierre cobra comisión SOLO a quien llevó un plan con comisión en el período", () => {
  it("un mes con todos los casos: solo los dos de la modalidad con comisión cierran con cargo", async () => {
    estado.uso = {
      "pro-cancelado": [2000, 1100],
      "equipo-impagado": [2000, 1100],
      "legado-vivo": [2000, 1100],
      "legado-cancelado": [2000, 1100],
      "solo-medir": [2000, 2000], // el ingest de «Medir» deja base = real
      "enterprise-sin-sub": [2000, 1100],
      "exenta-con-legado": [2000, 1100],
      "precio-de-cortesia": [2000, 1100],
    };
    estado.exentas = ["exenta-con-legado"];
    estado.subs = [
      sub("pro-cancelado", "price_pro_m", "canceled", { canceled_at: "2026-10-20T10:00:00Z" }),
      sub("equipo-impagado", "price_team_m", "unpaid"),
      sub("legado-vivo", "price_legacy_m", "active"),
      sub("legado-cancelado", "price_legacy_y", "canceled", { canceled_at: "2026-10-15T10:00:00Z" }),
      sub("exenta-con-legado", "price_legacy_m", "active"),
      sub("precio-de-cortesia", "price_cortesia", "active"),
    ];
    const res = await cerrar();
    expect(res.status).toBe(200);

    // El extracto de TODAS se conserva: una fila por organización con uso.
    expect(estado.upsert!.map((f) => f.org_id).sort()).toEqual(Object.keys(estado.uso).sort());

    for (const org of ["pro-cancelado", "equipo-impagado", "enterprise-sin-sub", "exenta-con-legado", "precio-de-cortesia"]) {
      expect(fila(org), org).toMatchObject({ cargo_eur: 0, es_exento: true, ahorro_medido_usd: 900 });
      // «Lo que habría sido» sigue en el documento, para auditoría.
      expect(Number(fila(org).comision_eur), org).toBeGreaterThan(0);
    }
    expect(fila("solo-medir")).toMatchObject({ cargo_eur: 0, comision_eur: 0, ahorro_medido_usd: 0 });

    for (const org of ["legado-vivo", "legado-cancelado"]) {
      expect(fila(org), org).toMatchObject({ es_exento: false, es_calibracion: false });
      expect(Number(fila(org).cargo_eur), org).toBeGreaterThan(0);
      expect(fila(org).cargo_eur, org).toBe(fila(org).comision_eur);
    }
    expect(estado.alertas).toEqual([]);
  });

  it("lee TODAS las filas del catálogo, sin filtrar por estado: la cancelada también decide", async () => {
    estado.uso = { a: [2000, 1100] };
    await cerrar();
    expect(estado.consulta!.columnas).toBe("org_id, price_id, status, created_at, canceled_at, current_period_end, cancel_at_period_end");
    expect(estado.consulta!.ids.sort()).toEqual(["price_legacy_m", "price_legacy_y", "price_pro_m", "price_team_m"]);
    expect(estado.consulta!.filtros).toEqual(["in:price_id"]);
  });

  it("varias suscripciones: comisión y Pro en el mismo mes → cargo 0 y aviso para revisarlo a mano", async () => {
    estado.uso = { mixta: [2000, 1100], "legado-con-pro-antiguo": [2000, 1100] };
    estado.subs = [
      sub("mixta", "price_legacy_m", "canceled", { canceled_at: "2026-10-05T10:00:00Z" }),
      sub("mixta", "price_pro_m", "active", { created_at: "2026-10-05T10:05:00Z" }),
      sub("legado-con-pro-antiguo", "price_legacy_m", "active"),
      sub("legado-con-pro-antiguo", "price_pro_m", "canceled", {
        created_at: "2026-01-01T00:00:00Z",
        canceled_at: "2026-03-01T00:00:00Z",
        current_period_end: "2026-03-01T00:00:00Z",
      }),
    ];
    await cerrar();
    expect(fila("mixta")).toMatchObject({ cargo_eur: 0, es_exento: true });
    expect(Number(fila("legado-con-pro-antiguo").cargo_eur)).toBeGreaterThan(0);
    expect(estado.alertas).toHaveLength(1);
    expect(estado.alertas[0]).toMatchObject({ nivel: "aviso", detalle: { periodo: "2026-10", orgs: ["mixta"] } });
  });

  it("el mes siguiente a la cancelación de la comisión ya no se cobra", async () => {
    estado.uso = { ex: [2000, 1100] };
    estado.subs = [sub("ex", "price_legacy_m", "canceled", { canceled_at: "2026-09-15T10:00:00Z" })];
    await cerrar();
    expect(fila("ex")).toMatchObject({ cargo_eur: 0, es_exento: true });
  });

  it("sin ningún Price de comisión configurado: nadie paga, no se consulta nada y se avisa", async () => {
    estado.catalogo = { comision: [], pro: ["price_pro_m"], equipo: ["price_team_m"] };
    estado.uso = { a: [2000, 1100] };
    estado.subs = [sub("a", "price_legacy_m", "active")];
    await cerrar();
    expect(estado.consulta).toBeNull();
    expect(fila("a")).toMatchObject({ cargo_eur: 0, es_exento: true });
    expect(estado.alertas).toHaveLength(1);
    expect(estado.alertas[0]).toMatchObject({ nivel: "aviso" });
    expect(estado.alertas[0]!.asunto).toMatch(/Price de comisión/);
  });

  it("falla CERRADO: si las suscripciones no se pueden leer, no se sella nada y se alerta", async () => {
    estado.uso = { a: [2000, 1100] };
    estado.falloSubs = true;
    const res = await cerrar();
    expect(res.status).toBe(500);
    expect(estado.upsert).toBeNull();
    expect(estado.alertas[0]).toMatchObject({ nivel: "critico" });
  });

  it("?seco=1 enseña el mismo veredicto sin sellar", async () => {
    estado.uso = { "pro-cancelado": [2000, 1100], "legado-vivo": [2000, 1100] };
    estado.subs = [
      sub("pro-cancelado", "price_pro_m", "canceled", { canceled_at: "2026-10-20T10:00:00Z" }),
      sub("legado-vivo", "price_legacy_m", "active"),
    ];
    const res = await cerrar("&seco=1");
    const cuerpo = (await res.json()) as { extractos: Array<{ org_id: string; cargo_eur: number; es_exento: boolean }> };
    expect(estado.upsert).toBeNull();
    const de = (org: string) => cuerpo.extractos.find((e) => e.org_id === org)!;
    expect(de("pro-cancelado")).toMatchObject({ cargo_eur: 0, es_exento: true });
    expect(de("legado-vivo").es_exento).toBe(false);
    expect(de("legado-vivo").cargo_eur).toBeGreaterThan(0);
  });
});
