import { describe, it, expect } from "vitest";

import { parseUsageRecord, UsageValidationError } from "./usage";

/** Un registro mínimo válido (todos los numéricos de la lista, ids con charset). */
function cuerpoValido(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: "req-1",
    model: "claude-haiku-4-5",
    cacheResult: "miss",
    at: Date.now(),
    avoidedLlm: 0,
    actualLlm: 1,
    baselineInputTokens: 10,
    actualInputTokens: 10,
    eliminatedInputTokens: 0,
    compressedInputTokens: 0,
    baselineOutputTokens: 5,
    actualOutputTokens: 5,
    providerCachedInputTokens: 0,
    baselineCost: 0.01,
    actualCost: 0.01,
    netSavings: 0,
    ...extra,
  };
}

describe("ingesta — atribución por sesión/subagente (0019)", () => {
  it("acepta sessionId y agentId con charset de identidad, y los conserva", () => {
    const rec = parseUsageRecord(cuerpoValido({ sessionId: "ses_01:abc-123", agentId: "ag.7" }), "org-1");
    expect(rec["sessionId"]).toBe("ses_01:abc-123");
    expect(rec["agentId"]).toBe("ag.7");
  });

  it("son opcionales: sin ellos el registro pasa y el campo no existe", () => {
    const rec = parseUsageRecord(cuerpoValido(), "org-1");
    expect("sessionId" in rec).toBe(false);
    expect("agentId" in rec).toBe(false);
  });

  it("rechaza texto libre — el cierre de canal de contenido aplica igual que a seatId", () => {
    expect(() => parseUsageRecord(cuerpoValido({ sessionId: "el usuario preguntó cómo…" }), "org-1")).toThrow(
      UsageValidationError,
    );
    expect(() => parseUsageRecord(cuerpoValido({ agentId: "x".repeat(129) }), "org-1")).toThrow(/agentId/);
  });

  it("parentAgentId sigue siendo campo desconocido: rechazado (no viaja en v1)", () => {
    expect(() => parseUsageRecord(cuerpoValido({ parentAgentId: "p-1" }), "org-1")).toThrow(/disallowed field/);
  });
});
