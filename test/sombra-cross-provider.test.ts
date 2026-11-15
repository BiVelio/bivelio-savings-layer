import { describe, it, expect } from "vitest";

import { sombraCrossProvider } from "../src/economics/sombra-cross-provider.js";

/**
 * LA SOMBRA CROSS-PROVIDER: lo que el MISMO uso medido costaría en los modelos
 * baratos de otro proveedor, a precios de lista versionados. Aritmética pura,
 * sin red: aquí se fija la cuenta y los casos en que no hay nada que decir.
 */

// Precios de lista del catálogo (USD por 1M), para la cuenta a mano:
//   claude-sonnet-4-5  in 3.00   out 15.00  cached 0.30
//   deepseek-flash     in 0.30   out 1.20   cached 0.003
//   deepseek-v4-pro    in 1.32   out 3.96   cached 0.003
//   qwen3.8-flash      in 0.15   out 0.47   cached 0.015
//   glm-5.3-flash      in ~0.111 out ~0.389 (sin tarifa cacheada)

describe("sombraCrossProvider", () => {
  it("valora el mismo uso en las alternativas, de más barata a más cara", () => {
    const r = sombraCrossProvider("claude-sonnet-4-5", {
      inputTokens: 1000,
      outputTokens: 100,
      servidoUsd: 0.0045, // 1000×3/1M + 100×15/1M
    })!;
    expect(r.basis).toBe("shadow");
    expect(r.servido).toBe("claude-sonnet-4-5");
    expect(r.alternativas.length).toBe(4);
    // Ordenadas por coste.
    const costes = r.alternativas.map((a) => a.listPriceUsd);
    expect([...costes].sort((a, b) => a - b)).toEqual(costes);
    // La más barata: glm-5.3-flash (~0.00015) o qwen3.8-flash (~0.000197).
    expect(r.alternativas[0]!.model).toBe("glm-5.3-flash");
    // El ratio: todas por debajo de 1 (sonnet-4-5 es caro).
    for (const a of r.alternativas) expect(a.ratio).toBeLessThan(1);
    // La cuenta de deepseek-flash: 1000×0.30/1M + 100×1.20/1M = 0.00042.
    const flash = r.alternativas.find((a) => a.model === "deepseek-flash")!;
    expect(flash.listPriceUsd).toBeCloseTo(0.00042, 8);
    expect(flash.ratio).toBeCloseTo(0.00042 / 0.0045, 8);
  });

  it("las lecturas cacheadas van a la tarifa de lectura del modelo alternativo", () => {
    const r = sombraCrossProvider("claude-sonnet-4-5", {
      inputTokens: 4000,
      cachedInputTokens: 3000,
      outputTokens: 100,
      servidoUsd: 0.005,
    })!;
    const flash = r.alternativas.find((a) => a.model === "deepseek-flash")!;
    // 1000×0.30/1M + 3000×0.003/1M + 100×1.20/1M = 0.0003 + 0.000009 + 0.00012.
    expect(flash.listPriceUsd).toBeCloseTo(0.000429, 8);
  });

  it("sin coste servido no hay denominador: null", () => {
    expect(
      sombraCrossProvider("claude-sonnet-4-5", { inputTokens: 10, outputTokens: 1, servidoUsd: 0 }),
    ).toBeNull();
  });

  it("si el servido ES una alternativa, no se compara contra sí mismo", () => {
    const r = sombraCrossProvider("deepseek-flash", {
      inputTokens: 1000,
      outputTokens: 100,
      servidoUsd: 0.00042,
    })!;
    expect(r.alternativas.some((a) => a.model === "deepseek-flash")).toBe(false);
    expect(r.alternativas.length).toBe(3);
  });

  it("un uso absurdo (negativos) no produce informe", () => {
    expect(
      sombraCrossProvider("claude-sonnet-4-5", { inputTokens: -1, outputTokens: 1, servidoUsd: 1 }),
    ).toBeNull();
  });

  it("es determinista: misma entrada, misma salida", () => {
    const uso = { inputTokens: 1000, outputTokens: 100, servidoUsd: 0.0045 };
    expect(sombraCrossProvider("claude-sonnet-4-5", uso)).toEqual(sombraCrossProvider("claude-sonnet-4-5", uso));
  });
});
