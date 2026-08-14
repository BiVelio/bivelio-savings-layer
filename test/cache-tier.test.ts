import { describe, it, expect } from "vitest";

import {
  decidirCompresion, costeEsperado, equilibrioPrefixHitRate,
  OPENAI_CACHE_TIER, ANTHROPIC_CACHE_TIER, NO_CACHE_TIER,
} from "../src/economics/cache-tier.js";

/**
 * Medido contra el proveedor real, escenario de la tabla de 50 filas, 210
 * ensayos pareados:
 *
 *     naive   1212 tokens  ->  SÍ entra en la caché de prefijo (mínimo 1024)
 *     nuestro  780 tokens  ->  NO, cae por debajo
 *
 *     tokens quitados      35,6%
 *     dinero capturado     18,5%
 *
 * La mitad del ahorro se evaporaba porque nuestra propia compresión nos sacaba
 * del tramo cacheable. Contar tokens eliminados no es contar dinero.
 */

const TABLA = {
  originalTokens: 1212,
  compressedTokens: 780,
  stablePrefixTokens: 512, // lo observado: 42% del prompt del naive se sirvió de caché
  tier: OPENAI_CACHE_TIER,
};

describe("coste esperado con caché de prefijo", () => {
  it("por debajo del mínimo NO se cachea nada, aunque el prefijo sea estable", () => {
    // 780 < 1024: se paga todo a precio lleno por mucho prefijo estable que haya.
    expect(costeEsperado(780, 700, 1.0, OPENAI_CACHE_TIER)).toBe(780);
  });

  it("por encima del mínimo, el prefijo caliente se paga a mitad", () => {
    // 1212 tokens, 512 de prefijo, todos calientes: 700 + 512*0,5 = 956
    expect(costeEsperado(1212, 512, 1.0, OPENAI_CACHE_TIER)).toBeCloseTo(956, 6);
  });

  it("en frío no hay descuento: se paga el prompt entero", () => {
    expect(costeEsperado(1212, 512, 0, OPENAI_CACHE_TIER)).toBeCloseTo(1212, 6);
  });

  it("Anthropic descuenta más al leer pero cobra prima al escribir", () => {
    const caliente = costeEsperado(1212, 512, 1.0, ANTHROPIC_CACHE_TIER);
    const frio = costeEsperado(1212, 512, 0, ANTHROPIC_CACHE_TIER);
    expect(caliente).toBeCloseTo(700 + 512 * 0.1, 6);
    // En frío sale MÁS CARO que no cachear: la prima de escritura es real y hay
    // que contarla, o se promete un ahorro que la primera llamada no da.
    expect(frio).toBeGreaterThan(1212);
  });
});

describe("la verja: comprimir solo si de verdad ahorra dinero", () => {
  it("en OpenAI comprimir sigue ganando, pero MUCHO menos de lo que dicen los tokens", () => {
    // Lo observado: 512 de los 1212 tokens del naive se sirvieron de su caché.
    const d = decidirCompresion({ ...TABLA, prefixHitRate: 1 });
    expect(d.comprimir).toBe(true);
    // 1212 -> 780 son 432 tokens, un 35,6%. Pero el dinero real es 956 -> 780:
    // un 18,4%. La mitad del "ahorro" se lo come la caché que rompemos.
    expect(d.costeSinComprimir).toBeCloseTo(956, 6);
    expect(d.ganancia).toBeCloseTo(176, 6);
    expect(1 - 780 / d.costeSinComprimir).toBeCloseTo(0.184, 3);
  });

  it("en Anthropic, con prefijo caliente, comprimir PIERDE y se bloquea", () => {
    // Lee a 0,1x en vez de 0,5x: el prompt sin comprimir sale más barato que el
    // comprimido. El cliente de alto volumen con prefijo estable —el que más
    // paga— es justo al que peor le iría. Antes se le comprimía igual.
    const d = decidirCompresion({ ...TABLA, prefixHitRate: 1, tier: ANTHROPIC_CACHE_TIER });
    expect(d.comprimir).toBe(false);
    expect(d.razon).toMatch(/drops the prompt out of the cacheable tier/);
    expect(d.costeSinComprimir).toBeCloseTo(751.2, 3);
  });

  it("el punto de equilibrio se calcula, y depende del proveedor", () => {
    // En OpenAI no existe: comprimir gana incluso con el prefijo siempre caliente.
    expect(equilibrioPrefixHitRate(TABLA)).toBeNull();
    // En Anthropic sí, y está muy arriba.
    const h = equilibrioPrefixHitRate({ ...TABLA, tier: ANTHROPIC_CACHE_TIER });
    expect(h).not.toBeNull();
    expect(h!).toBeGreaterThan(0.9);
  });

  it("si la compresión NO saca del tramo, compensa sin reservas", () => {
    // Un prompt enorme que sigue por encima de 1024 tras comprimir.
    const d = decidirCompresion({
      originalTokens: 8000, compressedTokens: 5000, stablePrefixTokens: 1000,
      prefixHitRate: 0.5, tier: OPENAI_CACHE_TIER,
    });
    expect(d.comprimir).toBe(true);
    expect(d.ganancia).toBeGreaterThan(0);
  });

  it("sin caché de proveedor la decisión es la de siempre: menos tokens gana", () => {
    // Sin regresión para proveedores que no cachean.
    const d = decidirCompresion({ ...TABLA, prefixHitRate: 0.9, tier: NO_CACHE_TIER });
    expect(d.comprimir).toBe(true);
    expect(d.ganancia).toBeCloseTo(1212 - 780, 6);
  });

  it("un compresor caro puede anular su propio ahorro", () => {
    const d = decidirCompresion({ ...TABLA, prefixHitRate: 0, compressorCostTokens: 600 });
    expect(d.comprimir).toBe(false);
    expect(d.ganancia).toBeLessThan(0);
  });

  it("un prompt pequeño que nunca cacheó no se ve afectado", () => {
    const d = decidirCompresion({
      originalTokens: 300, compressedTokens: 200, stablePrefixTokens: 100,
      prefixHitRate: 0.9, tier: OPENAI_CACHE_TIER,
    });
    expect(d.comprimir).toBe(true);
    expect(d.ganancia).toBeCloseTo(100, 6);
  });
});
