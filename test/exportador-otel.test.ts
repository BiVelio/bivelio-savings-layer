import { describe, it, expect } from "vitest";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";

import {
  createMockProvider,
  createSavingsLayer,
  instrumentSavingsLayer,
  recordSavingsOnSpan,
  savingsSpanAttributes,
  type SavingsLayer,
  type SavingsRequest,
  type SavingsResult,
  type SavingsStream,
  type SpanLike,
  type TracerLike,
} from "../src/index.js";
import { StreamAbortedError } from "../src/pipeline/errors.js";
import { SPAN_KIND_CLIENT, SPAN_STATUS_ERROR } from "../src/exporters/otel.js";
import type { Provider, ProviderStreamEvent, ProviderStreamOptions } from "../src/providers/types.js";
import { informeSintetico } from "./helpers/informe-sintetico.js";

/**
 * EL EXPORTADOR OPENTELEMETRY (recomendación n.º 11 del informe de competencia).
 *
 * Lo que defiende, además de que los atributos estén:
 *  · el dinero va en UNA clave por basis y conserva el signo; `unmeasured` y
 *    `shadow` no sacan dinero; la proporción `netSavings` no se confunde con
 *    dinero;
 *  · ni una línea de contenido: ni prompt, ni respuesta, ni mensaje de error;
 *  · la capa instrumentada devuelve LOS MISMOS objetos y LOS MISMOS errores, y
 *    un tracer roto nunca cambia una petición.
 */

function montar() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  return { exporter, provider, spans: () => exporter.getFinishedSpans() };
}

const MODELO = "openai/gpt-4o-mini";
const pedir = (content: string, over: Partial<SavingsRequest> = {}): SavingsRequest => ({
  model: MODELO,
  temperature: 0,
  messages: [{ role: "user", content }],
  ...over,
});

const saved = (attrs: Record<string, unknown>) => Object.keys(attrs).filter((k) => k.startsWith("com.bivelio.cost.saved."));

/** Una capa de mentira que devuelve lo que se le diga: para identidad y para informes sintéticos. */
function capaFalsa(g: {
  generate?: (r: SavingsRequest) => Promise<SavingsResult<unknown>>;
  generateStream?: (r: SavingsRequest) => SavingsStream<unknown>;
}): SavingsLayer & { llamadas: number } {
  const capa = {
    llamadas: 0,
    batches: undefined as unknown as SavingsLayer["batches"],
    generate<T>(r: SavingsRequest): Promise<SavingsResult<T>> {
      capa.llamadas += 1;
      return g.generate!(r) as Promise<SavingsResult<T>>;
    },
    generateStream<T>(r: SavingsRequest): SavingsStream<T> {
      capa.llamadas += 1;
      return g.generateStream!(r) as SavingsStream<T>;
    },
    close() {},
  };
  return capa;
}

const resultado = (report = informeSintetico()): SavingsResult<unknown> => ({
  requestId: report.requestId,
  data: undefined,
  text: "",
  report,
});

function unSpan(spans: ReadableSpan[]): ReadableSpan {
  expect(spans).toHaveLength(1);
  return spans[0]!;
}

