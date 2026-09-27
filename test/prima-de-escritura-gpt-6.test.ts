import { describe, it, expect } from "vitest";

import { OpenAICompatibleProvider } from "../src/index.js";
import { CATALOGO } from "../src/pricing/catalogo.js";
import { PRIMA_ESCRITURA_CACHE, primaDeEscritura, primaDeEscrituraAutomatica } from "../src/pricing/primas.js";
import { SavingsLedger, type CostModel } from "../src/tokenizer/accounting.js";
import { SavingsPipeline } from "../src/pipeline/pipeline.js";
import { TokenizerRegistry } from "../src/tokenizer/registry.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import type { SavingsRequest } from "../src/contracts/types.js";
import { costeMedido, mapearUsoChat } from "../gateway/medidor.js";

/**
 * LA ESCRITURA DE CACHÉ A 1,25× EN OPENAI, DE GPT-5.6 EN ADELANTE (FAMILIA 6 INCLUIDA).
 *
 * Fuente: https://developers.openai.com/api/docs/guides/prompt-caching
 * (consultada el 2026-09-27): «For GPT-5.6 and later, cache writes cost 1.25×
 * the standard, uncached input-token rate». La tabla oficial de precios lo
 * confirma con su columna «Cache writes»: gpt-6-luna $0.125 sobre $0.10,
 * gpt-6-sol $2.50 sobre $2, gpt-6-astra $12.50 sobre $10.
 *
 * Antes, `primaDeEscritura` solo reconocía `^gpt-5\.6`: la familia 6 salía a 1×
 * y el gateway medía sus escrituras un 20% por debajo de la factura. Y el SDK
 * ni siquiera leía `cache_write_tokens`.
 */

describe("primaDeEscritura: por versión, no por lista", () => {
  it("1,25× en gpt-5.6+ y toda la familia 6, con o sin prefijo de pasarela", () => {
    for (const m of [
      "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra",
      "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "openai/gpt-6-luna", "GPT-6-SOL",
      // Las que vengan: una 6.1 o una 7 no pueden caer en el 1× por no estar en una lista.
      "gpt-6.1", "gpt-7", "gpt-5.10",
    ]) {
      expect(primaDeEscritura(m), m).toBe(PRIMA_ESCRITURA_CACHE);
      expect(primaDeEscrituraAutomatica(m), m).toBe(PRIMA_ESCRITURA_CACHE);
    }
  });

  it("1× en los GPT anteriores, la serie o, los abiertos y Gemini; el prefijo ya no confunde", () => {
    for (const m of [
      "gpt-5.5", "gpt-5.4-mini", "gpt-5", "gpt-5-mini", "gpt-4o", "gpt-4.1", "gpt-3.5-turbo",
      "o3", "o4-mini", "gpt-oss-120b", "gemini-3.8-flash",
      // Antes, un id con prefijo de pasarela no empezaba por `gpt-` y caía en el
      // 1,25× de Anthropic.
      "openai/gpt-4o", "openai/o3", "google/gemini-2.5-pro",
    ]) {
      expect(primaDeEscritura(m), m).toBe(1);
      expect(primaDeEscrituraAutomatica(m), m).toBe(1);
    }
  });

  it("Anthropic cobra prima de escritura, pero NO por su cuenta: la provoca quien marca", () => {
    expect(primaDeEscritura("claude-opus-5-5")).toBe(PRIMA_ESCRITURA_CACHE);
    expect(primaDeEscrituraAutomatica("claude-opus-5-5")).toBe(1);
  });
});

describe("gateway: la escritura de gpt-6 se tarifa a 1,25×", () => {
  it("Chat Completions: prompt − cached − writes a entrada, writes a 1,25×", () => {
    const uso = mapearUsoChat({
      prompt_tokens: 100_000,
      completion_tokens: 2_000,
      prompt_tokens_details: { cached_tokens: 60_000, cache_write_tokens: 30_000 },
    })!;
    const r = costeMedido("gpt-6-sol", uso)!;
    const p = CATALOGO["gpt-6-sol"]!;
    const esperado =
      (10_000 / 1000) * p.inputPer1k +
      (60_000 / 1000) * p.cachedInputPer1k! +
      (30_000 / 1000) * p.inputPer1k * 1.25 +
      (2_000 / 1000) * p.outputPer1k;
    expect(r.costeUsd).toBeCloseTo(esperado, 12);
    // La columna «Cache writes» de la tabla oficial: $2.50 por millón.
    expect(p.inputPer1k * 1.25 * 1000).toBeCloseTo(2.5, 12);
  });
});

