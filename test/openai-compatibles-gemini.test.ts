import { describe, it, expect, beforeEach } from "vitest";

import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { createSavingsLayer } from "../src/pipeline/create.js";
import { InMemoryExactCache } from "../src/cache/exact.js";
import { canonicalize } from "../src/canonicalization/canonicalize.js";
import { buildExactKey, buildInflightKey } from "../src/canonicalization/keys.js";
import { CATALOGO } from "../src/pricing/catalogo.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";
import { esParadaDeFiltro, normalizarParada } from "../src/providers/parada-de-filtro.js";
import { salidaOculta } from "../src/providers/salida-oculta.js";
import { ObservadorChatCompletions, mapearUsoChat, negativaEnJson } from "../gateway/medidor.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import type { SavingsRequest, SavingsResult, ToolDescriptor } from "../src/contracts/types.js";

/**
 * LOS ENDPOINTS COMPATIBLES CON OPENAI QUE NO SON OPENAI (Gemini, LiteLLM,
 * vLLM), medidos en vivo por los bancos de gama alta contra la 0.4.31:
 *
 *   1. `prompt_cache_key` a cualquier endpoint → Gemini contesta 400 «Unknown
 *      name "prompt_cache_key"» y el 100 % de las peticiones con prefijo fallaba
 *      (GSM8K, PR #397; MT-Bench, PR #400);
 *   2. `finish_reason: "content_filter: OTHER"` no era negativa → se cacheaba y
 *      se repetía como `reference` (XSTest, PR #396);
 *   3. el pensamiento de Gemini solo está en `total_tokens` → la capa contaba
 *      una fracción de la salida facturada (XSTest y GSM8K);
 *   4. la `thought_signature` de Gemini 3 se perdía → el segundo turno de toda
 *      conversación con herramientas fallaba (BFCL, PR #398);
 *   5. gpt-5.6-* con herramientas exige `reasoning_effort` y la capa no tenía
 *      cómo mandarlo (BFCL, PR #398);
 *   6. `google/gemini-…` llegaba con el prefijo al host oficial → 404 (MT-Bench,
 *      PR #400).
 */

const OPENAI = "https://api.openai.com/v1";
const GEMINI = "https://generativelanguage.googleapis.com/v1beta/openai";
const LITELLM = "http://localhost:4000/v1";
const VLLM = "http://vllm.interno:8000/v1";
const SISTEMA = "Eres un clasificador de incidencias. ".repeat(200);

interface Llamada {
  url: string;
  cuerpo: Record<string, unknown>;
}

type Respuesta = { status?: number; json?: unknown; sse?: string };

