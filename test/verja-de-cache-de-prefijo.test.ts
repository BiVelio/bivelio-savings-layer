import { describe, it, expect } from "vitest";

import {
  costeEsperado,
  ANTHROPIC_CACHE_TIER,
  OPENAI_CACHE_TIER,
} from "../src/economics/cache-tier.js";
import {
  umbralDeMarcado,
  VerjaDeCacheDePrefijo,
} from "../src/economics/prefix-cache-gate.js";

/**
 * LA VERJA QUE IMPIDE PERDER DINERO MARCANDO LA CACHÉ.
 *
 * Marcar no es gratis: la escritura lleva prima. Con lectura a 0,10x y escritura
 * a 1,25x, marcar compensa sólo si la tasa de aciertos h cumple
 *
 *     h·0,10 + (1−h)·1,25 < 1   =>   h > 0,25/1,15 = 0,217391…
 *
 * Los tests de abajo no dan esa cifra por buena: la COMPRUEBAN contra
 * `costeEsperado`, que es quien de verdad tarifa. Una constante que sólo se
 * compara consigo misma no prueba nada.
 */

const T = 4000; // tokens del prompt entero
const P = 3000; // tokens del prefijo estable

describe("el punto de equilibrio de marcar la caché", () => {
  it("está en 21,74%, y se comprueba contra el tarifador, no contra sí mismo", () => {
    const h = umbralDeMarcado({
      totalTokens: T,
      stablePrefixTokens: P,
      tier: ANTHROPIC_CACHE_TIER,
    })!;
    expect(h).toBeCloseTo(0.25 / 1.15, 6);
    expect(h).toBeCloseTo(0.2174, 4);

    // JUSTO POR DEBAJO marcar sale MÁS CARO que no marcar; justo por encima,
    // más barato. `costeEsperado(total, prefijo, h, tier)` es marcar;
    // `totalTokens` a secas es no marcar (todo a precio lleno).
    expect(costeEsperado(T, P, h - 0.01, ANTHROPIC_CACHE_TIER)).toBeGreaterThan(T);
    expect(costeEsperado(T, P, h + 0.01, ANTHROPIC_CACHE_TIER)).toBeLessThan(T);
    expect(costeEsperado(T, P, h, ANTHROPIC_CACHE_TIER)).toBeCloseTo(T, 6);
  });

  it("con 0% de aciertos marcar cuesta un 25% más del prefijo", () => {
    // La prima de escritura, desnuda: 3000 tokens escritos a 1,25x = 750 de más.
    expect(costeEsperado(T, P, 0, ANTHROPIC_CACHE_TIER) - T).toBeCloseTo(0.25 * P, 6);
  });

  it("sin prima de escritura no hay umbral: marcar no puede perder", () => {
    // OpenAI cobra la escritura a 1x. Ahí la verja no tiene nada que vigilar.
    expect(
      umbralDeMarcado({ totalTokens: T, stablePrefixTokens: P, tier: OPENAI_CACHE_TIER }),
    ).toBeNull();
  });

  it("por debajo del mínimo de tramo tampoco hay umbral: marcar no hace nada", () => {
    expect(
      umbralDeMarcado({ totalTokens: 500, stablePrefixTokens: 400, tier: ANTHROPIC_CACHE_TIER }),
    ).toBeNull();
  });
});

