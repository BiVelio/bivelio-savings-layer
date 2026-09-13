import { describe, it, expect } from "vitest";
import { createSavingsLayer } from "../src/pipeline/create.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";

/**
 * La línea base de recuperación es lo que el camino ingenuo habría hecho. Sin
 * retriever configurado no hay recuperación posible, así que no puede haber
 * rondas «evitadas»: publicar `route.rounds` como baseline inventaba un ahorro
 * de recuperación en instalaciones que jamás recuperan nada (hallazgo «medio»
 * de la auditoría de agosto, CIERRE.md § 2.3).
 */
class ProveedorFijo implements Provider {
  readonly id = "fijo";
  async generate(_r: ProviderRequest): Promise<ProviderResponse> {
    return { text: "La capital de Francia es París.", usage: { inputTokens: 40, outputTokens: 12 } };
  }
}

describe("baselineRetrieval sin retriever", () => {
  it("una pregunta factual sin retriever configurado publica 0 rondas de línea base y 0 reales", async () => {
    const capa = createSavingsLayer({
      provider: new ProveedorFijo(),
      costModels: { "openai/gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 } },
    });
    const { report } = await capa.generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "¿Cuál es la capital de Francia según el informe anual de 2025 de la OCDE?" }],
      savings: { exactCache: false },
    });
    expect(report.calls.baselineRetrieval).toBe(0);
    expect(report.calls.actualRetrieval).toBe(0);
  });
});