describe("instrumentSavingsLayer — un span por petición, con GenAI y com.bivelio.*", () => {
  it("un span por generate(): nombre, kind CLIENT, GenAI y el uso igual al contador del informe", async () => {
    const { provider, spans } = montar();
    const layer = createSavingsLayer({ provider: createMockProvider({ answer: "Paris." }) });
    const traced = instrumentSavingsLayer(layer, { tracer: provider });
    const { report } = await traced.generate(pedir("capital of france?"));
    const s = unSpan(spans());
    expect(s.name).toBe("chat gpt-4o-mini");
    expect(s.kind).toBe(SpanKind.CLIENT);
    expect(s.attributes["gen_ai.operation.name"]).toBe("chat");
    expect(s.attributes["gen_ai.provider.name"]).toBe("openai");
    expect(s.attributes["gen_ai.request.model"]).toBe("gpt-4o-mini");
    expect(s.attributes["gen_ai.request.temperature"]).toBe(0);
    expect(s.attributes["gen_ai.response.model"]).toBe("gpt-4o-mini");
    expect(s.attributes["gen_ai.usage.input_tokens"]).toBe(report.tokens.actualInput);
    expect(s.attributes["gen_ai.usage.output_tokens"]).toBe(report.tokens.actualOutput);
    expect(s.attributes["com.bivelio.request_id"]).toBe(report.requestId);
    expect(s.attributes["com.bivelio.model.id"]).toBe(MODELO);
    expect(s.attributes["com.bivelio.cost.basis"]).toBe(report.cost.basis);
    expect(s.attributes["com.bivelio.cost.currency"]).toBe("USD");
    expect(s.instrumentationScope.name).toBe("@bivelio/savings-layer");
    layer.close();
  });

  it("la segunda petición idéntica (llamada evitada) sale con uso 0 y calls.avoided = 1", async () => {
    const { provider, spans } = montar();
    const layer = createSavingsLayer({ provider: createMockProvider({ answer: "Paris." }) });
    const traced = instrumentSavingsLayer(layer, { tracer: provider });
    await traced.generate(pedir("capital of spain?"));
    const segunda = await traced.generate(pedir("capital of spain?"));
    expect(segunda.report.calls.avoidedLlm).toBe(1);
    const s = spans()[1]!;
    expect(s.attributes["gen_ai.usage.input_tokens"]).toBe(0);
    expect(s.attributes["gen_ai.usage.output_tokens"]).toBe(0);
    expect(s.attributes["com.bivelio.calls.avoided"]).toBe(1);
    expect(s.attributes["com.bivelio.calls.actual"]).toBe(0);
    layer.close();
  });

  it("la proporción no es dinero: net_savings_ratio = cost.netSavings y saved = baselineEstimate − actual", async () => {
    const { provider, spans } = montar();
    const layer = createSavingsLayer({ provider: createMockProvider({ answer: "Paris." }) });
    const traced = instrumentSavingsLayer(layer, { tracer: provider });
    await traced.generate(pedir("capital of italy?"));
    const { report } = await traced.generate(pedir("capital of italy?"));
    const s = spans()[1]!;
    const clave = `com.bivelio.cost.saved.${report.cost.basis}`;
    expect(s.attributes["com.bivelio.cost.net_savings_ratio"]).toBe(report.cost.netSavings);
    expect(s.attributes[clave]).toBeCloseTo(report.cost.baselineEstimate - report.cost.actual, 12);
    // En una llamada evitada la proporción es 1 y el dinero es una fracción de céntimo.
    expect(s.attributes[clave]).not.toBe(s.attributes["com.bivelio.cost.net_savings_ratio"]);
    layer.close();
  });
});