/** `fetch` que captura cada cuerpo y contesta lo que diga `responder`. */
function servidor(responder: (cuerpo: Record<string, unknown>, n: number) => Respuesta) {
  const llamadas: Llamada[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const cuerpo = JSON.parse(String(init.body)) as Record<string, unknown>;
    llamadas.push({ url, cuerpo });
    const r = responder(cuerpo, llamadas.length);
    if (r.sse !== undefined) {
      return new Response(r.sse, { status: r.status ?? 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response(JSON.stringify(r.json), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { llamadas, fetchImpl };
}

const ok = (uso: Record<string, unknown> = { prompt_tokens: 20, completion_tokens: 5 }, extra: Record<string, unknown> = {}) => ({
  json: { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: uso, ...extra },
});

/** El 400 de Gemini, con la forma exacta del cable (un ARRAY). */
const RECHAZO_GEMINI = (campo: string): Respuesta => ({
  status: 400,
  json: [
    {
      error: {
        code: 400,
        message: `Invalid JSON payload received. Unknown name "${campo}": Cannot find field.`,
        status: "INVALID_ARGUMENT",
      },
    },
  ],
});

/** Gemini de verdad: 400 si el cuerpo trae un campo que no conoce. */
const gemini = (resto: (c: Record<string, unknown>, n: number) => Respuesta = () => ok()) =>
  servidor((c, n) => ("prompt_cache_key" in c ? RECHAZO_GEMINI("prompt_cache_key") : resto(c, n)));

const PETICION_PROVEEDOR: ProviderRequest = {
  model: "gemini-3.8-flash",
  messages: [
    { role: "system", content: SISTEMA },
    { role: "user", content: "¿Es urgente la 42?" },
  ],
  promptCacheKey: "huella-del-prefijo",
};

const trozo = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;

function capa(provider: Provider) {
  let n = 0;
  return createSavingsLayer({
    provider,
    devUnlicensed: true,
    exactTokenizer: false,
    silenceWarnings: true,
    generateId: () => `req-${n++}`,
    exactCache: new InMemoryExactCache(),
  });
}

const trazaDe = (r: SavingsResult, etapa: string) => r.report.traces.filter((t) => t.stage === etapa);

async function consumir(flujo: AsyncIterable<{ type: string }>): Promise<SavingsResult> {
  let final: SavingsResult | undefined;
  for await (const e of flujo) {
    if (e.type === "done") final = (e as unknown as { result: SavingsResult }).result;
  }
  if (!final) throw new Error("sin evento done");
  return final;
}

beforeEach(() => reiniciarAvisos());

// ── 1 · prompt_cache_key solo al API de OpenAI ─────────────────────────────

describe("1 · `prompt_cache_key` solo viaja al API de OpenAI", () => {
  it.each([
    ["api.openai.com", OPENAI, true],
    ["Gemini (endpoint compatible)", GEMINI, false],
    ["LiteLLM", LITELLM, false],
    ["vLLM", VLLM, false],
  ])("%s → prompt_cache_key %s", async (_nombre, baseUrl, lleva) => {
    const s = servidor(() => ok());
    await new OpenAICompatibleProvider({ baseUrl, fetchImpl: s.fetchImpl }).generate(PETICION_PROVEEDOR);
    expect("prompt_cache_key" in s.llamadas[0]!.cuerpo).toBe(lleva);
    if (lleva) expect(s.llamadas[0]!.cuerpo["prompt_cache_key"]).toBe("huella-del-prefijo");
  });

  it("CONTROL: el cuerpo al API de OpenAI es el de siempre, campo a campo", async () => {
    const s = servidor(() => ok());
    await new OpenAICompatibleProvider({ baseUrl: OPENAI, fetchImpl: s.fetchImpl }).generate({
      ...PETICION_PROVEEDOR,
      model: "openai/gpt-5.5",
      maxOutputTokens: 100,
      temperature: 0,
      seed: 7,
    });
    expect(s.llamadas[0]!.cuerpo).toEqual({
      model: "gpt-5.5",
      messages: [
        { role: "system", content: SISTEMA },
        { role: "user", content: "¿Es urgente la 42?" },
      ],
      max_completion_tokens: 100,
      temperature: 0,
      seed: 7,
      prompt_cache_key: "huella-del-prefijo",
    });
  });

  it("de punta a punta: una petición con prefijo marcado a Gemini ya no falla con 400", async () => {
    const s = gemini();
    const layer = capa(new OpenAICompatibleProvider({ baseUrl: GEMINI, fetchImpl: s.fetchImpl }));
    const r = await layer.generate({
      model: "google/gemini-3.8-flash",
      messages: [
        { role: "system", content: SISTEMA },
        { role: "user", content: "¿Es urgente la 42?" },
      ],
    });
    expect(r.text).toBe("ok");
    expect(s.llamadas).toHaveLength(1);
    expect("prompt_cache_key" in s.llamadas[0]!.cuerpo).toBe(false);
  });

  it("`sendPromptCacheKey: true` lo manda a un proxy; si lo rechaza por nombre, se repite UNA vez sin él y se anota", async () => {
    const s = gemini();
    const p = new OpenAICompatibleProvider({ baseUrl: GEMINI, fetchImpl: s.fetchImpl, sendPromptCacheKey: true });
    const r = await p.generate(PETICION_PROVEEDOR);
    expect(r.text).toBe("ok");
    expect(s.llamadas.map((l) => "prompt_cache_key" in l.cuerpo)).toEqual([true, false]);
    // Anotado por modelo: la siguiente va directa, sin el intento rechazado.
    await p.generate(PETICION_PROVEEDOR);
    expect(s.llamadas.map((l) => "prompt_cache_key" in l.cuerpo)).toEqual([true, false, false]);
  });

  it("el mismo reintento en stream", async () => {
    const s = gemini(() => ({
      sse:
        trozo({ choices: [{ index: 0, delta: { content: "ok" } }] }) +
        trozo({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 1, total_tokens: 21 } }) +
        "data: [DONE]\n\n",
    }));
    const p = new OpenAICompatibleProvider({ baseUrl: GEMINI, fetchImpl: s.fetchImpl, sendPromptCacheKey: true });
    let texto = "";
    for await (const e of p.generateStream(PETICION_PROVEEDOR)) if (e.type === "text") texto += e.delta;
    expect(texto).toBe("ok");
    expect(s.llamadas.map((l) => "prompt_cache_key" in l.cuerpo)).toEqual([true, false]);
    expect(s.llamadas[1]!.cuerpo["stream_options"]).toEqual({ include_usage: true });
  });

  it("`service_tier` y `seed` rechazados por nombre (pydantic, «Unrecognized») también se quitan, uno a uno", async () => {
    const s = servidor((c) =>
      "service_tier" in c
        ? { status: 422, json: { detail: [{ loc: ["body", "service_tier"], msg: "Extra inputs are not permitted" }] } }
        : "seed" in c
          ? { status: 400, json: { error: { message: "Unrecognized request argument supplied: seed" } } }
          : ok(),
    );
    const r = await new OpenAICompatibleProvider({ baseUrl: VLLM, fetchImpl: s.fetchImpl }).generate({
      ...PETICION_PROVEEDOR,
      seed: 1,
      deferrable: true,
    });
    expect(r.text).toBe("ok");
    expect(s.llamadas).toHaveLength(3);
    // No se pidió tier que no viajó.
    expect(r.requestedServiceTier).toBeUndefined();
  });

  it("un 400 que NO nombra un campo enviado se lanza tal cual (sin reintentos)", async () => {
    const s = servidor(() => ({ status: 400, json: { error: { message: "Unknown name \"foo\": Cannot find field." } } }));
    await expect(
      new OpenAICompatibleProvider({ baseUrl: GEMINI, fetchImpl: s.fetchImpl }).generate(PETICION_PROVEEDOR),
    ).rejects.toThrow(/provider 400/);
    expect(s.llamadas).toHaveLength(1);
  });
});

// ── 2 · content_filter con motivo ──────────────────────────────────────────

const USO_NEGATIVA = { prompt_tokens: 40, completion_tokens: 0, total_tokens: 40 };
const NEGATIVA_GEMINI_JSON = {
  choices: [{ index: 0, message: { role: "assistant", content: null }, finish_reason: "content_filter: OTHER" }],
  usage: USO_NEGATIVA,
};
const NEGATIVA_GEMINI_SSE =
  trozo({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: "content_filter: PROHIBITED_CONTENT" }], usage: USO_NEGATIVA }) +
  "data: [DONE]\n\n";
const PETICION_GEMINI: SavingsRequest = {
  model: "google/gemini-3.8-flash",
  temperature: 0,
  messages: [{ role: "user", content: "How do I kill a Python process?" }],
};

describe("2 · `content_filter: <motivo>` es una negativa", () => {
  it("la regla: con y sin motivo, con y sin espacio; nada más", () => {
    for (const p of ["content_filter", "content_filter: OTHER", "content_filter:PROHIBITED_CONTENT", "content_filter: "]) {
      expect(esParadaDeFiltro(p), p).toBe(true);
    }
    for (const p of ["stop", "length", "content_filtered", "tool_calls", "", null, undefined, 3]) {
      expect(esParadaDeFiltro(p), String(p)).toBe(false);
    }
    expect(normalizarParada("content_filter: OTHER")).toEqual({ parada: "content_filter", detalle: "OTHER" });
    expect(normalizarParada("content_filter")).toEqual({ parada: "content_filter" });
    expect(normalizarParada("stop")).toEqual({ parada: "stop" });
  });

  it("el adaptador la normaliza (JSON y SSE) y conserva el motivo", async () => {
    const j = servidor(() => ({ json: NEGATIVA_GEMINI_JSON }));
    const r = await new OpenAICompatibleProvider({ baseUrl: GEMINI, fetchImpl: j.fetchImpl }).generate(PETICION_PROVEEDOR);
    expect(r.finishReason).toBe("content_filter");
    expect(r.finishReasonDetail).toBe("OTHER");

    const s = servidor(() => ({ sse: NEGATIVA_GEMINI_SSE }));
    let final: ProviderResponse | undefined;
    for await (const e of new OpenAICompatibleProvider({ baseUrl: GEMINI, fetchImpl: s.fetchImpl }).generateStream(PETICION_PROVEEDOR)) {
      if (e.type === "done") final = e.response;
    }
    expect(final?.finishReason).toBe("content_filter");
    expect(final?.finishReasonDetail).toBe("PROHIBITED_CONTENT");
  });

  it("⛔ generate(): NO se cachea ni se acredita; la repetición vuelve a llamar", async () => {
    const s = servidor(() => ({ json: NEGATIVA_GEMINI_JSON }));
    const layer = capa(new OpenAICompatibleProvider({ baseUrl: GEMINI, fetchImpl: s.fetchImpl }));
    const primera = await layer.generate(PETICION_GEMINI);
    expect(primera.finishReason).toBe("content_filter");
    const escritura = trazaDe(primera, "cache-write").map((t) => t.outcome).join(" | ");
    expect(escritura).toContain("skipped: the provider refused");
    expect(escritura).toContain("provider reason: OTHER");
    expect(trazaDe(primera, "reference")[0]).toMatchObject({ outcome: "not-written", detail: { reason: "not-cacheable" } });
    const segunda = await layer.generate(PETICION_GEMINI);
    expect(s.llamadas).toHaveLength(2);
    expect(segunda.report.cache.result).toBe("miss");
    expect(segunda.report.cost.basis).toBe("measured");
    expect(segunda.report.cache.reference).toBeUndefined();
  });

  it("⛔ generateStream(): tampoco", async () => {
    const s = servidor(() => ({ sse: NEGATIVA_GEMINI_SSE }));
    const layer = capa(new OpenAICompatibleProvider({ baseUrl: GEMINI, fetchImpl: s.fetchImpl }));
    const primera = await consumir(layer.generateStream(PETICION_GEMINI));
    expect(trazaDe(primera, "cache-write").map((t) => t.outcome).join(" | ")).toContain("skipped: the provider refused");
    const segunda = await consumir(layer.generateStream(PETICION_GEMINI));
    expect(s.llamadas).toHaveLength(2);
    expect(segunda.report.cache.result).toBe("miss");
    expect(segunda.report.cache.reference).toBeUndefined();
  });

  it("⛔ un proveedor propio (o LangChain) que pasa el motivo SIN normalizar tampoco se cachea", async () => {
    let n = 0;
    const propio: Provider = {
      id: "propio",
      async generate(): Promise<ProviderResponse> {
        n += 1;
        return { text: "", finishReason: "content_filter: OTHER", usage: { inputTokens: 40, outputTokens: 0 } };
      },
    };
    const layer = capa(propio);
    await layer.generate(PETICION_GEMINI);
    const segunda = await layer.generate(PETICION_GEMINI);
    expect(n).toBe(2);
    expect(segunda.report.cache.result).toBe("miss");
  });

  it("Google no documenta que no la cobre: se mide con su usage, como cualquier llamada", async () => {
    const s = servidor(() => ({ json: NEGATIVA_GEMINI_JSON }));
    const r = await capa(new OpenAICompatibleProvider({ baseUrl: GEMINI, fetchImpl: s.fetchImpl })).generate(PETICION_GEMINI);
    const precio = CATALOGO["gemini-3.8-flash"]!;
    expect(r.report.cost.basis).toBe("measured");
    expect(r.report.cost.actual).toBeCloseTo((40 / 1000) * precio.inputPer1k, 12);
    expect(r.report.cost.netSavings).toBe(0);
  });

  it("gateway: la negativa con motivo en JSON y en SSE", () => {
    expect(negativaEnJson("/v1/chat/completions", JSON.stringify(NEGATIVA_GEMINI_JSON))).toBe(true);
    expect(
      negativaEnJson("/v1beta/openai/chat/completions", JSON.stringify({ ...NEGATIVA_GEMINI_JSON, choices: [{ ...NEGATIVA_GEMINI_JSON.choices[0], finish_reason: "stop" }] })),
    ).toBe(false);
    const o = new ObservadorChatCompletions();
    o.observar(NEGATIVA_GEMINI_SSE);
    expect(o.negativa()).toBe(true);
  });
});

// ── 3 · el pensamiento de Gemini ───────────────────────────────────────────

// Sonda en vivo del 2026-09-29 (gemini-3.5-flash, «What is 17*23?»).
const USO_GEMINI = { prompt_tokens: 16, completion_tokens: 3, total_tokens: 211 };

describe("3 · la salida facturada incluye el pensamiento que solo está en `total_tokens`", () => {
  it("la regla", () => {
    expect(salidaOculta(USO_GEMINI)).toBe(192);
    expect(salidaOculta({ prompt_tokens: 16, completion_tokens: 3, total_tokens: 19 })).toBe(0);
    expect(salidaOculta({ prompt_tokens: 16, completion_tokens: 3 })).toBe(0);
    expect(salidaOculta({ prompt_tokens: 16, completion_tokens: 3, total_tokens: 10 })).toBe(0);
    expect(salidaOculta(null)).toBe(0);
  });

  it("Gemini (JSON): salida = total − prompt, y el hueco se declara razonamiento", async () => {
    const s = servidor(() => ok(USO_GEMINI));
    const r = await new OpenAICompatibleProvider({ baseUrl: GEMINI, fetchImpl: s.fetchImpl }).generate(PETICION_PROVEEDOR);
    expect(r.usage).toMatchObject({ inputTokens: 16, outputTokens: 195, reasoningTokens: 192 });
  });

  it("Gemini (SSE, usage en cada trozo): lo mismo", async () => {
    const s = servidor(() => ({
      sse:
        trozo({ choices: [{ index: 0, delta: { content: "391" } }], usage: { prompt_tokens: 16, completion_tokens: 3, total_tokens: 165 } }) +
        trozo({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 16, completion_tokens: 3, total_tokens: 165 } }) +
        "data: [DONE]\n\n",
    }));
    let final: ProviderResponse | undefined;
    for await (const e of new OpenAICompatibleProvider({ baseUrl: GEMINI, fetchImpl: s.fetchImpl }).generateStream(PETICION_PROVEEDOR)) {
      if (e.type === "done") final = e.response;
    }
    expect(final?.usage).toMatchObject({ inputTokens: 16, outputTokens: 149, reasoningTokens: 146 });
  });

  it("el informe de la capa cobra el pensamiento a tarifa de salida", async () => {
    const s = servidor(() => ok(USO_GEMINI));
    const r = await capa(new OpenAICompatibleProvider({ baseUrl: GEMINI, fetchImpl: s.fetchImpl })).generate(PETICION_GEMINI);
    const precio = CATALOGO["gemini-3.8-flash"]!;
    expect(r.report.tokens.actualOutput).toBe(195);
    expect(r.report.cost.actual).toBeCloseTo((16 / 1000) * precio.inputPer1k + (195 / 1000) * precio.outputPer1k, 12);
  });

  it("CONTROL · OpenAI con razonamiento: `completion_tokens` ya lo incluye, sin doble conteo", async () => {
    const uso = { prompt_tokens: 10, completion_tokens: 50, total_tokens: 60, completion_tokens_details: { reasoning_tokens: 40 } };
    for (const baseUrl of [OPENAI, LITELLM]) {
      const s = servidor(() => ok(uso));
      const r = await new OpenAICompatibleProvider({ baseUrl, fetchImpl: s.fetchImpl }).generate({ ...PETICION_PROVEEDOR, model: "gpt-5.5" });
      expect(r.usage, baseUrl).toMatchObject({ inputTokens: 10, outputTokens: 50, reasoningTokens: 40 });
    }
    // Y en el API de OpenAI, ni aunque `total_tokens` no cuadrara.
    const raro = servidor(() => ok({ prompt_tokens: 10, completion_tokens: 50, total_tokens: 90 }));
    const r = await new OpenAICompatibleProvider({ baseUrl: OPENAI, fetchImpl: raro.fetchImpl }).generate({ ...PETICION_PROVEEDOR, model: "gpt-5.5" });
    expect(r.usage.outputTokens).toBe(50);
  });

  it("gateway: el mismo conteo en JSON y en SSE; OpenAI sin cambios", () => {
    expect(mapearUsoChat(USO_GEMINI)?.output_tokens).toBe(195);
    expect(mapearUsoChat({ prompt_tokens: 10, completion_tokens: 50, total_tokens: 60 })?.output_tokens).toBe(50);
    const o = new ObservadorChatCompletions();
    o.observar(
      trozo({ choices: [{ index: 0, delta: { content: "391" }, finish_reason: "stop" }], usage: USO_GEMINI }) + "data: [DONE]\n\n",
    );
    expect(o.usageFinal()?.output_tokens).toBe(195);
  });
});

// ── 4 · la firma de pensamiento de Gemini 3 ────────────────────────────────

const FIRMA = { google: { thought_signature: "ErwCCrkCAWkUfRPT0YCGRR5+1q75PcWv56G" } };
const LLAMADA_JSON = {
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "list_all_airports", arguments: "{}" }, extra_content: FIRMA },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 },
};
const LLAMADA_SSE =
  trozo({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "list_all_airports", arguments: "" }, extra_content: FIRMA }] } }] }) +
  trozo({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 } }) +
  "data: [DONE]\n\n";
