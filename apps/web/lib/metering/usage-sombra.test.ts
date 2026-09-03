import { describe, it, expect } from "vitest";

import { parseUsageRecord, UsageValidationError } from "./usage";

/**
 * S2.2 · La verja del ingest ante el carril sombra (basis:"shadow", 0021).
 * Lo que se prueba no es que "shadow" pase — es que pase EXACTAMENTE con la
 * forma que la RPC espera: calls a cero (la sombra aporta 0 a los totales) y
 * netSavings como PROPORCIÓN, no dólares (la cicatriz de la coalescencia).
 */

function registroSombra(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: "req-1:shadow",
    model: "claude-sonnet-5",
    cacheResult: "miss",
    at: Date.now(),
    // La sombra no evita ni ejecuta llamadas: aporta CERO a los contadores.
    avoidedLlm: 0,
    actualLlm: 0,
    baselineInputTokens: 0,
    actualInputTokens: 0,
    eliminatedInputTokens: 0,
    compressedInputTokens: 0,
    baselineOutputTokens: 0,
    actualOutputTokens: 0,
    providerCachedInputTokens: 0,
    baselineCost: 0.42,
    actualCost: 0.33,
    netSavings: 0.214,
    basis: "shadow",
    ...extra,
  };
}

describe("ingesta — el carril sombra (S2.2, 0021)", () => {
  it("acepta basis:'shadow' con el requestId sufijado (':shadow' pasa el charset)", () => {
    const rec = parseUsageRecord(registroSombra(), "org-1");
    expect(rec["basis"]).toBe("shadow");
    expect(rec.requestId).toBe("req-1:shadow");
  });

  it("una política que PIERDE dinero viaja: netSavings negativo dentro de [-100,1]", () => {
    // v2 lo demostró en el replay (−39 %): el carril tiene que poder decir la verdad.
    const rec = parseUsageRecord(registroSombra({ netSavings: -0.39 }), "org-1");
    expect(rec["netSavings"]).toBe(-0.39);
  });

  it("⛔ netSavings en DÓLARES sigue rechazado también en sombra", () => {
    expect(() => parseUsageRecord(registroSombra({ netSavings: 142.53 }), "org-1")).toThrow(UsageValidationError);
  });

  it("⛔ un basis desconocido sigue rechazado (la lista es cerrada)", () => {
    expect(() => parseUsageRecord(registroSombra({ basis: "shadowy" }), "org-1")).toThrow(/basis/);
  });

  it("⛔ los costes sombra no pueden ser negativos", () => {
    expect(() => parseUsageRecord(registroSombra({ actualCost: -0.1 }), "org-1")).toThrow(/actualCost/);
  });
});
