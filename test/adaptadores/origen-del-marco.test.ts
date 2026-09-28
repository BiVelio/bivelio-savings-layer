import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { ChatOpenAI } from "@langchain/openai";
import { createAgent } from "langchain";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { SavingsReport } from "../../src/index.js";
import { anthropicSavings } from "@bivelio/savings-layer/anthropic-sdk";
import { getSavingsReportFromMessage, savingsAgentMiddleware } from "@bivelio/savings-layer/langchain";
import { prohibirLaRed } from "./ayudas.js";

/**
 * E0-BIS EN LOS ADAPTADORES DE MARCOS: los que pueden leer a quién habla su
 * cliente por una API PÚBLICA lo atestiguan, y detrás de un proxy la llamada que
 * corre no deja registro de referencia (`unofficial-origin`): su repetición se
 * sirve igual, sin llamar, y sale `estimated`. Contra el origen oficial, todo
 * como siempre.
 *
 *   · SDK de Anthropic: la URL de la petición que ve el middleware.
 *   · LangChain: `ChatOpenAI.identifyingParams().baseURL` (con `@langchain/openai`
 *     de verdad) y el campo público `apiUrl` de `ChatAnthropic` (aquí un modelo
 *     con su misma forma: `@langchain/anthropic` no es dependencia del repo).
 *
 * El AI SDK y Mastra no enseñan su base URL: su origen queda desconocido y la
 * regla no cambia (lo dicen sus cabeceras).
 *
 * Sin red: `fetch` falsos, y ninguna clave real.
 */

let restaurarRed: () => void;
beforeAll(() => {
  restaurarRed = prohibirLaRed();
});
afterAll(() => restaurarRed());

const razonDeLaPoblada = (r: SavingsReport | undefined) =>
  r?.traces.find((t) => t.stage === "reference")?.detail?.["reason"];
const escritaEnLaPoblada = (r: SavingsReport | undefined) => r?.traces.find((t) => t.stage === "reference")?.outcome;

// ─── SDK de Anthropic ───────────────────────────────────────────────────────

