import { describe, it, expect } from "vitest";
import { createSavingsLayer, DEFAULT_COST_MODEL, OpenAICompatibleProvider } from "../src/index.js";
import type { SavingsLayerConfig, SavingsResult } from "../src/index.js";

/**
 * N5 (auditoría del 2026-11-19) · UN PRECIO DE EJEMPLO NO ES DINERO MEDIDO.
 *
 * Un modelo sin fila en el catálogo (el más nuevo de un proveedor, un id de
 * pasarela con «:free», un modelo local) se tarifaba con el precio ilustrativo
 * —0,0005/0,0015 por 1K, hasta veinte veces por debajo del real— y el informe
 * salía `basis: "measured"`: «dinero real, comprobable contra la factura». Los
 * tokens sí los midió el proveedor; los dólares no. Ahora sale `estimated` y la
 * traza lo dice. Con un precio declarado por el cliente, sigue `measured`.
 * Servidor simulado; modelos y textos inventados.
 */

const PREGUNTA = [{ role: "user" as const, content: "Explica en una línea qué es un índice de base de datos." }];

function capa(config: Partial<SavingsLayerConfig> = {}) {
  const estado = { llamadas: 0 };
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
    estado.llamadas += 1;
    const cuerpo = JSON.parse(String(init?.body)) as { model: string };
    return new Response(
      JSON.stringify({
        model: cuerpo.model,
        choices: [{ index: 0, message: { role: "assistant", content: "Una estructura que acelera las búsquedas." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 120, completion_tokens: 18, total_tokens: 138 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  const layer = createSavingsLayer({
    provider: new OpenAICompatibleProvider({ baseUrl: "https://pasarela.test/v1", apiKey: "k-inventada", fetchImpl }),
    silenceWarnings: true,
    ...config,
  });
  return { layer, estado };
}

const trazaDePrecio = (r: SavingsResult<unknown>) => r.report.traces.find((t) => t.stage === "price");

describe("⛔ sin precio declarado ni fila de catálogo, el coste no sale «measured»", () => {
  it.each([
    "acme/modelo-inventado-9000",
    "modelo-sin-prefijo",
    "llama3.2",
    "openai/gpt-4o-mini:free", // N4: la variante no hereda la fila de gpt-4o-mini
    "google/gemini-2.5-flash-lite", // N4: no hereda la de gemini-2.5-flash
    "anthropic/claude-fable-5-2", // sin fila propia: no hereda la de claude-fable-5
    "deepseek/deepseek-chat",
  ])("«%s»: basis estimated y la traza dice que el precio es ilustrativo", async (model) => {
    const { layer } = capa();
    const r = await layer.generate({ model, messages: PREGUNTA });
    expect(r.report.cache.result).toBe("miss");
    expect(r.report.cost.basis).not.toBe("measured");
    expect(r.report.cost.basis).toBe("estimated");
    expect(trazaDePrecio(r)?.detail).toEqual({ priceSource: "illustrative", model });
    // Los tokens siguen siendo los del contador del proveedor.
    expect(r.report.tokens.actualInput).toBe(120);
    expect(r.report.tokens.actualOutput).toBe(18);
  });

  it("su repetición desde caché tampoco es dinero medido ni por referencia", async () => {
    const { layer, estado } = capa();
    const peticion = { model: "acme/modelo-inventado-9000", messages: PREGUNTA, temperature: 0 };
    await layer.generate(peticion);
    const repetida = await layer.generate(peticion);
    expect(estado.llamadas).toBe(1);
    expect(repetida.report.cache.result).toBe("exact");
    expect(repetida.report.cost.basis).toBe("estimated");
  });
});

describe("lo que funciona no se rompe: con precio, sigue «measured»", () => {
  it("un modelo del catálogo", async () => {
    const { layer } = capa();
    const r = await layer.generate({ model: "openai/gpt-4o-mini", messages: PREGUNTA });
    expect(r.report.cost.basis).toBe("measured");
    expect(trazaDePrecio(r)).toBeUndefined();
  });

  it("un modelo fuera de catálogo con su precio en costModels", async () => {
    const { layer } = capa({ costModels: { "modelo-inventado-9000": { inputPer1k: 0.002, outputPer1k: 0.006 } } });
    const r = await layer.generate({ model: "acme/modelo-inventado-9000", messages: PREGUNTA });
    expect(r.report.cost.basis).toBe("measured");
    expect(trazaDePrecio(r)).toBeUndefined();
  });

  it("un id con «:free» con su precio en costModels", async () => {
    const { layer } = capa({ costModels: { "openai/gpt-4o-mini:free": { inputPer1k: 0, outputPer1k: 0 } } });
    const r = await layer.generate({ model: "openai/gpt-4o-mini:free", messages: PREGUNTA });
    expect(r.report.cost.basis).toBe("measured");
    expect(r.report.cost.actual).toBe(0);
  });

  it("con defaultCostModel declarado (aunque lleve las cifras del ejemplo): el cliente lo ha dicho", async () => {
    for (const defaultCostModel of [{ inputPer1k: 0.001, outputPer1k: 0.002 }, DEFAULT_COST_MODEL]) {
      const { layer } = capa({ defaultCostModel });
      const r = await layer.generate({ model: "acme/modelo-inventado-9000", messages: PREGUNTA });
      expect(r.report.cost.basis).toBe("measured");
      expect(trazaDePrecio(r)).toBeUndefined();
    }
  });
});
