import { describe, it, expect } from "vitest";

import { AnthropicProvider } from "../src/providers/anthropic.js";
import { extraDeCompactacion } from "../src/providers/iteraciones-de-compactacion.js";
import type { ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import { CATALOGO } from "../src/pricing/catalogo.js";
import { ObservadorSse, costeMedido, usoDeJsonPorRuta } from "../gateway/medidor.js";

/**
 * LA COMPACTACIÓN DE ANTHROPIC SE FACTURA FUERA DEL PRIMER NIVEL DE `usage`.
 *
 * https://platform.claude.com/docs/en/build-with-claude/compaction-threshold
 * (consultada el 2026-09-27): «The top-level `input_tokens` and `output_tokens`
 * do not include compaction iteration usage. […] To calculate total tokens
 * consumed and billed for a request, sum across all entries in the
 * `usage.iterations` array.» El ejemplo oficial es este mismo:
 */
const USO_OFICIAL = {
  input_tokens: 23_000,
  output_tokens: 1_000,
  iterations: [
    { type: "compaction", input_tokens: 180_000, output_tokens: 3_500 },
    { type: "message", input_tokens: 23_000, output_tokens: 1_000 },
  ],
};

const PETICION: ProviderRequest = { model: "claude-opus-5-5", messages: [{ role: "user", content: "sigue" }] };

describe("extraDeCompactacion", () => {
  it("suma SOLO las iteraciones `compaction` (el primer nivel ya es la suma de las demás)", () => {
    expect(extraDeCompactacion(USO_OFICIAL.iterations)).toEqual({
      input: 180_000,
      output: 3_500,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      iteraciones: 1,
    });
  });

  it("sin compactación no hay nada que añadir: null", () => {
    expect(extraDeCompactacion(undefined)).toBeNull();
    expect(extraDeCompactacion(null)).toBeNull();
    expect(extraDeCompactacion({})).toBeNull();
    // Con la beta puesta TODA respuesta trae `iterations`, aunque no compacte.
    expect(extraDeCompactacion([{ type: "message", input_tokens: 10, output_tokens: 2 }])).toBeNull();
  });

  it("una iteración de otro modelo (advisor) NO se suma: se factura a otra tarifa", () => {
    expect(extraDeCompactacion([{ type: "advisor_message", input_tokens: 9_999, output_tokens: 9_999 }])).toBeNull();
  });

  it("lee caché y desglose por TTL, e ignora basura", () => {
    const e = extraDeCompactacion([
      {
        type: "compaction",
        input_tokens: 100,
        output_tokens: 10,
        cache_read_input_tokens: 5_000,
        cache_creation_input_tokens: 700,
        cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 500 },
      },
      { type: "compaction", input_tokens: -3, output_tokens: "x" },
      null,
      7,
    ])!;
    expect(e).toEqual({ input: 100, output: 10, cacheRead: 5_000, cacheWrite: 700, cacheWrite1h: 500, iteraciones: 2 });
  });
});

function espiaJson(respuesta: unknown): typeof fetch {
  return (async () =>
    ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => respuesta,
      text: async () => JSON.stringify(respuesta),
    }) as unknown as Response) as unknown as typeof fetch;
}