function redDeAnthropic() {
  const urls: string[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    urls.push(String(url));
    const pedido = JSON.parse(String(init?.body ?? "{}")) as { stream?: boolean };
    const mensaje = {
      id: `msg_${urls.length}`,
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5",
      content: [{ type: "text", text: "Paris." }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1736, output_tokens: 20 },
    };
    if (pedido.stream) {
      const ev = (e: string, d: unknown) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`;
      const sse =
        ev("message_start", { type: "message_start", message: { ...mensaje, content: [], stop_reason: null, usage: { input_tokens: 1736, output_tokens: 1 } } }) +
        ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
        ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Paris." } }) +
        ev("content_block_stop", { type: "content_block_stop", index: 0 }) +
        ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } }) +
        ev("message_stop", { type: "message_stop" });
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response(JSON.stringify(mensaje), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { urls, fetchImpl };
}

const PEDIDO = {
  model: "claude-haiku-4-5",
  max_tokens: 64,
  temperature: 0,
  messages: [{ role: "user" as const, content: "What is the capital of France?" }],
};

describe("anthropicSavings · el origen es el host de la petición", () => {
  it("contra https://api.anthropic.com: registro escrito y la repetición sale reference", async () => {
    const n = redDeAnthropic();
    const s = anthropicSavings({ silenceWarnings: true });
    const c = new Anthropic({ apiKey: "test-not-a-key", baseURL: "https://api.anthropic.com", fetch: n.fetchImpl, middleware: [s.middleware], maxRetries: 0 });
    const primera = await c.messages.create(PEDIDO);
    const repeticion = await c.messages.create(PEDIDO);
    expect(n.urls).toEqual(["https://api.anthropic.com/v1/messages"]);
    expect(escritaEnLaPoblada(s.reportFor(primera))).toBe("written");
    expect(s.reportFor(repeticion)?.cache.result).toBe("exact");
    expect(s.reportFor(repeticion)?.cost.basis).toBe("reference");
    s.close();
  });

  it("contra un proxy (LiteLLM en local): unofficial-origin, y la repetición se sirve sin llamar pero estimated", async () => {
    const n = redDeAnthropic();
    const s = anthropicSavings({ silenceWarnings: true });
    const c = new Anthropic({ apiKey: "test-not-a-key", baseURL: "http://127.0.0.1:4000", fetch: n.fetchImpl, middleware: [s.middleware], maxRetries: 0 });
    const primera = await c.messages.create(PEDIDO);
    const repeticion = await c.messages.create(PEDIDO);
    expect(n.urls).toEqual(["http://127.0.0.1:4000/v1/messages"]);
    expect(s.reportFor(primera)?.cost.basis).toBe("measured");
    expect(razonDeLaPoblada(s.reportFor(primera))).toBe("unofficial-origin");
    const informe = s.reportFor(repeticion);
    expect(informe?.cache.result).toBe("exact");
    expect(informe?.cost.basis).toBe("estimated");
    expect(informe?.cache.referenceRejected).toBe("absent");
    s.close();
  });

  it("…también en stream", async () => {
    const n = redDeAnthropic();
    const s = anthropicSavings({ silenceWarnings: true });
    const c = new Anthropic({ apiKey: "test-not-a-key", baseURL: "http://127.0.0.1:4000", fetch: n.fetchImpl, middleware: [s.middleware], maxRetries: 0 });
    const primera = await c.messages.stream(PEDIDO).finalMessage();
    expect(s.reportFor(primera)?.cost.basis).toBe("measured");
    expect(razonDeLaPoblada(s.reportFor(primera))).toBe("unofficial-origin");
    const repeticion = await c.messages.create(PEDIDO);
    expect(n.urls).toHaveLength(1);
    expect(s.reportFor(repeticion)?.cost.basis).toBe("estimated");
    s.close();
  });
});

// ─── LangChain ──────────────────────────────────────────────────────────────

/** Chat Completions (y la Responses API, por si ChatOpenAI la elige) con un contador. */
function redDeOpenAI() {
  const urls: string[] = [];
  const fetchImpl = (async (entrada: string | URL | Request, init?: RequestInit) => {
    const url = typeof entrada === "string" ? entrada : entrada instanceof URL ? entrada.href : entrada.url;
    urls.push(url);
    const pedido = JSON.parse(String(init?.body ?? "{}")) as { stream?: boolean };
    if (url.endsWith("/responses")) {
      return new Response(
        JSON.stringify({
          id: "resp_1",
          object: "response",
          created_at: 1,
          status: "completed",
          model: "gpt-4o-mini",
          output: [{ type: "message", id: "m1", status: "completed", role: "assistant", content: [{ type: "output_text", text: "Paris.", annotations: [] }] }],
          usage: { input_tokens: 1736, output_tokens: 20, total_tokens: 1756, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (!url.endsWith("/chat/completions")) throw new Error(`[test] red inesperada: ${url}`);
    const uso = { prompt_tokens: 1736, completion_tokens: 20, total_tokens: 1756, completion_tokens_details: { reasoning_tokens: 0 } };
    if (pedido.stream) {
      const trozo = (d: unknown) => `data: ${JSON.stringify(d)}\n\n`;
      const sse =
        trozo({ id: "c", object: "chat.completion.chunk", created: 1, model: "gpt-4o-mini", choices: [{ index: 0, delta: { role: "assistant", content: "Paris." }, finish_reason: null }] }) +
        trozo({ id: "c", object: "chat.completion.chunk", created: 1, model: "gpt-4o-mini", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
        trozo({ id: "c", object: "chat.completion.chunk", created: 1, model: "gpt-4o-mini", choices: [], usage: uso }) +
        "data: [DONE]\n\n";
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response(
      JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 1,
        model: "gpt-4o-mini",
        choices: [{ index: 0, message: { role: "assistant", content: "Paris." }, logprobs: null, finish_reason: "stop" }],
        usage: uso,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { urls, fetchImpl };
}

const PREGUNTA = { messages: [{ role: "user", content: "What is the capital of France?" }] };

function ultimo(r: { messages: BaseMessage[] }): BaseMessage {
  return r.messages[r.messages.length - 1] as BaseMessage;
}

async function dosVecesConElAgente(model: BaseChatModel) {
  const mw = savingsAgentMiddleware({ silenceWarnings: true });
  try {
    const agente = createAgent({ model, tools: [], middleware: [mw] });
    const primera = getSavingsReportFromMessage(ultimo(await agente.invoke(PREGUNTA)));
    const repeticion = getSavingsReportFromMessage(ultimo(await agente.invoke(PREGUNTA)));
    return { primera, repeticion };
  } finally {
    mw.close();
  }
}

const chatOpenAI = (baseURL: string, fetchImpl: typeof fetch) =>
  new ChatOpenAI({ model: "gpt-4o-mini", temperature: 0, apiKey: "test-not-a-key", configuration: { baseURL, fetch: fetchImpl } });

describe("savingsAgentMiddleware · ChatOpenAI, por `identifyingParams().baseURL`", () => {
  it("la API pública da la base URL que se configuró", () => {
    const m = chatOpenAI("http://127.0.0.1:4000/v1", redDeOpenAI().fetchImpl);
    expect((m.identifyingParams() as { baseURL?: unknown }).baseURL).toBe("http://127.0.0.1:4000/v1");
  });

  it("contra https://api.openai.com/v1: registro escrito y la repetición sale reference", async () => {
    const n = redDeOpenAI();
    const { primera, repeticion } = await dosVecesConElAgente(chatOpenAI("https://api.openai.com/v1", n.fetchImpl));
    expect(n.urls).toHaveLength(1);
    expect(n.urls[0]!.startsWith("https://api.openai.com/v1/")).toBe(true);
    expect(primera?.model).toBe("openai/gpt-4o-mini");
    expect(escritaEnLaPoblada(primera)).toBe("written");
    expect(repeticion?.cache.result).toBe("exact");
    expect(repeticion?.cost.basis).toBe("reference");
  });

  it("contra un proxy: unofficial-origin, y la repetición sale estimated", async () => {
    const n = redDeOpenAI();
    const { primera, repeticion } = await dosVecesConElAgente(chatOpenAI("http://127.0.0.1:4000/v1", n.fetchImpl));
    expect(n.urls).toHaveLength(1);
    expect(n.urls[0]!.startsWith("http://127.0.0.1:4000/v1/")).toBe(true);
    expect(primera?.cost.basis).toBe("measured");
    expect(razonDeLaPoblada(primera)).toBe("unofficial-origin");
    expect(repeticion?.cache.result).toBe("exact");
    expect(repeticion?.cost.basis).toBe("estimated");
    expect(repeticion?.cache.referenceRejected).toBe("absent");
  });
});

/**
 * Un modelo con la forma PÚBLICA de `ChatAnthropic` de @langchain/anthropic 1.5:
 * `_llmType()` "anthropic", el campo `apiUrl` ya resuelto, e
 * `identifyingParams()` sin la URL.
 */
class ComoChatAnthropic extends BaseChatModel {
  model = "claude-haiku-4-5";
  temperature = 0;
  llamadas = 0;
  constructor(readonly apiUrl: string | undefined) {
    super({});
  }
  override _llmType(): string {
    return "anthropic";
  }
  identifyingParams(): Record<string, unknown> {
    return { model_name: this.model };
  }
  override bindTools(): this {
    return this;
  }
  override async _generate() {
    this.llamadas += 1;
    const message = new AIMessage({
      content: "Paris.",
      usage_metadata: { input_tokens: 1736, output_tokens: 20, total_tokens: 1756 },
      response_metadata: { stop_reason: "end_turn" },
    });
    return { generations: [{ text: "Paris.", message }] };
  }
}

describe("savingsAgentMiddleware · ChatAnthropic, por su campo público `apiUrl`", () => {
  it("apiUrl oficial: reference; apiUrl de un proxy: unofficial-origin y estimated", async () => {
    const oficial = await dosVecesConElAgente(new ComoChatAnthropic("https://api.anthropic.com"));
    expect(oficial.primera?.model).toBe("anthropic/claude-haiku-4-5");
    expect(escritaEnLaPoblada(oficial.primera)).toBe("written");
    expect(oficial.repeticion?.cost.basis).toBe("reference");

    const m = new ComoChatAnthropic("http://127.0.0.1:4000");
    const proxy = await dosVecesConElAgente(m);
    expect(m.llamadas).toBe(1);
    expect(razonDeLaPoblada(proxy.primera)).toBe("unofficial-origin");
    expect(proxy.repeticion?.cache.result).toBe("exact");
    expect(proxy.repeticion?.cost.basis).toBe("estimated");
  });

  it("sin apiUrl (puede tener un `createClient` propio): desconocido, y todo como siempre", async () => {
    const { primera, repeticion } = await dosVecesConElAgente(new ComoChatAnthropic(undefined));
    expect(escritaEnLaPoblada(primera)).toBe("written");
    expect(repeticion?.cost.basis).toBe("reference");
  });
});
