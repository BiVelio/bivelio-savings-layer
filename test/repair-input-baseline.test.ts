import { describe, it, expect } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import type { SavingsRequest } from "../src/contracts/types.js";

/**
 * El reintento de reparación es coste NUESTRO, no del cliente.
 *
 * Para la SALIDA ya existía la corrección (`repairOutput` → `baselineOutputHonesto`).
 * Para la ENTRADA no había nada: el baseline de una llamada ejecutada se
 * reconstruye desde `actualInput`, que ya acumula las DOS llamadas, así que el
 * reintento se pagaba a sí mismo y una PÉRDIDA se publicaba como AHORRO. Y con
 * `basis` de cara al panel, que es donde el cliente lo contrasta con su factura.
 *
 * Aquí se comprueba lo único que importa de verdad: cuando la capa gasta MÁS que
 * el camino naive, el informe tiene que decirlo con signo negativo.
 */

/** Devuelve JSON inválido la primera vez para forzar la reparación, válido la segunda. */
class ProveedorQueObligaAReparar implements Provider {
  readonly id = "repara";
  llamadas = 0;
  async generate(_r: ProviderRequest): Promise<ProviderResponse> {
    this.llamadas += 1;
    if (this.llamadas === 1) {
      // No parsea → dispara la etapa de reparación.
      return { text: "{oops not json", usage: { inputTokens: 500, outputTokens: 200 } };
    }
    return { text: '{"answer":"ok"}', usage: { inputTokens: 520, outputTokens: 40 } };
  }
}

const peticion = (): SavingsRequest => ({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "Devuelve la respuesta en el formato pedido." }],
  response: {
    contractId: "c1",
    version: "v1",
    schema: {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    },
  },
  savings: { exactCache: false },
});

describe("la entrada del reintento de reparación no engorda el baseline", () => {
  it("una petición que costó DOS llamadas no se publica como ahorro", async () => {
    const proveedor = new ProveedorQueObligaAReparar();
    const capa = createSavingsLayer({
      provider: proveedor,
      costModels: { "openai/gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 } },
    });

    const res = await capa.generate(peticion());

    // Se ejecutaron de verdad las dos llamadas (original + reparación).
    expect(proveedor.llamadas).toBe(2);
    expect(res.report.calls.actualLlm).toBe(2);

    // EL DEFECTO: con la entrada del reintento dentro del baseline, esto salía
    // POSITIVO. La capa gastó más que el camino naive, así que el ahorro tiene
    // que ser negativo — un cliente no puede leer una pérdida como una ganancia.
    expect(res.report.cost.netSavingsRatio).toBeLessThan(0);
  });

  it("el baseline de entrada no incluye la llamada de reparación", async () => {
    const proveedor = new ProveedorQueObligaAReparar();
    const capa = createSavingsLayer({
      provider: proveedor,
      costModels: { "openai/gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 } },
    });
    const res = await capa.generate(peticion());

    // actualInput suma las dos llamadas (500 + 520 = 1020). El baseline debe
    // quedarse por debajo: representa lo que habría costado SIN la capa, y el
    // reintento no existe en ese mundo.
    expect(res.report.tokens.actualInput).toBe(1020);
    expect(res.report.tokens.baselineInput).toBeLessThan(1020);
  });

  it("sin reparación, el baseline no cambia de comportamiento", async () => {
    class Limpio implements Provider {
      readonly id = "limpio";
      async generate(): Promise<ProviderResponse> {
        return { text: '{"answer":"ok"}', usage: { inputTokens: 500, outputTokens: 40 } };
      }
    }
    const capa = createSavingsLayer({
      provider: new Limpio(),
      costModels: { "openai/gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 } },
    });
    const res = await capa.generate(peticion());
    expect(res.report.calls.actualLlm).toBe(1);
    expect(res.report.tokens.baselineInput).toBeGreaterThanOrEqual(500);
  });
});
