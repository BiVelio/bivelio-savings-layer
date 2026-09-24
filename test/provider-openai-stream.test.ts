import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { OpenAICompatibleProvider } from "../src/index.js";
import type { ProviderRequest, ProviderStreamEvent } from "../src/index.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";

/**
 * generateStream() del adaptador OpenAI-compatible: el texto se reenvía según
 * llega, y el contador que se reporta es el del chunk FINAL de usage. Sin ese
 * chunk no hay medición —`complete: false`, y la capa lo publica
 * `unmeasured`—, nunca un cero con cara de medido.
 */

interface Llamada {
  url: string;
  body: Record<string, unknown>;
  signal: AbortSignal | undefined;
}

type Respuesta = { status: number; body: string | ReadableStream<Uint8Array>; json?: boolean };

function falso(respuestas: ((body: Record<string, unknown>) => Respuesta)[] | ((body: Record<string, unknown>) => Respuesta)) {
  const llamadas: Llamada[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    llamadas.push({ url, body, signal: init.signal ?? undefined });
    const f = Array.isArray(respuestas) ? respuestas[llamadas.length - 1]! : respuestas;
    const r = f(body);
    return new Response(r.body, {
      status: r.status,
      headers: { "content-type": r.json ? "application/json" : "text/event-stream" },
    });
  }) as unknown as typeof fetch;
  return { llamadas, fetchImpl };
}

const sse = (...chunks: unknown[]): string =>
  chunks.map((c) => `data: ${typeof c === "string" ? c : JSON.stringify(c)}\n\n`).join("");

const trozo = (delta: Record<string, unknown>, finish: string | null = null) => ({
  object: "chat.completion.chunk",
  choices: [{ index: 0, delta, finish_reason: finish }],
});

const USO = { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } };

const CUERPO_NORMAL = sse(
  trozo({ role: "assistant", content: "" }),
  trozo({ content: "Hola" }),
  trozo({ content: ", qué " }),
  trozo({ content: "tal" }),
  trozo({}, "stop"),
  { object: "chat.completion.chunk", choices: [], usage: USO },
  "[DONE]",
);

const REQ: ProviderRequest = { model: "gpt-4o-mini", messages: [{ role: "user", content: "hola" }] };

function proveedor(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return new OpenAICompatibleProvider({ baseUrl: "https://example.test/v1", fetchImpl, ...extra });
}

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

