import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * GET /api/cron/retencion — desde 0029 purga también reference_hits (el CSV de
 * las repeticiones medidas por referencia), DESPUÉS de la purga de idempotencia
 * y con su propio corte (día, 460 días). Sin la tabla (migración aún no
 * aplicada) esa segunda purga se salta sin alerta; un fallo real, alerta crítica.
 */

let tablaReferencias: "ok" | "ausente" | "falla" = "ok";
const borrados: Array<{ tabla: string; columna: string; corte: string }> = [];
const alertas: Array<{ nivel: string; asunto: string }> = [];

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    schema: () => ({
      from: (tabla: string) => ({
        delete: () => ({
          lt: async (columna: string, corte: string) => {
            borrados.push({ tabla, columna, corte });
            if (tabla === "reference_hits" && tablaReferencias === "ausente") {
              return { count: null, error: { code: "42P01", message: 'relation "bvsala.reference_hits" does not exist' } };
            }
            if (tabla === "reference_hits" && tablaReferencias === "falla") {
              return { count: null, error: { code: "57014", message: "statement timeout" } };
            }
            return { count: tabla === "reference_hits" ? 3 : 7, error: null };
          },
        }),
        select: () => ({
          lt: async () =>
            tabla === "reference_hits" && tablaReferencias === "ausente"
              ? { count: null, error: { code: "PGRST205", message: "Could not find the table" } }
              : { count: 2, error: null },
        }),
      }),
    }),
  }),
}));
vi.mock("@/lib/observabilidad/alerta", () => ({
  alertar: async (a: { nivel: string; asunto: string }) => void alertas.push(a),
}));

import { GET } from "./route";

const pedir = (q = "") =>
  GET(new Request(`https://savings.bivelio.com/api/cron/retencion${q}`, { headers: { authorization: "Bearer s" } }));

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "s");
  tablaReferencias = "ok";
  borrados.length = 0;
  alertas.length = 0;
});
afterEach(() => vi.unstubAllEnvs());

describe("cron retencion — reference_hits (0029)", () => {
  it("purga las dos tablas, reference_hits por `day` y DESPUÉS de la de idempotencia", async () => {
    const res = await pedir();
    expect(res.status).toBe(200);
    expect(borrados.map((b) => b.tabla)).toEqual(["usage_ingest_seen", "reference_hits"]);
    expect(borrados[1]!.columna).toBe("day");
    expect(borrados[1]!.corte).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const cuerpo = (await res.json()) as { borradas: number; referencias: { borradas: number; dias: number } };
    expect(cuerpo.borradas).toBe(7);
    expect(cuerpo.referencias).toMatchObject({ borradas: 3, dias: 460 });
  });

  it("sin la tabla (0029 sin aplicar): se salta, 200 y ninguna alerta", async () => {
    tablaReferencias = "ausente";
    const res = await pedir();
    expect(res.status).toBe(200);
    expect(alertas).toEqual([]);
    expect(((await res.json()) as { referencias: unknown }).referencias).toEqual({ tablaAusente: true });
  });

  it("un fallo real de la purga de reference_hits: alerta crítica y 500", async () => {
    tablaReferencias = "falla";
    const res = await pedir();
    expect(res.status).toBe(500);
    expect(alertas).toHaveLength(1);
    expect(alertas[0]).toMatchObject({ nivel: "critico" });
  });

  it("?seco=1 cuenta las dos tablas sin borrar nada", async () => {
    const res = await pedir("?seco=1");
    expect(borrados).toEqual([]);
    const cuerpo = (await res.json()) as { borraria: number; referencias: { borraria: number } };
    expect(cuerpo.borraria).toBe(2);
    expect(cuerpo.referencias.borraria).toBe(2);
  });
});
