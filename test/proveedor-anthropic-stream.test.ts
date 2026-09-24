import { describe, it, expect } from "vitest";

import { AnthropicProvider } from "../src/providers/anthropic.js";
import type { ProviderRequest, ProviderStreamEvent } from "../src/providers/types.js";

/**
 * generateStream() del adaptador de Anthropic.
 *
 * Lo que se juega aquí es el CONTADOR: `message_start` trae la entrada y un
 * `output_tokens` provisional (un marcador); la salida de verdad llega en
 * `message_delta`. Un stream sin ese evento no tiene contador final, y eso se
 * dice (`complete: false`) en vez de publicar un 1 como si fuera la salida.
 */

function espia(cuerpo: string, estado = 200) {
  const enviados: Record<string, unknown>[] = [];
  const senales: (AbortSignal | undefined)[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    enviados.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    senales.push(init.signal ?? undefined);
    return new Response(cuerpo, {
      status: estado,
      headers: { "content-type": estado === 200 && cuerpo.startsWith("event:") ? "text/event-stream" : "application/json" },
    });
  }) as unknown as typeof fetch;
  return { enviados, senales, fetchImpl };
}

const ev = (tipo: string, data: Record<string, unknown>): string =>
  `event: ${tipo}\ndata: ${JSON.stringify({ type: tipo, ...data })}\n\n`;

const inicio = (usage: Record<string, unknown>) =>
  ev("message_start", { message: { id: "msg_1", role: "assistant", content: [], usage } });
const textoBloque = (index: number) => ev("content_block_start", { index, content_block: { type: "text", text: "" } });
const textoDelta = (index: number, text: string) =>
  ev("content_block_delta", { index, delta: { type: "text_delta", text } });
const parar = (index: number) => ev("content_block_stop", { index });
const delta = (stop_reason: string, usage: Record<string, unknown>) =>
  ev("message_delta", { delta: { stop_reason, stop_sequence: null }, usage });
const fin = ev("message_stop", {});

const PETICION: ProviderRequest = {
  model: "claude-sonnet-4-5",
  messages: [
    { role: "system", content: "Eres el asistente de soporte." },
    { role: "user", content: "¿Dónde está mi pedido?" },
  ],
};

