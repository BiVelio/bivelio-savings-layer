import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as ai7 from "ai";
import { MockLanguageModelV4 } from "ai/test";
import * as ai6 from "ai-v6";
import { MockLanguageModelV3 } from "ai-v6/test";
import { LicenseError } from "../../src/index.js";
import { getSavingsReport, savingsMiddleware } from "@bivelio/savings-layer/ai-sdk";
import { coleccion, medicion, prohibirLaRed, sinLicencia, vaciar } from "./ayudas.js";

/**
 * EL ADAPTADOR DEL VERCEL AI SDK, contra el AI SDK DE VERDAD en sus dos líneas
 * soportadas (7 y 6), con los modelos de prueba del propio AI SDK. Sin red.
 *
 * El proveedor de los dobles se llama `openai.chat` a propósito: un proveedor
 * `mock-…` es un modelo de prueba y su contador sale `unmeasured` (D8), que es
 * justo lo que NO queremos medir aquí salvo en el test que lo comprueba.
 */

let restaurarRed: () => void;
beforeAll(() => {
  restaurarRed = prohibirLaRed();
});
afterAll(() => restaurarRed());

type Lib = typeof ai7;
const USO = {
  inputTokens: { total: 10, noCache: 7, cacheRead: 3, cacheWrite: 0 },
  outputTokens: { total: 4, text: 4, reasoning: 0 },
};
const PARADA = { unified: "stop", raw: "stop" } as const;

// Un stream con todo lo que el observador tiene que reenviar sin tocar.
function partesVivas(texto = "Hello") {
  return [
    { type: "stream-start", warnings: [] },
    { type: "response-metadata", id: "resp-1", modelId: "gpt-4o-mini", timestamp: new Date(0) },
    { type: "reasoning-start", id: "r" },
    { type: "reasoning-delta", id: "r", delta: "thinking" },
    { type: "reasoning-end", id: "r" },
    { type: "raw", rawValue: { anything: 1 } },
    { type: "text-start", id: "0" },
    { type: "text-delta", id: "0", delta: texto.slice(0, 2) },
    { type: "text-delta", id: "0", delta: texto.slice(2) },
    { type: "text-end", id: "0" },
    { type: "finish", finishReason: PARADA, usage: USO },
  ];
}

interface Doble {
  model: InstanceType<typeof MockLanguageModelV4>;
  llamadas: number;
  vistos: unknown[];
}

function doble(
  Mock: typeof MockLanguageModelV4 | typeof MockLanguageModelV3,
  lib: Lib,
  o: {
    contenido?: () => unknown[];
    parada?: unknown;
    partes?: () => unknown[];
    proveedor?: string;
  } = {},
): Doble {
  const d: Doble = { llamadas: 0, vistos: [], model: undefined as never };
  d.model = new (Mock as typeof MockLanguageModelV4)({
    provider: o.proveedor ?? "openai.chat",
    modelId: "gpt-4o-mini",
    doGenerate: (async (params: unknown) => {
      d.llamadas += 1;
      d.vistos.push(params);
      return {
        content: o.contenido?.() ?? [{ type: "text", text: "Hello" }],
        finishReason: o.parada ?? PARADA,
        usage: USO,
        warnings: [],
      };
    }) as never,
    doStream: (async (params: unknown) => {
      d.llamadas += 1;
      d.vistos.push(params);
      return { stream: lib.simulateReadableStream({ chunks: (o.partes?.() ?? partesVivas()) as never[] }) };
    }) as never,
  });
  return d;
}

async function leer<T>(stream: ReadableStream<T>): Promise<T[]> {
  const partes: T[] = [];
  const lector = stream.getReader();
  for (;;) {
    const { done, value } = await lector.read();
    if (done) return partes;
    partes.push(value);
  }
}

const VERSIONES = [
  ["ai 7", ai7, MockLanguageModelV4],
  ["ai 6", ai6 as unknown as Lib, MockLanguageModelV3],
] as const;

