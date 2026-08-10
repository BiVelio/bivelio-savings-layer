import { describe, it, expect, vi, afterEach } from "vitest";

import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";

/**
 * `content ?? ""` tiraba las llamadas a herramienta. Cuando el modelo invoca una
 * herramienta devuelve `content: null` + `tool_calls`, así que el adaptador
 * entregaba CADENA VACÍA y la petición del modelo se perdía entera: se servía ""
 * como si fuera la respuesta, se cacheaba, y la siguiente repetición acreditaba
 * 100 % de ahorro sobre una acción que nunca se ejecutó.
 */
const respuestaConHerramienta = {
  choices: [
    {
      finish_reason: "tool_calls",
      message: {
        content: null,
        tool_calls: [
          { id: "call_1", function: { name: "send_invoice", arguments: '{"id":"F-2026-1"}' } },
        ],
      },
    },
  ],
  usage: { prompt_tokens: 120, completion_tokens: 18 },
};

function mockFetch(payload: unknown) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
  })) as unknown as typeof fetch;
}

afterEach(() => vi.unstubAllGlobals());

describe("adaptador openai-compatible — las llamadas a herramienta no se pierden", () => {
  it("propaga tool_calls cuando content es null", async () => {
    vi.stubGlobal("fetch", mockFetch(respuestaConHerramienta));
    const p = new OpenAICompatibleProvider({ apiKey: "k", baseUrl: "https://x.test/v1" });
    const res = await p.generate({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "send the invoice" }],
    } as never);

    expect(res.toolCalls).toBeDefined();
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls![0]!.name).toBe("send_invoice");
    expect(res.toolCalls![0]!.arguments).toBe('{"id":"F-2026-1"}');
    expect(res.finishReason).toBe("tool_calls");
  });

  it("una respuesta normal de texto no gana el campo", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        choices: [{ finish_reason: "stop", message: { content: "hola" } }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }),
    );
    const p = new OpenAICompatibleProvider({ apiKey: "k", baseUrl: "https://x.test/v1" });
    const res = await p.generate({ model: "gpt-4o-mini", messages: [] } as never);
    expect(res.text).toBe("hola");
    expect(res.toolCalls).toBeUndefined();
  });

  it("descarta una tool_call sin nombre en vez de propagar basura", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        choices: [{ message: { content: null, tool_calls: [{ id: "x", function: {} }] } }],
        usage: { prompt_tokens: 5, completion_tokens: 0 },
      }),
    );
    const p = new OpenAICompatibleProvider({ apiKey: "k", baseUrl: "https://x.test/v1" });
    const res = await p.generate({ model: "gpt-4o-mini", messages: [] } as never);
    expect(res.toolCalls).toBeUndefined();
  });
});
