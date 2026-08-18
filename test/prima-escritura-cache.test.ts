import { describe, it, expect } from "vitest";

import { SavingsLedger } from "../src/tokenizer/accounting.js";

/**
 * La prima de escritura de la caché de prefijo entra en `cost.actual`.
 *
 * POR QUÉ. La capa marca `cache_control` por defecto contra Anthropic, que cobra
 * la ESCRITURA de caché a 1,25x. Ese sobrecoste —que la capa provoca— no se
 * tarifaba: `actualInput` cuenta los tokens de escritura a tarifa normal (1x) y
 * nada añadía el 0,25x que falta. Resultado medido: una petición marcada en frío
 * publicaba `netSavings 0` con `basis:"measured"` cuando la factura real subió
 * ~12,5% (neto verdadero −14%) — rompiendo la promesa de que «measured» se
 * contrasta con la factura.
 */

const SONNET = { inputPer1k: 0.003, outputPer1k: 0.015, cachedInputPer1k: 0.0003 };

/** El escenario exacto de la auditoría: 500 tokens sin cachear + 2000 de
 *  escritura de caché + 200 de salida, marcado en frío contra Anthropic. */
function ledgerMarcadoEnFrio(): SavingsLedger {
  const l = new SavingsLedger();
  l.actualLlm = 1;
  l.actualInput = 2500; // 500 sin cachear + 2000 de escritura
  l.actualOutput = 200;
  l.sentInputLocal = 2500;
  l.removedInputLocal = 0; // la capa no quitó nada: baseline == actual base
  return l;
}

describe("prima de escritura de caché en cost.actual", () => {
  it("con Anthropic (1,25x) la prima entra en actual y el neto se vuelve negativo", () => {
    const l = ledgerMarcadoEnFrio();
    l.cacheWritePremium(2000, 1.25);
    const c = l.estimateCost(SONNET);

    // Factura real: 500·0,003 + 2000·0,00375 + 200·0,015 (por 1k) = 0,012.
    expect(c.actual).toBeCloseTo(0.012, 6);
    // El baseline (sin marcar, reconstruido) es 0,0105: marcar costó dinero.
    expect(c.baselineEstimate).toBeCloseTo(0.0105, 6);
    // netSavings ≈ 1 − 0,012/0,0105 ≈ −0,143. Antes salía 0.
    expect(c.netSavings).toBeCloseTo(-0.143, 2);
    expect(c.netSavings).toBeLessThan(0);
  });

  it("sin prima (multiplicador 1: OpenAI, proveedor desconocido) actual no cambia", () => {
    const conMulti1 = ledgerMarcadoEnFrio();
    conMulti1.cacheWritePremium(2000, 1);
    const sinLlamar = ledgerMarcadoEnFrio();
    expect(conMulti1.estimateCost(SONNET).actual).toBeCloseTo(
      sinLlamar.estimateCost(SONNET).actual,
      6,
    );
  });

  it("la prima escala con los tokens de escritura, no con los de lectura", () => {
    const pocos = ledgerMarcadoEnFrio();
    pocos.cacheWritePremium(500, 1.25);
    const muchos = ledgerMarcadoEnFrio();
    muchos.cacheWritePremium(4000, 1.25);
    expect(muchos.estimateCost(SONNET).actual).toBeGreaterThan(pocos.estimateCost(SONNET).actual);
  });

  it("cascadeAttempt cobra los tokens cacheados del intento barato a tarifa cacheada, no plena", () => {
    const conCache = new SavingsLedger();
    conCache.cascadeAttempt({ inputTokens: 1000, outputTokens: 50, cachedInputTokens: 800 }, SONNET);
    const sinCache = new SavingsLedger();
    sinCache.cascadeAttempt({ inputTokens: 1000, outputTokens: 50 }, SONNET);
    // Con 800 de 1000 tokens servidos de caché (a 0,0003 en vez de 0,003), el
    // intento barato cuesta MENOS que tarifándolo todo a tarifa plena.
    expect(conCache.extraCostUsd).toBeLessThan(sinCache.extraCostUsd);
    // Comprobación exacta: (200·0,003 + 800·0,0003 + 50·0,015)/1000.
    expect(conCache.extraCostUsd).toBeCloseTo((200 * 0.003 + 800 * 0.0003 + 50 * 0.015) / 1000, 8);
  });
});