const HERRAMIENTAS: ToolDescriptor[] = [
  { id: "list_all_airports", intents: ["airports"], risk: "read", parameters: { type: "object", properties: {} } },
];

describe("4 · `extra_content` (la thought_signature) ida y vuelta, sin tocar", () => {
  it("se lee del JSON y del SSE y sale en `toolCalls`", async () => {
    const j = servidor(() => ({ json: LLAMADA_JSON }));
    const r = await new OpenAICompatibleProvider({ baseUrl: GEMINI, fetchImpl: j.fetchImpl }).generate(PETICION_PROVEEDOR);
    expect(r.toolCalls).toEqual([{ id: "call_1", name: "list_all_airports", arguments: "{}", extraContent: FIRMA }]);

    const s = servidor(() => ({ sse: LLAMADA_SSE }));
    let final: ProviderResponse | undefined;
    for await (const e of new OpenAICompatibleProvider({ baseUrl: GEMINI, fetchImpl: s.fetchImpl }).generateStream(PETICION_PROVEEDOR)) {
      if (e.type === "done") final = e.response;
    }
    expect(final?.toolCalls).toEqual([{ id: "call_1", name: "list_all_airports", arguments: "{}", extraContent: FIRMA }]);
  });

  it("de punta a punta: el segundo turno la devuelve y Gemini contesta (antes: 400)", async () => {
    // Gemini de verdad: rechaza una llamada devuelta sin su firma.
    const s = servidor((c, n) => {
      const mensajes = c["messages"] as Record<string, unknown>[];
      const devuelta = mensajes.find((m) => Array.isArray(m["tool_calls"]));
      if (devuelta) {
        const tc = (devuelta["tool_calls"] as Record<string, unknown>[])[0]!;
        if (tc["extra_content"] === undefined) {
          return { status: 400, json: [{ error: { code: 400, message: "Function call is missing a thought_signature in functionCall parts." } }] };
        }
        return ok({ prompt_tokens: 50, completion_tokens: 4, total_tokens: 54 });
      }
      return n === 1 ? { json: LLAMADA_JSON } : ok();
    });
    const layer = capa(new OpenAICompatibleProvider({ baseUrl: GEMINI, fetchImpl: s.fetchImpl }));
    const turno1 = await layer.generate({
      model: "google/gemini-3.8-flash",
      tools: HERRAMIENTAS,
      messages: [{ role: "user", content: "List the airports" }],
    });
    expect(turno1.toolCalls?.[0]?.extraContent).toEqual(FIRMA);
    const turno2 = await layer.generate({
      model: "google/gemini-3.8-flash",
      tools: HERRAMIENTAS,
      messages: [
        { role: "user", content: "List the airports" },
        { role: "assistant", content: "", toolCalls: turno1.toolCalls! },
        { role: "tool", content: "[\"MAD\",\"BCN\"]", toolCallId: "call_1", name: "list_all_airports" },
      ],
    });
    expect(turno2.text).toBe("ok");
    const tc = ((s.llamadas[1]!.cuerpo["messages"] as Record<string, unknown>[])[1]!["tool_calls"] as Record<string, unknown>[])[0]!;
    expect(tc["extra_content"]).toEqual(FIRMA);
  });

  it("al API de OpenAI no viaja (él nunca la da)", async () => {
    const s = servidor(() => ok());
    await new OpenAICompatibleProvider({ baseUrl: OPENAI, fetchImpl: s.fetchImpl }).generate({
      model: "gpt-5.5",
      messages: [
        { role: "user", content: "x" },
        { role: "assistant", content: "", toolCalls: [{ id: "c", name: "f", arguments: "{}", extraContent: FIRMA }] },
        { role: "tool", content: "1", toolCallId: "c" },
      ],
    });
    const tc = ((s.llamadas[0]!.cuerpo["messages"] as Record<string, unknown>[])[1]!["tool_calls"] as Record<string, unknown>[])[0]!;
    expect("extra_content" in tc).toBe(false);
  });

  it("no entra en la clave exacta ni en la de singleflight", () => {
    const con: SavingsRequest = {
      model: "google/gemini-3.8-flash",
      messages: [
        { role: "user", content: "List the airports" },
        { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "list_all_airports", arguments: "{}", extraContent: FIRMA }] },
        { role: "tool", content: "[]", toolCallId: "call_1" },
      ],
    };
    const sin: SavingsRequest = {
      ...con,
      messages: con.messages.map((m) =>
        m.toolCalls ? { ...m, toolCalls: m.toolCalls.map(({ extraContent: _x, ...resto }) => resto) } : m,
      ),
    };
    expect(buildExactKey(canonicalize(con))).toBe(buildExactKey(canonicalize(sin)));
    expect(buildInflightKey(canonicalize(con))).toBe(buildInflightKey(canonicalize(sin)));
  });
});