describe("una clave de dinero por basis, con signo, y nada de dinero sin medida", () => {
  it("measured con baseline 1 y actual 1,5: saved.measured = −0,5 y ninguna otra clave saved.*", () => {
    const a = savingsSpanAttributes(
      informeSintetico({ cost: { basis: "measured", baselineEstimate: 1, actual: 1.5, netSavings: -0.5 } }),
    );
    expect(saved(a)).toEqual(["com.bivelio.cost.saved.measured"]);
    expect(a["com.bivelio.cost.saved.measured"]).toBe(-0.5);
  });

  it("reference: su clave y el id de la petición que corrió", () => {
    const a = savingsSpanAttributes(
      informeSintetico({
        calls: { actualLlm: 0, avoidedLlm: 1 },
        cache: {
          result: "exact",
          reference: {
            requestId: "req-que-corrio",
            at: 0,
            inputTokens: 100,
            outputTokens: 20,
            creditedInputTokens: 92,
            creditedOutputTokens: 0,
            cachedInputPer1k: 0.000075,
            outputPer1k: 0.0006,
            tierFactor: 1,
          },
        },
        cost: { basis: "reference", baselineEstimate: 0.0000069, actual: 0, netSavings: 1 },
      }),
    );
    expect(saved(a)).toEqual(["com.bivelio.cost.saved.reference"]);
    expect(a["com.bivelio.cache.reference_request_id"]).toBe("req-que-corrio");
  });

  it("estimated: su clave y ninguna otra", () => {
    const a = savingsSpanAttributes(informeSintetico({ cost: { basis: "estimated", baselineEstimate: 2, actual: 1 } }));
    expect(saved(a)).toEqual(["com.bivelio.cost.saved.estimated"]);
    expect(a["com.bivelio.cost.saved.estimated"]).toBe(1);
  });

  it("unmeasured: contadores sí; ni saved.*, ni baseline/actual, ni ratio, ni uso GenAI", async () => {
    const report = informeSintetico({ cost: { basis: "unmeasured", baselineEstimate: 0, actual: 0.002 } });
    const a = savingsSpanAttributes(report);
    expect(saved(a)).toEqual([]);
    expect(a).not.toHaveProperty("com.bivelio.cost.baseline");
    expect(a).not.toHaveProperty("com.bivelio.cost.actual");
    expect(a).not.toHaveProperty("com.bivelio.cost.net_savings_ratio");
    expect(a["com.bivelio.tokens.actual_input"]).toBe(100);

    const { provider, spans } = montar();
    const traced = instrumentSavingsLayer(capaFalsa({ generate: async () => resultado(report) }), { tracer: provider });
    await traced.generate(pedir("x"));
    const claves = Object.keys(unSpan(spans()).attributes);
    expect(claves.filter((k) => k.startsWith("gen_ai.usage."))).toEqual([]);
    expect(claves).toContain("gen_ai.response.model");
  });

  it("shadow: sin dinero y sin uso (es hipotético)", () => {
    const a = savingsSpanAttributes(
      informeSintetico({ cost: { basis: "shadow", baselineEstimate: 5, actual: 1, netSavings: 0.8 } }),
    );
    expect(saved(a)).toEqual([]);
    expect(a).not.toHaveProperty("com.bivelio.cost.actual");
    expect(a).not.toHaveProperty("com.bivelio.cost.net_savings_ratio");
    const span = { attrs: {} as Record<string, unknown>, setAttributes(x: Record<string, unknown>) { Object.assign(this.attrs, x); }, end() {} };
    recordSavingsOnSpan(span, informeSintetico({ cost: { basis: "shadow" } }), { genAi: true });
    expect(Object.keys(span.attrs).filter((k) => k.startsWith("gen_ai.usage."))).toEqual([]);
  });

  it("el suelo de la elisión va en su carril, solo si existe y nunca sumado al ahorro", () => {
    const con = savingsSpanAttributes(
      informeSintetico({ cost: { basis: "measured", baselineEstimate: 1, actual: 1, eliminatedInputFloorCost: 0.25 } }),
    );
    expect(con["com.bivelio.cost.eliminated_input_floor"]).toBe(0.25);
    expect(con["com.bivelio.cost.saved.measured"]).toBe(0);
    expect(savingsSpanAttributes(informeSintetico())).not.toHaveProperty("com.bivelio.cost.eliminated_input_floor");
  });
});

// Un proveedor con secretos en la respuesta, y otro que lanza con un secreto en el mensaje.
function proveedorQueLanza(): Provider {
  return {
    id: "lanza",
    async generate() {
      throw new Error("SECRETO-ERR-789 upstream said: SECRETO-PROMPT-123");
    },
  };
}

