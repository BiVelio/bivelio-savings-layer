import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicProvider } from "../../src/index.js";
import { anthropicSavings } from "@bivelio/savings-layer/anthropic-sdk";
import { coleccion, medicion, prohibirLaRed, sinLicencia, vaciar } from "./ayudas.js";

/**
 * EL ADAPTADOR DEL SDK OFICIAL DE ANTHROPIC, con el SDK de verdad y un `fetch`
 * falso que contesta como la API de Mensajes (JSON o SSE). Sin red, y sin
 * ninguna clave real: `apiKey` es una cadena de prueba.
 */

let restaurarRed: () => void;
beforeAll(() => {
  restaurarRed = prohibirLaRed();
});
afterAll(() => restaurarRed());

const USO = { input_tokens: 5, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 4 };

function ev(e: string, d: unknown): string {
  return `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`;
}

function sse(o: { id?: string; texto?: string; bloquesExtra?: string; usoFinal?: unknown; usoInicio?: unknown } = {}): string {
  return (
    ev("message_start", {
      type: "message_start",
      message: {
        id: o.id ?? "msg_live",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: o.usoInicio ?? { input_tokens: 5, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 1 },
      },
    }) +
    (o.bloquesExtra ?? "") +
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
    ev("ping", { type: "ping" }) +
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: (o.texto ?? "Hi there").slice(0, 3) } }) +
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: (o.texto ?? "Hi there").slice(3) } }) +
    ev("content_block_stop", { type: "content_block_stop", index: 0 }) +
    ev("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: o.usoFinal ?? { output_tokens: 4 },
    }) +
    ev("message_stop", { type: "message_stop" })
  );
}

