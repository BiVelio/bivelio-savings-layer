import { describe, it, expect } from "vitest";

import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import type { ChatMessage } from "../src/contracts/types.js";

/**
 * El adaptador OpenAI transporta el turno de vuelta de herramientas.
 *
 * Chat Completions exige que un `role:"tool"` lleve `tool_call_id` y siga a un
 * assistant con `tool_calls`; sin ambos responde 400. El mapeo a `{role, content}`
 * a secas descartaba `tool_call_id` y no emitía `tool_calls`, así que el ciclo de
 * herramientas que el SDK documenta reventaba. Se captura el body enviado con un
 * fetch de prueba (no se llama a la API real).
 */

function capturaBody() {
  const capturado: { body?: any } = {};
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    capturado.body = JSON.parse(init.body as string);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { capturado, fetchImpl };
}

describe("OpenAICompatibleProvider — turno de herramientas", () => {
  it("un role:tool viaja con tool_call_id (no lo descarta)", async () => {
    const { capturado, fetchImpl } = capturaBody();
    const p = new OpenAICompatibleProvider({ baseUrl: "https://x.test/v1", apiKey: "k", fetchImpl });
    const messages: ChatMessage[] = [
      { role: "user", content: "envía la factura" },
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "send_invoice", arguments: "{}" }] },
      { role: "tool", content: '{"status":"sent"}', name: "send_invoice", toolCallId: "call_1" },
    ];
    await p.generate({ model: "gpt-4o-mini", messages });

    const enviados = capturado.body.messages;
    const toolMsg = enviados.find((m: any) => m.role === "tool");
    expect(toolMsg.tool_call_id).toBe("call_1");
    // Y el assistant previo lleva sus tool_calls en el formato de la API.
    const asst = enviados.find((m: any) => m.role === "assistant");
    expect(asst.tool_calls[0]).toMatchObject({ id: "call_1", type: "function", function: { name: "send_invoice", arguments: "{}" } });
  });

  it("acepta tool_call_id también desde metadata (compatibilidad)", async () => {
    const { capturado, fetchImpl } = capturaBody();
    const p = new OpenAICompatibleProvider({ baseUrl: "https://x.test/v1", apiKey: "k", fetchImpl });
    const messages: ChatMessage[] = [
      { role: "user", content: "hola" },
      { role: "tool", content: "res", metadata: { tool_call_id: "call_9" } },
    ];
    await p.generate({ model: "gpt-4o-mini", messages });
    const toolMsg = capturado.body.messages.find((m: any) => m.role === "tool");
    expect(toolMsg.tool_call_id).toBe("call_9");
  });

  it("un turno normal sigue igual (sin tool_calls ni tool_call_id espurios)", async () => {
    const { capturado, fetchImpl } = capturaBody();
    const p = new OpenAICompatibleProvider({ baseUrl: "https://x.test/v1", apiKey: "k", fetchImpl });
    await p.generate({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hola" }] });
    const userMsg = capturado.body.messages[0];
    expect(userMsg).toEqual({ role: "user", content: "hola" });
  });
});
