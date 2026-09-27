import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAgent, createMiddleware, tool } from "langchain";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { InMemoryCache } from "@langchain/core/caches";
import { z } from "zod";
import { LicenseError } from "../../src/index.js";
import { getSavingsReportFromMessage, savingsAgentMiddleware } from "@bivelio/savings-layer/langchain";
import { coleccion, medicion, prohibirLaRed, sinLicencia, vaciar } from "./ayudas.js";

/**
 * EL ADAPTADOR DE LANGCHAIN.JS, con `createAgent` de verdad y un modelo de chat
 * propio que contesta como un proveedor: `usage_metadata` con el contador y
 * `finish_reason` en `response_metadata`. Sin red.
 */

let restaurarRed: () => void;
beforeAll(() => {
  restaurarRed = prohibirLaRed();
});
afterAll(() => restaurarRed());

interface Guion {
  content: string | Record<string, unknown>[];
  tool_calls?: { id: string; name: string; args: Record<string, unknown> }[];
  additional_kwargs?: Record<string, unknown>;
  sinParada?: boolean;
}

class ModeloDePrueba extends BaseChatModel {
  llamadas = 0;
  model = "gpt-4o-mini";
  guion: Guion[] = [];
  tipo = "openai";
  vistos: BaseMessage[][] = [];

  constructor() {
    super({});
  }

  override _llmType(): string {
    return this.tipo;
  }

  override bindTools(): this {
    return this;
  }

  override async _generate(messages: BaseMessage[]) {
    this.llamadas += 1;
    this.vistos.push(messages);
    const r = this.guion.shift() ?? { content: "Hello from the model" };
    const message = new AIMessage({
      content: r.content as string,
      ...(r.tool_calls ? { tool_calls: r.tool_calls } : {}),
      ...(r.additional_kwargs ? { additional_kwargs: r.additional_kwargs } : {}),
      usage_metadata: {
        input_tokens: 20,
        output_tokens: 5,
        total_tokens: 25,
        input_token_details: { cache_read: 8 },
        output_token_details: { reasoning: 0 },
      },
      response_metadata: r.sinParada ? {} : { finish_reason: r.tool_calls ? "tool_calls" : "stop" },
    });
    return { generations: [{ text: typeof r.content === "string" ? r.content : "", message }] };
  }
}

function ultimo(r: { messages: BaseMessage[] }): BaseMessage {
  return r.messages[r.messages.length - 1] as BaseMessage;
}

const PREGUNTA = { messages: [{ role: "user", content: "Name a colour." }] };

