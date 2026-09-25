import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * GET /api/cron/cierre-extractos — el carril medido por referencia (0029).
 *
 *  · Con 0029 aplicada: el cierre lee reference_* y sella las cuatro columnas
 *    nuevas de extractos (con la referencia DENTRO de lo medido).
 *  · Sin 0029 (el despliegue adelantó a la migración): 42703 en la lectura →
 *    alerta CRÍTICA, lectura sin el carril y upsert SIN las cuatro columnas, en
 *    vez de aplazar el cierre. Crítica (llega por correo) porque, con el SDK
 *    emitiendo referencia, cada mes sin 0029 sella ese ahorro fuera de la base
 *    sin ningún error visible.
 */

const ORG = "11111111-1111-4111-8111-111111111111";

interface Estado {
  /** Columnas pedidas a usage_daily en cada lectura del período. */
  selects: string[];
  /** Filas que llegaron al upsert de extractos. */
  upsert: Array<Record<string, unknown>> | null;
  /** ¿Existen las columnas de 0029? */
  con0029: boolean;
  alertas: Array<{ nivel: string; asunto: string }>;
}
const estado: Estado = { selects: [], upsert: null, con0029: true, alertas: [] };

const FILA_USO = {
  org_id: ORG,
  day: "2026-09-10",
  requests: 30,
  baseline_cost: 2050,
  actual_cost: 1100,
  measured_requests: 10,
  measured_baseline_cost: 2000,
  measured_actual_cost: 1100,
};

/** Un builder de PostgREST encadenable: cada método devuelve el mismo objeto; los terminales resuelven. */
function builder(tabla: string) {
  let columnas = "";
  const b: Record<string, unknown> = {};
  const encadenar = () => b;
  Object.assign(b, {
    select: (c: string) => {
      columnas = c;
      if (tabla === "usage_daily" && c !== "day") estado.selects.push(c);
      return b;
    },
    eq: encadenar,
    gte: encadenar,
    lt: encadenar,
    order: encadenar,
    limit: encadenar,
    range: async () => {
      if (tabla === "organizations") return { data: [], error: null };
      if (tabla === "usage_daily") {
        if (columnas.includes("reference_") && !estado.con0029) {
          return { data: null, error: { code: "42703", message: "column usage_daily.reference_requests does not exist" } };
        }
        const fila = columnas.includes("reference_")
          ? { ...FILA_USO, reference_requests: 20, reference_baseline_cost: 50, reference_actual_cost: 0 }
          : FILA_USO;
        return { data: [fila], error: null };
      }
      return { data: [], error: null };
    },
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
vi.mock("@/lib/billing/fx", () => ({
  obtenerFxCierre: async () => ({ eurPorUsd: 0.9, fuente: "BCE (test)" }),
}));
vi.mock("@/lib/observabilidad/alerta", () => ({
  alertar: async (a: { nivel: string; asunto: string }) => {
    estado.alertas.push(a);
  },
}));

import { GET } from "./route";

const peticion = () =>
  new Request("https://savings.bivelio.com/api/cron/cierre-extractos?periodo=2026-09", {
    headers: { authorization: "Bearer secreto-de-prueba" },
  });

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "secreto-de-prueba");
  estado.selects = [];
  estado.upsert = null;
  estado.con0029 = true;
  estado.alertas = [];
});
afterEach(() => vi.unstubAllEnvs());

describe("cierre-extractos — el carril medido por referencia (0029)", () => {
  it("con 0029: lee reference_* y sella las cuatro columnas, con la referencia dentro de lo medido", async () => {
    const res = await GET(peticion());
    expect(res.status).toBe(200);
    expect(estado.selects).toHaveLength(1);
    expect(estado.selects[0]).toContain("reference_requests, reference_baseline_cost, reference_actual_cost");
    const [fila] = estado.upsert!;
    expect(fila).toMatchObject({
      org_id: ORG,
      periodo: "2026-09",
      requests_referencia: 20,
      base_referencia_usd: 50,
      ahorro_referencia_usd: 50,
      regla_referencia: "reference-v2",
      requests_medidas: 30,
      ahorro_medido_usd: 950,
    });
    expect(estado.alertas).toEqual([]);
  });

  it("sin 0029: alerta crítica, lectura sin el carril y upsert SIN las cuatro columnas — el cierre no se aplaza", async () => {
    estado.con0029 = false;
    const res = await GET(peticion());
    expect(res.status).toBe(200);
    expect(estado.selects).toHaveLength(2);
    expect(estado.selects[1]).not.toContain("reference_");
    const [fila] = estado.upsert!;
    for (const col of ["requests_referencia", "base_referencia_usd", "ahorro_referencia_usd", "regla_referencia"]) {
      expect(col in fila!, col).toBe(false);
    }
    // El dinero medido por la propia petición, intacto: 900 USD.
    expect(fila).toMatchObject({ requests_medidas: 10, ahorro_medido_usd: 900 });
    expect(estado.alertas).toHaveLength(1);
    // Crítica: solo lo crítico llega por correo, y esto es ingreso perdido en silencio.
    expect(estado.alertas[0]).toMatchObject({ nivel: "critico" });
    expect(estado.alertas[0]!.asunto).toMatch(/0029/);
  });

  it("?seco=1 enseña requests_referencia por organización, sin sellar nada", async () => {
    const res = await GET(
      new Request("https://savings.bivelio.com/api/cron/cierre-extractos?periodo=2026-09&seco=1", {
        headers: { authorization: "Bearer secreto-de-prueba" },
      }),
    );
    const cuerpo = (await res.json()) as { extractos: Array<{ requests_referencia: number }> };
    expect(estado.upsert).toBeNull();
    expect(cuerpo.extractos[0]!.requests_referencia).toBe(20);
  });
});
