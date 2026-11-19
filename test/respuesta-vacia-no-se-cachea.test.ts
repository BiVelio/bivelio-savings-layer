import { describe, it, expect } from "vitest";
import { createSavingsLayer, OpenAICompatibleProvider, AnthropicProvider, GoogleProvider } from "../src/index.js";

/**
 * N3 (auditoría del 2026-11-19) · UN FALLO DE UN SEGUNDO DEL PROVEEDOR SE
 * QUEDABA 24 H EN CACHÉ.
 *
 * Un HTTP 200 con `{"error": ...}` (lo hace OpenRouter cuando el modelo de
 * detrás falla) o sin `choices` se leía como respuesta vacía: se servía "", se
 * guardaba en la caché exacta y cada repetición salía como llamada evitada, con
 * su ahorro. Dos reglas: eso es un ERROR del proveedor (como ya lo era en el
 * stream), y una respuesta vacía o sin contador no se guarda nunca.
 * Servidores simulados; todos los textos son inventados.
 */

const PREGUNTA = [{ role: "user" as const, content: "Explica en una línea qué es una cola de mensajes." }];
const JSON_OK = { status: 200, headers: { "content-type": "application/json" } };

type Cuerpo = (n: number, peticion: { model?: string }) => unknown;

function simulado(cuerpo: Cuerpo) {
  const estado = { llamadas: 0 };
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
    estado.llamadas += 1;
    const peticion = init?.body ? (JSON.parse(String(init.body)) as { model?: string }) : {};
    return new Response(JSON.stringify(cuerpo(estado.llamadas, peticion)), JSON_OK);
  }) as unknown as typeof fetch;
  return { estado, fetchImpl };
}

const completion = (texto: string | null, uso: unknown = { prompt_tokens: 40, completion_tokens: 9, total_tokens: 49 }) => ({
  id: "chatcmpl-inventado",
  object: "chat.completion",
  choices: [{ index: 0, message: { role: "assistant", content: texto }, finish_reason: "stop" }],
  ...(uso !== null ? { usage: uso } : {}),
});

function capaOpenAI(cuerpo: Cuerpo) {
  const { estado, fetchImpl } = simulado(cuerpo);
  const capa = createSavingsLayer({
    provider: new OpenAICompatibleProvider({ baseUrl: "https://api.openai.test/v1", apiKey: "k-inventada", fetchImpl }),
    silenceWarnings: true,
  });
  const pedir = () => capa.generate({ model: "openai/gpt-4o-mini", messages: PREGUNTA });
  return { estado, pedir };
}

describe("⛔ un 200 sin respuesta es un error del proveedor (OpenAI-compatible)", () => {
  it.each<[string, unknown]>([
    ["{error} con HTTP 200", { error: { message: "upstream overloaded", code: 529 } }],
    ["error como cadena", { error: "upstream overloaded" }],
    ["choices vacío", { choices: [], usage: { prompt_tokens: 10, completion_tokens: 0 } }],
    ["sin choices", { id: "x", usage: { prompt_tokens: 10, completion_tokens: 0 } }],
    ["choices[0] sin message", { choices: [{ index: 0, finish_reason: "stop" }] }],
    ["null", null],
  ])("%s → generate() rechaza", async (_caso, cuerpo) => {
    const { pedir } = capaOpenAI(() => cuerpo);
    await expect(pedir()).rejects.toThrow(/provider/);
  });

  it("el fallo no se queda en caché: cuando el proveedor se recupera, se le vuelve a llamar", async () => {
    const { estado, pedir } = capaOpenAI((n) =>
      n === 1 ? { error: { message: "upstream overloaded" } } : completion("Un buzón que desacopla a quien envía de quien recibe."),
    );
    await expect(pedir()).rejects.toThrow(/upstream overloaded/);
    const llamadasDelFallo = estado.llamadas;
    const despues = await pedir();
    expect(despues.text).toBe("Un buzón que desacopla a quien envía de quien recibe.");
    expect(despues.report.cache.result).toBe("miss");
    expect(estado.llamadas).toBe(llamadasDelFallo + 1);
  });
});

