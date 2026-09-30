import Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { anthropicSavings } from "@bivelio/savings-layer/anthropic-sdk";
import { createSavingsLayer } from "../src/index.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { GoogleProvider } from "../src/providers/google.js";
import { cerrarParada } from "../src/providers/motivo-de-parada.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import type {
  Provider,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
} from "../src/providers/types.js";
import { prohibirLaRed } from "./adaptadores/ayudas.js";

/**
 * EL MOTIVO DE PARADA, CERRADO (0.5, docs/MIGRAR-A-0.5.md §4).
 *
 * `finishReason` es uno de cinco —`stop`, `length`, `tool_calls`,
 * `content_filter`, `other`— para todos los proveedores y en los dos modos
 * (JSON y stream). El literal del proveedor, cuando dice algo más que el valor
 * cerrado, viaja SOLO en `finishReasonDetail`. Aquí: cada adaptador por su
 * cable falso, en JSON y en stream, y el pipeline con un proveedor de terceros
 * que devuelve cadenas crudas (la interfaz `Provider` sigue siendo abierta).
 */

const CERRADO = new Set(["stop", "length", "tool_calls", "content_filter", "other"]);

let restaurarRed: () => void;
beforeAll(() => {
  restaurarRed = prohibirLaRed();
});
afterAll(() => restaurarRed());

type Respuesta = { json?: unknown; sse?: string };

/** Un `fetch` falso que contesta JSON o SSE según lo que devuelva `responder`. */
function cable(responder: (cuerpo: Record<string, unknown>, url: string) => Respuesta): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const cuerpo = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const r = responder(cuerpo, String(url));
    if (r.sse !== undefined) {
      return new Response(r.sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response(JSON.stringify(r.json), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

async function final(it: AsyncIterable<ProviderStreamEvent>): Promise<ProviderResponse> {
  let hecho: ProviderResponse | undefined;
  for await (const e of it) if (e.type === "done") hecho = e.response;
  if (!hecho) throw new Error("el stream no cerró con done");
  return hecho;
}

function esperar(r: { finishReason?: string; finishReasonDetail?: string }, motivo: string, detalle?: string) {
  expect(CERRADO.has(r.finishReason ?? "")).toBe(true);
  expect(r.finishReason).toBe(motivo);
  if (detalle === undefined) expect(r.finishReasonDetail).toBeUndefined();
  else expect(r.finishReasonDetail).toBe(detalle);
}

// ── La tabla ──────────────────────────────────────────────────────────────────

describe("cerrarParada: la tabla", () => {
  it.each([
    ["stop", undefined, "stop", undefined],
    ["end_turn", undefined, "stop", undefined],
    ["STOP", undefined, "stop", undefined],
    ["stop_sequence", undefined, "stop", "stop_sequence"],
    ["length", undefined, "length", undefined],
    ["max_tokens", undefined, "length", undefined],
    ["MAX_TOKENS", undefined, "length", undefined],
    ["model_context_window_exceeded", undefined, "length", "model_context_window_exceeded"],
    ["tool_calls", undefined, "tool_calls", undefined],
    ["tool_use", undefined, "tool_calls", undefined],
    ["function_call", undefined, "tool_calls", "function_call"],
    ["content_filter", undefined, "content_filter", undefined],
    ["content_filter: OTHER", undefined, "content_filter", "OTHER"],
    ["content_filter:PROHIBITED_CONTENT", undefined, "content_filter", "PROHIBITED_CONTENT"],
    ["refusal", undefined, "content_filter", "refusal"],
    ["refusal", "cyber", "content_filter", "cyber"],
    ["SAFETY", undefined, "content_filter", "SAFETY"],
    ["pause_turn", undefined, "other", "pause_turn"],
    ["MALFORMED_FUNCTION_CALL", undefined, "other", "MALFORMED_FUNCTION_CALL"],
    ["cualquier-cosa", undefined, "other", "cualquier-cosa"],
    ["other", "pause_turn", "other", "pause_turn"],
  ])("%s (detalle %s) → %s / %s", (cruda, fino, motivo, detalle) => {
    const r = cerrarParada(cruda, fino);
    esperar(r, motivo, detalle);
    // Idempotente: volver a cerrar lo cerrado no cambia nada.
    expect(cerrarParada(r.finishReason, r.finishReasonDetail)).toEqual(r);
  });

  it("sin parada no hay motivo", () => {
    expect(cerrarParada(undefined)).toEqual({});
    expect(cerrarParada(null)).toEqual({});
    expect(cerrarParada("")).toEqual({});
  });
});

// ── Anthropic (API de Mensajes) ───────────────────────────────────────────────

const PETICION: ProviderRequest = {
  model: "claude-sonnet-4-5",
  messages: [{ role: "user", content: "Name a colour." }],
};

function mensajeAnthropic(stop_reason: string, stop_details?: unknown) {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5",
    content: stop_reason === "refusal" ? [] : [{ type: "text", text: "Blue" }],
    stop_reason,
    stop_sequence: stop_reason === "stop_sequence" ? "###" : null,
    ...(stop_details !== undefined ? { stop_details } : {}),
    usage: { input_tokens: 5, output_tokens: stop_reason === "refusal" ? 0 : 1 },
  };
}

const evA = (tipo: string, data: Record<string, unknown>): string =>
  `event: ${tipo}\ndata: ${JSON.stringify({ type: tipo, ...data })}\n\n`;

function sseAnthropic(stop_reason: string, stop_details?: unknown): string {
  return (
    evA("message_start", {
      message: {
        id: "msg_live",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 1 },
      },
    }) +
    (stop_reason === "refusal"
      ? ""
      : evA("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
        evA("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Blue" } }) +
        evA("content_block_stop", { index: 0 })) +
    evA("message_delta", {
      delta: { stop_reason, stop_sequence: null, ...(stop_details !== undefined ? { stop_details } : {}) },
      usage: { output_tokens: stop_reason === "refusal" ? 0 : 1 },
    }) +
    evA("message_stop", {})
  );
}