let avisos: string[] = [];
beforeEach(() => {
  avisos = [];
  reiniciarAvisos();
  vi.spyOn(console, "warn").mockImplementation((m: unknown) => {
    avisos.push(String(m));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("OpenAICompatibleProvider.generateStream", () => {
  it("el cuerpo lleva stream:true y stream_options.include_usage", async () => {
    const f = falso(() => ({ status: 200, body: CUERPO_NORMAL }));
    await recoger(proveedor(f.fetchImpl).generateStream(REQ));
    expect(f.llamadas).toHaveLength(1);
    expect(f.llamadas[0]!.body["stream"]).toBe(true);
    expect(f.llamadas[0]!.body["stream_options"]).toEqual({ include_usage: true });
    expect(f.llamadas[0]!.url).toBe("https://example.test/v1/chat/completions");
  });

  it("reenvía los deltas y cierra con el texto entero y el usage final", async () => {
    const f = falso(() => ({ status: 200, body: CUERPO_NORMAL }));
    const evs = await recoger(proveedor(f.fetchImpl).generateStream(REQ));
    expect(evs.filter((e) => e.type === "text")).toEqual([
      { type: "text", delta: "Hola" },
      { type: "text", delta: ", qué " },
      { type: "text", delta: "tal" },
    ]);
    const r = hecho(evs);
    expect(r.text).toBe("Hola, qué tal");
    expect(r.finishReason).toBe("stop");
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 20, cachedInputTokens: 40 });
    expect("complete" in r.usage).toBe(false);
  });

  it("done.response es lo que generate() devolvería sobre el JSON equivalente (salvo raw)", async () => {
    const f = falso(() => ({ status: 200, body: CUERPO_NORMAL }));
    const evs = await recoger(proveedor(f.fetchImpl).generateStream(REQ));
    const g = falso(() => ({
      status: 200,
      json: true,
      body: JSON.stringify({
        choices: [{ message: { content: "Hola, qué tal" }, finish_reason: "stop" }],
        usage: USO,
      }),
    }));
    const deGenerate = await proveedor(g.fetchImpl).generate(REQ);
    const { raw: _a, ...stream } = hecho(evs);
    const { raw: _b, ...entero } = deGenerate;
    expect(stream).toEqual(entero);
  });

  it("reensambla tool_calls por index sin duplicar el nombre, y no emite eventos de herramienta", async () => {
    const tc = (args: string) => ({
      tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "get_weather", arguments: args } }],
    });
    const cuerpo = sse(
      trozo({ role: "assistant", content: null, ...tc("") }),
      trozo(tc('{"city":')),
      trozo(tc('"Madrid"}')),
      trozo({}, "tool_calls"),
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } },
      "[DONE]",
    );
    const f = falso(() => ({ status: 200, body: cuerpo }));
    const evs = await recoger(proveedor(f.fetchImpl).generateStream(REQ));
    expect(evs.map((e) => e.type)).toEqual(["done"]);
    const r = hecho(evs);
    expect(r.toolCalls).toEqual([{ id: "c1", name: "get_weather", arguments: '{"city":"Madrid"}' }]);
    expect(r.text).toBe("");
    expect(r.finishReason).toBe("tool_calls");
  });

  it("service_tier produce servedServiceTier", async () => {
    const cuerpo = sse(
      { ...trozo({ content: "x" }), service_tier: "flex" },
      { ...trozo({}, "stop"), service_tier: "flex" },
      { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 }, service_tier: "flex" },
      "[DONE]",
    );
    const f = falso(() => ({ status: 200, body: cuerpo }));
    expect(hecho(await recoger(proveedor(f.fetchImpl).generateStream(REQ))).servedServiceTier).toBe("flex");
  });

  it("un 400 por stream_options se repite UNA vez sin la opción, avisa una vez y el usage sale incompleto", async () => {
    const sinUso = sse(trozo({ content: "ok" }), trozo({}, "stop"), "[DONE]");
    const f = falso((body) =>
      "stream_options" in body
        ? { status: 400, body: '{"error":{"message":"Unrecognized request argument supplied: stream_options"}}' }
        : { status: 200, body: sinUso },
    );
    const p = proveedor(f.fetchImpl);
    const r = hecho(await recoger(p.generateStream(REQ)));
    expect(f.llamadas).toHaveLength(2);
    expect("stream_options" in f.llamadas[0]!.body).toBe(true);
    expect("stream_options" in f.llamadas[1]!.body).toBe(false);
    expect(f.llamadas[1]!.body["stream"]).toBe(true);
    expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 0, complete: false });
    expect(avisos.filter((a) => a.includes("rejects `stream_options`"))).toHaveLength(1);

    // La siguiente ya sale sin la opción, en un solo intento, y sin repetir el aviso.
    await recoger(p.generateStream(REQ));
    expect(f.llamadas).toHaveLength(3);
    expect("stream_options" in f.llamadas[2]!.body).toBe(false);
    expect(avisos.filter((a) => a.includes("rejects `stream_options`"))).toHaveLength(1);
  });

  it("un 422 con cualquier cuerpo degrada igual", async () => {
    const f = falso((body) =>
      "stream_options" in body
        ? { status: 422, body: '{"detail":[{"msg":"extra fields not permitted"}]}' }
        : { status: 200, body: sse(trozo({ content: "ok" }), trozo({}, "stop"), "[DONE]") },
    );
    const r = hecho(await recoger(proveedor(f.fetchImpl).generateStream(REQ)));
    expect(f.llamadas).toHaveLength(2);
    expect(r.text).toBe("ok");
    expect(r.usage.complete).toBe(false);
  });

  it("un 400 que no habla de stream_options se propaga sin reintentar", async () => {
    const f = falso(() => ({ status: 400, body: '{"error":{"message":"model not found"}}' }));
    await expect(recoger(proveedor(f.fetchImpl).generateStream(REQ))).rejects.toThrow(/provider 400: .*model not found/);
    expect(f.llamadas).toHaveLength(1);
  });

  it("con requireUsage, el rechazo de stream_options lanza tras UN solo fetch", async () => {
    const f = falso(() => ({
      status: 400,
      body: "Unrecognized request argument supplied: stream_options",
    }));
    await expect(
      recoger(proveedor(f.fetchImpl, { requireUsage: true }).generateStream(REQ)),
    ).rejects.toThrow(/rejects stream_options/);
    expect(f.llamadas).toHaveLength(1);
  });

  it("con requireUsage, un stream sin chunk de usage lanza", async () => {
    const f = falso(() => ({ status: 200, body: sse(trozo({ content: "ok" }), trozo({}, "stop"), "[DONE]") }));
    await expect(
      recoger(proveedor(f.fetchImpl, { requireUsage: true }).generateStream(REQ)),
    ).rejects.toThrow(/incomplete usage/);
  });

  it("un EOF sin finish_reason lanza: media respuesta no es una respuesta", async () => {
    const f = falso(() => ({ status: 200, body: sse(trozo({ content: "a medias" })) }));
    const evs: ProviderStreamEvent[] = [];
    await expect(
      (async () => {
        for await (const e of proveedor(f.fetchImpl).generateStream(REQ)) evs.push(e);
      })(),
    ).rejects.toThrow(/ended before completion/);
    // El texto sí se reenvió; lo que no hay es `done`.
    expect(evs).toEqual([{ type: "text", delta: "a medias" }]);
  });

  it("un error en mitad del stream lanza con el mensaje del proveedor", async () => {
    const f = falso(() => ({
      status: 200,
      body: sse(trozo({ content: "a" }), { error: { message: "boom" } }, trozo({}, "stop"), "[DONE]"),
    }));
    await expect(recoger(proveedor(f.fetchImpl).generateStream(REQ))).rejects.toThrow(
      /provider stream error: boom/,
    );
  });

  it("options.signal llega al fetch", async () => {
    const f = falso(() => ({ status: 200, body: CUERPO_NORMAL }));
    const ctrl = new AbortController();
    await recoger(proveedor(f.fetchImpl).generateStream(REQ, { signal: ctrl.signal }));
    expect(f.llamadas[0]!.signal).toBe(ctrl.signal);
  });

  it("con esquema o diferible no streamea: un solo text y done, y el fetch no lleva stream", async () => {
    const json = JSON.stringify({
      choices: [{ message: { content: '{"answer":8}' }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    for (const extra of [
      { schema: { type: "object" as const, properties: { answer: { type: "number" as const } }, required: ["answer"], additionalProperties: false } },
      { deferrable: true },
    ]) {
      const f = falso(() => ({ status: 200, json: true, body: json }));
      const evs = await recoger(proveedor(f.fetchImpl).generateStream({ ...REQ, ...extra }));
      expect(evs.map((e) => e.type)).toEqual(["text", "done"]);
      expect(evs[0]).toEqual({ type: "text", delta: '{"answer":8}' });
      expect("stream" in f.llamadas[0]!.body).toBe(false);
      expect("stream_options" in f.llamadas[0]!.body).toBe(false);
    }
  });

  it("lee el cuerpo como ReadableStream troceado en cualquier punto", async () => {
    const bytes = new TextEncoder().encode(CUERPO_NORMAL);
    for (const corte of [1, 3, 17, 64]) {
      const f = falso(() => ({
        status: 200,
        body: new ReadableStream<Uint8Array>({
          start(c) {
            for (let i = 0; i < bytes.length; i += corte) c.enqueue(bytes.slice(i, i + corte));
            c.close();
          },
        }),
      }));
      const r = hecho(await recoger(proveedor(f.fetchImpl).generateStream(REQ)));
      expect(r.text, `corte=${corte}`).toBe("Hola, qué tal");
      expect(r.usage.inputTokens).toBe(100);
    }
  });
});

describe("OpenAICompatibleProvider.generate — usage parcial", () => {
  it("un contador ausente marca complete:false; con los dos, la clave no aparece", async () => {
    const parcial = falso(() => ({
      status: 200,
      json: true,
      body: JSON.stringify({ choices: [{ message: { content: "x" } }], usage: { prompt_tokens: 10 } }),
    }));
    const r1 = await proveedor(parcial.fetchImpl).generate(REQ);
    expect(r1.usage).toEqual({ inputTokens: 10, outputTokens: 0, complete: false });

    const entero = falso(() => ({
      status: 200,
      json: true,
      body: JSON.stringify({ choices: [{ message: { content: "x" } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }),
    }));
    const r2 = await proveedor(entero.fetchImpl).generate(REQ);
    expect(r2.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
  });
});
