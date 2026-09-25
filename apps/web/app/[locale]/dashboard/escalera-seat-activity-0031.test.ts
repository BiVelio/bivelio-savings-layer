import { describe, expect, it, vi } from "vitest";

import { getAsientos } from "./data";

/**
 * EL PELDAÑO DE 0031 EN getAsientos. El despliegue puede adelantar a la
 * migración: sin las columnas reference_* de seat_activity PostgREST responde
 * 42703, y sin este peldaño la tarjeta de máquinas y el aviso de versión
 * desaparecerían del panel. Con el peldaño se relee con las columnas de 0024 y
 * la referencia por asiento sale a 0 (no disponible). Con 0031, se suma, y el
 * numeric(20,10) llega de PostgREST como CADENA.
 */
const ORG = "33333333-3333-4333-8333-333333333333";
const AYER = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

/** Una fila de seat_activity con TODAS las columnas de 0024 y 0031. */
const FILA: Record<string, unknown> = {
  seat_id: "m-ref",
  is_ci: false,
  day: AYER,
  last_seen_at: new Date().toISOString(),
  client_version_min: "gateway/0.4.23",
  client_version_max: "gateway/0.4.23",
  requests_sin_version: 0,
  measured_baseline_cost: "0.000000",
  measured_actual_cost: "0.000000",
  reference_baseline_cost: "0.0200000000",
  reference_actual_cost: "0.0000000000",
};

type Modo = "con0031" | "sin0031" | "sinTabla";

/** Un doble de supabase cuya seat_activity tiene (o no) las columnas de 0031, o ni existe. */
function doble(modo: Modo) {
  const selects: string[] = [];
  const consulta = () => {
    let columnas = "";
    const q: Record<string, unknown> = {
      select: (c: string) => ((columnas = c), selects.push(c), q),
      eq: () => q,
      gte: () => q,
      order: () => q,
      limit: () => q,
      then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => {
        const pedidas = columnas.split(",").map((c) => c.trim());
        const r =
          modo === "sinTabla"
            ? { data: null, error: { code: "42P01", message: 'relation "bvsala.seat_activity" does not exist' } }
            : modo === "sin0031" && pedidas.some((c) => c.startsWith("reference_"))
              ? { data: null, error: { code: "42703", message: "column seat_activity.reference_baseline_cost does not exist" } }
              : { data: [Object.fromEntries(pedidas.map((c) => [c, FILA[c]]))], error: null };
        return Promise.resolve(r).then(ok, ko);
      },
    };
    return q;
  };
  return { cliente: { schema: () => ({ from: consulta }), from: consulta } as never, selects };
}

describe("getAsientos — el peldaño de 0031", () => {
  it("con 0031: una sola lectura, y la referencia (cadena de numeric) se suma", async () => {
    const { cliente, selects } = doble("con0031");
    const r = await getAsientos(cliente, ORG);
    expect(r.failed).toBe(false);
    expect(selects).toHaveLength(1);
    expect(selects[0]).toContain("reference_baseline_cost, reference_actual_cost");
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.ahorroReferencia7dUsd).toBeCloseTo(0.02, 12);
    // COMISIONAR_REFERENCIA está encendido: lo medido de 7 días la incluye.
    expect(r.rows[0]!.ahorroMedido7dUsd).toBeCloseTo(0.02, 12);
  });

  it("sin 0031: aviso, relectura con las columnas de 0024, filas presentes y referencia 0", async () => {
    const { cliente, selects } = doble("sin0031");
    const avisos = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = await getAsientos(cliente, ORG);
      expect(r.failed).toBe(false);
      expect(selects).toHaveLength(2);
      expect(selects[1]).not.toContain("reference_");
      expect(selects[1]).toContain("measured_actual_cost");
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]!.ahorroReferencia7dUsd).toBe(0);
      expect(r.rows[0]!.ahorroMedido7dUsd).toBe(0);
      expect(avisos.mock.calls.some((a) => String(a[0]).includes("0031"))).toBe(true);
    } finally {
      avisos.mockRestore();
    }
  });

  it("sin tabla: sin filas y SIN fallo (la tarjeta se esconde, el panel sigue)", async () => {
    const { cliente } = doble("sinTabla");
    // El mensaje «does not exist» también casa con columna inexistente: se
    // intenta el peldaño, vuelve a faltar la tabla y el resultado es el mismo.
    const avisos = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = await getAsientos(cliente, ORG);
      expect(r).toEqual({ rows: [], failed: false });
    } finally {
      avisos.mockRestore();
    }
  });
});
