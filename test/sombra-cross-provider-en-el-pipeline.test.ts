import { describe, expect, it } from "vitest";

import { SavingsPipeline } from "../src/pipeline/pipeline.js";
import { TokenizerRegistry } from "../src/tokenizer/registry.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import type { SavingsRequest } from "../src/contracts/types.js";

/**
 * LA SOMBRA CROSS-PROVIDER, en el camino real del pipeline: con
 * `savings.crossProviderShadow: true` y una llamada que corre, el informe
 * publica `report.crossProviderShadow` (basis "shadow") con las alternativas
 * baratas de otros proveedores valoradas al MISMO uso medido. Sin el flag, el
 * campo no existe. Nada se enruta ni se factura.
 */

class Testigo implements Provider {
  readonly id = "testigo";
  async generate(_req: ProviderRequest): Promise<ProviderResponse> {
    return { text: "ok", usage: { inputTokens: 1000, outputTokens: 100 } };
  }
}

function capa(): SavingsPipeline {
  return new SavingsPipeline({ provider: new Testigo(), tokenizer: new TokenizerRegistry(), devUnlicensed: true } as never);
}

function peticion(flag?: boolean): SavingsRequest {
  return {
    model: "anthropic/claude-sonnet-4-5",
    messages: [{ role: "user", content: "¿Cuánto tarda un envío?" }],
    ...(flag !== undefined ? { savings: { crossProviderShadow: flag } } : {}),
  } as SavingsRequest;
}

describe("sombra cross-provider en el pipeline", () => {
  it("con el flag publica el informe de sombra, en ids de catálogo y de más barato a más caro", async () => {
    const r = await capa().generate(peticion(true));
    const s = r.report.crossProviderShadow;
    expect(s).toBeDefined();
    expect(s!.basis).toBe("shadow");
    expect(s!.servido).toBe("claude-sonnet-4-5");
    expect(s!.servidoUsd).toBeGreaterThan(0);
    // Las cuatro alternativas, ordenadas por coste.
    expect(s!.alternativas.map((a) => a.model)).toEqual(["glm-5.3-flash", "qwen3.8-flash", "deepseek-flash", "deepseek-v4-pro"]);
    const costes = s!.alternativas.map((a) => a.listPriceUsd);
    expect([...costes].sort((a, b) => a - b)).toEqual(costes);
    // Todas más baratas que sonnet-4-5 en esta carga.
    for (const a of s!.alternativas) expect(a.ratio).toBeLessThan(1);
  });

  it("sin el flag el campo no existe", async () => {
    const r = await capa().generate(peticion());
    expect(r.report.crossProviderShadow).toBeUndefined();
  });

  it("el dinero de la sombra no toca cost ni la comisión: cost.actual es el medido", async () => {
    const r = await capa().generate(peticion(true));
    // 1000×3/1M + 100×15/1M = 0.0045 USD, medido.
    expect(r.report.cost.actual).toBeCloseTo(0.0045, 10);
    expect(r.report.cost.basis).toBe("measured");
  });
});