describe("⛔ una respuesta vacía o sin contador nunca se guarda en caché", () => {
  it.each<[string, Cuerpo]>([
    ['content ""', () => completion("")],
    ["content null", () => completion(null)],
    ["solo espacios", () => completion("  \n ")],
  ])("%s: se sirve, y la repetición idéntica vuelve al proveedor", async (_caso, cuerpo) => {
    const { estado, pedir } = capaOpenAI(cuerpo);
    const primera = await pedir();
    expect(primera.text.trim()).toBe("");
    const segunda = await pedir();
    expect(segunda.report.cache.result).toBe("miss");
    expect(segunda.report.calls.avoidedLlm).toBe(0);
    expect(estado.llamadas).toBe(2);
  });

  it("una respuesta sin contador de tokens tampoco: su repetición vuelve al proveedor", async () => {
    const { estado, pedir } = capaOpenAI(() => completion("Un buzón entre servicios.", null));
    const primera = await pedir();
    expect(primera.report.cost.basis).toBe("unmeasured");
    const segunda = await pedir();
    expect(segunda.report.cache.result).toBe("miss");
    expect(estado.llamadas).toBe(2);
  });

  it("y con medio contador (solo prompt_tokens) igual", async () => {
    const { estado, pedir } = capaOpenAI(() => completion("Un buzón entre servicios.", { prompt_tokens: 40 }));
    await pedir();
    const segunda = await pedir();
    expect(segunda.report.cache.result).toBe("miss");
    expect(estado.llamadas).toBe(2);
  });

  it("lo que funciona no se rompe: una respuesta normal con su contador sigue acertando", async () => {
    const { estado, pedir } = capaOpenAI(() => completion("Un buzón entre servicios."));
    await pedir();
    const segunda = await pedir();
    expect(segunda.report.cache.result).toBe("exact");
    expect(segunda.text).toBe("Un buzón entre servicios.");
    expect(estado.llamadas).toBe(1);
  });
});

describe("⛔ lo mismo en los adaptadores de Anthropic y de Google", () => {
  function capaAnthropic(cuerpo: Cuerpo) {
    const { estado, fetchImpl } = simulado(cuerpo);
    const capa = createSavingsLayer({
      provider: new AnthropicProvider({ apiKey: "k-inventada", fetchImpl }),
      silenceWarnings: true,
    });
    return { estado, pedir: () => capa.generate({ model: "anthropic/claude-haiku-4-5", messages: PREGUNTA }) };
  }
  function capaGoogle(cuerpo: Cuerpo) {
    const { estado, fetchImpl } = simulado(cuerpo);
    const capa = createSavingsLayer({
      provider: new GoogleProvider({ apiKey: "k-inventada", fetchImpl }),
      silenceWarnings: true,
    });
    return { estado, pedir: () => capa.generate({ model: "google/gemini-2.5-flash", messages: PREGUNTA }) };
  }

  it.each<[string, unknown]>([
    ["{type:error} con HTTP 200", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }],
    ["sin content", { id: "msg_inventado", type: "message", usage: { input_tokens: 10, output_tokens: 0 } }],
  ])("Anthropic · %s → generate() rechaza", async (_caso, cuerpo) => {
    const { pedir } = capaAnthropic(() => cuerpo);
    await expect(pedir()).rejects.toThrow(/provider/);
  });

  it("Anthropic · content [] se sirve vacío y no se guarda", async () => {
    const { estado, pedir } = capaAnthropic(() => ({
      id: "msg_inventado",
      type: "message",
      role: "assistant",
      content: [],
      stop_reason: "end_turn",
      usage: { input_tokens: 30, output_tokens: 0 },
    }));
    expect((await pedir()).text).toBe("");
    expect((await pedir()).report.cache.result).toBe("miss");
    expect(estado.llamadas).toBe(2);
  });

  it.each<[string, unknown]>([
    ["{error} con HTTP 200", { error: { code: 503, message: "The model is overloaded." } }],
    ["sin candidatos", { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 0, totalTokenCount: 10 } }],
  ])("Google · %s → generate() rechaza", async (_caso, cuerpo) => {
    const { pedir } = capaGoogle(() => cuerpo);
    await expect(pedir()).rejects.toThrow(/provider/);
  });

  it("Google · un candidato sin texto se sirve vacío y no se guarda", async () => {
    const { estado, pedir } = capaGoogle(() => ({
      candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP", index: 0 }],
      usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 0, totalTokenCount: 30 },
    }));
    expect((await pedir()).text).toBe("");
    expect((await pedir()).report.cache.result).toBe("miss");
    expect(estado.llamadas).toBe(2);
  });
});
