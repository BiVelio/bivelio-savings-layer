import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SavingsLayerConfig } from "../src/pipeline/config.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";

const registrar = vi.hoisted(() => vi.fn());

vi.mock("../src/tokenizer/exact.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/tokenizer/exact.js")>();
  return { ...real, registerExactTokenizer: registrar };
});

class Proveedor implements Provider {
  readonly id = "mock";
  readonly llamadas: string[] = [];

  async generate(req: ProviderRequest): Promise<ProviderResponse> {
    this.llamadas.push(req.model);
    return {
      text: '{"answer":"ok"}',
      usage: { inputTokens: 10, outputTokens: 1 },
      finishReason: "stop",
    };
  }
}

let crearCapa: typeof import("../src/pipeline/create.js").createSavingsLayer;

beforeEach(async () => {
  vi.resetModules();
  registrar.mockReset();
  ({ createSavingsLayer: crearCapa } = await import("../src/pipeline/create.js"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

function capa(provider: Provider, extra: Partial<SavingsLayerConfig> = {}) {
  return crearCapa({ provider, devUnlicensed: true, silenceWarnings: true, ...extra });
}

const peticion = (model = "openai/gpt-4o-mini") => ({
  model,
  messages: [{ role: "user" as const, content: "hola" }],
});

describe("carga selectiva del tokenizador exacto", () => {
  it("no invoca al cargador cuando el modelo no lo necesita o está desactivado", async () => {
    registrar.mockImplementation(() => new Promise<boolean>(() => {}));
    const provider = new Proveedor();
    const anthropic = capa(provider);
    await anthropic.generate(peticion("anthropic/claude-sonnet-5"));
    await anthropic.close();

    const desactivado = capa(provider, { exactTokenizer: false });
    await desactivado.generate(peticion());
    await desactivado.close();

    expect(registrar).not.toHaveBeenCalled();
    expect(provider.llamadas).toHaveLength(2);
  });

  it("OpenAI espera solo o200k_base y comparte la carga con generateStream", async () => {
    let listo!: (value: boolean) => void;
    registrar.mockImplementation(() => new Promise<boolean>((resolve) => { listo = resolve; }));
    const provider = new Proveedor();
    const layer = capa(provider);
    const pendiente = layer.generate(peticion());

    await vi.waitFor(() => expect(registrar).toHaveBeenCalledTimes(1));
    expect(provider.llamadas).toHaveLength(0);
    expect(registrar).toHaveBeenCalledWith(expect.anything(), { codificaciones: ["o200k_base"] });
    listo(true);
    await pendiente;

    const stream = layer.generateStream(peticion());
    await stream.result;
    expect(registrar).toHaveBeenCalledTimes(1);
    await layer.close();
  });

  it("la cascada carga las codificaciones del modelo pedido y del servido", async () => {
    registrar.mockResolvedValue(true);
    const provider = new Proveedor();
    const layer = capa(provider, {
      modelCascade: { pairs: { "gpt-4": "gpt-4o-mini" } },
      costModels: {
        "gpt-4": { inputPer1k: 0.01, outputPer1k: 0.03 },
        "gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 },
      },
    });
    await layer.generate({
      ...peticion("gpt-4"),
      savings: { modelCascade: "on" },
      response: {
        contractId: "answer:v1",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["answer"],
          properties: { answer: { type: "string" } },
        },
      },
    });
    await layer.close();

    expect(provider.llamadas).toEqual(["gpt-4o-mini"]);
    expect(registrar.mock.calls.map((call) => call[1]?.codificaciones).sort()).toEqual([
      ["cl100k_base"],
      ["o200k_base"],
    ]);
  });

  it("un deadline durante una carga lenta no inicia llamadas, ni en generate ni en streaming", async () => {
    registrar.mockImplementation(() => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 30)));
    const provider = new Proveedor();
    const layer = capa(provider);

    const pendiente = layer.generate(peticion(), { requestTimeoutMs: 5 });
    await vi.waitFor(() => expect(registrar).toHaveBeenCalled());
    await expect(pendiente).rejects.toMatchObject({
      code: "REQUEST_TIMEOUT",
      requestSent: false,
    });
    const stream = layer.generateStream(peticion("openai/gpt-4"), { requestTimeoutMs: 5 });
    await expect(stream.result).rejects.toMatchObject({ code: "REQUEST_TIMEOUT", requestSent: false });

    expect(registrar).toHaveBeenCalledTimes(2);
    expect(provider.llamadas).toHaveLength(0);
    await layer.close();
  });
});