describe("⛔ ni una línea de contenido sale en un span", () => {
  it("ni el prompt, ni la respuesta, ni el mensaje de error: solo ids, contadores, dinero y enumerados", async () => {
    const { provider, spans } = montar();
    const buena = createSavingsLayer({ provider: createMockProvider({ answer: "SECRETO-RESP-456" }) });
    const mala = createSavingsLayer({ provider: proveedorQueLanza() });
    const opciones = { tracer: provider, langfuse: { metadata: true, cost: true }, datadog: { metadata: true } };
    const r = await instrumentSavingsLayer(buena, opciones).generate(pedir("SECRETO-PROMPT-123 what now?"));
    expect(r.text).toContain("SECRETO-RESP-456");
    const s = buena.generateStream(pedir("SECRETO-PROMPT-123 again"));
    await s.result;
    await instrumentSavingsLayer(buena, opciones).generateStream(pedir("SECRETO-PROMPT-123 streamed")).result;
    await expect(instrumentSavingsLayer(mala, opciones).generate(pedir("SECRETO-PROMPT-123 fails"))).rejects.toThrow();

    const todo = spans();
    expect(todo.length).toBeGreaterThanOrEqual(3);
    const volcado = JSON.stringify(todo.map((x) => ({ n: x.name, a: x.attributes, s: x.status, e: x.events })));
    for (const secreto of ["SECRETO-PROMPT-123", "SECRETO-RESP-456", "SECRETO-ERR-789", "upstream said"]) {
      expect(volcado).not.toContain(secreto);
    }
    for (const x of todo) {
      for (const k of Object.keys(x.attributes)) {
        expect(k).not.toMatch(/traces|input\.messages|output\.messages|system_instructions|tool\.call/);
      }
      expect(x.events).toEqual([]);
    }
    const fallo = todo.find((x) => x.status.code === SpanStatusCode.ERROR)!;
    expect(fallo.status.message).toBeUndefined();
    buena.close();
    mala.close();
  });
});

describe("mismos objetos, mismos errores", () => {
  it("generate() resuelve al MISMO objeto y generateStream() devuelve el MISMO stream", async () => {
    const { provider, spans } = montar();
    const res = resultado();
    const stream = { result: Promise.resolve(res), abort() {}, async *[Symbol.asyncIterator]() {} } as unknown as SavingsStream<unknown>;
    const capa = capaFalsa({ generate: async () => res, generateStream: () => stream });
    const traced = instrumentSavingsLayer(capa, { tracer: provider });
    expect(await traced.generate(pedir("x"))).toBe(res);
    expect(traced.generateStream(pedir("y"))).toBe(stream);
    await stream.result;
    await Promise.resolve();
    expect(spans()).toHaveLength(2);
    expect(capa.llamadas).toBe(2);
  });

  it("relanza EL MISMO error; el span queda en ERROR con error.type = su nombre y sin mensaje", async () => {
    class ProveedorCaido extends Error {
      override name = "ProveedorCaido";
    }
    const err = new ProveedorCaido("SECRETO-ERR-789");
    const { provider, spans } = montar();
    const traced = instrumentSavingsLayer(capaFalsa({ generate: () => Promise.reject(err) }), { tracer: provider });
    await expect(traced.generate(pedir("x"))).rejects.toBe(err);
    const s = unSpan(spans());
    expect(s.status.code).toBe(SpanStatusCode.ERROR);
    expect(s.status.message).toBeUndefined();
    expect(s.attributes["error.type"]).toBe("ProveedorCaido");
  });

  it("un error sin nombre de clase reconocible sale como _OTHER", async () => {
    const { provider, spans } = montar();
    const raro = { name: "SECRETO-PROMPT-123 in a name with spaces" };
    const traced = instrumentSavingsLayer(capaFalsa({ generate: () => Promise.reject(raro) }), { tracer: provider });
    await expect(traced.generate(pedir("x"))).rejects.toBe(raro);
    expect(unSpan(spans()).attributes["error.type"]).toBe("_OTHER");
  });
});