async function recoger(it: AsyncIterable<ProviderStreamEvent>): Promise<ProviderStreamEvent[]> {
  const out: ProviderStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function hecho(evs: ProviderStreamEvent[]) {
  const d = evs[evs.length - 1];
  if (!d || d.type !== "done") throw new Error("el último evento no es done");
  return d.response;
}

const CUERPO =
  inicio({ input_tokens: 10, cache_read_input_tokens: 400, cache_creation_input_tokens: 50, output_tokens: 1 }) +
  textoBloque(0) +
  "event: ping\ndata: {\"type\":\"ping\"}\n\n" +
  textoDelta(0, "Su pedido ") +
  textoDelta(0, "sale hoy.") +
  parar(0) +
  delta("end_turn", { output_tokens: 42 }) +
  fin;

describe("AnthropicProvider.generateStream", () => {
  it("el cuerpo lleva stream:true", async () => {
    const s = espia(CUERPO);
    await recoger(new AnthropicProvider({ fetchImpl: s.fetchImpl }).generateStream(PETICION));
    expect(s.enviados[0]!["stream"]).toBe(true);
    expect(s.enviados[0]!["system"]).toBeDefined();
  });

  it("reenvía los text_delta y el texto final es su concatenación", async () => {
    const s = espia(CUERPO);
    const evs = await recoger(new AnthropicProvider({ fetchImpl: s.fetchImpl }).generateStream(PETICION));
    expect(evs.filter((e) => e.type === "text")).toEqual([
      { type: "text", delta: "Su pedido " },
      { type: "text", delta: "sale hoy." },
    ]);
    expect(hecho(evs).text).toBe("Su pedido sale hoy.");
  });

  it("la entrada suma los tres contadores y la salida es la de message_delta", async () => {
    const s = espia(CUERPO);
    const r = hecho(await recoger(new AnthropicProvider({ fetchImpl: s.fetchImpl }).generateStream(PETICION)));
    expect(r.usage).toEqual({
      inputTokens: 460,
      outputTokens: 42,
      cachedInputTokens: 400,
      cacheWriteInputTokens: 50,
    });
    expect("complete" in r.usage).toBe(false);
    expect(r.finishReason).toBe("stop");
  });

  it("el desglose de cache_creation de message_start sobrevive al delta", async () => {
    const cuerpo =
      inicio({
        input_tokens: 10,
        cache_creation_input_tokens: 2000,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 2000 },
        output_tokens: 1,
      }) +
      textoBloque(0) +
      textoDelta(0, "ok") +
      delta("end_turn", { output_tokens: 3, cache_creation: null, input_tokens: null }) +
      fin;
    const s = espia(cuerpo);
    const r = hecho(await recoger(new AnthropicProvider({ fetchImpl: s.fetchImpl }).generateStream(PETICION)));
    const raw = r.raw as { usage: Record<string, unknown> };
    expect(raw.usage["cache_creation"]).toEqual({ ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 2000 });
    // Un null en el delta no borra lo que dijo message_start.
    expect(raw.usage["input_tokens"]).toBe(10);
    expect(r.usage.inputTokens).toBe(2010);
    expect(r.usage.cacheWriteInputTokens).toBe(2000);
  });

  it("tool_use con partial_json con espacios da arguments normalizados; sin parámetros, \"{}\"", async () => {
    const cuerpo =
      inicio({ input_tokens: 20, output_tokens: 1 }) +
      ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: "tu_1", name: "get_weather", input: {} } }) +
      ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"city": ' } }) +
      ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '"Paris"}' } }) +
      parar(0) +
      ev("content_block_start", { index: 1, content_block: { type: "tool_use", id: "tu_2", name: "now", input: {} } }) +
      ev("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: "" } }) +
      parar(1) +
      delta("tool_use", { output_tokens: 30 }) +
      fin;
    const s = espia(cuerpo);
    const evs = await recoger(new AnthropicProvider({ fetchImpl: s.fetchImpl }).generateStream(PETICION));
    expect(evs.map((e) => e.type)).toEqual(["done"]);
    const r = hecho(evs);
    expect(r.toolCalls).toEqual([
      { id: "tu_1", name: "get_weather", arguments: '{"city":"Paris"}' },
      { id: "tu_2", name: "now", arguments: "{}" },
    ]);
    expect(r.finishReason).toBe("tool_calls");
  });

  it("max_tokens se traduce a length", async () => {
    const cuerpo =
      inicio({ input_tokens: 5, output_tokens: 1 }) + textoBloque(0) + textoDelta(0, "cort") + delta("max_tokens", { output_tokens: 4 }) + fin;
    const s = espia(cuerpo);
    const r = hecho(await recoger(new AnthropicProvider({ fetchImpl: s.fetchImpl }).generateStream(PETICION)));
    expect(r.finishReason).toBe("length");
  });

  it("sin message_delta pero con message_stop: usage {0, 0, complete:false}; con requireUsage lanza", async () => {
    const cuerpo = inicio({ input_tokens: 10, output_tokens: 1 }) + textoBloque(0) + textoDelta(0, "hola") + fin;
    const s = espia(cuerpo);
    const r = hecho(await recoger(new AnthropicProvider({ fetchImpl: s.fetchImpl }).generateStream(PETICION)));
    expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 0, complete: false });
    expect(r.text).toBe("hola");

    const t = espia(cuerpo);
    await expect(
      recoger(new AnthropicProvider({ fetchImpl: t.fetchImpl, requireUsage: true }).generateStream(PETICION)),
    ).rejects.toThrow(/incomplete usage/);
  });

  it("event: error lanza con el tipo del proveedor", async () => {
    const cuerpo =
      inicio({ input_tokens: 10, output_tokens: 1 }) +
      textoBloque(0) +
      textoDelta(0, "a") +
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n';
    const s = espia(cuerpo);
    await expect(
      recoger(new AnthropicProvider({ fetchImpl: s.fetchImpl }).generateStream(PETICION)),
    ).rejects.toThrow(/provider stream error: overloaded_error/);
  });

  it("un EOF sin message_delta ni message_stop lanza", async () => {
    const cuerpo = inicio({ input_tokens: 10, output_tokens: 1 }) + textoBloque(0) + textoDelta(0, "a medias");
    const s = espia(cuerpo);
    await expect(
      recoger(new AnthropicProvider({ fetchImpl: s.fetchImpl }).generateStream(PETICION)),
    ).rejects.toThrow(/ended before completion/);
  });

  it("usage.service_tier produce servedServiceTier", async () => {
    const cuerpo =
      inicio({ input_tokens: 10, output_tokens: 1, service_tier: "standard" }) +
      textoBloque(0) +
      textoDelta(0, "ok") +
      delta("end_turn", { output_tokens: 2 }) +
      fin;
    const s = espia(cuerpo);
    const r = hecho(await recoger(new AnthropicProvider({ fetchImpl: s.fetchImpl }).generateStream(PETICION)));
    expect(r.servedServiceTier).toBe("standard");
  });

  it("con esquema delega en generate(): el cuerpo no lleva stream y hay un solo text", async () => {
    const respuesta = JSON.stringify({
      content: [{ type: "tool_use", id: "t", name: "bvsala_contract", input: { answer: 8 } }],
      stop_reason: "tool_use",
      usage: { input_tokens: 30, output_tokens: 6 },
    });
    const s = espia(respuesta);
    const evs = await recoger(
      new AnthropicProvider({ fetchImpl: s.fetchImpl }).generateStream({
        ...PETICION,
        schema: {
          type: "object",
          properties: { answer: { type: "number" } },
          required: ["answer"],
          additionalProperties: false,
        },
      }),
    );
    expect("stream" in s.enviados[0]!).toBe(false);
    expect(evs.map((e) => e.type)).toEqual(["text", "done"]);
    expect(evs[0]).toEqual({ type: "text", delta: '{"answer":8}' });
    // La herramienta del contrato nunca aparece como llamada.
    expect(hecho(evs).toolCalls).toBeUndefined();
  });

  it("options.signal llega al fetch", async () => {
    const s = espia(CUERPO);
    const ctrl = new AbortController();
    await recoger(new AnthropicProvider({ fetchImpl: s.fetchImpl }).generateStream(PETICION, { signal: ctrl.signal }));
    expect(s.senales[0]).toBe(ctrl.signal);
  });
});

describe("AnthropicProvider.generate — usage parcial", () => {
  it("un contador ausente marca complete:false; con los dos, la clave no aparece", async () => {
    const parcial = espia(JSON.stringify({ content: [{ type: "text", text: "x" }], stop_reason: "end_turn", usage: { input_tokens: 10 } }));
    const r1 = await new AnthropicProvider({ fetchImpl: parcial.fetchImpl }).generate(PETICION);
    expect(r1.usage).toEqual({ inputTokens: 10, outputTokens: 0, complete: false });

    const entero = espia(JSON.stringify({ content: [{ type: "text", text: "x" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 2 } }));
    const r2 = await new AnthropicProvider({ fetchImpl: entero.fetchImpl }).generate(PETICION);
    expect(r2.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
  });
});
