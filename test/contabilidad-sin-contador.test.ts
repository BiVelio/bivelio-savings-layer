import { describe, it, expect } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import { SavingsLedger } from "../src/tokenizer/accounting.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";

/**
 * UNA LLAMADA FACTURADA SIN SU CONTADOR SACA LA PETICIÓN ENTERA DE `measured`.
 *
 * El hueco que esto cierra: una primaria sin usage (un stream cortado antes del
 * evento final, un gateway que omite un contador) seguida de una reparación que
 * sí lo trae dejaba en el ledger los tokens de la SEGUNDA como si fueran toda
 * la petición, y `estimateCost` la publicaba `measured`. Medido, sí; pero medido
 * a medias, que es otra cosa. El principio es «ahorro medido con el contador del
 * proveedor, nunca una estimación», y un contador que falta no es el suyo.
 */

const esquema = {
  type: "object" as const,
  properties: { answer: { type: "number" as const } },
  required: ["answer"],
  additionalProperties: false,
};

describe("SavingsLedger.callsWithoutUsage", () => {
  it("cualquier llamada sin contador → unmeasured y netSavings ≤ 0", () => {
    const l = new SavingsLedger();
    l.actualLlm = 1;
    l.actualInput = 100;
    l.actualOutput = 10;
    l.sentInputLocal = 80;
    l.removedInputLocal = 0;
    l.callsWithoutUsage = 1;
    const c = l.estimateCost({ inputPer1k: 0.001, outputPer1k: 0.002 });
    expect(c.basis).toBe("unmeasured");
    expect(c.netSavingsRatio).toBeLessThanOrEqual(0);
    expect(l.baselineInput).toBe(0);
  });

  it("es la PRIMERA comprobación: gana aunque hubiera algo quitado que acreditar", () => {
    const l = new SavingsLedger();
    l.actualLlm = 1;
    l.actualInput = 100;
    l.sentInputLocal = 80;
    l.removedInputLocal = 500;
    l.estimatorExact = true;
    l.callsWithoutUsage = 2;
    const c = l.estimateCost({ inputPer1k: 0.001, outputPer1k: 0.002 });
    expect(c.basis).toBe("unmeasured");
    expect(c.netSavingsRatio).toBeLessThanOrEqual(0);
  });

  it("no toca las llamadas evitadas (su baseline es el estimado de siempre)", () => {
    const l = new SavingsLedger();
    l.avoidCall(100, 20);
    l.callsWithoutUsage = 1;
    expect(l.estimateCost({ inputPer1k: 0.001, outputPer1k: 0.002 }).basis).toBe("estimated");
  });
});

/** Devuelve, por orden, las respuestas que se le den. */
class ProveedorGuion implements Provider {
  readonly id = "guion";
  llamadas = 0;
  constructor(private readonly guion: ProviderResponse[]) {}
  async generate(_r: ProviderRequest): Promise<ProviderResponse> {
    const r = this.guion[Math.min(this.llamadas, this.guion.length - 1)]!;
    this.llamadas += 1;
    return r;
  }
}

describe("a través de la capa", () => {
  it("primaria SIN contador + reparación CON contador → unmeasured, y las dos llamadas contadas", async () => {
    const provider = new ProveedorGuion([
      { text: "not json", usage: { inputTokens: 0, outputTokens: 0, complete: false } },
      { text: '{"answer":8}', usage: { inputTokens: 50, outputTokens: 5 } },
    ]);
    const layer = createSavingsLayer({ provider, devUnlicensed: true });
    const r = await layer.generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "dame un número de la suerte para hoy" }],
      response: { contractId: "respuesta", schema: esquema },
    });
    expect(provider.llamadas).toBe(2);
    expect(r.report.calls.actualLlm).toBe(2);
    expect(r.report.cost.basis).toBe("unmeasured");
    expect(r.report.cost.netSavingsRatio).toBeLessThanOrEqual(0);
  });

  it("OpenAICompatibleProvider.generate() con usage parcial → unmeasured (antes salía measured)", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "hola" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const provider = new OpenAICompatibleProvider({ baseUrl: "https://example.test/v1", fetchImpl });
    const layer = createSavingsLayer({ provider, devUnlicensed: true });
    const r = await layer.generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "hola" }],
    });
    expect(r.report.cost.basis).toBe("unmeasured");
    expect(r.report.cost.netSavingsRatio).toBeLessThanOrEqual(0);
  });

  it("regresión: un proveedor sin campo `complete` sigue saliendo measured cuando no se quita nada", async () => {
    const provider = new ProveedorGuion([{ text: "respuesta", usage: { inputTokens: 50, outputTokens: 10 } }]);
    const layer = createSavingsLayer({ provider, devUnlicensed: true });
    const r = await layer.generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "en qué año se firmó el tratado de Utrecht" }],
    });
    expect(r.report.cost.basis).toBe("measured");
    expect(r.report.cost.netSavingsRatio).toBe(0);
  });

  it("el camino de fail-open tampoco llama medido a un contador que falta", async () => {
    const provider = new ProveedorGuion([
      { text: "respuesta", usage: { inputTokens: 0, outputTokens: 0, complete: false } },
    ]);
    const layer = createSavingsLayer({
      provider,
      devUnlicensed: true,
      exactCache: {
        get() {
          throw new Error("boom: fallo interno del optimizador");
        },
        async set() {},
        async delete() {},
      },
    });
    const r = await layer.generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "hola" }],
    });
    expect(r.report.traces.some((t) => t.stage === "fail-open")).toBe(true);
    expect(r.report.cost.basis).toBe("unmeasured");
  });
});
