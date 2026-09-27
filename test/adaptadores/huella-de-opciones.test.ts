import { describe, expect, it } from "vitest";
import * as ai from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { getSavingsReport, savingsMiddleware } from "@bivelio/savings-layer/ai-sdk";
import { construirPeticion, huellaDe } from "../../src/adapters/comun/peticion.js";

/**
 * LA HUELLA (D5): todo lo que el framework manda y la clave del núcleo no cubre
 * entra en `context.authorizationScope`. Dos peticiones que difieren solo ahí
 * nunca comparten respuesta; dos que difieren solo en lo que cambia en cada
 * ejecución (ids de llamadas a herramienta, sellos de Mastra, cabeceras de
 * traza) sí.
 *
 * Se prueba con el adaptador del AI SDK de verdad y un modelo de prueba: cada
 * par de peticiones se hace dos veces sobre la misma capa y se cuenta cuántas
 * veces llegó la llamada al modelo.
 */

const USO = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } };

type Params = Record<string, unknown>;

function base(): Params {
  return {
    prompt: [
      { role: "system", content: "Be brief." },
      { role: "user", content: [{ type: "text", text: "Name a colour." }] },
    ],
    temperature: 0,
  };
}

// Una conversación con una llamada a herramienta ya resuelta.
function conHerramienta(id: string, args: unknown, salida: unknown, sello = 1): Params {
  return {
    prompt: [
      { role: "user", content: [{ type: "text", text: "Look it up.", providerOptions: { mastra: { createdAt: sello } } }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "lookup", input: args }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "lookup", output: { type: "json", value: salida } }] },
    ],
    temperature: 0,
  };
}

async function llamadasPara(a: Params, b: Params): Promise<number> {
  let llamadas = 0;
  const model = new MockLanguageModelV4({
    provider: "openai.chat",
    modelId: "gpt-4o-mini",
    doGenerate: (async () => {
      llamadas += 1;
      return { content: [{ type: "text", text: "Blue" }], finishReason: { unified: "stop", raw: "stop" }, usage: USO, warnings: [] };
    }) as never,
  });
  const mw = savingsMiddleware({ silenceWarnings: true });
  const envuelto = ai.wrapLanguageModel({ model, middleware: mw });
  await envuelto.doGenerate(a as never);
  const r = await envuelto.doGenerate(b as never);
  mw.close();
  expect(getSavingsReport(r)?.cache.result).toBe(llamadas === 1 ? "exact" : "miss");
  return llamadas;
}

describe("la huella de lo que el núcleo no modela", () => {
  const distintas: [string, Params][] = [
    ["maxOutputTokens", { ...base(), maxOutputTokens: 5 }],
    ["stopSequences", { ...base(), stopSequences: ["\n"] }],
    ["topP", { ...base(), topP: 0.5 }],
    ["responseFormat", { ...base(), responseFormat: { type: "json" } }],
    ["toolChoice", { ...base(), toolChoice: { type: "none" } }],
    ["providerOptions del proveedor", { ...base(), providerOptions: { openai: { reasoningEffort: "high" } } }],
    ["cabecera anthropic-beta", { ...base(), headers: { "anthropic-beta": "context-1m" } }],
    [
      "cache_control en una parte",
      {
        ...base(),
        prompt: [
          { role: "system", content: "Be brief." },
          {
            role: "user",
            content: [{ type: "text", text: "Name a colour.", providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }],
          },
        ],
      },
    ],
    [
      "un fichero adjunto",
      {
        ...base(),
        prompt: [
          { role: "user", content: [{ type: "text", text: "Name a colour." }, { type: "file", mediaType: "image/png", data: new Uint8Array([1, 2, 3]) }] },
        ],
      },
    ],
  ];

  it.each(distintas)("difiere solo en %s → nunca acierta", async (_nombre, otra) => {
    expect(await llamadasPara(base(), otra)).toBe(2);
  });

  it("los bytes de un fichero cuentan", async () => {
    const conFichero = (bytes: number[]): Params => ({
      prompt: [{ role: "user", content: [{ type: "text", text: "Describe it." }, { type: "file", mediaType: "image/png", data: new Uint8Array(bytes) }] }],
      temperature: 0,
    });
    expect(await llamadasPara(conFichero([1, 2, 3]), conFichero([1, 2, 4]))).toBe(2);
    expect(await llamadasPara(conFichero([1, 2, 3]), conFichero([1, 2, 3]))).toBe(1);
  });

  it("los argumentos de una llamada a herramienta y su resultado crudo cuentan", async () => {
    expect(await llamadasPara(conHerramienta("c1", { q: "x" }, { r: 1 }), conHerramienta("c1", { q: "y" }, { r: 1 }))).toBe(2);
    // «R» y «r» normalizan igual en la clave del núcleo; la huella los separa.
    expect(await llamadasPara(conHerramienta("c1", { q: "x" }, { r: 1 }), conHerramienta("c1", { q: "x" }, { R: 1 }))).toBe(2);
  });

  it("lo que cambia en cada ejecución NO cuenta: ids de llamada, sellos de Mastra y cabeceras de traza", async () => {
    expect(await llamadasPara(conHerramienta("call_1", { q: "x" }, { r: 1 }, 111), conHerramienta("call_9", { q: "x" }, { r: 1 }, 999))).toBe(1);
    expect(await llamadasPara({ ...base(), headers: { "x-request-id": "a" } }, { ...base(), headers: { "x-request-id": "b" } })).toBe(1);
    expect(
      await llamadasPara(
        { ...base(), providerOptions: { bivelio: { context: { sessionId: "s" } } } },
        { ...base(), providerOptions: { bivelio: { context: { sessionId: "s" } }, mastra: { x: 1 } } },
      ),
    ).toBe(1);
  });

  it("el authorizationScope del llamante se conserva como prefijo", async () => {
    const req = await construirPeticion(
      {},
      { model: "m", messages: [], tools: [], proyeccion: { a: 1 }, context: { authorizationScope: "tenant-7", tenantId: "t" } },
    );
    expect(req.context?.authorizationScope).toMatch(/^tenant-7\|bvsala-adapter:[0-9a-f]{64}$/);
    expect(req.context?.tenantId).toBe("t");
    const sinScope = await construirPeticion({}, { model: "m", messages: [], tools: [], proyeccion: { a: 1 } });
    expect(sinScope.context?.authorizationScope).toMatch(/^default\|bvsala-adapter:[0-9a-f]{64}$/);
  });

  it("la huella es estable ante el orden de claves y distingue tipos", async () => {
    expect(await huellaDe({ a: 1, b: [1, 2] })).toBe(await huellaDe({ b: [1, 2], a: 1 }));
    expect(await huellaDe({ a: 1 })).not.toBe(await huellaDe({ a: "1" }));
    expect(await huellaDe({ d: new Uint8Array([1]) })).not.toBe(await huellaDe({ d: new Uint8Array([2]) }));
  });

  it("sin huella fiable, no se reutiliza nada", async () => {
    // Un valor que no se puede recorrer: la huella sale null y el adaptador apaga
    // la caché exacta y la petición en vuelo para esa llamada.
    const hostil = {
      get x(): never {
        throw new Error("no");
      },
    };
    const req = await construirPeticion({}, { model: "m", messages: [], tools: [], proyeccion: hostil });
    expect(req.savings?.exactCache).toBe(false);
    expect(req.savings?.singleflight).toBe(false);
  });
});
