import { describe, it, expect } from "vitest";

import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { GoogleProvider } from "../src/providers/google.js";
import type { ProviderRequest } from "../src/providers/types.js";

/**
 * `Provider.generate(req, options?)` acepta `{ signal }` (aditivo) para que la
 * copia de verificación se pueda abortar al cerrar la capa. SIN `options`, la
 * petición HTTP tiene que ser byte a byte la de siempre: ni una clave `signal`
 * en el `init`, y el cuerpo idéntico.
 */

function espia(respuesta: unknown) {
  const inits: RequestInit[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    inits.push(init);
    return {
      ok: true,
      status: 200,
      json: async () => respuesta,
      text: async () => JSON.stringify(respuesta),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { inits, fetchImpl };
}

const PETICION: ProviderRequest = {
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "hola" }],
};

describe("OpenAI-compatible", () => {
  const OK = { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } };

  it("sin options: ninguna clave `signal` en el init", async () => {
    const { inits, fetchImpl } = espia(OK);
    await new OpenAICompatibleProvider({ baseUrl: "https://x.test/v1", fetchImpl }).generate(PETICION);
    expect(inits).toHaveLength(1);
    expect("signal" in inits[0]!).toBe(false);
  });

  it("con options: la señal llega al fetch y el cuerpo no cambia", async () => {
    const a = espia(OK);
    const b = espia(OK);
    const ctrl = new AbortController();
    await new OpenAICompatibleProvider({ baseUrl: "https://x.test/v1", fetchImpl: a.fetchImpl }).generate(PETICION);
    await new OpenAICompatibleProvider({ baseUrl: "https://x.test/v1", fetchImpl: b.fetchImpl }).generate(PETICION, {
      signal: ctrl.signal,
    });
    expect(b.inits[0]!.signal).toBe(ctrl.signal);
    expect(b.inits[0]!.body).toBe(a.inits[0]!.body);
  });

  it("también en el reintento sin `response_format`", async () => {
    const inits: RequestInit[] = [];
    let n = 0;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      inits.push(init);
      n++;
      if (n === 1) {
        return { ok: false, status: 400, text: async () => "response_format is not supported with this model" } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"a":1}' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const ctrl = new AbortController();
    await new OpenAICompatibleProvider({ baseUrl: "https://x.test/v1", fetchImpl }).generate(
      { ...PETICION, model: "openai/gpt-4-sin-formato", schema: { type: "object" } },
      { signal: ctrl.signal },
    );
    expect(inits).toHaveLength(2);
    expect(inits.every((i) => i.signal === ctrl.signal)).toBe(true);
  });
});

describe("Anthropic", () => {
  const OK = { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 2 } };

  it("sin options: ninguna clave `signal` en el init", async () => {
    const { inits, fetchImpl } = espia(OK);
    await new AnthropicProvider({ fetchImpl }).generate({ ...PETICION, model: "claude-sonnet-4-5" });
    expect("signal" in inits[0]!).toBe(false);
  });

  it("con options: la señal llega al fetch y el cuerpo no cambia", async () => {
    const a = espia(OK);
    const b = espia(OK);
    const ctrl = new AbortController();
    const q = { ...PETICION, model: "claude-sonnet-4-5" };
    await new AnthropicProvider({ fetchImpl: a.fetchImpl }).generate(q);
    await new AnthropicProvider({ fetchImpl: b.fetchImpl }).generate(q, { signal: ctrl.signal });
    expect(b.inits[0]!.signal).toBe(ctrl.signal);
    expect(b.inits[0]!.body).toBe(a.inits[0]!.body);
  });
});

describe("generateStream con entrega entera", () => {
  it("OpenAI conserva options al delegar en generate por contrato", async () => {
    const { inits, fetchImpl } = espia({
      choices: [{ message: { content: '{"a":1}' }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    });
    const ctrl = new AbortController();
    const provider = new OpenAICompatibleProvider({ baseUrl: "https://x.test/v1", fetchImpl });
    for await (const _event of provider.generateStream(
      { ...PETICION, schema: { type: "object" } },
      { signal: ctrl.signal },
    )) {
      // Consumir la entrega ejecuta la rama entera.
    }
    expect(inits).toHaveLength(1);
    expect(inits[0]!.signal).toBe(ctrl.signal);
  });

  it("Anthropic conserva options al delegar en generate por contrato", async () => {
    const { inits, fetchImpl } = espia({
      content: [{ type: "text", text: '{"a":1}' }],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 2 },
    });
    const ctrl = new AbortController();
    const provider = new AnthropicProvider({ fetchImpl });
    for await (const _event of provider.generateStream(
      { ...PETICION, model: "claude-sonnet-4-5", schema: { type: "object" } },
      { signal: ctrl.signal },
    )) {
      // Consumir la entrega ejecuta la rama entera.
    }
    expect(inits).toHaveLength(1);
    expect(inits[0]!.signal).toBe(ctrl.signal);
  });

  it("Google conserva options al delegar en generate por contrato", async () => {
    const { inits, fetchImpl } = espia({
      candidates: [{ content: { role: "model", parts: [{ text: '{"a":1}' }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
    });
    const ctrl = new AbortController();
    const provider = new GoogleProvider({ fetchImpl });
    for await (const _event of provider.generateStream(
      { ...PETICION, model: "gemini-3-flash-preview", schema: { type: "object" } },
      { signal: ctrl.signal },
    )) {
      // Consumir la entrega ejecuta la rama entera.
    }
    expect(inits).toHaveLength(1);
    expect(inits[0]!.signal).toBe(ctrl.signal);
  });
});
