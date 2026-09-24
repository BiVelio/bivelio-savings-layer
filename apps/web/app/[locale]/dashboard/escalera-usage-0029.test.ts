import { describe, expect, it, vi } from "vitest";

import { getUsageRollups } from "./data";

/**
 * EL PELDAÑO DE 0029 EN LA ESCALERA DE getUsageRollups. El despliegue puede
 * adelantar a la migración: sin las columnas reference_* PostgREST responde
 * 42703, y sin este peldaño el panel entero pintaría «la lectura falló» a un
 * cliente con los datos intactos. Con el peldaño, se relee sin el carril y las
 * filas salen SIN los campos de referencia (no disponibles, no cero) — y el
 * resto del panel sigue.
 */
const ORG = "33333333-3333-4333-8333-333333333333";

/** Una fila de usage_daily con TODAS las columnas de 0015/0021/0025/0029. */
const FILA_COMPLETA: Record<string, number | string> = {
  day: "2026-09-10",
  requests: 30,
  avoided_llm: 20,
  actual_llm: 10,
  eliminated_input_tokens: 0,
  compressed_input_tokens: 0,
  provider_cached_input_tokens: 0,
  baseline_cost: 2050,
  actual_cost: 1100,
  measured_requests: 10,
  measured_baseline_cost: 2000,
  measured_actual_cost: 1100,
  baseline_input_tokens: 1,
  actual_input_tokens: 1,
  baseline_output_tokens: 1,
  actual_output_tokens: 1,
  shadow_requests: 0,
  shadow_baseline_cost: 0,
  shadow_actual_cost: 0,
  eliminated_floor_cost: 0,
  eliminated_credited_requests: 0,
  reference_requests: 20,
  reference_baseline_cost: "50.0000000000",
  reference_actual_cost: "0.0000000000",
};

/** Un doble de supabase cuya usage_daily tiene (o no) las columnas de 0029. */
function doble(con0029: boolean) {
  const selects: string[] = [];
  const consulta = () => {
    let columnas = "";
    const q: Record<string, unknown> = {
      select: (c: string) => ((columnas = c), selects.push(c), q),
      eq: () => q,
      gte: () => q,
      order: () => q,
      then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => {
        const pedidas = columnas.split(",").map((c) => c.trim());
        const r =
          !con0029 && pedidas.some((c) => c.startsWith("reference_"))
            ? { data: null, error: { code: "42703", message: "column usage_daily.reference_requests does not exist" } }
            : { data: [Object.fromEntries(pedidas.map((c) => [c, FILA_COMPLETA[c]]))], error: null };
        return Promise.resolve(r).then(ok, ko);
      },
    };
    return q;
  };
  return { cliente: { schema: () => ({ from: consulta }), from: consulta } as never, selects };
}

describe("getUsageRollups — el peldaño de 0029", () => {
  it("con 0029: una sola lectura y las filas traen el carril (texto de numeric → número)", async () => {
    const { cliente, selects } = doble(true);
    const r = await getUsageRollups(cliente, ORG);
    expect(r.failed).toBe(false);
    expect(selects).toHaveLength(1);
    expect(selects[0]).toContain("reference_requests, reference_baseline_cost, reference_actual_cost");
    expect(r.rows[0]).toMatchObject({ referenceRequests: 20, referenceBaselineCost: 50, referenceActualCost: 0 });
  });

  it("sin 0029: aviso, relectura SIN el carril, las filas sin sus campos (no disponibles, no cero) y el panel NO falla", async () => {
    const { cliente, selects } = doble(false);
    const avisos = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = await getUsageRollups(cliente, ORG);
      expect(r.failed).toBe(false);
      expect(selects).toHaveLength(2);
      expect(selects[1]).not.toContain("reference_");
      // Los demás carriles siguen: el peldaño solo quita el de 0029.
      expect(selects[1]).toContain("eliminated_floor_cost");
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]).toMatchObject({ measuredRequests: 10, measuredBaselineCost: 2000 });
      for (const campo of ["referenceRequests", "referenceBaselineCost", "referenceActualCost"]) {
        expect(campo in r.rows[0]!, campo).toBe(false);
      }
      expect(avisos.mock.calls.some((a) => String(a[0]).includes("0029"))).toBe(true);
    } finally {
      avisos.mockRestore();
    }
  });
});