const CASOS_ANTHROPIC: [string, unknown, string, string | undefined][] = [
  ["end_turn", undefined, "stop", undefined],
  ["max_tokens", undefined, "length", undefined],
  ["stop_sequence", undefined, "stop", "stop_sequence"],
  ["pause_turn", undefined, "other", "pause_turn"],
  ["refusal", { type: "refusal", category: "cyber" }, "content_filter", "cyber"],
  ["refusal", { type: "refusal", category: null }, "content_filter", "refusal"],
];

describe("AnthropicProvider", () => {
  it.each(CASOS_ANTHROPIC)("JSON: %s → %s", async (parada, detalles, motivo, detalle) => {
    const p = new AnthropicProvider({ apiKey: "test-not-a-key", fetchImpl: cable(() => ({ json: mensajeAnthropic(parada, detalles) })) });
    esperar(await p.generate(PETICION), motivo, detalle);
  });

  it.each(CASOS_ANTHROPIC)("stream: %s → %s", async (parada, detalles, motivo, detalle) => {
    const p = new AnthropicProvider({ apiKey: "test-not-a-key", fetchImpl: cable(() => ({ sse: sseAnthropic(parada, detalles) })) });
    esperar(await final(p.generateStream!(PETICION)), motivo, detalle);
  });
});

// ── OpenAI-compatible (incluido el endpoint compatible de Gemini) ─────────────

const PETICION_OPENAI: ProviderRequest = { model: "gpt-4o-mini", messages: [{ role: "user", content: "Name a colour." }] };

function jsonOpenAI(finish_reason: string) {
  return {
    id: "chatcmpl-1",
    choices: [{ index: 0, message: { role: "assistant", content: "Blue" }, finish_reason }],
    usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
  };
}

function sseOpenAI(finish_reason: string): string {
  const trozos = [
    { id: "c1", choices: [{ index: 0, delta: { role: "assistant", content: "Blue" }, finish_reason: null }] },
    { id: "c1", choices: [{ index: 0, delta: {}, finish_reason }] },
    { id: "c1", choices: [], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } },
  ];
  return trozos.map((t) => `data: ${JSON.stringify(t)}\n\n`).join("") + "data: [DONE]\n\n";
}

