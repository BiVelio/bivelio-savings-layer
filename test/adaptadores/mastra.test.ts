import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream } from "ai";
import { z } from "zod";
import { savingsProcessor } from "@bivelio/savings-layer/mastra";
import { coleccion, medicion, prohibirLaRed, sinLicencia, vaciar } from "./ayudas.js";

/**
 * EL ADAPTADOR DE MASTRA, con un `Agent` de verdad (Mastra 1.71) y el modelo de
 * prueba del AI SDK. Sin red.
 */

let restaurarRed: () => void;
beforeAll(() => {
  process.env.MASTRA_TELEMETRY_DISABLED = "true";
  restaurarRed = prohibirLaRed();
});
afterAll(() => restaurarRed());

const USO = {
  inputTokens: { total: 10, noCache: 7, cacheRead: 3, cacheWrite: 0 },
  outputTokens: { total: 4, text: 4, reasoning: 0 },
};
const PARADA = { unified: "stop", raw: "stop" } as const;

interface Doble {
  model: MockLanguageModelV4;
  llamadas: number;
  fallar: boolean;
}

function doble(o: { contenido?: () => unknown[]; texto?: string } = {}): Doble {
  const d: Doble = { llamadas: 0, fallar: false, model: undefined as never };
  const texto = o.texto ?? "Hello world";
  d.model = new MockLanguageModelV4({
    provider: "openai.chat",
    modelId: "gpt-4o-mini",
    doGenerate: (async () => {
      d.llamadas += 1;
      if (d.fallar) throw Object.assign(new Error("boom 400"), { statusCode: 400 });
      return { content: o.contenido?.() ?? [{ type: "text", text: texto }], finishReason: PARADA, usage: USO, warnings: [] };
    }) as never,
    doStream: (async () => {
      d.llamadas += 1;
      if (d.fallar) throw Object.assign(new Error("boom 400"), { statusCode: 400 });
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "response-metadata", id: "resp-1", modelId: "gpt-4o-mini", timestamp: new Date(0) },
            { type: "text-start", id: "0" },
            { type: "text-delta", id: "0", delta: texto.slice(0, 5) },
            { type: "text-delta", id: "0", delta: texto.slice(5) },
            { type: "text-end", id: "0" },
            { type: "finish", finishReason: PARADA, usage: USO },
          ] as never[],
        }),
      };
    }) as never,
  });
  return d;
}

function agente(d: Doble, proc: ReturnType<typeof savingsProcessor>, extra: Record<string, unknown> = {}): Agent {
  return new Agent({ id: "a", name: "a", instructions: "Be brief.", model: d.model, inputProcessors: [proc], ...extra } as never);
}

