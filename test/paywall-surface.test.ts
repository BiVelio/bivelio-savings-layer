import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import { SavingsPipeline } from "../src/pipeline/pipeline.js";
import { defaultTokenizerRegistry } from "../src/tokenizer/registry.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";

/**
 * La auditoría de publicación encontró DOS vías de saltarse el pago más fáciles
 * que las ya cerradas (ni siquiera hacía falta firmar un token):
 *
 *   A1 — createSavingsLayer({ provider, licenseGate: { isActive: () => true } })
 *        El gate inyectado tenía precedencia y cruzaba el paywall.
 *   A2 — layer.pipeline.generateOptimized(req) corría el optimizador entero sin
 *        pasar por assertLicensed(); `layer.pipeline` y `SavingsPipeline` eran
 *        superficie pública.
 *
 * Estos tests corren desde el FUENTE, donde no hay build publicado (la bandera
 * es undefined). Por eso se comprueban las dos capas que valen en cualquier
 * build: que `layer.pipeline` no existe, que generateOptimized gatea, y que el
 * gate inyectado SÍ se respeta en fuente (los tests lo necesitan). La verja del
 * build publicado —descartar el gate inyectado— se cubre construyendo dist/ y
 * ejecutándolo; aquí se documenta el contrato.
 */

const provider: Provider = {
  id: "p",
  async generate(_r: ProviderRequest): Promise<ProviderResponse> {
    return { text: "ok", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5 } };
  },
};
const req = { model: "m", messages: [{ role: "user" as const, content: "hola" }] };

describe("A2 · superficie del pipeline", () => {
  it("layer.pipeline ya NO se expone en el handle público", () => {
    const layer = createSavingsLayer({ provider, devUnlicensed: true });
    expect((layer as unknown as { pipeline?: unknown }).pipeline).toBeUndefined();
  });

  it("generateOptimized gatea la licencia (defensa en profundidad)", async () => {
    // Aunque alguien alcance una instancia del pipeline por otra vía, sin
    // licencia no corre. El entorno de test corre dev-open (vitest.config.ts);
    // se apaga aquí para comprobar la denegación real, y se restaura.
    const guardado = process.env.BVSALA_DEV_OPEN;
    delete process.env.BVSALA_DEV_OPEN;
    const pipeline = new SavingsPipeline({ provider, tokenizer: defaultTokenizerRegistry });
    await expect(
      (pipeline as unknown as { generateOptimized: (r: unknown) => Promise<unknown> })
        .generateOptimized(req),
    ).rejects.toThrow(/license/i);
    if (guardado !== undefined) process.env.BVSALA_DEV_OPEN = guardado;
  });

  it("con dev-open, generateOptimized sí corre (sin regresión)", async () => {
    const pipeline = new SavingsPipeline({ provider, tokenizer: defaultTokenizerRegistry, devUnlicensed: true });
    const r = await (pipeline as unknown as { generateOptimized: (r: unknown) => Promise<{ text: string }> })
      .generateOptimized(req);
    expect(r.text).toBe("ok");
  });
});

describe("A1 · gate inyectado", () => {
  it("desde el FUENTE, un licenseGate inyectado se respeta (lo usan los tests)", async () => {
    // La verja que lo DESCARTA solo actúa en el build publicado
    // (__BV_SALA_ALLOW_DEV_OPEN__ === false). En fuente es undefined, así que el
    // gate se honra — que es como toda la suite monta escenarios de licencia.
    const layer = createSavingsLayer({
      provider,
      licenseGate: { isActive: () => true, isEntitled: () => true },
    });
    const r = await layer.generate(req);
    expect(r.text).toBe("ok");
  });
});