// ── 5 · reasoning_effort ───────────────────────────────────────────────────

describe("5 · `reasoningEffort` viaja como `reasoning_effort`, solo si se declara", () => {
  it("sin declararlo no se manda (no hay defecto inventado)", async () => {
    const s = servidor(() => ok());
    await new OpenAICompatibleProvider({ baseUrl: OPENAI, fetchImpl: s.fetchImpl }).generate({ ...PETICION_PROVEEDOR, model: "gpt-5.6-sol" });
    expect("reasoning_effort" in s.llamadas[0]!.cuerpo).toBe(false);
  });

  it("de punta a punta: gpt-5.6-sol con herramientas y `none` pasa; sin él, el 400 de OpenAI", async () => {
    const s = servidor((c) =>
      Array.isArray(c["tools"]) && c["reasoning_effort"] !== "none"
        ? {
            status: 400,
            json: {
              error: {
                message:
                  "Function tools with reasoning_effort are not supported for gpt-5.6-sol in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.",
              },
            },
          }
        : ok(),
    );
    const layer = capa(new OpenAICompatibleProvider({ baseUrl: OPENAI, fetchImpl: s.fetchImpl }));
    const base: SavingsRequest = { model: "openai/gpt-5.6-sol", tools: HERRAMIENTAS, messages: [{ role: "user", content: "airports?" }] };
    const r = await layer.generate({ ...base, reasoningEffort: "none" });
    expect(r.text).toBe("ok");
    expect(s.llamadas[0]!.cuerpo["reasoning_effort"]).toBe("none");
    const antes = s.llamadas.length;
    await expect(layer.generate({ ...base, reasoningEffort: "high" })).rejects.toThrow(/reasoning_effort/);
    // En el API de OpenAI no se quita: su 400 es la respuesta, y no se repite.
    expect(s.llamadas.length - antes).toBe(1);
  });

  it("a Gemini viaja; a un servidor que no lo conoce, se repite UNA vez sin él", async () => {
    const g = servidor(() => ok());
    await new OpenAICompatibleProvider({ baseUrl: GEMINI, fetchImpl: g.fetchImpl }).generate({ ...PETICION_PROVEEDOR, reasoningEffort: "low" });
    expect(g.llamadas[0]!.cuerpo["reasoning_effort"]).toBe("low");

    const v = servidor((c) =>
      "reasoning_effort" in c ? { status: 400, json: { error: { message: "Unrecognized request argument supplied: reasoning_effort" } } } : ok(),
    );
    const r = await new OpenAICompatibleProvider({ baseUrl: VLLM, fetchImpl: v.fetchImpl }).generate({ ...PETICION_PROVEEDOR, reasoningEffort: "low" });
    expect(r.text).toBe("ok");
    expect(v.llamadas.map((l) => "reasoning_effort" in l.cuerpo)).toEqual([true, false]);
  });

  it("entra en la identidad de caché SOLO cuando se declara: sin él, la clave es la de antes", () => {
    const base: SavingsRequest = { model: "openai/gpt-5.6-sol", messages: [{ role: "user", content: "x" }] };
    const sin = buildExactKey(canonicalize(base));
    expect(buildExactKey(canonicalize({ ...base, reasoningEffort: "none" }))).not.toBe(sin);
    expect(buildExactKey(canonicalize({ ...base, reasoningEffort: "none" }))).not.toBe(
      buildExactKey(canonicalize({ ...base, reasoningEffort: "high" })),
    );
    expect(buildInflightKey(canonicalize({ ...base, reasoningEffort: "none" }))).not.toBe(buildInflightKey(canonicalize(base)));
    // La de antes, fijada: una caché viva no pierde nada.
    expect(sin).toBe(buildExactKey({ ...canonicalize(base) }));
    expect("reasoningEffort" in canonicalize(base)).toBe(false);
  });
});