describe("savingsProcessor", () => {
  it("(a) llamada viva: una llamada, medida con el contador del modelo, onReport y un registro", async () => {
    const d = doble();
    const { onReport, informes } = coleccion();
    const { opciones, registros } = medicion();
    const proc = savingsProcessor({ silenceWarnings: true, onReport, ...opciones });
    const r = await agente(d, proc).generate("Say hello", { modelSettings: { temperature: 0 } });
    await vaciar();
    expect(r.text).toBe("Hello world");
    expect(d.llamadas).toBe(1);
    expect(informes).toHaveLength(1);
    expect(informes[0]?.cost.basis).toBe("measured");
    expect(informes[0]?.model).toBe("openai/gpt-4o-mini");
    expect(informes[0]?.tokens.actualInput).toBe(10);
    expect(informes[0]?.tokens.actualOutput).toBe(4);
    expect(informes[0]?.tokens.providerCachedInput).toBe(3);
    expect(registros).toHaveLength(1);
    proc.close();
  });

  it("(b) la repetición idéntica se contesta sin llamar: caché exacta, por referencia, uso 0 e informe en providerMetadata", async () => {
    const d = doble();
    const { onReport, informes } = coleccion();
    const proc = savingsProcessor({ silenceWarnings: true, onReport });
    const a = agente(d, proc);
    await a.generate("Say hello", { modelSettings: { temperature: 0 } });
    const r = await a.generate("Say hello", { modelSettings: { temperature: 0 } });
    expect(d.llamadas).toBe(1);
    expect(r.text).toBe("Hello world");
    expect(informes[1]?.cache.result).toBe("exact");
    expect(informes[1]?.cost.basis).toBe("reference");
    expect(r.usage.inputTokens ?? 0).toBe(0);
    const pm = (r as unknown as { providerMetadata?: { bivelio?: { savingsReport?: { requestId?: string } } } }).providerMetadata;
    expect(pm?.bivelio?.savingsReport?.requestId).toBe(informes[1]?.requestId);
    proc.close();
  });

  it("(c) una cuenta se contesta sin llamar", async () => {
    const d = doble();
    const { onReport, informes } = coleccion();
    const proc = savingsProcessor({ silenceWarnings: true, onReport });
    const r = await agente(d, proc).generate("What is 2 + 2 * 3?");
    expect(r.text).toBe("8");
    expect(d.llamadas).toBe(0);
    expect(informes[0]?.cost.basis).toBe("estimated");
    proc.close();
  });

  it("(d)(e) agent.stream: en vivo se mide, y la repetición sale del atajo por textStream", async () => {
    const d = doble();
    const { onReport, informes } = coleccion();
    const proc = savingsProcessor({ silenceWarnings: true, onReport });
    const a = agente(d, proc);
    for (let i = 0; i < 2; i++) {
      const s = await a.stream("Say hello", { modelSettings: { temperature: 0 } });
      let texto = "";
      for await (const t of s.textStream) texto += t;
      expect(texto).toBe("Hello world");
    }
    expect(d.llamadas).toBe(1);
    expect(informes.map((i) => i.cost.basis)).toEqual(["measured", "reference"]);
    proc.close();
  });

  it("(f) herramientas: sin declarar, la respuesta final no se reutiliza; declarada de lectura, sí", async () => {
    const lookup = createTool({
      id: "lookup",
      description: "look it up",
      inputSchema: z.object({ q: z.string() }),
      execute: async () => ({ r: 1 }),
    });
    for (const [lectura, esperado] of [[[], 2], [["lookup"], 1]] as const) {
      const d = doble();
      const proc = savingsProcessor({ silenceWarnings: true, readOnlyTools: lectura });
      const a = agente(d, proc, { tools: { lookup } });
      await a.generate("Name a colour.", { modelSettings: { temperature: 0 } });
      await a.generate("Name a colour.", { modelSettings: { temperature: 0 } });
      expect(d.llamadas, JSON.stringify(lectura)).toBe(esperado);
      proc.close();
    }
  });

  it("(g) razonamiento firmado: no se reutiliza", async () => {
    const d = doble({
      contenido: () => [
        { type: "reasoning", text: "hmm", providerMetadata: { anthropic: { signature: "sig" } } },
        { type: "text", text: "Hello" },
      ],
    });
    const proc = savingsProcessor({ silenceWarnings: true });
    const a = agente(d, proc);
    await a.generate("Name a colour.", { modelSettings: { temperature: 0 } });
    await a.generate("Name a colour.", { modelSettings: { temperature: 0 } });
    expect(d.llamadas).toBe(2);
    proc.close();
  });

  it("camino de último recurso del núcleo: una llamada, medida y con su traza", async () => {
    const rota = { get: async () => { throw new Error("cache down"); }, set: async () => {}, delete: async () => {} };
    const d = doble();
    const { onReport, informes } = coleccion();
    const proc = savingsProcessor({ silenceWarnings: true, onReport, exactCache: rota });
    const r = await agente(d, proc).generate("Say hello", { modelSettings: { temperature: 0 } });
    expect(r.text).toBe("Hello world");
    expect(d.llamadas).toBe(1);
    expect(informes[0]?.cost.basis).toBe("measured");
    expect(informes[0]?.traces.some((t) => t.stage === "fail-open")).toBe(true);
    proc.close();
  });

  it("(h) sin licencia: modo Community — el agente llama al modelo y el gancho directo resuelve", async () => {
    const d = doble();
    await sinLicencia(async () => {
      const proc = savingsProcessor({ silenceWarnings: true });
      const res = await agente(d, proc).generate("Say hello");
      expect(res.text).toBeTruthy();
      proc.close();
    });
    expect(d.llamadas).toBe(1);
    // Y el gancho directo tampoco falla por licencia.
    await sinLicencia(async () => {
      const proc = savingsProcessor({ silenceWarnings: true }) as unknown as {
        processLLMRequest(a: unknown): Promise<unknown>;
        close(): void;
      };
      await expect(
        proc.processLLMRequest({
          state: {},
          stepNumber: 0,
          prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          model: { provider: "openai.chat", modelId: "gpt-4o-mini" },
        }),
      ).resolves.toBeUndefined();
      proc.close();
    });
  });

  it("(k) un error del modelo no registra uso ni deja la llamada pendiente", async () => {
    const d = doble();
    d.fallar = true;
    const { opciones, registros } = medicion();
    const { onReport, informes } = coleccion();
    const proc = savingsProcessor({ silenceWarnings: true, onReport, ...opciones });
    const a = agente(d, proc);
    await expect(a.generate("Say hello")).rejects.toThrow("boom 400");
    await vaciar();
    expect(registros).toHaveLength(0);
    expect(informes).toHaveLength(0);
    // La siguiente llamada funciona y se mide: no quedó nada colgado.
    d.fallar = false;
    const r = await a.generate("Say hello again");
    await vaciar();
    expect(r.text).toBe("Hello world");
    expect(registros).toHaveLength(1);
    proc.close();
  });

  it("(k) una llamada que Mastra nunca devuelve se abandona al vencer el plazo, sin registro", async () => {
    const { opciones, registros } = medicion();
    const { onReport, informes } = coleccion();
    const proc = savingsProcessor({ silenceWarnings: true, onReport, providerTimeoutMs: 20, ...opciones }) as unknown as {
      processInputStep(a: unknown): unknown;
      processLLMRequest(a: unknown): Promise<unknown>;
      processLLMResponse(a: unknown): Promise<unknown>;
      close(): void;
    };
    const state: Record<string, unknown> = {};
    proc.processInputStep({ state, stepNumber: 0, tools: {} });
    const salida = await proc.processLLMRequest({
      state,
      stepNumber: 0,
      prompt: [{ role: "user", content: [{ type: "text", text: "Say hello" }] }],
      model: { provider: "openai.chat", modelId: "gpt-4o-mini" },
    });
    expect(salida).toBeUndefined();
    await new Promise((r) => setTimeout(r, 60));
    // Llega tarde: ya no hay nada que resolver.
    await proc.processLLMResponse({ state, fromCache: false, chunks: [], model: { provider: "openai.chat" } });
    await vaciar();
    expect(registros).toHaveLength(0);
    expect(informes).toHaveLength(0);
    proc.close();
  });

  it("(k) la cancelación también abandona la llamada, sin registro", async () => {
    const { opciones, registros } = medicion();
    const proc = savingsProcessor({ silenceWarnings: true, ...opciones }) as unknown as {
      processInputStep(a: unknown): unknown;
      processLLMRequest(a: unknown): Promise<unknown>;
      processLLMResponse(a: unknown): Promise<unknown>;
      close(): void;
    };
    const state: Record<string, unknown> = {};
    const control = new AbortController();
    proc.processInputStep({ state, stepNumber: 0, tools: {} });
    await proc.processLLMRequest({
      state,
      stepNumber: 0,
      abortSignal: control.signal,
      prompt: [{ role: "user", content: [{ type: "text", text: "Say hello" }] }],
      model: { provider: "openai.chat", modelId: "gpt-4o-mini" },
    });
    control.abort();
    await proc.processLLMResponse({ state, fromCache: false, chunks: [], model: { provider: "openai.chat" } });
    await vaciar();
    expect(registros).toHaveLength(0);
    proc.close();
  });

  it("(k) CONTRATO: el atajo emite los mismos tipos de trozo y las mismas claves de payload que Mastra en vivo", async () => {
    // Lo que Mastra 1.71 entrega a `processLLMResponse` de una respuesta de solo
    // texto en vivo es la fuente de verdad del formato.
    type Trozo = { type: string; payload?: Record<string, unknown> };
    let vivo: Trozo[] = [];
    const espia = {
      id: "espia",
      processLLMResponse(a: { fromCache: boolean; chunks: Trozo[] }) {
        if (!a.fromCache) vivo = a.chunks;
      },
    };
    const d = doble();
    const conEspia = savingsProcessor({ silenceWarnings: true });
    await new Agent({ id: "a", name: "a", instructions: "Be brief.", model: d.model, inputProcessors: [conEspia, espia] } as never).generate(
      "Say hello",
    );
    conEspia.close();
    // Los trozos del atajo, tal como los devuelve el gancho (aquí, el resolver).
    const proc = savingsProcessor({ silenceWarnings: true }) as unknown as {
      processInputStep(a: unknown): unknown;
      processLLMRequest(a: unknown): Promise<{ response?: { chunks: Trozo[] } } | undefined>;
      close(): void;
    };
    const state: Record<string, unknown> = {};
    // Mastra le pasa a `processInputStep` el id del mensaje de la respuesta.
    proc.processInputStep({ state, stepNumber: 0, tools: {}, messageId: "msg-1" });
    const r = await proc.processLLMRequest({
      state,
      stepNumber: 0,
      prompt: [{ role: "user", content: [{ type: "text", text: "What is 2 + 2 * 3?" }] }],
      model: { provider: "openai.chat", modelId: "gpt-4o-mini" },
    });
    const atajo = r?.response?.chunks ?? [];
    expect(vivo.length).toBeGreaterThan(0);
    expect(atajo.map((c) => c.type)).toEqual(vivo.map((c) => c.type));
    atajo.forEach((c, i) => {
      // `providerMetadata` solo aparece cuando el proveedor manda metadatos.
      const claves = (t: Trozo | undefined) => Object.keys(t?.payload ?? {}).filter((k) => k !== "providerMetadata").sort();
      expect(claves(c), c.type).toEqual(claves(vivo[i]));
    });
    proc.close();
  });

  it("emitReportPart: el informe sale como parte `data-bivelio-savings-report` del stream", async () => {
    const d = doble();
    const proc = savingsProcessor({ silenceWarnings: true, emitReportPart: true });
    const s = await agente(d, proc).stream("Say hello", { modelSettings: { temperature: 0 } });
    const tipos: string[] = [];
    let informe: { cost?: { basis?: string } } | undefined;
    for await (const parte of s.fullStream as AsyncIterable<{ type: string; data?: unknown; payload?: { data?: unknown } }>) {
      tipos.push(parte.type);
      if (parte.type === "data-bivelio-savings-report") informe = (parte.data ?? parte.payload?.data) as never;
    }
    expect(tipos).toContain("data-bivelio-savings-report");
    expect(informe?.cost?.basis).toBe("measured");
    proc.close();
  });
});
