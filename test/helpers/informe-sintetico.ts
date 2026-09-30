import type { SavingsReport } from "../../src/contracts/types.js";

/**
 * Un SavingsReport COMPLETO y sintético para los tests de los exportadores:
 * las cifras que se quieren probar, y lo demás con valores neutros. No es un
 * `.test.ts`: vitest no lo ejecuta, `typecheck` sí lo compila.
 */
export type ParcheDeInforme = Partial<Omit<SavingsReport, "calls" | "tokens" | "cache" | "cost">> & {
  calls?: Partial<SavingsReport["calls"]>;
  tokens?: Partial<SavingsReport["tokens"]>;
  cache?: Partial<SavingsReport["cache"]>;
  cost?: Partial<SavingsReport["cost"]>;
};

let secuencia = 0;

export function informeSintetico(p: ParcheDeInforme = {}): SavingsReport {
  secuencia += 1;
  const { calls, tokens, cache, cost, ...resto } = p;
  return {
    requestId: `req-sint-${secuencia}`,
    model: "openai/gpt-4o-mini",
    calls: {
      baselineLlm: 1,
      actualLlm: 1,
      avoidedLlm: 0,
      baselineRetrieval: 0,
      actualRetrieval: 0,
      baselineTools: 0,
      actualTools: 0,
      retries: 0,
      ...calls,
    },
    tokens: {
      baselineInput: 100,
      actualInput: 100,
      eliminatedInput: 0,
      compressedInput: 0,
      baselineOutput: 20,
      actualOutput: 20,
      eliminatedOutput: 0,
      ...tokens,
    },
    cache: { result: "miss", ...cache },
    routing: { executionClass: "NO_RETRIEVAL", confidence: 0.5, rounds: 0 },
    serialization: { chosen: "json-compact", candidateTokens: {}, instructionOverheadTokens: 0 },
    constraints: { backend: "none", schemaVersion: "none", structurallyValid: true },
    quality: {},
    cost: {
      baselineEstimate: 0.001,
      actual: 0.001,
      netSavingsRatio: 0,
      basis: "measured",
      ...cost,
      // El importe se deriva de lo que el test fije, salvo que lo fije él: así
      // un informe sintético cuadra como uno real.
      netSavingsUsd:
        cost?.netSavingsUsd ??
        Math.round(((cost?.baselineEstimate ?? 0.001) - (cost?.actual ?? 0.001)) * 1e10) / 1e10,
    },
    latencyMs: { total: 5, preprocessing: 1, provider: 4 },
    traces: [],
    ...resto,
  };
}
