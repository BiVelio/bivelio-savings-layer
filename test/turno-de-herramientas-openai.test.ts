import { describe, it, expect } from "vitest";

import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import type { ChatMessage } from "../src/contracts/types.js";

/**
 * EL TURNO DE VUELTA DE UNA HERRAMIENTA TIENE QUE ATRAVESAR EL ADAPTADOR.
 *
 * Chat Completions exige dos cosas a la vez: que un mensaje `role:"tool"` lleve
 * `tool_call_id`, y que siga a un `assistant` con `tool_calls`. Sin ellas
 * responde 400.
 *
 * El adaptador mapeaba TODO a `{role, content}`, así que descartaba las dos. El
 * efecto: se podía pedir la herramienta —`SavingsResult.toolCalls` llegaba bien—
 * pero no se podía CONTESTAR con su resultado. Y es el flujo que el propio SDK
 * documenta: «treat an empty text together with a populated toolCalls as a tool
 * invocation to execute».
 *
 * Se inspecciona el cuerpo que sale hacia el proveedor, que es donde vive el
 * fallo; no hace falta red.
 */
function proveedorEspia() {
  const cuerpos: unknown[] = [];
  const provider = new OpenAICompatibleProvider({
    baseUrl: "https://ejemplo.invalido/v1",
    apiKey: "no-se-usa",
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      cuerpos.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "listo" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch,
  });
  return { provider, cuerpos };
}

const conversacion: ChatMessage[] = [
  { role: "user", content: "¿qué tiempo hace en Andorra?" },
  {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "call_abc123", name: "get_weather", arguments: '{"city":"Andorra"}' }],
  },
  { role: "tool", content: '{"tempC":12}', toolCallId: "call_abc123", name: "get_weather" },
];

describe("turno de herramientas en el adaptador OpenAI-compatible", () => {
  it("el mensaje role:tool viaja con su tool_call_id", async () => {
    const { provider, cuerpos } = proveedorEspia();
    await provider.generate({ model: "gpt-4o-mini", messages: conversacion });
    const enviado = (cuerpos[0] as { messages: Record<string, unknown>[] }).messages;
    const tool = enviado.find((m) => m["role"] === "tool")!;
    expect(tool["tool_call_id"]).toBe("call_abc123");
    expect(tool["name"]).toBe("get_weather");
  });

  it("el turno assistant lleva sus tool_calls en el formato del proveedor", async () => {
    const { provider, cuerpos } = proveedorEspia();
    await provider.generate({ model: "gpt-4o-mini", messages: conversacion });
    const enviado = (cuerpos[0] as { messages: Record<string, unknown>[] }).messages;
    const asis = enviado.find((m) => m["role"] === "assistant")!;
    expect(asis["tool_calls"]).toEqual([
      { id: "call_abc123", type: "function", function: { name: "get_weather", arguments: '{"city":"Andorra"}' } },
    ]);
    // Con `tool_calls`, un content vacío viaja como null: es lo que admite el
    // proveedor, y mandar "" hacía que algunos lo rechazaran.
    expect(asis["content"]).toBeNull();
  });

  it("acepta el id por `metadata`, para quien ya lo pasaba así", async () => {
    const { provider, cuerpos } = proveedorEspia();
    await provider.generate({
      model: "gpt-4o-mini",
      messages: [
        { role: "user", content: "hola" },
        { role: "tool", content: "{}", metadata: { tool_call_id: "call_viejo" } },
      ],
    });
    const enviado = (cuerpos[0] as { messages: Record<string, unknown>[] }).messages;
    expect(enviado.find((m) => m["role"] === "tool")!["tool_call_id"]).toBe("call_viejo");
  });

  it("una conversación SIN herramientas sale exactamente igual que antes", async () => {
    const { provider, cuerpos } = proveedorEspia();
    await provider.generate({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "sé breve" },
        { role: "user", content: "hola" },
      ],
    });
    const enviado = (cuerpos[0] as { messages: Record<string, unknown>[] }).messages;
    expect(enviado).toEqual([
      { role: "system", content: "sé breve" },
      { role: "user", content: "hola" },
    ]);
  });
});