describe("fail-open: la telemetría nunca cambia una petición", () => {
  it("si startActiveSpan lanza, generate responde igual (y la capa se llama una vez)", async () => {
    const res = resultado();
    const capa = capaFalsa({ generate: async () => res });
    const roto: TracerLike = {
      startActiveSpan() {
        throw new Error("tracer caído");
      },
    };
    expect(await instrumentSavingsLayer(capa, { tracer: roto }).generate(pedir("x"))).toBe(res);
    expect(capa.llamadas).toBe(1);
  });

  it("si el tracer lanza DESPUÉS de ejecutar la función, se devuelve lo obtenido sin repetir la petición", async () => {
    const res = resultado();
    const capa = capaFalsa({ generate: async () => res });
    const span: SpanLike = { setAttributes() {}, end() {} };
    const tardio: TracerLike = {
      startActiveSpan(_n, _o, fn) {
        fn(span);
        throw new Error("contexto roto");
      },
    };
    expect(await instrumentSavingsLayer(capa, { tracer: tardio }).generate(pedir("x"))).toBe(res);
    expect(capa.llamadas).toBe(1);
  });

  it("si el tracer llama a la función TARDE (fuera de contrato), la petición no se repite y ese span se cierra", async () => {
    const res = resultado();
    const capa = capaFalsa({ generate: async () => res });
    let tarde: ((span: SpanLike) => unknown) | undefined;
    let cerrados = 0;
    const perezoso: TracerLike = {
      startActiveSpan(_n, _o, fn) {
        tarde = fn as (span: SpanLike) => unknown;
        return undefined as never;
      },
    };
    expect(await instrumentSavingsLayer(capa, { tracer: perezoso }).generate(pedir("x"))).toBe(res);
    tarde!({ setAttributes() {}, end: () => void (cerrados += 1) });
    expect(capa.llamadas).toBe(1);
    expect(cerrados).toBe(1);
  });

  it("si setAttributes / setStatus / end lanzan, generate responde igual y el error sigue siendo el mismo", async () => {
    const hostil: SpanLike = {
      setAttributes() {
        throw new Error("x");
      },
      setStatus() {
        throw new Error("y");
      },
      end() {
        throw new Error("z");
      },
    };
    const tracer: TracerLike = { startActiveSpan: (_n, _o, fn) => fn(hostil) };
    const res = resultado();
    expect(await instrumentSavingsLayer(capaFalsa({ generate: async () => res }), { tracer }).generate(pedir("x"))).toBe(res);
    const err = new Error("el de la capa");
    await expect(
      instrumentSavingsLayer(capaFalsa({ generate: () => Promise.reject(err) }), { tracer }).generate(pedir("x")),
    ).rejects.toBe(err);
  });

  it("recordSavingsOnSpan nunca lanza y no hace nada en un span que no graba", () => {
    const escritos: unknown[] = [];
    recordSavingsOnSpan({ isRecording: () => false, setAttributes: (a) => escritos.push(a), end() {} }, informeSintetico());
    expect(escritos).toEqual([]);
    expect(() =>
      recordSavingsOnSpan(
        {
          setAttributes() {
            throw new Error("x");
          },
          end() {},
        },
        informeSintetico(),
      ),
    ).not.toThrow();
  });

  it("un tracer sin métodos es un error de CONFIGURACIÓN: TypeError al instrumentar, no en cada petición", () => {
    const capa = capaFalsa({});
    expect(() => instrumentSavingsLayer(capa, { tracer: {} as TracerLike })).toThrow(TypeError);
    expect(() => instrumentSavingsLayer(capa, { tracer: { getTracer: () => ({}) } as never })).toThrow(TypeError);
    expect(() => instrumentSavingsLayer(capa, { tracer: montar().provider, currency: "usd" })).toThrow(TypeError);
  });

  it("recordSavingsOnSpan no pone gen_ai.* salvo con genAi: true, y entonces solo el uso y response.model", () => {
    const attrs: Record<string, unknown> = {};
    const span: SpanLike = { setAttributes: (a) => void Object.assign(attrs, a), end() {} };
    recordSavingsOnSpan(span, informeSintetico());
    expect(Object.keys(attrs).filter((k) => k.startsWith("gen_ai."))).toEqual([]);
    recordSavingsOnSpan(span, informeSintetico({ tokens: { providerCachedInput: 40 } }), { genAi: true });
    expect(Object.keys(attrs).filter((k) => k.startsWith("gen_ai.")).sort()).toEqual([
      "gen_ai.response.model",
      "gen_ai.usage.cache_read.input_tokens",
      "gen_ai.usage.input_tokens",
      "gen_ai.usage.output_tokens",
    ]);
  });
});