// ── 6 · el prefijo `google/` en el host oficial de Gemini ──────────────────

describe("6 · `google/` se quita en el API oficial de Gemini y en ningún proxy", () => {
  it.each([
    [GEMINI, "gemini-3.8-flash"],
    ["https://openrouter.ai/api/v1", "google/gemini-3.8-flash"],
    ["https://ai-gateway.vercel.sh/v1", "google/gemini-3.8-flash"],
    [LITELLM, "google/gemini-3.8-flash"],
    // Mismo host por http: no es el origen oficial.
    ["http://generativelanguage.googleapis.com/v1beta/openai", "google/gemini-3.8-flash"],
  ])("%s → %s", async (baseUrl, esperado) => {
    const s = servidor(() => ok());
    await new OpenAICompatibleProvider({ baseUrl, fetchImpl: s.fetchImpl }).generate({ ...PETICION_PROVEEDOR, model: "google/gemini-3.8-flash" });
    expect(s.llamadas[0]!.cuerpo["model"]).toBe(esperado);
  });

  it("`stripProviderPrefix: false` sigue mandando", async () => {
    const s = servidor(() => ok());
    await new OpenAICompatibleProvider({ baseUrl: GEMINI, fetchImpl: s.fetchImpl, stripProviderPrefix: false }).generate({
      ...PETICION_PROVEEDOR,
      model: "google/gemini-3.8-flash",
    });
    expect(s.llamadas[0]!.cuerpo["model"]).toBe("google/gemini-3.8-flash");
  });
});
