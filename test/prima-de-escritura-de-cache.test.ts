import { describe, it, expect } from "vitest";

import { SavingsLedger, type CostModel } from "../src/tokenizer/accounting.js";

const BARATO: CostModel = { inputPer1k: 0.001, outputPer1k: 0.005 };
const FUERTE: CostModel = { inputPer1k: 0.015, outputPer1k: 0.075 };

/**
 * LA PRIMA DE ESCRITURA DE CACHÉ SE COBRA, Y SE COBRA AL PRECIO DEL QUE MARCÓ.
 *
 * Anthropic factura las escrituras de caché de prefijo a 1,25x. El recuento
 * entero ya está en `actualInput` a tarifa normal; lo que faltaba era el
 * suplemento (+0,25x), que es un coste que la capa PROVOCA al marcar y que el
 * camino ingenuo nunca pagó. Sin él, una petición marcada en frío publicaba
 * `netSavings 0` con `basis:"measured"` mientras la factura real subía ~12,5 %.
 *
 * Y el segundo test es el que importa de verdad: la prima se guarda en DÓLARES,
 * ya tarifada, no en tokens. `estimateCost` recibe un solo `CostModel` —el del
 * modelo que acabó contestando—, así que guardar tokens los cobraría al precio
 * del FUERTE en cuanto la cascada escala, cuando la marca la puso el BARATO.
 */
describe("prima de escritura de caché", () => {
  it("se cobra a `actual` y nunca al baseline", () => {
    const l = new SavingsLedger();
    l.actualInput = 10_000;
    l.baselineInput = 10_000;
    l.cacheWritePremium(10_000, 1.25, BARATO);

    const c = l.estimateCost(BARATO);
    // 10k tokens a 0,001/1k = 0,01 de base. La prima es 10k × 0,001 × 0,25 = 0,0025.
    expect(l.cacheWritePremiumUsd).toBeCloseTo(0.0025, 10);
    expect(c.actual).toBeCloseTo(0.01 + 0.0025, 10);
    expect(c.baselineEstimate).toBeCloseTo(0.01, 10);
    // Y por tanto el ahorro sale NEGATIVO: marcar costó dinero, y se dice.
    expect(c.netSavingsRatio).toBeLessThan(0);
  });

  it("multiplicador 1 (OpenAI, proveedor desconocido) no cobra nada", () => {
    const l = new SavingsLedger();
    l.actualInput = 10_000;
    l.cacheWritePremium(10_000, 1, BARATO);
    expect(l.cacheWritePremiumUsd).toBe(0);
  });

  it("AL ESCALAR, la prima sigue al precio del BARATO, no al del fuerte", () => {
    // Este es el caso que hundía la cifra. La llamada marcada es la barata —el
    // código no marca la escalada, a propósito—, pero quien acaba contestando es
    // el fuerte, y es SU precio el que llega a `estimateCost`.
    const l = new SavingsLedger();
    l.cacheWritePremium(20_000, 1.25, BARATO);

    // 20k × 0,001 × 0,25 = 0,005. Con el precio del fuerte serían 0,075: 15x.
    expect(l.cacheWritePremiumUsd).toBeCloseTo(0.005, 10);

    // Y tarifar el informe con el fuerte NO cambia la prima ya guardada.
    l.actualInput = 1_000;
    const c = l.estimateCost(FUERTE);
    expect(c.actual).toBeCloseTo((1_000 / 1000) * FUERTE.inputPer1k + 0.005, 10);
    const conElFuerte = (20_000 / 1000) * FUERTE.inputPer1k * 0.25;
    expect(conElFuerte).toBeCloseTo(0.075, 10);
    expect(c.actual).toBeLessThan((1_000 / 1000) * FUERTE.inputPer1k + conElFuerte);
  });

  it("acumula entre marcas y no acepta tokens negativos", () => {
    const l = new SavingsLedger();
    l.cacheWritePremium(1_000, 1.25, BARATO);
    l.cacheWritePremium(1_000, 1.25, BARATO);
    l.cacheWritePremium(-500, 1.25, BARATO);
    expect(l.cacheWriteInputTokens).toBe(2_000);
    expect(l.cacheWritePremiumUsd).toBeCloseTo(2 * (1_000 / 1000) * 0.001 * 0.25, 10);
  });
});