// Un proveedor de stream que escribe un trozo y espera al abort.
function colgado(): Provider {
  return {
    id: "colgado",
    async generate() {
      return { text: "Hello", usage: { inputTokens: 3, outputTokens: 1 }, finishReason: "stop" };
    },
    async *generateStream(_req, options: ProviderStreamOptions = {}): AsyncGenerator<ProviderStreamEvent, void, undefined> {
      yield { type: "text", delta: "Hel" };
      await new Promise<void>((resolve) => {
        const s = options.signal;
        if (!s || s.aborted) return resolve();
        s.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new DOMException("This operation was aborted", "AbortError");
    },
  };
}

describe("generateStream instrumentado", () => {
  it("el span termina tras `result`, con request.stream y time_to_first_chunk en `live`", async () => {
    const { provider, spans } = montar();
    const layer = createSavingsLayer({ provider: createMockProvider({ answer: "a streamed answer here" }) });
    const s = instrumentSavingsLayer(layer, { tracer: provider }).generateStream(pedir("stream me"));
    expect(spans()).toHaveLength(0);
    for await (const _ of s) {
      // se consume
    }
    const { report } = await s.result;
    await Promise.resolve();
    const span = unSpan(spans());
    expect(span.attributes["gen_ai.request.stream"]).toBe(true);
    expect(report.streaming?.delivery).toBe("live");
    expect(span.attributes["gen_ai.response.time_to_first_chunk"]).toBe(report.streaming!.firstEventMs! / 1000);
    expect(span.attributes["com.bivelio.request_id"]).toBe(report.requestId);
    layer.close();
  });

  it("al abortar: error.type = StreamAbortedError y com.bivelio.stream.request_sent", async () => {
    const { provider, spans } = montar();
    const layer = createSavingsLayer({ provider: colgado() });
    const s = instrumentSavingsLayer(layer, { tracer: provider }).generateStream(pedir("never finishes"));
    for await (const e of s) if (e.type === "text") s.abort();
    const err = await s.result.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(StreamAbortedError);
    await Promise.resolve();
    const span = unSpan(spans());
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes["error.type"]).toBe("StreamAbortedError");
    expect(span.attributes["com.bivelio.stream.request_sent"]).toBe(true);
    layer.close();
  });
});

describe("las copias para Langfuse y Datadog, apagadas por defecto", () => {
  const report = informeSintetico({
    cost: { basis: "measured", baselineEstimate: 0.002, actual: 0.0015, netSavings: 0.25 },
    tokens: { providerCachedInput: 30 },
    qualityStatus: "not_verified",
  });

  it("por defecto no hay ninguna clave langfuse.* ni _dd.*", () => {
    const claves = Object.keys(savingsSpanAttributes(report));
    expect(claves.filter((k) => k.startsWith("langfuse.") || k.startsWith("_dd."))).toEqual([]);
  });

  it("langfuse.metadata: claves langfuse.observation.metadata.bivelio_* con valor string", () => {
    const a = savingsSpanAttributes(report, { langfuse: { metadata: true } });
    const lf = Object.entries(a).filter(([k]) => k.startsWith("langfuse.observation.metadata."));
    expect(lf.length).toBeGreaterThan(5);
    for (const [k, v] of lf) {
      expect(k).toMatch(/^langfuse\.observation\.metadata\.bivelio_[a-z_]+$/);
      expect(typeof v).toBe("string");
    }
    expect(a["langfuse.observation.metadata.bivelio_saved_measured"]).toBe("0.0005");
    expect(a["langfuse.observation.metadata.bivelio_basis"]).toBe("measured");
    expect(a).not.toHaveProperty("langfuse.observation.cost_details");
  });

  it("langfuse.cost: cost_details = {\"total\": actual}, solo en USD y con dinero", () => {
    const a = savingsSpanAttributes(report, { langfuse: { cost: true } });
    expect(JSON.parse(String(a["langfuse.observation.cost_details"]))).toEqual({ total: 0.0015 });
    expect(savingsSpanAttributes(report, { langfuse: { cost: true }, currency: "EUR" })).not.toHaveProperty(
      "langfuse.observation.cost_details",
    );
    const sinMedida = informeSintetico({ cost: { basis: "unmeasured" } });
    expect(savingsSpanAttributes(sinMedida, { langfuse: { cost: true } })).not.toHaveProperty(
      "langfuse.observation.cost_details",
    );
  });

  it("datadog.metadata: _dd.ml_obs.metadata es JSON válido con las cifras bajo `bivelio`", () => {
    const a = savingsSpanAttributes(report, { datadog: { metadata: true } });
    const md = JSON.parse(String(a["_dd.ml_obs.metadata"])) as { bivelio: Record<string, unknown> };
    expect(md.bivelio.basis).toBe("measured");
    expect(md.bivelio.saved_measured).toBe(0.0005);
    expect(md.bivelio.provider_cached_input_tokens).toBe(30);
    expect(Object.keys(md.bivelio).filter((k) => k.startsWith("saved_"))).toEqual(["saved_measured"]);
  });
});

// Las claves GenAI de las semantic conventions v1.41.1 (la última PUBLICADA),
// copiadas de https://github.com/open-telemetry/semantic-conventions/blob/v1.41.1/model/gen-ai/registry.yaml
// el 2026‑09‑27 — solo las que este exportador podría usar. Si una release de
// open-telemetry/semantic-conventions-genai cambia alguna, este test obliga a
// decidirlo a mano.
const GEN_AI_V1_41_1 = new Set([
  "gen_ai.operation.name",
  "gen_ai.provider.name",
  "gen_ai.request.model",
  "gen_ai.request.max_tokens",
  "gen_ai.request.temperature",
  "gen_ai.request.seed",
  "gen_ai.request.stream",
  "gen_ai.response.model",
  "gen_ai.response.finish_reasons",
  "gen_ai.response.time_to_first_chunk",
  "gen_ai.usage.input_tokens",
  "gen_ai.usage.output_tokens",
  "gen_ai.usage.cache_read.input_tokens",
  "gen_ai.conversation.id",
]);

describe("higiene de las claves", () => {
  it("toda clave propia es com.bivelio.[a-z0-9_.]; toda gen_ai.* está en el registry v1.41.1; nada de coste GenAI", async () => {
    const { provider, spans } = montar();
    const layer = createSavingsLayer({ provider: createMockProvider({ answer: "ok", cachedInputTokens: 2 }) });
    const traced = instrumentSavingsLayer(layer, { tracer: provider, langfuse: { metadata: true, cost: true } });
    const req = pedir("hygiene check", { seed: 7, context: { sessionId: "sesion-1" } });
    await traced.generate({ ...req, response: { contractId: "c:1", schema: { type: "object" }, maxOutputTokens: 50 } });
    await traced.generateStream(pedir("hygiene stream")).result;
    await Promise.resolve();
    const claves = new Set(spans().flatMap((s) => Object.keys(s.attributes)));
    expect(claves.has("gen_ai.conversation.id")).toBe(true);
    expect(claves.has("gen_ai.request.seed")).toBe(true);
    expect(claves.has("gen_ai.request.max_tokens")).toBe(true);
    expect(claves.has("gen_ai.usage.cache_read.input_tokens")).toBe(true);
    for (const k of claves) {
      if (k.startsWith("com.bivelio.")) expect(k).toMatch(/^com\.bivelio\.[a-z0-9_.]+$/);
      else if (k.startsWith("gen_ai.")) expect(GEN_AI_V1_41_1.has(k), k).toBe(true);
      else expect(k).toMatch(/^(error\.type|langfuse\.observation\.(metadata\.bivelio_[a-z_]+|cost_details)|_dd\.ml_obs\.metadata)$/);
      expect(k).not.toMatch(/cache_creation|cache_write|gen_ai\.usage\.cost/);
    }
    // Ninguna clave propia es a la vez hoja y espacio de nombres.
    const propias = [...claves].filter((k) => k.startsWith("com.bivelio."));
    for (const k of propias) expect(propias.some((o) => o.startsWith(`${k}.`)), k).toBe(false);
    layer.close();
  });

  it("las constantes copiadas coinciden con SpanKind.CLIENT y SpanStatusCode.ERROR del paquete real", () => {
    expect(SPAN_KIND_CLIENT).toBe(SpanKind.CLIENT);
    expect(SPAN_STATUS_ERROR).toBe(SpanStatusCode.ERROR);
  });
});