function mensaje(o: { id?: string; contenido?: unknown[]; uso?: unknown } = {}) {
  return {
    id: o.id ?? "msg_json",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5",
    content: o.contenido ?? [{ type: "text", text: "Hi there" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: o.uso ?? USO,
  };
}

interface Red {
  fetch: typeof fetch;
  llamadas: { url: string; body: string }[];
  /** Respuestas no-2xx que se devuelven antes de la buena (una por intento). */
  fallos: number[];
  cuerpo?: () => unknown;
  sse?: () => string;
}

function red(): Red {
  const r: Red = {
    llamadas: [],
    fallos: [],
    fetch: (async (url: string | URL, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      r.llamadas.push({ url: String(url), body });
      const estado = r.fallos.shift();
      if (estado !== undefined) {
        return new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "busy" } }), {
          status: estado,
          headers: { "content-type": "application/json" },
        });
      }
      if ((init?.method ?? "GET").toUpperCase() === "GET") {
        return new Response(JSON.stringify({ data: [], has_more: false, first_id: null, last_id: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (String(url).includes("count_tokens")) {
        return new Response(JSON.stringify({ input_tokens: 7 }), { status: 200, headers: { "content-type": "application/json" } });
      }
      const pedido = JSON.parse(body) as { stream?: boolean };
      if (pedido.stream) {
        return new Response((r.sse ?? (() => sse()))(), {
          status: 200,
          headers: { "content-type": "text/event-stream", "request-id": "req_live" },
        });
      }
      return new Response(JSON.stringify((r.cuerpo ?? (() => mensaje()))()), {
        status: 200,
        headers: { "content-type": "application/json", "request-id": "req_live" },
      });
    }) as unknown as typeof fetch,
  };
  return r;
}

function cliente(n: Red, savings: ReturnType<typeof anthropicSavings>, extra: Record<string, unknown> = {}): Anthropic {
  return new Anthropic({ apiKey: "test-not-a-key", fetch: n.fetch, middleware: [savings.middleware], maxRetries: 2, ...extra });
}

const PEDIDO = {
  model: "claude-sonnet-4-5",
  max_tokens: 64,
  temperature: 0,
  messages: [{ role: "user" as const, content: "Name a colour." }],
};

describe("anthropicSavings", () => {
  it("(a) llamada viva: una llamada, medida con la aritmética de la API de Mensajes, informe por reportFor y un registro", async () => {
    const n = red();
    const { onReport, informes } = coleccion();
    const { opciones, registros } = medicion();
    const s = anthropicSavings({ silenceWarnings: true, onReport, ...opciones });
    const m = await cliente(n, s).messages.create(PEDIDO);
    await vaciar();
    expect(m.id).toBe("msg_json");
    expect(n.llamadas).toHaveLength(1);
    const informe = s.reportFor(m);
    expect(informe?.cost.basis).toBe("measured");
    expect(informe?.model).toBe("anthropic/claude-sonnet-4-5");
    // input_tokens es solo el resto no cacheado: el total suma los tres.
    expect(informe?.tokens.actualInput).toBe(10);
    expect(informe?.tokens.providerCachedInput).toBe(3);
    expect(informe?.tokens.actualOutput).toBe(4);
    expect(informes).toHaveLength(1);
    expect(s.reportFor("msg_json")?.requestId).toBe(informe?.requestId);
    expect(registros).toHaveLength(1);
    s.close();
  });

  it("(b) la repetición idéntica sale de la caché exacta, sin llamar y con uso 0 en el Message", async () => {
    const n = red();
    const s = anthropicSavings({ silenceWarnings: true });
    const c = cliente(n, s);
    await c.messages.create(PEDIDO);
    const m = await c.messages.create(PEDIDO);
    expect(n.llamadas).toHaveLength(1);
    expect(m.id.startsWith("msg_bvsala_")).toBe(true);
    expect(m.content).toEqual([{ type: "text", text: "Hi there" }]);
    expect(m.usage.input_tokens).toBe(0);
    expect(s.reportFor(m)?.cache.result).toBe("exact");
    expect(s.reportFor(m)?.cost.basis).toBe("reference");
    s.close();
  });

  it("(c) una cuenta se contesta sin llamar", async () => {
    const n = red();
    const s = anthropicSavings({ silenceWarnings: true });
    const m = await cliente(n, s).messages.create({ ...PEDIDO, messages: [{ role: "user", content: "What is 2 + 2 * 3?" }] });
    expect(n.llamadas).toHaveLength(0);
    expect(m.content).toEqual([{ type: "text", text: "8" }]);
    expect(s.reportFor(m)?.cost.basis).toBe("estimated");
    s.close();
  });

  it("(d) stream vivo: el SSE llega byte a byte, el SDK lo parsea y el informe está listo al acabar", async () => {
    const n = red();
    const s = anthropicSavings({ silenceWarnings: true });
    const c = cliente(n, s);
    // Byte a byte: el cuerpo crudo que ve el SDK es el que mandó el proveedor.
    const crudo = await c.messages.create({ ...PEDIDO, stream: true }).asResponse();
    expect(await crudo.text()).toBe(sse());
    const fm = await c.messages.stream({ ...PEDIDO, messages: [{ role: "user", content: "Name a shape." }] }).finalMessage();
    expect(fm.id).toBe("msg_live");
    expect((fm.content[0] as { text?: string }).text).toBe("Hi there");
    const informe = s.reportFor(fm);
    expect(informe?.cost.basis).toBe("measured");
    expect(informe?.streaming).toMatchObject({ delivery: "live" });
    expect(informe?.tokens.actualInput).toBe(10);
    expect(informe?.tokens.actualOutput).toBe(4);
    s.close();
  });

  it("(e) el atajo en stream: messages.stream().finalMessage() y create({stream:true})", async () => {
    const n = red();
    const s = anthropicSavings({ silenceWarnings: true });
    const c = cliente(n, s);
    await c.messages.create(PEDIDO);
    const fm = await c.messages.stream(PEDIDO).finalMessage();
    expect(n.llamadas).toHaveLength(1);
    expect((fm.content[0] as { text?: string }).text).toBe("Hi there");
    expect(s.reportFor(fm)?.cache.result).toBe("exact");
    const eventos: string[] = [];
    for await (const e of await c.messages.create({ ...PEDIDO, stream: true })) eventos.push(e.type);
    expect(eventos[0]).toBe("message_start");
    expect(eventos.at(-1)).toBe("message_stop");
    expect(n.llamadas).toHaveLength(1);
    s.close();
  });

  it("(f) herramientas: sin declarar, nunca de caché; declarada de lectura, sí; del servidor, nunca", async () => {
    const tools = [{ name: "lookup", description: "look up", input_schema: { type: "object" as const, properties: { q: { type: "string" } } } }];
    for (const [lectura, esperado] of [[[], 2], [["lookup"], 1]] as const) {
      const n = red();
      const s = anthropicSavings({ silenceWarnings: true, readOnlyTools: lectura });
      const c = cliente(n, s);
      await c.messages.create({ ...PEDIDO, tools });
      await c.messages.create({ ...PEDIDO, tools });
      expect(n.llamadas.length, JSON.stringify(lectura)).toBe(esperado);
      s.close();
    }
    const n = red();
    const s = anthropicSavings({ silenceWarnings: true, readOnlyTools: ["web_search"] });
    const c = cliente(n, s);
    const servidor = [{ type: "web_search_20250305", name: "web_search" }] as never;
    await c.messages.create({ ...PEDIDO, tools: servidor });
    await c.messages.create({ ...PEDIDO, tools: servidor });
    expect(n.llamadas).toHaveLength(2);
    s.close();
  });

  it("(g) pensamiento firmado, citas o bloques del servidor: no se reutilizan", async () => {
    const casos = [
      [{ type: "thinking", thinking: "hmm", signature: "sig" }, { type: "text", text: "Hi" }],
      [{ type: "text", text: "Hi", citations: [{ type: "char_location", cited_text: "x" }] }],
      [{ type: "server_tool_use", id: "s1", name: "web_search", input: {} }, { type: "text", text: "Hi" }],
    ];
    for (const contenido of casos) {
      const n = red();
      n.cuerpo = () => mensaje({ contenido });
      const s = anthropicSavings({ silenceWarnings: true });
      const c = cliente(n, s);
      await c.messages.create(PEDIDO);
      const m = await c.messages.create(PEDIDO);
      expect(n.llamadas.length, JSON.stringify(contenido[0])).toBe(2);
      expect(s.reportFor(m)?.cost.basis).toBe("measured");
      s.close();
    }
  });

  it("(h) sin licencia: modo Community — crea y streamea llamando a fetch", async () => {
    const n = red();
    await sinLicencia(async () => {
      const s = anthropicSavings({ silenceWarnings: true });
      const c = cliente(n, s, { maxRetries: 0 });
      const m = await c.messages.create(PEDIDO);
      expect(m.content).toBeTruthy();
      const enStream = await c.messages.stream(PEDIDO).finalMessage();
      expect(enStream.content).toBeTruthy();
      s.close();
    });
    // fetch se llamó al menos una vez; el `PEDIDO` idéntico del stream lo sirve
    // la caché exacta — que es la capa haciendo su trabajo.
    expect(n.llamadas.length).toBeGreaterThanOrEqual(1);
  });

  it("(i) el cuerpo que llega a fetch es el que serializó el SDK, sin reserializar", async () => {
    const n = red();
    const s = anthropicSavings({ silenceWarnings: true });
    const sin = new Anthropic({ apiKey: "test-not-a-key", fetch: n.fetch, maxRetries: 0 });
    await sin.messages.create({ ...PEDIDO, metadata: { user_id: "u-1" } });
    const conCapa = cliente(n, s);
    await conCapa.messages.create({ ...PEDIDO, metadata: { user_id: "u-1" } });
    expect(n.llamadas[1]?.body).toBe(n.llamadas[0]?.body);
    s.close();
  });

  it("(l) 529 y después 200: el middleware corre por intento y hay UN solo registro", async () => {
    const n = red();
    n.fallos = [529];
    const { opciones, registros } = medicion();
    const s = anthropicSavings({ silenceWarnings: true, ...opciones });
    const m = await cliente(n, s).messages.create(PEDIDO);
    await vaciar();
    expect(n.llamadas).toHaveLength(2);
    expect(s.reportFor(m)?.cost.basis).toBe("measured");
    expect(registros).toHaveLength(1);
    s.close();
  });

  it("(l) un 400 llega al llamante como el error tipado del SDK, sin registro", async () => {
    const n = red();
    n.fallos = [400];
    const { opciones, registros } = medicion();
    const s = anthropicSavings({ silenceWarnings: true, ...opciones });
    await expect(cliente(n, s).messages.create(PEDIDO)).rejects.toBeInstanceOf(Anthropic.BadRequestError);
    await vaciar();
    expect(registros).toHaveLength(0);
    s.close();
  });

  it("(l) count_tokens y models pasan sin tocar la capa", async () => {
    const n = red();
    const { onReport, informes } = coleccion();
    const s = anthropicSavings({ silenceWarnings: true, onReport });
    const c = cliente(n, s);
    const r = await c.messages.countTokens({ model: PEDIDO.model, messages: PEDIDO.messages });
    expect(r.input_tokens).toBe(7);
    await c.models.list();
    expect(n.llamadas).toHaveLength(2);
    expect(n.llamadas[1]?.url).toContain("/v1/models");
    expect(informes).toHaveLength(0);
    s.close();
  });

  it("(l) usage.iterations con dos entradas: la factura suma iteraciones, así que unmeasured", async () => {
    const n = red();
    n.cuerpo = () => mensaje({ uso: { ...USO, iterations: [{ input_tokens: 1 }, { input_tokens: 2 }] } });
    const s = anthropicSavings({ silenceWarnings: true });
    const m = await cliente(n, s).messages.create(PEDIDO);
    expect(s.reportFor(m)?.cost.basis).toBe("unmeasured");
    s.close();
  });

  it("(l) paridad con AnthropicProvider: el mismo contador sobre el mismo JSON y el mismo SSE", async () => {
    for (const enStream of [false, true]) {
      const n = red();
      const s = anthropicSavings({ silenceWarnings: true });
      const c = cliente(n, s);
      const pregunta = enStream ? "Name a planet." : "Name a river.";
      const m = enStream
        ? await c.messages.stream({ ...PEDIDO, messages: [{ role: "user", content: pregunta }] }).finalMessage()
        : await c.messages.create({ ...PEDIDO, messages: [{ role: "user", content: pregunta }] });
      const delAdaptador = s.reportFor(m)?.tokens;

      const proveedor = new AnthropicProvider({ apiKey: "test-not-a-key", fetchImpl: n.fetch });
      const req = { model: "claude-sonnet-4-5", messages: [{ role: "user" as const, content: pregunta }] };
      let uso;
      if (enStream) {
        for await (const e of proveedor.generateStream(req)) if (e.type === "done") uso = e.response.usage;
      } else {
        uso = (await proveedor.generate(req)).usage;
      }
      expect(delAdaptador?.actualInput, enStream ? "SSE" : "JSON").toBe(uso?.inputTokens);
      expect(delAdaptador?.actualOutput).toBe(uso?.outputTokens);
      expect(delAdaptador?.providerCachedInput).toBe(uso?.cachedInputTokens);
      s.close();
    }
  });

  it("camino de último recurso del núcleo: JSON y SSE llegan al SDK tal cual, con un intento y su informe", async () => {
    const rota = { get: async () => { throw new Error("cache down"); }, set: async () => {}, delete: async () => {} };
    const n = red();
    const s = anthropicSavings({ silenceWarnings: true, exactCache: rota });
    const c = cliente(n, s);
    const m = await c.messages.create(PEDIDO);
    expect(s.reportFor(m)?.traces.some((t) => t.stage === "fail-open")).toBe(true);
    const fm = await c.messages.stream({ ...PEDIDO, messages: [{ role: "user", content: "Name a shape." }] }).finalMessage();
    expect((fm.content[0] as { text?: string }).text).toBe("Hi there");
    const informe = s.reportFor(fm);
    expect(informe?.streaming).toEqual({ delivery: "whole", wholeReason: "fail-open" });
    expect(informe?.cost.basis).toBe("measured");
    expect(informe?.tokens.actualInput).toBe(10);
    expect(n.llamadas).toHaveLength(2);
    s.close();
  });

  it("un stream que el lector abandona a medias no registra uso", async () => {
    // El proveedor entrega evento a evento: el lector sale tras el primero y el
    // resto no llega a enviarse (no hay contador final que medir).
    const eventos = sse().split(/(?<=\n\n)/);
    const fetchPorEventos = (async () => {
      let i = 0;
      const cuerpo = new ReadableStream<Uint8Array>({
        async pull(controller) {
          await new Promise((r) => setTimeout(r, 5));
          if (i < eventos.length) controller.enqueue(new TextEncoder().encode(eventos[i++]));
          else controller.close();
        },
      });
      return new Response(cuerpo, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const { opciones, registros } = medicion();
    const s = anthropicSavings({ silenceWarnings: true, ...opciones });
    const c = new Anthropic({ apiKey: "test-not-a-key", fetch: fetchPorEventos, middleware: [s.middleware], maxRetries: 0 });
    const stream = await c.messages.create({ ...PEDIDO, stream: true });
    for await (const e of stream) {
      if (e.type === "message_start") break;
    }
    await vaciar();
    expect(registros).toHaveLength(0);
    s.close();
  });

  it("un cuerpo que no es una cadena falla cerrado, sin llamar", async () => {
    const s = anthropicSavings({ silenceWarnings: true });
    let llamado = false;
    const next = async () => {
      llamado = true;
      return new Response("{}");
    };
    const request = { url: "https://api.anthropic.com/v1/messages", method: "POST", headers: new Headers(), body: new Uint8Array([1]) };
    await expect(s.middleware(request as never, next, { options: undefined } as never)).rejects.toThrow(
      "[bvsala] could not read the request body; nothing was sent.",
    );
    expect(llamado).toBe(false);
    s.close();
  });
});
