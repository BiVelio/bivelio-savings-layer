import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * GET /api/cron/retencion — desde 0029 purga también reference_hits (el CSV de
 * las repeticiones medidas por referencia), DESPUÉS de la purga de idempotencia
 * y con su propio corte (día, 460 días). Sin la tabla (migración aún no
 * aplicada) esa segunda purga se salta sin alerta; un fallo real, alerta crítica.
 */

let tablaReferencias: "ok" | "ausente" | "falla" = "ok";
let tablasVerificacion: "ok" | "ausente" | "falla" = "ok";
const VERIF = ["verification_samples", "verification_daily", "verification_batches_seen"];
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
            if (VERIF.includes(tabla) && tablasVerificacion === "ausente") {
              return { count: null, error: { code: "42P01", message: `relation "bvsala.${tabla}" does not exist` } };
            }
            if (tabla === "verification_daily" && tablasVerificacion === "falla") {
              return { count: null, error: { code: "57014", message: "statement timeout" } };
            }
            if (VERIF.includes(tabla)) return { count: { verification_samples: 5, verification_daily: 4, verification_batches_seen: 9 }[tabla]!, error: null };
            return { count: tabla === "reference_hits" ? 3 : 7, error: null };
          },
        }),
        select: () => ({
          lt: async () =>
            (tabla === "reference_hits" && tablaReferencias === "ausente") || (VERIF.includes(tabla) && tablasVerificacion === "ausente")
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
  tablasVerificacion = "ok";
  borrados.length = 0;
  alertas.length = 0;
});
afterEach(() => vi.unstubAllEnvs());

describe("cron retencion — reference_hits (0029)", () => {
  it("purga las dos tablas, reference_hits por `day` y DESPUÉS de la de idempotencia", async () => {
    const res = await pedir();
    expect(res.status).toBe(200);
    expect(borrados.map((b) => b.tabla).slice(0, 2)).toEqual(["usage_ingest_seen", "reference_hits"]);
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

describe("cron retencion — «tu propio banco» (0030)", () => {
  it("purga las tres tablas al final: muestras y recuentos por `day` (180 días), lotes por `seen_at` (30 días)", async () => {
    const res = await pedir();
    expect(res.status).toBe(200);
    expect(borrados.map((b) => b.tabla)).toEqual([
      "usage_ingest_seen",
      "reference_hits",
      "verification_samples",
      "verification_daily",
      "verification_batches_seen",
    ]);
    expect(borrados[2]).toMatchObject({ columna: "day" });
    expect(borrados[3]).toMatchObject({ columna: "day" });
    expect(borrados[4]).toMatchObject({ columna: "seen_at", corte: borrados[0]!.corte });
    const corte = new Date(Date.now() - 180 * 86_400_000).toISOString().slice(0, 10);
    expect(borrados[2]!.corte).toBe(corte);
    const cuerpo = (await res.json()) as Record<string, unknown>;
    expect(cuerpo["verificacion"]).toEqual({ corte, dias: 180, borradas: 9, lotesBorrados: 9 });
    // Las claves de antes, intactas.
    expect(Object.keys(cuerpo).sort()).toEqual(["borradas", "corte", "dias", "referencias", "verificacion"]);
  });

  it("sin las tablas (0030 sin aplicar): se salta, 200 y ninguna alerta", async () => {
    tablasVerificacion = "ausente";
    const res = await pedir();
    expect(res.status).toBe(200);
    expect(alertas).toEqual([]);
    expect(((await res.json()) as { verificacion: unknown }).verificacion).toEqual({ tablaAusente: true });
  });

  it("sin reference_hits la purga de la verificación sigue corriendo", async () => {
    tablaReferencias = "ausente";
    const res = await pedir();
    const cuerpo = (await res.json()) as { referencias: unknown; verificacion: { borradas: number } };
    expect(cuerpo.referencias).toEqual({ tablaAusente: true });
    expect(cuerpo.verificacion.borradas).toBe(9);
  });

  it("un fallo real: alerta crítica y 500", async () => {
    tablasVerificacion = "falla";
    const res = await pedir();
    expect(res.status).toBe(500);
    expect(alertas).toHaveLength(1);
    expect(alertas[0]).toMatchObject({ nivel: "critico" });
  });

  it("?seco=1 trae la clave `verificacion` y no borra nada", async () => {
    const res = await pedir("?seco=1");
    expect(borrados).toEqual([]);
    const cuerpo = (await res.json()) as { verificacion: Record<string, unknown> };
    expect(cuerpo.verificacion).toMatchObject({ dias: 180, borraria: 4, lotesBorraria: 2 });
    tablasVerificacion = "ausente";
    const r2 = (await (await pedir("?seco=1")).json()) as { verificacion: unknown };
    expect(r2.verificacion).toEqual({ tablaAusente: true });
  });
});