function falsoFetch(respuesta: unknown): typeof fetch {
  return (async () => ({ ok: true, status: 200, json: async () => respuesta }) as Response) as unknown as typeof fetch;
}

describe("SDK: el adaptador OpenAI lee `cache_write_tokens`", () => {
  it("generate(): la escritura viaja aparte en `cacheWriteInputTokens`, y la entrada sigue siendo el total", async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://example.test/v1",
      fetchImpl: falsoFetch({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 5_000,
          completion_tokens: 50,
          prompt_tokens_details: { cached_tokens: 1_000, cache_write_tokens: 3_000 },
        },
      }),
    });
    const r = await provider.generate({ model: "gpt-6-luna", messages: [{ role: "user", content: "hola" }] });
    expect(r.usage.inputTokens).toBe(5_000);
    expect(r.usage.cachedInputTokens).toBe(1_000);
    expect(r.usage.cacheWriteInputTokens).toBe(3_000);
  });

  it("generateStream(): lo mismo en el chunk final de usage", async () => {
    const sse = [
      { object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] },
      { object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      {
        object: "chat.completion.chunk",
        choices: [],
        usage: { prompt_tokens: 5_000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 4_000 } },
      },
    ]
      .map((c) => `data: ${JSON.stringify(c)}\n\n`)
      .join("") + "data: [DONE]\n\n";
    const fetchImpl = (async () =>
      new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
    const provider = new OpenAICompatibleProvider({ baseUrl: "https://example.test/v1", fetchImpl });
    let usage: ProviderResponse["usage"] | undefined;
    for await (const e of provider.generateStream({ model: "gpt-6-luna", messages: [{ role: "user", content: "hola" }] })) {
      if (e.type === "done") usage = e.response.usage;
    }
    expect(usage?.inputTokens).toBe(5_000);
    expect(usage?.cacheWriteInputTokens).toBe(4_000);
  });
});