describe("SDK: el adaptador de Anthropic suma la compactación", () => {
  it("generate(): entrada y salida con la iteración de compactación; sin afirmar razonamiento 0", async () => {
    const r = await new AnthropicProvider({ fetchImpl: espiaJson({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: USO_OFICIAL,
    }) }).generate(PETICION);
    expect(r.usage.inputTokens).toBe(23_000 + 180_000);
    expect(r.usage.outputTokens).toBe(1_000 + 3_500);
    // La salida lleva un resumen que no es la respuesta servida: nada de «0 razonamiento».
    expect(r.usage.reasoningTokens).toBeUndefined();
    expect(r.usage.complete).toBeUndefined();
  });

  it("la compactación bajo demanda: primer nivel a cero y todo el coste en la iteración", async () => {
    const r = await new AnthropicProvider({ fetchImpl: espiaJson({
      content: [{ type: "compaction", content: "Resumen", signature: "x" }],
      stop_reason: "compaction",
      usage: { input_tokens: 0, output_tokens: 0, iterations: [{ type: "compaction", input_tokens: 144, output_tokens: 276 }] },
    }) }).generate(PETICION);
    expect(r.usage.inputTokens).toBe(144);
    expect(r.usage.outputTokens).toBe(276);
  });

  it("con caché: lectura y escritura de la iteración se suman a sus campos (y a la entrada total)", async () => {
    const r = await new AnthropicProvider({ fetchImpl: espiaJson({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 50,
        output_tokens: 10,
        cache_read_input_tokens: 1_000,
        iterations: [
          { type: "compaction", input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 4_000, cache_creation_input_tokens: 300 },
          { type: "message", input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 1_000 },
        ],
      },
    }) }).generate(PETICION);
    expect(r.usage.cachedInputTokens).toBe(5_000);
    expect(r.usage.cacheWriteInputTokens).toBe(300);
    expect(r.usage.inputTokens).toBe(50 + 20 + 5_000 + 300);
    expect(r.usage.outputTokens).toBe(15);
  });

  it("sin compactación, todo queda como estaba (y el 0 de razonamiento se sigue afirmando)", async () => {
    const r = await new AnthropicProvider({ fetchImpl: espiaJson({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 20, iterations: [{ type: "message", input_tokens: 100, output_tokens: 20 }] },
    }) }).generate(PETICION);
    expect(r.usage).toMatchObject({ inputTokens: 100, outputTokens: 20, reasoningTokens: 0 });
    expect(r.usage.cachedInputTokens).toBeUndefined();
  });

  it("generateStream(): la iteración llega en el message_delta final y se suma igual", async () => {
    const ev = (tipo: string, data: Record<string, unknown>) => `event: ${tipo}\ndata: ${JSON.stringify({ type: tipo, ...data })}\n\n`;
    const cuerpo =
      ev("message_start", { message: { id: "m", role: "assistant", content: [], usage: { input_tokens: 23_000, output_tokens: 1 } } }) +
      ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } }) +
      ev("content_block_stop", { index: 0 }) +
      ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1_000, iterations: USO_OFICIAL.iterations } }) +
      ev("message_stop", {});
    const fetchImpl = (async () =>
      new Response(cuerpo, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
    let usage: ProviderResponse["usage"] | undefined;
    for await (const e of new AnthropicProvider({ fetchImpl }).generateStream(PETICION)) {
      if (e.type === "done") usage = e.response.usage;
    }
    expect(usage?.inputTokens).toBe(203_000);
    expect(usage?.outputTokens).toBe(4_500);
    expect(usage?.reasoningTokens).toBeUndefined();
  });
});

describe("gateway: el medidor suma la compactación", () => {
  const P = CATALOGO["claude-opus-5-5"]!;

  it("costeMedido: la iteración de compactación se tarifa como la respuesta (JSON y SSE)", () => {
    const esperado = ((23_000 + 180_000) / 1000) * P.inputPer1k + ((1_000 + 3_500) / 1000) * P.outputPer1k;

    const json = usoDeJsonPorRuta("/v1/messages", JSON.stringify({ usage: USO_OFICIAL }))!;
    const r = costeMedido("claude-opus-5-5", json)!;
    expect(r.tokens).toMatchObject({ entrada: 203_000, salida: 4_500 });
    expect(r.costeUsd).toBeCloseTo(esperado, 12);

    const obs = new ObservadorSse();
    obs.observar(`event: message_start\ndata: ${JSON.stringify({ message: { usage: { input_tokens: 23_000, output_tokens: 1 } } })}\n\n`);
    obs.observar(`event: message_delta\ndata: ${JSON.stringify({ usage: { output_tokens: 1_000, iterations: USO_OFICIAL.iterations } })}\n\n`);
    const s = costeMedido("claude-opus-5-5", obs.usageFinal()!)!;
    expect(s.costeUsd).toBeCloseTo(esperado, 12);
  });

  it("la escritura de la iteración entra con su TTL: la de 1 h a 2×", () => {
    const uso = {
      input_tokens: 10,
      output_tokens: 1,
      cache_creation_input_tokens: 100,
      iterations: [
        {
          type: "compaction",
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 1_000,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000 },
        },
      ],
    };
    const r = costeMedido("claude-opus-5-5", uso)!;
    expect(r.tokens).toMatchObject({ cacheEscrita: 1_100, cacheEscrita1h: 1_000 });
    const esperado =
      (10 / 1000) * P.inputPer1k + (1 / 1000) * P.outputPer1k +
      (100 / 1000) * P.inputPer1k * 1.25 + (1_000 / 1000) * P.inputPer1k * 2;
    expect(r.costeUsd).toBeCloseTo(esperado, 12);
  });

  it("sin iteraciones de compactación, el registro no cambia", () => {
    const a = costeMedido("claude-opus-5-5", { input_tokens: 100, output_tokens: 20 })!;
    const b = costeMedido("claude-opus-5-5", {
      input_tokens: 100,
      output_tokens: 20,
      iterations: [{ type: "message", input_tokens: 100, output_tokens: 20 }],
    })!;
    expect(b.costeUsd).toBe(a.costeUsd);
    expect(b.tokens).toEqual(a.tokens);
  });
});
