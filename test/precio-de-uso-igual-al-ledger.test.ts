import { describe, it, expect } from "vitest";

import { CATALOGO } from "../src/pricing/catalogo.js";
import { SavingsLedger, type CostModel } from "../src/tokenizer/accounting.js";
import { precioDelUso } from "../src/verification/precio.js";
import { mulberry32 } from "../benchmarks/stats.js";

/**
 * EL PRECIO DE LA COPIA ES LA MISMA ARITMÉTICA QUE EL `actual` DEL INFORME.
 * Los dos lados de un par tienen que tarifarse con la misma regla, o la
 * diferencia media mediría la diferencia entre dos fórmulas. Se comprueba bit a
 * bit contra `SavingsLedger.estimateCost(model).actual` de un ledger medido
 * equivalente (una llamada, sin prima de escritura ni coste extra), en 500
 * casos con semilla sobre TODO el catálogo.
 */
function filas(): Array<[string, CostModel]> {
  const out: Array<[string, CostModel]> = [];
  for (const [id, fila] of Object.entries(CATALOGO as Record<string, unknown>)) {
    const f = fila as Partial<CostModel>;
    if (typeof f?.inputPer1k === "number" && typeof f?.outputPer1k === "number") {
      out.push([id, { inputPer1k: f.inputPer1k, outputPer1k: f.outputPer1k, ...(f.cachedInputPer1k !== undefined ? { cachedInputPer1k: f.cachedInputPer1k } : {}) }]);
    }
  }
  return out;
}

describe("precioDelUso = estimateCost(model).actual", () => {
  const catalogo = filas();

  it("el catálogo tiene filas", () => {
    expect(catalogo.length).toBeGreaterThan(10);
  });

  it("500 casos con semilla, bit a bit", () => {
    const rng = mulberry32(20260925);
    for (let i = 0; i < 500; i++) {
      const [id, precio] = catalogo[i % catalogo.length]!;
      const entrada = Math.floor(rng() * 200_000);
      const salida = Math.floor(rng() * 16_000);
      // A veces más cacheados que entrada (el min tiene que igualarlos).
      const cached = rng() < 0.3 ? 0 : Math.floor(rng() * entrada * 1.2);
      const ledger = new SavingsLedger();
      ledger.actualLlm = 1;
      ledger.actualInput = entrada;
      ledger.actualOutput = salida;
      ledger.providerCachedInput = cached;
      ledger.sentInputLocal = entrada;
      const esperado = ledger.estimateCost(precio).actual;
      expect(precioDelUso({ inputTokens: entrada, outputTokens: salida, cachedInputTokens: cached }, precio), `${id} #${i}`).toBe(esperado);
    }
  });
});