const CASOS_OPENAI: [string, string, string | undefined][] = [
  ["stop", "stop", undefined],
  ["length", "length", undefined],
  ["content_filter", "content_filter", undefined],
  ["content_filter: OTHER", "content_filter", "OTHER"],
  ["function_call", "tool_calls", "function_call"],
  ["eos", "stop", "eos"],
  ["abort", "other", "abort"],
];

describe("OpenAICompatibleProvider", () => {
  const nuevo = (fetchImpl: typeof fetch) =>
    new OpenAICompatibleProvider({ baseUrl: "https://example.test/v1", apiKey: "test-not-a-key", fetchImpl });

  it.each(CASOS_OPENAI)("JSON: %s → %s", async (parada, motivo, detalle) => {
    esperar(await nuevo(cable(() => ({ json: jsonOpenAI(parada) }))).generate(PETICION_OPENAI), motivo, detalle);
  });

  it.each(CASOS_OPENAI)("stream: %s → %s", async (parada, motivo, detalle) => {
    const p = nuevo(cable(() => ({ sse: sseOpenAI(parada) })));
    esperar(await final(p.generateStream!(PETICION_OPENAI)), motivo, detalle);
  });
});

// ── Google nativo ────────────────────────────────────────────────────────────

const PETICION_GOOGLE: ProviderRequest = {
  model: "google/gemini-3.8-flash",
  messages: [{ role: "user", content: "Name a colour." }],
};

function jsonGemini(finishReason: string) {
  return {
    candidates: [
      {
        content: { parts: finishReason === "STOP" || finishReason === "MAX_TOKENS" ? [{ text: "Blue" }] : [], role: "model" },
        finishReason,
        index: 0,
      },
    ],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, totalTokenCount: 6 },
    responseId: "r1",
  };
}

const CASOS_GOOGLE: [string, string, string | undefined][] = [
  ["STOP", "stop", undefined],
  ["MAX_TOKENS", "length", undefined],
  ["SAFETY", "content_filter", "SAFETY"],
  ["PROHIBITED_CONTENT", "content_filter", "PROHIBITED_CONTENT"],
  ["MALFORMED_FUNCTION_CALL", "other", "MALFORMED_FUNCTION_CALL"],
  ["UNEXPECTED_TOOL_CALL", "other", "UNEXPECTED_TOOL_CALL"],
];

describe("GoogleProvider", () => {
  const nuevo = (fetchImpl: typeof fetch) => new GoogleProvider({ apiKey: "test-not-a-key", fetchImpl });

  it.each(CASOS_GOOGLE)("JSON: %s → %s", async (parada, motivo, detalle) => {
    esperar(await nuevo(cable(() => ({ json: jsonGemini(parada) }))).generate(PETICION_GOOGLE), motivo, detalle);
  });

  it.each(CASOS_GOOGLE)("stream: %s → %s", async (parada, motivo, detalle) => {
    const p = nuevo(cable(() => ({ sse: `data: ${JSON.stringify(jsonGemini(parada))}\r\n\r\n` })));
    esperar(await final(p.generateStream!(PETICION_GOOGLE)), motivo, detalle);
  });

  it("promptFeedback.blockReason → content_filter con el motivo", async () => {
    const bloqueada = {
      promptFeedback: { blockReason: "PROHIBITED_CONTENT" },
      usageMetadata: { promptTokenCount: 5, totalTokenCount: 5 },
    };
    esperar(await nuevo(cable(() => ({ json: bloqueada }))).generate(PETICION_GOOGLE), "content_filter", "PROHIBITED_CONTENT");
  });
});

// ── El SDK oficial de Anthropic (el adaptador `/anthropic-sdk`) ───────────────
//
// Lo que el cliente del SDK recibe es el Message crudo de Anthropic (con su
// `stop_reason`); lo que la capa normaliza es su libro: `qualityLedger.truncation`.