describe("SDK: la prima que el proveedor cobra por su cuenta va a los DOS lados del libro", () => {
  const P: CostModel = { inputPer1k: 0.002, outputPer1k: 0.01, cachedInputPer1k: 0.0002 };

  it("en el libro: sube baseline y real por igual; el ahorro en dinero no se mueve", () => {
    const sin = new SavingsLedger();
    const con = new SavingsLedger();
    for (const l of [sin, con]) {
      l.actualInput = 10_000;
      l.actualOutput = 100;
      l.sentInputLocal = 10_000;
    }
    con.providerCacheWritePremium(8_000, 1.25, P);
    const a = sin.estimateCost(P);
    const b = con.estimateCost(P);
    const prima = (8_000 / 1000) * P.inputPer1k * 0.25;
    expect(b.actual).toBeCloseTo(a.actual + prima, 10);
    expect(b.baselineEstimate).toBeCloseTo(a.baselineEstimate + prima, 10);
    expect(b.baselineEstimate - b.actual).toBeCloseTo(a.baselineEstimate - a.actual, 10);
    expect(b.basis).toBe(a.basis);
  });

  it("el intento barato de la cascada paga su prima de escritura del proveedor, solo en `actual`", () => {
    // La llamada la puso la capa: su dinero entero —prima incluida— es coste de
    // la capa, como el resto de `cascadeAttempt`.
    const sin = new SavingsLedger();
    const con = new SavingsLedger();
    const uso = { inputTokens: 5_000, outputTokens: 100, cacheWriteInputTokens: 4_000 };
    sin.cascadeAttempt(uso, P);
    con.cascadeAttempt(uso, P, 1.25);
    expect(sin.extraCostUsd).toBeCloseTo((5_000 / 1000) * P.inputPer1k + (100 / 1000) * P.outputPer1k, 12);
    expect(con.extraCostUsd - sin.extraCostUsd).toBeCloseTo((4_000 / 1000) * P.inputPer1k * 0.25, 12);
    // Y los tokens publicados del intento no cambian: la escritura ya va dentro
    // de `inputTokens`.
    expect(con.cascadeInput).toBe(sin.cascadeInput);
  });

  it("multiplicador 1 no suma nada, y los tokens negativos no restan", () => {
    const l = new SavingsLedger();
    l.providerCacheWritePremium(10_000, 1, P);
    l.providerCacheWritePremium(-5_000, 1.25, P);
    expect(l.providerCacheWritePremiumUsd).toBe(0);
  });

  class Fijo implements Provider {
    readonly id = "fijo";
    constructor(private readonly usage: ProviderResponse["usage"]) {}
    async generate(_req: ProviderRequest): Promise<ProviderResponse> {
      return { text: "ok", usage: this.usage };
    }
  }
  const capa = (usage: ProviderResponse["usage"]) =>
    new SavingsPipeline({ provider: new Fijo(usage), tokenizer: new TokenizerRegistry(), devUnlicensed: true } as never);
  const peticion = (model: string) => ({ model, messages: [{ role: "user", content: "hola" }] }) as SavingsRequest;

  it("en el pipeline, con gpt-6-luna: `actual` lleva la prima de la factura y el ahorro es el mismo que sin escrituras", async () => {
    const base = { inputTokens: 20_000, outputTokens: 200, cachedInputTokens: 0 };
    const sin = (await capa(base).generate(peticion("openai/gpt-6-luna"))).report.cost;
    const con = (await capa({ ...base, cacheWriteInputTokens: 16_000 }).generate(peticion("openai/gpt-6-luna"))).report.cost;
    const prima = (16_000 / 1000) * CATALOGO["gpt-6-luna"]!.inputPer1k * 0.25;
    expect(con.actual).toBeCloseTo(sin.actual + prima, 10);
    expect(con.baselineEstimate).toBeCloseTo(sin.baselineEstimate + prima, 10);
    expect(con.baselineEstimate - con.actual).toBeCloseTo(sin.baselineEstimate - sin.actual, 10);
  });

  it("y en gpt-5.5, que no cobra la escritura, las escrituras no cambian nada", async () => {
    const base = { inputTokens: 20_000, outputTokens: 200, cachedInputTokens: 0 };
    const sin = (await capa(base).generate(peticion("gpt-5.5"))).report.cost;
    const con = (await capa({ ...base, cacheWriteInputTokens: 16_000 }).generate(peticion("gpt-5.5"))).report.cost;
    expect(con.actual).toBe(sin.actual);
    expect(con.baselineEstimate).toBe(sin.baselineEstimate);
  });
});

describe("SDK: la muestra de la cascada con un barato gpt-6 lleva su prima de escritura", () => {
  class PorModelo implements Provider {
    readonly id = "por-modelo";
    readonly llamadas: string[] = [];
    async generate(r: ProviderRequest): Promise<ProviderResponse> {
      this.llamadas.push(r.model);
      return r.model === "gpt-6-luna"
        ? { text: '{"answer":"barato"}', usage: { inputTokens: 1_000, outputTokens: 200, cacheWriteInputTokens: 800 } }
        : { text: '{"answer":"fuerte"}', usage: { inputTokens: 1_000, outputTokens: 200 } };
    }
  }

  it("`sampleCost` es lo que factura OpenAI: entrada, salida y el 0,25× de más de las escrituras", async () => {
    const p = new PorModelo();
    const res = await new SavingsPipeline({
      provider: p,
      tokenizer: new TokenizerRegistry(),
      devUnlicensed: true,
      silenceWarnings: true,
      modelCascade: { pairs: { "gpt-6-sol": "gpt-6-luna" }, shadowSampleRate: 1 },
    } as never).generate({
      model: "gpt-6-sol",
      messages: [{ role: "user", content: "resume en una frase" }],
      response: {
        contractId: "answer:v1",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["answer"],
          properties: { answer: { type: "string", maxLength: 200 } },
        },
      },
      savings: { modelCascade: "shadow" },
    } as SavingsRequest);
    expect(p.llamadas).toEqual(["gpt-6-sol", "gpt-6-luna"]);
    const luna = CATALOGO["gpt-6-luna"]!;
    const esperado =
      (1_000 / 1000) * luna.inputPer1k +
      (200 / 1000) * luna.outputPer1k +
      (800 / 1000) * luna.inputPer1k * 0.25;
    expect(res.report.modelCascade!.sampleCost).toBeCloseTo(esperado, 12);
  });
});
