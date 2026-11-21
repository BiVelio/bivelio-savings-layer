import { createAgent } from "langchain";
import { afterEach, describe, it, expect, vi } from "vitest";

import { getSavingsReportFromMessage, savingsAgentMiddleware } from "@bivelio/savings-layer/langchain";
import { precioDeLista } from "../../src/pricing/catalogo.js";
import { coleccion, prohibirLaRed } from "./ayudas.js";

/**
 * EL MODELO EN CADENA: `createAgent({ model: "openai:gpt-4o-mini" })`.
 *
 * Es la forma que enseñan el README, `bvsala init` y la documentación de
 * LangChain v1, y el adaptador no la nombraba: LangChain la entrega como
 * `ConfigurableModel`, cuyo `_llmType()` es "chat_model" y que no tiene `model`
 * ni `modelName`. El informe salía como "chat_model/" y se tarifaba al precio
 * ILUSTRATIVO — cifras en dólares que no cuadran con la factura. Lo encontró la
 * ejecución de la comprobación de `init` (examples/stacks/langchain), que avisaba
 * «no cost model configured for "chat_model/"».
 *
 * Aquí se prueba con `langchain` y `@langchain/openai` de verdad: la pregunta que
 * contesta la capa, y una llamada que SÍ va al modelo, contra un `fetch` falso de
 * la Responses API (la que usa ChatOpenAI por defecto en esta versión), para ver
 * que el coste medido es el de la fila del catálogo.
 */

let restaurar: (() => void) | undefined;
afterEach(() => {
  restaurar?.();
  restaurar = undefined;
  vi.unstubAllEnvs();
});