describe.each(VERSIONES)("savingsMiddleware con %s", (_nombre, lib, Mock) => {
  it("(a) llamada viva: una llamada, medida con el contador del doble, informe en providerMetadata y un registro de uso", async () => {
    const d = doble(Mock, lib);
    const { onReport, informes } = coleccion();
    const { opciones, registros } = medicion();
    const mw = savingsMiddleware({ onReport, silenceWarnings: true, ...opciones });
    const r = await lib.generateText({ model: lib.wrapLanguageModel({ model: d.model, middleware: mw }), prompt: "Name a colour.", temperature: 0 });
    await vaciar();
    expect(r.text).toBe("Hello");
    expect(d.llamadas).toBe(1);
    const informe = getSavingsReport(r);
    expect(informe?.cost.basis).toBe("measured");
    expect(informe?.model).toBe("openai/gpt-4o-mini");
    expect(informe?.tokens.actualInput).toBe(10);
    expect(informe?.tokens.actualOutput).toBe(4);
    expect(informe?.tokens.providerCachedInput).toBe(3);
    expect(informes).toHaveLength(1);
    expect(informes[0]?.requestId).toBe(informe?.requestId);
    expect(registros).toHaveLength(1);
    mw.close();
  });

  it("(b) la repetición idéntica sale de la caché exacta sin llamar, valorada por referencia y con uso 0", async () => {
    const d = doble(Mock, lib);
    const mw = savingsMiddleware({ silenceWarnings: true });
    const model = lib.wrapLanguageModel({ model: d.model, middleware: mw });
    await lib.generateText({ model, prompt: "Name a colour.", temperature: 0 });
    const r = await lib.generateText({ model, prompt: "Name a colour.", temperature: 0 });
    expect(d.llamadas).toBe(1);
    expect(r.text).toBe("Hello");
    expect(getSavingsReport(r)?.cache.result).toBe("exact");
    expect(getSavingsReport(r)?.cost.basis).toBe("reference");
    expect(r.usage.inputTokens).toBe(0);
    expect(r.usage.outputTokens).toBe(0);
    mw.close();
  });

  it("(c) una cuenta se contesta sin llamar al modelo, y sale estimada", async () => {
    const d = doble(Mock, lib);
    const mw = savingsMiddleware({ silenceWarnings: true });
    const r = await lib.generateText({ model: lib.wrapLanguageModel({ model: d.model, middleware: mw }), prompt: "What is 2 + 2 * 3?" });
    expect(r.text).toBe("8");
    expect(d.llamadas).toBe(0);
    expect(getSavingsReport(r)?.cost.basis).toBe("estimated");
    mw.close();
  });

  it("(d) stream vivo: las partes llegan idénticas y en su orden, y solo `finish` gana el informe", async () => {
    // Además de razonamiento y `raw`, la entrada de una herramienta que el modelo
    // empezó a escribir (`tool-input-*`): el observador reenvía lo que no lee.
    const partes = () => {
      const p = partesVivas();
      p.splice(p.length - 1, 0, { type: "tool-input-start", id: "t1", toolName: "lookup" } as never, { type: "tool-input-delta", id: "t1", delta: "{}" } as never, { type: "tool-input-end", id: "t1" } as never);
      return p;
    };
    const d = doble(Mock, lib, { partes });
    const mw = savingsMiddleware({ silenceWarnings: true });
    const model = lib.wrapLanguageModel({ model: d.model, middleware: mw });
    const { stream } = await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "Say hello." }] }] } as never);
    const recibidas = (await leer(stream as ReadableStream<Record<string, unknown>>)) as Record<string, unknown>[];
    const esperadas = partes();
    expect(recibidas.map((p) => p.type)).toEqual(esperadas.map((p) => p.type));
    expect(recibidas.slice(0, -1)).toEqual(esperadas.slice(0, -1));
    const fin = recibidas.at(-1) as { providerMetadata?: { bivelio?: { savingsReport?: { streaming?: unknown; cost?: { basis?: string } } } } };
    expect(fin.providerMetadata?.bivelio?.savingsReport?.streaming).toMatchObject({ delivery: "live" });
    expect(fin.providerMetadata?.bivelio?.savingsReport?.cost?.basis).toBe("measured");
    expect(d.llamadas).toBe(1);
    mw.close();
  });

  it("(e) el atajo en stream lo parsea el propio AI SDK: textStream y providerMetadata", async () => {
    const d = doble(Mock, lib);
    const mw = savingsMiddleware({ silenceWarnings: true });
    const model = lib.wrapLanguageModel({ model: d.model, middleware: mw });
    for (let i = 0; i < 2; i++) {
      const s = lib.streamText({ model, prompt: "Say hello.", temperature: 0 });
      let texto = "";
      for await (const t of s.textStream) texto += t;
      expect(texto).toBe("Hello");
      const informe = getSavingsReport({ providerMetadata: await s.providerMetadata });
      if (i === 0) expect(informe?.streaming?.delivery).toBe("live");
      else {
        expect(informe?.cache.result).toBe("exact");
        expect(informe?.streaming).toEqual({ delivery: "whole", wholeReason: "shortcut" });
      }
    }
    expect(d.llamadas).toBe(1);
    mw.close();
  });

  it("(f) herramientas: sin declarar, nunca de caché; declarada de lectura, sí; del proveedor, nunca", async () => {
    const herramientas = (lib: Lib) => ({
      lookup: lib.tool({ description: "look up", inputSchema: lib.jsonSchema({ type: "object", properties: { q: { type: "string" } } }) }),
    });
    for (const [lectura, esperado] of [[[], 2], [["lookup"], 1]] as const) {
      const d = doble(Mock, lib);
      const mw = savingsMiddleware({ silenceWarnings: true, readOnlyTools: lectura });
      const model = lib.wrapLanguageModel({ model: d.model, middleware: mw });
      let ultimo;
      for (let i = 0; i < 2; i++) {
        // `generateText` con herramientas genéricas: el tipo exacto de `tools` no
        // es lo que se prueba aquí.
        const generar = lib.generateText as unknown as (o: Record<string, unknown>) => Promise<{ providerMetadata?: unknown }>;
        ultimo = await generar({ model, prompt: "Name a colour.", temperature: 0, tools: herramientas(lib) });
      }
      expect(d.llamadas, `readOnlyTools=${JSON.stringify(lectura)}`).toBe(esperado);
      if (esperado === 2) {
        const trazas = getSavingsReport(ultimo as never)?.traces.map((t) => t.outcome).join(" ");
        expect(trazas).toMatch(/write\/destructive tools/);
      }
      mw.close();
    }
    // Una herramienta del PROVEEDOR es `write` aunque se declare de lectura.
    const d = doble(Mock, lib);
    const mw = savingsMiddleware({ silenceWarnings: true, readOnlyTools: ["web_search"] });
    const model = lib.wrapLanguageModel({ model: d.model, middleware: mw });
    const params = {
      prompt: [{ role: "user", content: [{ type: "text", text: "Name a colour." }] }],
      temperature: 0,
      tools: [{ type: "provider", id: "openai.web_search", name: "web_search", args: {} }],
    };
    await model.doGenerate(params as never);
    await model.doGenerate(params as never);
    expect(d.llamadas).toBe(2);
    mw.close();
  });

  it("(g) una respuesta con fichero, fuente o razonamiento firmado no se reutiliza", async () => {
    // El `data` de un fichero cambió de forma entre V3 (ai 6) y V4 (ai 7).
    const datos = lib === ai7 ? { type: "data", data: "AAAA" } : "AAAA";
    const casos = [
      [{ type: "file", mediaType: "image/png", data: datos }, { type: "text", text: "Hello" }],
      [{ type: "source", sourceType: "url", id: "s", url: "https://example.com" }, { type: "text", text: "Hello" }],
      [{ type: "reasoning", text: "hmm", providerMetadata: { anthropic: { signature: "sig" } } }, { type: "text", text: "Hello" }],
    ];
    for (const contenido of casos) {
      const d = doble(Mock, lib, { contenido: () => contenido });
      const mw = savingsMiddleware({ silenceWarnings: true });
      const model = lib.wrapLanguageModel({ model: d.model, middleware: mw });
      await lib.generateText({ model, prompt: "Name a colour.", temperature: 0 });
      const r = await lib.generateText({ model, prompt: "Name a colour.", temperature: 0 });
      expect(d.llamadas, JSON.stringify(contenido[0])).toBe(2);
      expect(getSavingsReport(r)?.cost.basis).toBe("measured");
      mw.close();
    }
  });

  it("(h) sin licencia: LicenseError y el modelo NO se llama (generate y stream)", async () => {
    const d = doble(Mock, lib);
    await sinLicencia(async () => {
      const mw = savingsMiddleware({ silenceWarnings: true });
      const model = lib.wrapLanguageModel({ model: d.model, middleware: mw });
      await expect(model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] } as never)).rejects.toBeInstanceOf(LicenseError);
      await expect(model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] } as never)).rejects.toBeInstanceOf(LicenseError);
      mw.close();
    });
    expect(d.llamadas).toBe(0);
  });

  it("(i) el modelo recibe EL MISMO objeto de parámetros que envió el framework", async () => {
    const d = doble(Mock, lib);
    const mw = savingsMiddleware({ silenceWarnings: true });
    const model = lib.wrapLanguageModel({ model: d.model, middleware: mw });
    const params = { prompt: [{ role: "user", content: [{ type: "text", text: "Name a colour." }] }], maxOutputTokens: 50 };
    await model.doGenerate(params as never);
    expect(d.vistos[0]).toBe(params);
    const enStream = { prompt: [{ role: "user", content: [{ type: "text", text: "Name a shape." }] }] };
    const { stream } = await model.doStream(enStream as never);
    await leer(stream);
    expect(d.vistos[1]).toBe(enStream);
    mw.close();
  });

  it("un modelo de prueba (`mock-…`) no da la factura: unmeasured", async () => {
    const d = doble(Mock, lib, { proveedor: "mock-provider" });
    const mw = savingsMiddleware({ silenceWarnings: true });
    const r = await lib.generateText({ model: lib.wrapLanguageModel({ model: d.model, middleware: mw }), prompt: "Name a colour." });
    expect(getSavingsReport(r)?.cost.basis).toBe("unmeasured");
    mw.close();
  });

  it("un stream que el lector cancela, o que el proveedor corta con error, no registra uso", async () => {
    const { opciones, registros } = medicion();
    const d = doble(Mock, lib);
    const mw = savingsMiddleware({ silenceWarnings: true, ...opciones });
    const model = lib.wrapLanguageModel({ model: d.model, middleware: mw });
    const { stream } = await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "Say hello." }] }] } as never);
    const lector = stream.getReader();
    await lector.read();
    await lector.cancel();

    const conError = doble(Mock, lib, {
      partes: () => [{ type: "stream-start", warnings: [] }, { type: "error", error: new Error("overloaded") }],
    });
    const mw2 = savingsMiddleware({ silenceWarnings: true, ...opciones });
    const model2 = lib.wrapLanguageModel({ model: conError.model, middleware: mw2 });
    const r2 = await model2.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "Say hi." }] }] } as never);
    const partes = (await leer(r2.stream)) as { type: string }[];
    expect(partes.map((p) => p.type)).toEqual(["stream-start", "error"]);
    await vaciar();
    expect(registros).toHaveLength(0);
    mw.close();
    mw2.close();
  });

  it("las palancas se apagan: globalmente y por llamada (providerOptions.bivelio)", async () => {
    const d = doble(Mock, lib);
    const mw = savingsMiddleware({ silenceWarnings: true, savings: { deterministicResolvers: false } });
    const model = lib.wrapLanguageModel({ model: d.model, middleware: mw });
    const r = await lib.generateText({ model, prompt: "What is 2 + 2 * 3?" });
    expect(d.llamadas).toBe(1);
    expect(r.text).toBe("Hello");
    const bivelio = { savings: { exactCache: false } };
    await lib.generateText({ model, prompt: "Name a colour.", temperature: 0, providerOptions: { bivelio } as never });
    await lib.generateText({ model, prompt: "Name a colour.", temperature: 0, providerOptions: { bivelio } as never });
    expect(d.llamadas).toBe(3);
    mw.close();
  });

  it("camino de último recurso del núcleo: generate y stream llaman al modelo ENTERO, una vez, y se entregan con informe", async () => {
    // Una caché exacta que falla hace fallar al optimizador ANTES de llamar: el
    // núcleo rescata la petición con una llamada directa (generate) al proveedor.
    const rota = { get: async () => { throw new Error("cache down"); }, set: async () => {}, delete: async () => {} };
    const d = doble(Mock, lib);
    const mw = savingsMiddleware({ silenceWarnings: true, exactCache: rota });
    const model = lib.wrapLanguageModel({ model: d.model, middleware: mw });
    const r = await lib.generateText({ model, prompt: "Name a colour.", temperature: 0 });
    expect(r.text).toBe("Hello");
    expect(getSavingsReport(r)?.traces.some((t) => t.stage === "fail-open")).toBe(true);
    const s = lib.streamText({ model, prompt: "Name a shape.", temperature: 0 });
    let texto = "";
    for await (const t of s.textStream) texto += t;
    expect(texto).toBe("Hello");
    const informe = getSavingsReport({ providerMetadata: await s.providerMetadata });
    expect(informe?.streaming).toEqual({ delivery: "whole", wholeReason: "fail-open" });
    expect(informe?.cost.basis).toBe("measured");
    expect(d.llamadas).toBe(2);
    mw.close();
  });

  it("reportInMetadata:false no toca providerMetadata, y onReport sigue llegando", async () => {
    const d = doble(Mock, lib);
    const { onReport, informes } = coleccion();
    const mw = savingsMiddleware({ silenceWarnings: true, reportInMetadata: false, onReport });
    const r = await lib.generateText({ model: lib.wrapLanguageModel({ model: d.model, middleware: mw }), prompt: "Name a colour." });
    expect(getSavingsReport(r)).toBeUndefined();
    expect(informes).toHaveLength(1);
    mw.close();
  });
});

describe("savingsMiddleware — tipos", () => {
  it("(j) el MISMO objeto sirve a wrapLanguageModel de ai 7 y de ai 6", async () => {
    const mw = savingsMiddleware({ silenceWarnings: true });
    // Tipos: con ai 7 instalado, el middleware es asignable sin conversión.
    const tipado7: Parameters<typeof ai7.wrapLanguageModel>[0]["middleware"] = mw;
    expect(tipado7).toBe(mw);
    // En tiempo de ejecución, con los dos (el test de tipos contra ai 6 compila
    // el `.d.ts` publicado: ver tipos-publicados.test.ts).
    const d7 = doble(MockLanguageModelV4, ai7);
    const d6 = doble(MockLanguageModelV3, ai6 as unknown as Lib);
    const r7 = await ai7.generateText({ model: ai7.wrapLanguageModel({ model: d7.model, middleware: mw }), prompt: "Name a fruit." });
    const r6 = await ai6.generateText({ model: ai6.wrapLanguageModel({ model: d6.model as never, middleware: mw as never }), prompt: "Name a fruit." });
    expect([r7.text, r6.text]).toEqual(["Hello", "Hello"]);
    mw.close();
  });
});