describe("savingsAgentMiddleware", () => {
  it("(a) llamada viva: una llamada, medida con usage_metadata, informe en response_metadata y un registro", async () => {
    const m = new ModeloDePrueba();
    const { onReport, informes } = coleccion();
    const { opciones, registros } = medicion();
    const mw = savingsAgentMiddleware({ silenceWarnings: true, onReport, ...opciones });
    const agente = createAgent({ model: m, tools: [], middleware: [mw], systemPrompt: "Be brief." });
    const r = await agente.invoke(PREGUNTA);
    await vaciar();
    const informe = getSavingsReportFromMessage(ultimo(r));
    expect(ultimo(r).content).toBe("Hello from the model");
    expect(m.llamadas).toBe(1);
    expect(informe?.cost.basis).toBe("measured");
    expect(informe?.model).toBe("openai/gpt-4o-mini");
    expect(informe?.tokens.actualInput).toBe(20);
    expect(informe?.tokens.actualOutput).toBe(5);
    expect(informe?.tokens.providerCachedInput).toBe(8);
    expect(informes).toHaveLength(1);
    expect(registros).toHaveLength(1);
    mw.close();
  });

  it("(b) la repetición idéntica sale de la caché exacta sin llamar, valorada por referencia y con uso 0", async () => {
    const m = new ModeloDePrueba();
    const mw = savingsAgentMiddleware({ silenceWarnings: true });
    const agente = createAgent({ model: m, tools: [], middleware: [mw], systemPrompt: "Be brief." });
    await agente.invoke(PREGUNTA);
    const r = await agente.invoke(PREGUNTA);
    const msg = ultimo(r) as AIMessage;
    expect(m.llamadas).toBe(1);
    expect(msg.content).toBe("Hello from the model");
    expect(getSavingsReportFromMessage(msg)?.cache.result).toBe("exact");
    expect(getSavingsReportFromMessage(msg)?.cost.basis).toBe("reference");
    expect(msg.usage_metadata?.input_tokens).toBe(0);
    mw.close();
  });

  it("(c) una cuenta se contesta sin llamar", async () => {
    const m = new ModeloDePrueba();
    const mw = savingsAgentMiddleware({ silenceWarnings: true });
    const agente = createAgent({ model: m, tools: [], middleware: [mw] });
    const r = await agente.invoke({ messages: [{ role: "user", content: "What is 2 + 2 * 3?" }] });
    expect(ultimo(r).content).toBe("8");
    expect(m.llamadas).toBe(0);
    expect(getSavingsReportFromMessage(ultimo(r))?.cost.basis).toBe("estimated");
    mw.close();
  });

  it("(e) el atajo también sale por agent.stream", async () => {
    const m = new ModeloDePrueba();
    const mw = savingsAgentMiddleware({ silenceWarnings: true });
    const agente = createAgent({ model: m, tools: [], middleware: [mw] });
    await agente.invoke(PREGUNTA);
    let final: { messages: BaseMessage[] } | undefined;
    for await (const estado of await agente.stream(PREGUNTA, { streamMode: "values" })) final = estado as never;
    expect(m.llamadas).toBe(1);
    expect(getSavingsReportFromMessage(ultimo(final as never))?.cache.result).toBe("exact");
    mw.close();
  });

  it("(f) herramientas: sin declarar, la respuesta final no se reutiliza; declarada de lectura, sí", async () => {
    const buscar = tool(async ({ q }: { q: string }) => `result for ${q}`, {
      name: "lookup",
      description: "look something up",
      schema: z.object({ q: z.string() }),
    });
    for (const [lectura, esperado] of [[[], 4], [["lookup"], 3]] as const) {
      const m = new ModeloDePrueba();
      // Cada ejecución: una llamada que pide la herramienta y otra que contesta.
      // Los ids de las llamadas cambian entre ejecuciones y no cuentan.
      m.guion = [
        { content: "", tool_calls: [{ id: "call_1", name: "lookup", args: { q: "colour" } }] },
        { content: "Blue." },
        { content: "", tool_calls: [{ id: "call_9", name: "lookup", args: { q: "colour" } }] },
        { content: "Blue." },
      ];
      const mw = savingsAgentMiddleware({ silenceWarnings: true, readOnlyTools: lectura });
      const agente = createAgent({ model: m, tools: [buscar], middleware: [mw] });
      await agente.invoke(PREGUNTA);
      const r = await agente.invoke(PREGUNTA);
      expect(ultimo(r).content).toBe("Blue.");
      expect(m.llamadas, JSON.stringify(lectura)).toBe(esperado);
      mw.close();
    }
  });

  it("(g) bloques que no son texto, razonamiento o parada desconocida: no se reutilizan", async () => {
    const casos: Guion[] = [
      { content: [{ type: "thinking", thinking: "hmm", signature: "sig" }, { type: "text", text: "Hi" }] },
      { content: "Hi", additional_kwargs: { reasoning: { id: "rs_1", encrypted_content: "x" } } },
      { content: "Hi", sinParada: true },
    ];
    for (const caso of casos) {
      const m = new ModeloDePrueba();
      m.guion = [caso, caso];
      const mw = savingsAgentMiddleware({ silenceWarnings: true });
      const agente = createAgent({ model: m, tools: [], middleware: [mw] });
      await agente.invoke(PREGUNTA);
      await agente.invoke(PREGUNTA);
      expect(m.llamadas, JSON.stringify(caso)).toBe(2);
      mw.close();
    }
  });

  it("camino de último recurso del núcleo: una llamada, medida y con su traza", async () => {
    const rota = { get: async () => { throw new Error("cache down"); }, set: async () => {}, delete: async () => {} };
    const m = new ModeloDePrueba();
    const mw = savingsAgentMiddleware({ silenceWarnings: true, exactCache: rota });
    const r = await createAgent({ model: m, tools: [], middleware: [mw] }).invoke(PREGUNTA);
    const informe = getSavingsReportFromMessage(ultimo(r));
    expect(m.llamadas).toBe(1);
    expect(informe?.cost.basis).toBe("measured");
    expect(informe?.traces.some((t) => t.stage === "fail-open")).toBe(true);
    mw.close();
  });

  it("(h) sin licencia: LicenseError y el modelo NO se llama", async () => {
    const m = new ModeloDePrueba();
    await sinLicencia(async () => {
      const mw = savingsAgentMiddleware({ silenceWarnings: true });
      const agente = createAgent({ model: m, tools: [], middleware: [mw] });
      // LangChain envuelve el error de un middleware en su `MiddlewareError`, que
      // conserva el nombre y lleva el original en `cause`.
      const e = (await agente.invoke(PREGUNTA).catch((x: unknown) => x)) as { name?: string; cause?: unknown };
      expect(e.name).toBe("LicenseError");
      expect(e.cause).toBeInstanceOf(LicenseError);
      mw.close();
    });
    expect(m.llamadas).toBe(0);
  });

  it("(i) lo que sigue hacia el modelo son LOS MISMOS objetos que recibió el adaptador", async () => {
    const m = new ModeloDePrueba();
    let recibida: unknown;
    let siguiente: unknown;
    const mw = savingsAgentMiddleware({
      silenceWarnings: true,
      context: (request) => {
        recibida = request;
        return undefined;
      },
    });
    const espia = createMiddleware({
      name: "Espia",
      wrapModelCall: async (request, handler) => {
        siguiente = request;
        return handler(request);
      },
    });
    const agente = createAgent({ model: m, tools: [], middleware: [mw, espia] });
    await agente.invoke(PREGUNTA);
    // LangChain entrega a cada capa de middleware un objeto de petición nuevo;
    // lo que tiene que llegar intacto es su contenido.
    const a = recibida as Record<string, unknown>;
    const b = siguiente as Record<string, unknown>;
    expect(b).toBeDefined();
    // (`state` y `runtime` también se recrean por capa, y no viajan al modelo.)
    for (const k of ["model", "messages", "systemMessage", "tools"]) expect(b[k], k).toBe(a[k]);
    expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
    mw.close();
  });

  it("(m) un modelo con `cache` propia sale unmeasured y avisa UNA vez; uno `fake…`, unmeasured", async () => {
    const avisos: string[] = [];
    const espia = vi.spyOn(console, "warn").mockImplementation((m: unknown) => {
      avisos.push(String(m));
    });
    try {
      const conCache = new ModeloDePrueba();
      conCache.cache = new InMemoryCache();
      const mw = savingsAgentMiddleware({});
      const agente = createAgent({ model: conCache, tools: [], middleware: [mw] });
      const r1 = await agente.invoke({ messages: [{ role: "user", content: "Name a planet." }] });
      await agente.invoke({ messages: [{ role: "user", content: "Name a river." }] });
      expect(getSavingsReportFromMessage(ultimo(r1))?.cost.basis).toBe("unmeasured");
      expect(avisos.filter((a) => a.includes("its own `cache`"))).toHaveLength(1);
      mw.close();

      const falso = new ModeloDePrueba();
      falso.tipo = "fake-tool-calling";
      const mw2 = savingsAgentMiddleware({ silenceWarnings: true });
      const r2 = await createAgent({ model: falso, tools: [], middleware: [mw2] }).invoke(PREGUNTA);
      expect(getSavingsReportFromMessage(ultimo(r2))?.cost.basis).toBe("unmeasured");
      mw2.close();
    } finally {
      espia.mockRestore();
    }
  });

  it("con salida estructurada solo se mide: ni resolvers ni reutilización", async () => {
    const m = new ModeloDePrueba();
    m.guion = [{ content: '{"n":8}' }, { content: '{"n":8}' }];
    const mw = savingsAgentMiddleware({ silenceWarnings: true });
    const hook = mw.wrapModelCall as (req: unknown, handler: (r: unknown) => Promise<AIMessage>) => Promise<AIMessage>;
    // Una petición de agente con `responseFormat`, pasada directamente al gancho.
    const peticion = () => ({ model: m, tools: [], responseFormat: { type: "json_schema" }, state: {}, runtime: {} });
    const handler = async () => {
      const g = await m._generate([]);
      return g.generations[0]!.message as AIMessage;
    };
    const r1 = await hook({ ...peticion(), messages: [{ getType: () => "human", content: "What is 2 + 2 * 3?" }] }, handler);
    const r2 = await hook({ ...peticion(), messages: [{ getType: () => "human", content: "What is 2 + 2 * 3?" }] }, handler);
    expect(m.llamadas).toBe(2);
    expect([r1.content, r2.content]).toEqual(['{"n":8}', '{"n":8}']);
    mw.close();
  });
});