describe("la verja mide antes de juzgar", () => {
  const ENTRADA = { totalTokens: T, stablePrefixTokens: P, tier: ANTHROPIC_CACHE_TIER };

  it("explora un número ACOTADO de peticiones, porque h no se puede saber sin marcar", () => {
    const verja = new VerjaDeCacheDePrefijo({ exploracion: 3 });
    for (let i = 0; i < 3; i++) {
      expect(verja.decidir("h1", ENTRADA).marcar).toBe(true);
      // El proveedor no acierta NUNCA: sólo escribe.
      verja.registrar("h1", { cacheWriteInputTokens: P });
    }
    // Con la medición hecha, la verja se apaga: seguir marcando sería pagar la
    // prima a cambio de nada, en cada petición, para siempre.
    const d = verja.decidir("h1", ENTRADA);
    expect(d.marcar).toBe(false);
    expect(d.observada).toBe(0);
    expect(d.razon).toMatch(/did not reach/);
  });

  it("el coste máximo de esa exploración está acotado y se puede publicar", () => {
    const verja = new VerjaDeCacheDePrefijo({ exploracion: 8 });
    // 8 escrituras a 0,25 de prima sobre 3000 tokens de prefijo.
    expect(verja.costeDeExploracion(P, ANTHROPIC_CACHE_TIER)).toBeCloseTo(8 * 0.25 * P, 6);
    // Con OpenAI explorar es gratis: no hay prima que pagar.
    expect(verja.costeDeExploracion(P, OPENAI_CACHE_TIER)).toBe(0);
  });

  it("con aciertos POR ENCIMA del equilibrio sigue marcando", () => {
    const verja = new VerjaDeCacheDePrefijo({ exploracion: 2 });
    verja.decidir("h2", ENTRADA);
    verja.registrar("h2", { cacheWriteInputTokens: P });
    verja.decidir("h2", ENTRADA);
    // 3 lecturas por 1 escritura = 75% de aciertos, muy por encima del 21,7%.
    verja.registrar("h2", { cachedInputTokens: P * 3 });

    const d = verja.decidir("h2", ENTRADA);
    expect(d.marcar).toBe(true);
    expect(d.observada).toBeCloseTo(0.75, 6);
  });

  it("con aciertos POR DEBAJO del equilibrio deja de marcar", () => {
    const verja = new VerjaDeCacheDePrefijo({ exploracion: 2 });
    verja.decidir("h3", ENTRADA);
    verja.registrar("h3", { cacheWriteInputTokens: 900 });
    verja.decidir("h3", ENTRADA);
    verja.registrar("h3", { cachedInputTokens: 100 }); // 100/1000 = 10%

    const d = verja.decidir("h3", ENTRADA);
    expect(d.observada).toBeCloseTo(0.1, 6);
    expect(d.observada!).toBeLessThan(d.umbral!);
    expect(d.marcar).toBe(false);
  });

  it("la tasa se mide en TOKENS, no en peticiones", () => {
    const verja = new VerjaDeCacheDePrefijo({ exploracion: 1 });
    verja.decidir("h4", ENTRADA);
    // «Acertó algo» en las dos peticiones -> contando PETICIONES daría 100%.
    // Pero sólo 10 de 1010 tokens se sirvieron baratos: 1%, muy por debajo del
    // equilibrio. Lo que decide el dinero es la fracción de TOKENS.
    verja.registrar("h4", { cachedInputTokens: 10, cacheWriteInputTokens: 1000 });
    const d = verja.decidir("h4", ENTRADA);
    expect(d.observada).toBeCloseTo(10 / 1010, 6);
    expect(d.marcar).toBe(false);
  });

  it("sin prefijo estable no se marca, por bueno que sea el tramo", () => {
    const verja = new VerjaDeCacheDePrefijo();
    const d = verja.decidir("h5", { ...ENTRADA, stablePrefixTokens: 0 });
    expect(d.marcar).toBe(false);
    expect(d.razon).toMatch(/no stable prefix/);
  });

  it("cada prefijo aprende por su cuenta", () => {
    const verja = new VerjaDeCacheDePrefijo({ exploracion: 1 });
    verja.decidir("bueno", ENTRADA);
    verja.registrar("bueno", { cachedInputTokens: 1000 });
    verja.decidir("malo", ENTRADA);
    verja.registrar("malo", { cacheWriteInputTokens: 1000 });

    // Un prefijo que no acierta no puede apagar el de al lado: son tráficos
    // distintos y el dinero de cada uno se decide por separado.
    expect(verja.decidir("bueno", ENTRADA).marcar).toBe(true);
    expect(verja.decidir("malo", ENTRADA).marcar).toBe(false);
  });

  it("una vez apagada se queda apagada, sin volver a pagar la exploración", () => {
    const verja = new VerjaDeCacheDePrefijo({ exploracion: 1 });
    verja.decidir("h6", ENTRADA);
    verja.registrar("h6", { cacheWriteInputTokens: 1000 });
    expect(verja.decidir("h6", ENTRADA).marcar).toBe(false);
    for (let i = 0; i < 20; i++) {
      expect(verja.decidir("h6", ENTRADA).marcar).toBe(false);
    }
  });
});