describe("anthropicSavings (SDK oficial)", () => {
  const PEDIDO = {
    model: "claude-sonnet-4-5",
    max_tokens: 64,
    messages: [{ role: "user" as const, content: "Name a colour." }],
  };

  const cliente = (fetchImpl: typeof fetch, s: ReturnType<typeof anthropicSavings>) =>
    new Anthropic({ apiKey: "test-not-a-key", fetch: fetchImpl, middleware: [s.middleware], maxRetries: 0 });

  const casos = CASOS_ANTHROPIC.filter(([p]) => p !== "refusal");

  it.each(casos)("JSON: %s → %s", async (parada, detalles, motivo, detalle) => {
    const s = anthropicSavings({ silenceWarnings: true });
    const m = await cliente(cable(() => ({ json: mensajeAnthropic(parada, detalles) })), s).messages.create(PEDIDO);
    expect(m.stop_reason).toBe(parada);
    esperar(s.reportFor(m)?.qualityLedger?.truncation ?? {}, motivo, detalle);
    s.close();
  });

  it.each(casos)("stream: %s → %s", async (parada, detalles, motivo, detalle) => {
    const s = anthropicSavings({ silenceWarnings: true });
    const fm = await cliente(cable(() => ({ sse: sseAnthropic(parada, detalles) })), s)
      .messages.stream(PEDIDO)
      .finalMessage();
    esperar(s.reportFor(fm)?.qualityLedger?.truncation ?? {}, motivo, detalle);
    s.close();
  });

  it("una negativa con categoría: content_filter y la categoría como detalle", async () => {
    const s = anthropicSavings({ silenceWarnings: true });
    const m = await cliente(
      cable(() => ({ json: mensajeAnthropic("refusal", { type: "refusal", category: "bio" }) })),
      s,
    ).messages.create(PEDIDO);
    esperar(s.reportFor(m)?.qualityLedger?.truncation ?? {}, "content_filter", "bio");
    s.close();
  });
});

// ── El pipeline, con un proveedor de terceros ────────────────────────────────

class Crudo implements Provider {
  readonly id = "crudo";
  constructor(
    private readonly parada: string,
    private readonly detalle?: string,
  ) {}
  async generate(): Promise<ProviderResponse> {
    return {
      text: "Blue",
      finishReason: this.parada,
      ...(this.detalle !== undefined ? { finishReasonDetail: this.detalle } : {}),
      usage: { inputTokens: 5, outputTokens: 1 },
    };
  }
  async *generateStream(): AsyncIterable<ProviderStreamEvent> {
    yield { type: "text", delta: "Blue" };
    yield { type: "done", response: await this.generate() };
  }
}

describe("el pipeline cierra lo que devuelve un proveedor de terceros", () => {
  it.each([
    ["end_turn", undefined, "stop", undefined],
    ["max_tokens", undefined, "length", undefined],
    ["pause_turn", undefined, "other", "pause_turn"],
    ["content_filter: SPII", undefined, "content_filter", "SPII"],
    ["refusal", "cyber", "content_filter", "cyber"],
  ])("JSON y stream: %s → %s, igual en el resultado y en el libro", async (parada, fino, motivo, detalle) => {
    for (const modo of ["json", "stream"] as const) {
      const layer = createSavingsLayer({ provider: new Crudo(parada, fino), silenceWarnings: true, exactCache: false } as never);
      const peticion = { model: "custom-model", messages: [{ role: "user" as const, content: `Name a colour (${modo} ${parada}).` }] };
      const r =
        modo === "json"
          ? await layer.generate(peticion)
          : await (async () => {
              const s = layer.generateStream(peticion);
              for await (const _ of s) {
                // se consume
              }
              return s.result;
            })();
      esperar(r, motivo, detalle);
      esperar(r.report.qualityLedger?.truncation ?? {}, motivo, detalle);
      expect(r.report.qualityLedger?.truncation?.truncated).toBe(motivo === "length");
    }
  });
});
