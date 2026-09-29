import { describe, expect, it, vi } from "vitest";

import { getUsageRollups } from "./data";
import { deriveAhorroNativo, deriveVerdict, proveedorDeModelo } from "./derive";

/**
 * 0032 · EL AHORRO NATIVO en el panel. El peldaño de la escalera (sin las
 * columnas native_* se relee sin ellas y el panel NO falla), y la derivación de
 * la tarjeta «Ahorro nativo activado»: neto = lectura − prima, por proveedor, y
 * JAMÁS dentro del titular.
 */
const ORG = "33333333-3333-4333-8333-333333333333";

const FILA: Record<string, number | string> = {
  day: "2026-09-20",
  requests: 10,
  avoided_llm: 0,
  actual_llm: 10,
  eliminated_input_tokens: 0,
  compressed_input_tokens: 0,
  provider_cached_input_tokens: 80_000,
  baseline_cost: 1,
  actual_cost: 1,
  measured_requests: 10,
  measured_baseline_cost: 1,
  measured_actual_cost: 1,
  baseline_input_tokens: 1,
  actual_input_tokens: 1,
  baseline_output_tokens: 1,
  actual_output_tokens: 1,
  shadow_requests: 0,
  shadow_baseline_cost: 0,
  shadow_actual_cost: 0,
  eliminated_floor_cost: 0,
  eliminated_credited_requests: 0,
  reference_requests: 0,
  reference_baseline_cost: 0,
  reference_actual_cost: 0,
  native_cache_read_savings: "0.2160000000",
  native_cache_write_premium: "0.0075000000",
  native_requests: 10,
};

function doble(con0032: boolean) {
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
          !con0032 && pedidas.some((c) => c.startsWith("native_"))
            ? { data: null, error: { code: "42703", message: "column usage_daily.native_requests does not exist" } }
            : { data: [Object.fromEntries(pedidas.map((c) => [c, FILA[c]]))], error: null };
        return Promise.resolve(r).then(ok, ko);
      },
    };
    return q;
  };
  return { cliente: { schema: () => ({ from: consulta }), from: consulta } as never, selects };
}

describe("getUsageRollups — el peldaño de 0032", () => {
  it("con 0032: una lectura y las filas traen el carril (texto de numeric → número)", async () => {
    const { cliente, selects } = doble(true);
    const r = await getUsageRollups(cliente, ORG);
    expect(selects).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ nativeRequests: 10, nativeCacheReadSavings: 0.216, nativeCacheWritePremium: 0.0075 });
  });

  it("sin 0032: aviso, relectura sin el carril, el resto intacto y el panel NO falla", async () => {
    const { cliente, selects } = doble(false);
    const avisos = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = await getUsageRollups(cliente, ORG);
      expect(r.failed).toBe(false);
      expect(selects).toHaveLength(2);
      expect(selects[1]).not.toContain("native_");
      expect(selects[1]).toContain("reference_requests");
      expect("nativeRequests" in r.rows[0]!).toBe(false);
      expect(avisos.mock.calls.some((a) => String(a[0]).includes("0032"))).toBe(true);
    } finally {
      avisos.mockRestore();
    }
  });
});

describe("deriveAhorroNativo — la tarjeta «Ahorro nativo activado»", () => {
  const fila = (extra: Record<string, number> = {}) => ({
    requests: 10, baselineCost: 1, actualCost: 1, measuredRequests: 10, measuredBaselineCost: 1, measuredActualCost: 1, ...extra,
  });

  it("sin columnas o sin peticiones con caché: none (nada de ceros fabricados)", () => {
    expect(deriveAhorroNativo([fila()])).toEqual({ kind: "none" });
    expect(deriveAhorroNativo([fila({ nativeRequests: 0, nativeCacheReadSavings: 0, nativeCacheWritePremium: 0 })])).toEqual({ kind: "none" });
  });

  it("neto = lectura − prima, y por proveedor desde el desglose por modelo", () => {
    const r = deriveAhorroNativo(
      [fila({ nativeRequests: 7, nativeCacheReadSavings: 0.3, nativeCacheWritePremium: 0.05 })],
      [
        { model: "claude-sonnet-5", nativeCacheReadSavings: 0.25, nativeCacheWritePremium: 0.05 },
        { model: "openai/gpt-5.6", nativeCacheReadSavings: 0.03, nativeCacheWritePremium: 0 },
        { model: "gemini-3.1-pro-preview", nativeCacheReadSavings: 0.02, nativeCacheWritePremium: 0 },
      ],
    );
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.net).toBeCloseTo(0.25, 12);
    expect(r.byProvider.map((p) => p.provider)).toEqual(["anthropic", "openai", "google"]);
    expect(r.byProvider[0]!.net).toBeCloseTo(0.2, 12);
  });

  it("un neto negativo (escrituras en frío) se enseña tal cual", () => {
    const r = deriveAhorroNativo([fila({ nativeRequests: 2, nativeCacheReadSavings: 0, nativeCacheWritePremium: 0.01 })]);
    expect(r).toMatchObject({ kind: "ok", net: -0.01 });
  });

  it("⛔ el titular no cambia con un carril nativo enorme", () => {
    const sin = deriveVerdict([fila()]);
    const con = deriveVerdict([fila({ nativeRequests: 10, nativeCacheReadSavings: 9_999, nativeCacheWritePremium: 0 })]);
    expect(con).toEqual(sin);
  });

  it("proveedorDeModelo es el espejo de familiaDeTarifa", () => {
    expect(proveedorDeModelo("anthropic/claude-opus-5")).toBe("anthropic");
    expect(proveedorDeModelo("gpt-6")).toBe("openai");
    expect(proveedorDeModelo("o3-mini")).toBe("openai");
    expect(proveedorDeModelo("google/gemini-3-flash")).toBe("google");
    expect(proveedorDeModelo("llama-4")).toBe("other");
  });
});