describe("LangChain con el modelo en cadena", () => {
  it("la respuesta de la capa sale con el id del proveedor y del modelo, no «chat_model/»", async () => {
    restaurar = prohibirLaRed();
    vi.stubEnv("OPENAI_API_KEY", "placeholder-not-sent");
    const { onReport, informes } = coleccion();
    const mw = savingsAgentMiddleware({ onReport });
    const agente = createAgent({ model: "openai:gpt-4o-mini", tools: [], middleware: [mw] });
    const estado = await agente.invoke({ messages: [{ role: "user", content: "What is 2 + 2 * 3?" }] });
    const informe = getSavingsReportFromMessage(estado.messages.at(-1));
    expect(estado.messages.at(-1)?.text).toBe("8");
    expect(informe?.model).toBe("openai/gpt-4o-mini");
    expect(informes[0]?.model).toBe("openai/gpt-4o-mini");
    mw.close();
  });

  it("una llamada real al modelo se mide con el contador y se tarifa con la fila de gpt-4o-mini", async () => {
    vi.stubEnv("OPENAI_API_KEY", "placeholder-not-sent");
    const original = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (entrada: unknown) => {
      const url = typeof entrada === "string" ? entrada : entrada instanceof URL ? entrada.href : String((entrada as Request).url);
      urls.push(url);
      if (!url.endsWith("/responses")) throw new Error(`[test] red inesperada: ${url}`);
      return new Response(
        JSON.stringify({
          id: "resp_1",
          object: "response",
          created_at: 1,
          status: "completed",
          model: "gpt-4o-mini",
          output: [
            { type: "message", id: "msg_1", status: "completed", role: "assistant", content: [{ type: "output_text", text: "Blue", annotations: [] }] },
          ],
          usage: {
            input_tokens: 1000,
            output_tokens: 500,
            total_tokens: 1500,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    restaurar = () => {
      globalThis.fetch = original;
    };

    const mw = savingsAgentMiddleware({ silenceWarnings: true });
    const agente = createAgent({ model: "openai:gpt-4o-mini", tools: [], middleware: [mw] });
    const estado = await agente.invoke({ messages: [{ role: "user", content: "Name a colour." }] });
    const informe = getSavingsReportFromMessage(estado.messages.at(-1));

    expect(urls).toEqual(["https://api.openai.com/v1/responses"]);
    expect(informe?.model).toBe("openai/gpt-4o-mini");
    expect(informe?.cost.basis).toBe("measured");
    expect(informe?.tokens.actualInput).toBe(1000);
    expect(informe?.tokens.actualOutput).toBe(500);
    const fila = precioDeLista("gpt-4o-mini");
    expect(fila).toBeDefined();
    // 1.000 de entrada y 500 de salida a precio de lista: la fila, no el ilustrativo.
    expect(informe?.cost.actual).toBeCloseTo(fila!.inputPer1k + 0.5 * fila!.outputPer1k, 10);
    mw.close();
  });
});

/**
 * LA RESPONSES API AHORRA (auditoría de lo gratis, 21-11-2026). Con
 * `createAgent({ model: "openai:…" })` LangChain va por la Responses API, cuyo
 * AIMessage no trae `finish_reason` (@langchain/openai 1.6, la fijada aquí) o lo
 * trae como "completed" (1.8). El adaptador no lo traducía a "stop": la
 * respuesta salía `replayable: false` y la misma pregunta repetida, o dos
 * simultáneas, llegaban dos veces al proveedor. Ya fallaba en la 1.2.3.
 */
describe("LangChain con la Responses API: repetidas y simultáneas no se pagan dos veces", () => {
  type Salida = Record<string, unknown>;
  const texto = (t: string): Salida => ({
    type: "message",
    id: "msg_1",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: t, annotations: [] }],
  });

  /** Un `fetch` falso de la Responses API que cuenta las llamadas y contesta con `respuesta`. */
  function responsesFalsa(respuesta: (n: number) => Salida) {
    const original = globalThis.fetch;
    let llamadas = 0;
    globalThis.fetch = (async (entrada: unknown) => {
      const url = typeof entrada === "string" ? entrada : entrada instanceof URL ? entrada.href : String((entrada as Request).url);
      if (!url.endsWith("/responses")) throw new Error(`[test] red inesperada: ${url}`);
      llamadas += 1;
      const n = llamadas;
      await new Promise((r) => setTimeout(r, 20));
      return new Response(
        JSON.stringify({
          id: `resp_${n}`,
          object: "response",
          created_at: 1,
          model: "gpt-4o-mini",
          usage: {
            input_tokens: 1000,
            output_tokens: 500,
            total_tokens: 1500,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
          ...respuesta(n),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    restaurar = () => {
      globalThis.fetch = original;
    };
    return { llamadas: () => llamadas };
  }

  it("la misma pregunta repetida: UNA llamada, la segunda sale de la caché exacta", async () => {
    vi.stubEnv("OPENAI_API_KEY", "placeholder-not-sent");
    const red = responsesFalsa(() => ({ status: "completed", output: [texto("Blue")] }));
    const mw = savingsAgentMiddleware({ silenceWarnings: true });
    const agente = createAgent({ model: "openai:gpt-4o-mini", tools: [], middleware: [mw] });
    const pregunta = { messages: [{ role: "user", content: "Name a colour." }] };
    const primera = await agente.invoke(pregunta);
    const segunda = await agente.invoke(pregunta);
    expect(red.llamadas()).toBe(1);
    expect(getSavingsReportFromMessage(primera.messages.at(-1))?.cost.basis).toBe("measured");
    expect(segunda.messages.at(-1)?.text).toBe("Blue");
    expect(getSavingsReportFromMessage(segunda.messages.at(-1))?.cache.result).toBe("exact");
    mw.close();
  });

  it("dos preguntas idénticas a la vez: UNA llamada", async () => {
    vi.stubEnv("OPENAI_API_KEY", "placeholder-not-sent");
    const red = responsesFalsa(() => ({ status: "completed", output: [texto("Green")] }));
    const mw = savingsAgentMiddleware({ silenceWarnings: true });
    const agente = createAgent({ model: "openai:gpt-4o-mini", tools: [], middleware: [mw] });
    const pregunta = { messages: [{ role: "user", content: "Name another colour." }] };
    const [a, b] = await Promise.all([agente.invoke(pregunta), agente.invoke(pregunta)]);
    expect(red.llamadas()).toBe(1);
    expect(a.messages.at(-1)?.text).toBe("Green");
    expect(b.messages.at(-1)?.text).toBe("Green");
    mw.close();
  });

  it("una respuesta incompleta (max_output_tokens) no se reutiliza: la repetida vuelve a llamar", async () => {
    vi.stubEnv("OPENAI_API_KEY", "placeholder-not-sent");
    const red = responsesFalsa(() => ({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [texto("Blu")] }));
    const mw = savingsAgentMiddleware({ silenceWarnings: true });
    const agente = createAgent({ model: "openai:gpt-4o-mini", tools: [], middleware: [mw] });
    const pregunta = { messages: [{ role: "user", content: "Name a third colour." }] };
    const primera = await agente.invoke(pregunta);
    await agente.invoke(pregunta);
    expect(red.llamadas()).toBe(2);
    const traza = getSavingsReportFromMessage(primera.messages.at(-1))?.traces.find((t) => t.stage === "cache-write");
    expect(JSON.stringify(traza)).toMatch(/skipped/);
    mw.close();
  });

  it("con salidas de herramientas del proveedor (búsqueda web) no se reutiliza", async () => {
    vi.stubEnv("OPENAI_API_KEY", "placeholder-not-sent");
    const red = responsesFalsa(() => ({
      status: "completed",
      output: [{ type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "colour" } }, texto("Red")],
    }));
    const mw = savingsAgentMiddleware({ silenceWarnings: true });
    const agente = createAgent({ model: "openai:gpt-4o-mini", tools: [], middleware: [mw] });
    const pregunta = { messages: [{ role: "user", content: "Search a colour." }] };
    await agente.invoke(pregunta);
    await agente.invoke(pregunta);
    expect(red.llamadas()).toBe(2);
    mw.close();
  });
});
