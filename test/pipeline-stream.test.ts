import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import { SavingsPipeline } from "../src/pipeline/pipeline.js";
import { StreamAbortedError } from "../src/pipeline/errors.js";
import { LicenseError } from "../src/license/errors.js";
import { TokenizerRegistry } from "../src/tokenizer/registry.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";
import type {
  Provider,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
  ProviderStreamOptions,
  ProviderUsage,
} from "../src/providers/types.js";
import type {
  SavingsRequest,
  SavingsStream,
  SavingsStreamEvent,
  ToolCallRequest,
} from "../src/contracts/types.js";
import type { ExactCache } from "../src/cache/exact.js";

/**
 * generateStream() DE PUNTA A PUNTA.
 *
 * Lo que se defiende aquí, además de que el texto llegue según se escribe:
 *
 *  · el informe de un stream sigue las MISMAS reglas de `basis` que el de
 *    generate() —el contador se lee al final, y sin él la petición es
 *    `unmeasured`—;
 *  · un abort mientras el proveedor escribe no deja caché ni registro, y uno
 *    posterior a su respuesta no deshace nada;
 *  · con contrato, diferible o un proveedor sin streaming, la petición es
 *    EXACTAMENTE la de generate(), entregada de una pieza;
 *  · un stream nunca lidera un singleflight: sus seguidores heredarían su abort.
 */

const USO: ProviderUsage = { inputTokens: 12, outputTokens: 3 };
const MODELO = "openai/gpt-4o-mini";

type GeneradorDeStream = (
  req: ProviderRequest,
  signal: AbortSignal | undefined,
  n: number,
) => AsyncGenerator<ProviderStreamEvent, void, undefined>;

interface Ganchos {
  generate?: (req: ProviderRequest, n: number) => Promise<ProviderResponse> | ProviderResponse;
  stream?: GeneradorDeStream;
}

class Falso implements Provider {
  readonly id = "falso";
  llamadasStream = 0;
  llamadasGenerate = 0;
  constructor(private readonly g: Ganchos = {}) {}

  async generate(req: ProviderRequest): Promise<ProviderResponse> {
    this.llamadasGenerate += 1;
    if (this.g.generate) return await this.g.generate(req, this.llamadasGenerate);
    return { text: "Hello world", usage: USO, finishReason: "stop" };
  }

  async *generateStream(
    req: ProviderRequest,
    options: ProviderStreamOptions = {},
  ): AsyncGenerator<ProviderStreamEvent, void, undefined> {
    this.llamadasStream += 1;
    if (this.g.stream) {
      yield* this.g.stream(req, options.signal, this.llamadasStream);
      return;
    }
    yield* guion(["Hel", "lo ", "world"]);
  }
}

async function* guion(
  trozos: string[],
  final: Partial<ProviderResponse> = {},
  pausaMs = 0,
): AsyncGenerator<ProviderStreamEvent, void, undefined> {
  if (pausaMs > 0) await dormir(pausaMs);
  for (const t of trozos) yield { type: "text", delta: t };
  yield {
    type: "done",
    response: { text: trozos.join(""), usage: USO, finishReason: "stop", ...final },
  };
}

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function hastaAbortar(signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!signal || signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function peticion(over: Partial<SavingsRequest> = {}): SavingsRequest {
  return {
    model: MODELO,
    messages: [{ role: "user", content: "Write a short greeting for the whole world" }],
    ...over,
  } as SavingsRequest;
}

async function recoger<T>(s: SavingsStream<T>): Promise<SavingsStreamEvent<T>[]> {
  const out: SavingsStreamEvent<T>[] = [];
  for await (const e of s) out.push(e);
  return out;
}

function forma(evs: SavingsStreamEvent[]): unknown[] {
  return evs.map((e) =>
    e.type === "text" ? ["text", e.delta] : e.type === "tool_call" ? ["tool_call", e.call] : ["done"],
  );
}

/** Una capa que reporta uso a un endpoint espía (un registro por lote). */
function conMedicion(provider: Provider, extra: Record<string, unknown> = {}) {
  const registros: Record<string, unknown>[] = [];
  const meteringFetch = (async (_url: string, init: RequestInit) => {
    registros.push(...(JSON.parse(String(init.body)) as Record<string, unknown>[]));
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const layer = createSavingsLayer({
    provider,
    devUnlicensed: true,
    serviceAccountKey: "bvk_test",
    meteringUrl: "https://cp.example/api/metering/usage",
    meteringFetch,
    metering: { maxBatch: 1, seatId: "t", ci: false },
    ...extra,
  });
  return { layer, registros };
}

let avisos: string[] = [];
beforeEach(() => {
  avisos = [];
  reiniciarAvisos();
  vi.spyOn(console, "warn").mockImplementation((m: unknown) => {
    avisos.push(String(m));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

const ESQUEMA = {
  type: "object" as const,
  properties: { answer: { type: "number" as const } },
  required: ["answer"],
  additionalProperties: false,
};

describe("generateStream — entrega en vivo", () => {
  it("reenvía los deltas según llegan y cierra con done; el informe es measured y live", async () => {
    const p = new Falso();
    const layer = createSavingsLayer({ provider: p, devUnlicensed: true });
    const s = layer.generateStream(peticion());
    const evs = await recoger(s);
    expect(forma(evs)).toEqual([["text", "Hel"], ["text", "lo "], ["text", "world"], ["done"]]);
    const r = await s.result;
    const done = evs[3]!;
    expect(done.type === "done" && done.result).toBe(r);
    expect(r.text).toBe("Hello world");
    expect(r.report.cost.basis).toBe("measured");
    expect(r.report.streaming?.delivery).toBe("live");
    expect(typeof r.report.streaming?.firstEventMs).toBe("number");
    expect(r.report.streaming!.firstEventMs!).toBeGreaterThanOrEqual(0);
    expect(r.report.streaming && "wholeReason" in r.report.streaming).toBe(false);
    expect(p.llamadasStream).toBe(1);
    expect(p.llamadasGenerate).toBe(0);
  });

  it("`result` sin iterar resuelve; iterar después entrega todos los eventos, done incluido", async () => {
    const p = new Falso();
    const layer = createSavingsLayer({ provider: p, devUnlicensed: true });
    const s = layer.generateStream(peticion());
    const r = await s.result;
    expect(r.text).toBe("Hello world");
    const evs = await recoger(s);
    expect(forma(evs)).toEqual([["text", "Hel"], ["text", "lo "], ["text", "world"], ["done"]]);
  });

  it("emite UN registro de uso, measured, cuando `result` se resuelve", async () => {
    const { layer, registros } = conMedicion(new Falso());
    const s = layer.generateStream(peticion());
    await s.result;
    await vi.waitFor(() => expect(registros).toHaveLength(1));
    expect(registros[0]!["basis"]).toBe("measured");
    expect(registros[0]!["actualInputTokens"]).toBe(12);
    // `streaming` no viaja: el wire no cambia.
    expect("streaming" in registros[0]!).toBe(false);
    layer.close();
  });

  it("generateStream nunca lanza de forma síncrona", async () => {
    const layer = createSavingsLayer({ provider: new Falso(), devUnlicensed: true });
    let s1: SavingsStream | undefined;
    expect(() => (s1 = layer.generateStream(null as unknown as SavingsRequest))).not.toThrow();
    await expect(s1!.result).rejects.toBeInstanceOf(TypeError);
    let s2: SavingsStream | undefined;
    const senalRota = { aborted: false } as unknown as AbortSignal;
    expect(() => (s2 = layer.generateStream(peticion(), { signal: senalRota }))).not.toThrow();
    await expect(s2!.result).rejects.toBeInstanceOf(TypeError);
  });
});

describe("generateStream — abort", () => {
  const abortable = (): Falso =>
    new Falso({
      stream: async function* (_req, signal, n) {
        if (n > 1) {
          yield* guion(["Hel", "lo"]);
          return;
        }
        yield { type: "text", delta: "Hel" };
        await hastaAbortar(signal);
        throw new DOMException("This operation was aborted", "AbortError");
      },
    });

  it("abort() a mitad: el bucle acaba sin error, result rechaza con StreamAbortedError, 0 registros y nada en caché", async () => {
    const p = abortable();
    const { layer, registros } = conMedicion(p);
    const s = layer.generateStream(peticion());
    const vistos: SavingsStreamEvent[] = [];
    for await (const e of s) {
      vistos.push(e);
      if (e.type === "text") s.abort();
    }
    expect(forma(vistos)).toEqual([["text", "Hel"]]);
    const err = await s.result.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(StreamAbortedError);
    expect((err as StreamAbortedError).requestSent).toBe(true);

    // Una segunda petición idéntica vuelve a llamar: no se cacheó media respuesta.
    const r2 = await layer.generateStream(peticion()).result;
    expect(r2.report.cache.result).toBe("miss");
    expect(p.llamadasStream).toBe(2);
    await vi.waitFor(() => expect(registros).toHaveLength(1));
    await dormir(10);
    // El único registro es el de la segunda.
    expect(registros).toHaveLength(1);
    layer.close();
  });

  it("`break` en el for-await tiene el mismo efecto que abort()", async () => {
    const p = abortable();
    const { layer, registros } = conMedicion(p);
    const s = layer.generateStream(peticion());
    for await (const e of s) {
      if (e.type === "text") break;
    }
    await expect(s.result).rejects.toBeInstanceOf(StreamAbortedError);
    await expect(s.result).rejects.toMatchObject({ requestSent: true });
    await dormir(10);
    expect(registros).toHaveLength(0);
    const r2 = await layer.generateStream(peticion()).result;
    expect(r2.report.cache.result).toBe("miss");
    expect(p.llamadasStream).toBe(2);
    layer.close();
  });

  it("una señal ya abortada: result rechaza sin haber enviado nada y la iteración no produce eventos", async () => {
    const p = new Falso();
    const layer = createSavingsLayer({ provider: p, devUnlicensed: true });
    const ctrl = new AbortController();
    ctrl.abort();
    const s = layer.generateStream(peticion(), { signal: ctrl.signal });
    expect(await recoger(s)).toEqual([]);
    await expect(s.result).rejects.toBeInstanceOf(StreamAbortedError);
    await expect(s.result).rejects.toMatchObject({ requestSent: false });
    expect(p.llamadasStream + p.llamadasGenerate).toBe(0);
  });

  it("abortar la señal externa a mitad cancela igual que abort()", async () => {
    const p = abortable();
    const layer = createSavingsLayer({ provider: p, devUnlicensed: true });
    const ctrl = new AbortController();
    const s = layer.generateStream(peticion(), { signal: ctrl.signal });
    const vistos: SavingsStreamEvent[] = [];
    for await (const e of s) {
      vistos.push(e);
      ctrl.abort();
    }
    expect(vistos).toHaveLength(1);
    await expect(s.result).rejects.toMatchObject({ requestSent: true });
  });

  it("un abort DESPUÉS del done del proveedor no deshace nada: result resuelve y hay 1 registro", async () => {
    let soltar!: () => void;
    const bloqueo = new Promise<void>((r) => (soltar = r));
    let avisarSet!: () => void;
    const enSet = new Promise<void>((r) => (avisarSet = r));
    const exactCache: ExactCache = {
      async get() {
        return null;
      },
      async set() {
        avisarSet();
        await bloqueo;
      },
      async delete() {},
    };
    const p = new Falso();
    const { layer, registros } = conMedicion(p, { exactCache });
    const s = layer.generateStream(peticion());
    await enSet;
    s.abort();
    soltar();
    const r = await s.result;
    expect(r.text).toBe("Hello world");
    expect(r.report.streaming?.delivery).toBe("live");
    await vi.waitFor(() => expect(registros).toHaveLength(1));
    layer.close();
  });
});

describe("generateStream — entrega entera", () => {
  it("con contrato va por generate() y se entrega de una pieza, validado", async () => {
    const p = new Falso({ generate: () => ({ text: '{"answer":8}', usage: USO, finishReason: "stop" }) });
    const layer = createSavingsLayer({ provider: p, devUnlicensed: true });
    const s = layer.generateStream<{ answer: number }>(peticion({ response: { contractId: "respuesta", schema: ESQUEMA } }));
    const evs = await recoger(s);
    expect(forma(evs)).toEqual([["text", '{"answer":8}'], ["done"]]);
    const r = await s.result;
    expect(r.report.streaming).toEqual({ delivery: "whole", wholeReason: "output-contract" });
    expect(p.llamadasStream).toBe(0);
    expect(p.llamadasGenerate).toBe(1);
    expect(r.data.answer).toBe(8);
  });

  it("con contrato, la reparación ocurre como en generate() y el único text es el reparado", async () => {
    const p = new Falso({
      generate: (_req, n) =>
        n === 1
          ? { text: "not json at all", usage: USO, finishReason: "stop" }
          : { text: '{"answer":8}', usage: USO, finishReason: "stop" },
    });
    const layer = createSavingsLayer({ provider: p, devUnlicensed: true });
    const s = layer.generateStream(peticion({ response: { contractId: "respuesta", schema: ESQUEMA } }));
    const evs = await recoger(s);
    expect(p.llamadasGenerate).toBe(2);
    expect(forma(evs)).toEqual([["text", '{"answer":8}'], ["done"]]);
  });

  it("con contrato y la respuesta cortada por el tope: no valida y no se cachea", async () => {
    const p = new Falso({ generate: () => ({ text: '{"answer":', usage: USO, finishReason: "length" }) });
    const layer = createSavingsLayer({ provider: p, devUnlicensed: true });
    const r = await layer.generateStream(peticion({ response: { contractId: "respuesta", schema: ESQUEMA } })).result;
    expect(r.report.constraints.structurallyValid).toBe(false);
    const antes = p.llamadasGenerate;
    await layer.generateStream(peticion({ response: { contractId: "respuesta", schema: ESQUEMA } })).result;
    expect(p.llamadasGenerate).toBeGreaterThan(antes);
  });

  it("deferrable va por generate() y se entrega entera", async () => {
    const p = new Falso();
    const layer = createSavingsLayer({ provider: p, devUnlicensed: true });
    const s = layer.generateStream(peticion({ savings: { deferrable: true } }));
    const evs = await recoger(s);
    expect(forma(evs)).toEqual([["text", "Hello world"], ["done"]]);
    expect((await s.result).report.streaming).toEqual({ delivery: "whole", wholeReason: "deferrable" });
    expect(p.llamadasStream).toBe(0);
    expect(p.llamadasGenerate).toBe(1);
  });

  it("un proveedor sin generateStream se entrega entero", async () => {
    let llamadas = 0;
    const provider: Provider = {
      id: "sin-stream",
      async generate() {
        llamadas += 1;
        return { text: "Hello world", usage: USO, finishReason: "stop" };
      },
    };
    const layer = createSavingsLayer({ provider, devUnlicensed: true });
    const s = layer.generateStream(peticion());
    expect(forma(await recoger(s))).toEqual([["text", "Hello world"], ["done"]]);
    expect((await s.result).report.streaming).toEqual({
      delivery: "whole",
      wholeReason: "provider-without-streaming",
    });
    expect(llamadas).toBe(1);
  });

  it("caché exacta tras un stream: la segunda sale entera, como atajo, y se valora por referencia", async () => {
    const p = new Falso();
    const layer = createSavingsLayer({ provider: p, devUnlicensed: true });
    const primera = await layer.generateStream(peticion()).result;
    const s = layer.generateStream(peticion());
    const evs = await recoger(s);
    expect(forma(evs)).toEqual([["text", "Hello world"], ["done"]]);
    const r = await s.result;
    expect(r.report.cache.result).toBe("exact");
    expect(r.report.calls.avoidedLlm).toBe(1);
    // La contabilidad es la misma que la de generate(): la poblada corrió intacta
    // en stream y con su contador completo, así que la repetición se valora con él.
    expect(r.report.cost.basis).toBe("reference");
    expect(r.report.cache.reference?.requestId).toBe(primera.report.requestId);
    expect(r.report.streaming).toEqual({ delivery: "whole", wholeReason: "shortcut" });
    expect(p.llamadasStream).toBe(1);
  });

  it("un stream con el contador a medias no deja referencia: la repetición sigue estimated", async () => {
    // La entrada llegó y la salida no: el adaptador rellena el 0 y marca
    // `complete: false`. La poblada sale unmeasured; su repetición no se cobra
    // contra un contador rellenado.
    const p = new Falso({
      stream: () => guion(["Hello ", "world"], { usage: { inputTokens: 12, outputTokens: 0, complete: false } }),
    });
    const layer = createSavingsLayer({ provider: p, devUnlicensed: true });
    const primera = await layer.generateStream(peticion()).result;
    expect(primera.report.cost.basis).toBe("unmeasured");
    const r = await layer.generateStream(peticion()).result;
    expect(r.report.cache.result).toBe("exact");
    expect(r.report.cost.basis).toBe("estimated");
    expect(r.report.cache.reference).toBeUndefined();
    expect(p.llamadasStream).toBe(1);
  });

  it("un acierto semántico sin esquema emite UN text igual a result.text", async () => {
    const { InMemorySemanticCache } = await import("../src/cache/semantic.js");
    const embed = async (t: string): Promise<number[]> =>
      [0, 1, 2, 3].map((i) => [...t].filter((c) => c.charCodeAt(0) % 4 === i).length);
    const semanticCache = new InMemorySemanticCache({ embed, similarityThreshold: 0.3, acceptThreshold: 0.3 });
    const p = new Falso();
    const layer = createSavingsLayer({ provider: p, semanticCacheStore: semanticCache, devUnlicensed: true });
    const base = {
      savings: { semanticCache: true as const, exactCache: false },
      context: { tenantId: "acme", knowledgeEpoch: "e1" },
    };
    await layer.generateStream(peticion(base)).result;
    const s = layer.generateStream(
      peticion({ ...base, messages: [{ role: "user", content: "Write a short greeting for the whole world!" }] }),
    );
    const evs = await recoger(s);
    const r = await s.result;
    expect(r.report.cache.result).toBe("semantic");
    expect(forma(evs)).toEqual([["text", r.text], ["done"]]);
    expect(r.report.streaming).toEqual({ delivery: "whole", wholeReason: "shortcut" });
    expect(p.llamadasStream).toBe(1);
  });
});

describe("generateStream — singleflight", () => {
  it("se suma como seguidor a un generate() idéntico en vuelo", async () => {
    const p = new Falso({
      generate: async () => {
        await dormir(100);
        return { text: "Hello world", usage: USO, finishReason: "stop" };
      },
    });
    const layer = createSavingsLayer({ provider: p, devUnlicensed: true });
    const lider = layer.generate(peticion());
    await dormir(10);
    const s = layer.generateStream(peticion());
    const [, r] = await Promise.all([lider, s.result]);
    expect(p.llamadasGenerate).toBe(1);
    expect(p.llamadasStream).toBe(0);
    expect(r.report.cache.result).toBe("singleflight");
    expect(r.report.cost.basis).toBe("estimated");
    expect(r.report.tokens.actualInput).toBe(0);
    expect(r.report.streaming).toEqual({ delivery: "whole", wholeReason: "shortcut" });
    expect(forma(await recoger(s))).toEqual([["text", "Hello world"], ["done"]]);
  });

  it("dos streams idénticos y concurrentes llaman los dos: ninguno lidera", async () => {
    const p = new Falso({ stream: () => guion(["Hel", "lo"], {}, 30) });
    const layer = createSavingsLayer({ provider: p, devUnlicensed: true });
    const [a, b] = await Promise.all([
      layer.generateStream(peticion()).result,
      layer.generateStream(peticion()).result,
    ]);
    expect(p.llamadasStream).toBe(2);
    for (const r of [a, b]) {
      expect(
        r.report.traces.some(
          (t) => t.stage === "singleflight" && t.outcome === "skipped (streaming: a streamed request never leads)",
        ),
      ).toBe(true);
    }
  });

  it("un generate() concurrente con un stream idéntico no se le suma (no hereda su abort ni su bloque streaming)", async () => {
    const p = new Falso({ stream: () => guion(["Hel", "lo"], {}, 50) });
    const layer = createSavingsLayer({ provider: p, devUnlicensed: true });
    const s = layer.generateStream(peticion());
    await dormir(10);
    const g = await layer.generate(peticion());
    await s.result;
    expect(p.llamadasStream + p.llamadasGenerate).toBe(2);
    expect("streaming" in g.report).toBe(false);
  });
});

describe("generateStream — fallos", () => {
  const explota: ExactCache = {
    get() {
      throw new Error("boom: internal optimizer failure");
    },
    async set() {},
    async delete() {},
  };

  it("un fallo interno antes de llamar al proveedor cae al fail-open, entregado entero", async () => {
    const p = new Falso();
    const layer = createSavingsLayer({ provider: p, devUnlicensed: true, exactCache: explota });
    const s = layer.generateStream(peticion());
    expect(forma(await recoger(s))).toEqual([["text", "Hello world"], ["done"]]);
    const r = await s.result;
    expect(r.report.streaming).toEqual({ delivery: "whole", wholeReason: "fail-open" });
    expect(p.llamadasGenerate).toBe(1);
    expect(p.llamadasStream).toBe(0);
  });

  it("con failOpen:false, result rechaza con el error interno", async () => {
    const layer = createSavingsLayer({
      provider: new Falso(),
      devUnlicensed: true,
      exactCache: explota,
      failOpen: false,
    });
    const s = layer.generateStream(peticion());
    await expect(s.result).rejects.toThrow(/boom/);
    await expect(recoger(s)).rejects.toThrow(/boom/);
  });

  it("un fallo del proveedor a mitad llega al for-await tras los deltas, y no hay fail-open", async () => {
    const p = new Falso({
      stream: async function* () {
        yield { type: "text", delta: "Hel" };
        yield { type: "text", delta: "lo" };
        throw new Error("provider 503");
      },
    });
    const layer = createSavingsLayer({ provider: p, devUnlicensed: true });
    const s = layer.generateStream(peticion());
    const vistos: SavingsStreamEvent[] = [];
    await expect(
      (async () => {
        for await (const e of s) vistos.push(e);
      })(),
    ).rejects.toThrow("provider 503");
    expect(forma(vistos)).toEqual([["text", "Hel"], ["text", "lo"]]);
    await expect(s.result).rejects.toThrow("provider 503");
    expect(p.llamadasStream).toBe(1);
    expect(p.llamadasGenerate).toBe(0);
  });

  it("un proveedor cuyo stream acaba sin done es un fallo del proveedor", async () => {
    const p = new Falso({
      stream: async function* () {
        yield { type: "text", delta: "Hel" };
      },
    });
    const layer = createSavingsLayer({ provider: p, devUnlicensed: true });
    const s = layer.generateStream(peticion());
    await expect(s.result).rejects.toThrow(/stream ended without a final response/);
    expect(p.llamadasGenerate).toBe(0);
  });
});

describe("generateStream — contrato del stream", () => {
  it("las llamadas a herramienta llegan como tool_call completos antes de done, y no se cachean", async () => {
    const llamadas: ToolCallRequest[] = [{ id: "c1", name: "get_weather", arguments: '{"city":"Madrid"}' }];
    const p = new Falso({
      stream: () => guion([], { text: "", toolCalls: llamadas, finishReason: "tool_calls" }),
    });
    const layer = createSavingsLayer({ provider: p, devUnlicensed: true });
    const s = layer.generateStream(peticion());
    const evs = await recoger(s);
    expect(forma(evs)).toEqual([["tool_call", llamadas[0]], ["done"]]);
    const r = await s.result;
    expect(r.toolCalls).toEqual(llamadas);
    expect(r.finishReason).toBe("tool_calls");
    expect(r.report.streaming?.delivery).toBe("live");
    expect(typeof r.report.streaming?.firstEventMs).toBe("number");
    await layer.generateStream(peticion()).result;
    expect(p.llamadasStream).toBe(2);
  });

  it("sin contador final: unmeasured, sin ahorro, y el registro dice unmeasured", async () => {
    const p = new Falso({
      stream: () => guion(["Hel", "lo"], { usage: { inputTokens: 0, outputTokens: 0, complete: false } }),
    });
    const { layer, registros } = conMedicion(p);
    const r = await layer.generateStream(peticion()).result;
    expect(r.report.cost.basis).toBe("unmeasured");
    expect(r.report.cost.netSavingsRatio).toBe(0);
    expect(r.report.cost.baselineEstimate).toBe(0);
    await vi.waitFor(() => expect(registros).toHaveLength(1));
    expect(registros[0]!["basis"]).toBe("unmeasured");
    layer.close();
  });

  it("si el texto emitido difiere del final, manda lo emitido y se avisa", async () => {
    const p = new Falso({ stream: () => guion(["a", "b"], { text: "abc" }) });
    const layer = createSavingsLayer({ provider: p, devUnlicensed: true });
    const r = await layer.generateStream(peticion()).result;
    expect(r.text).toBe("ab");
    expect(avisos.filter((a) => a.includes("streamed text that differs"))).toHaveLength(1);
  });

  it("sin licencia: el primer next() y result rechazan con LicenseError, sin llamar al proveedor", async () => {
    const guardado = process.env.BVSALA_DEV_OPEN;
    delete process.env.BVSALA_DEV_OPEN;
    try {
      const p = new Falso();
      const layer = createSavingsLayer({ provider: p });
      const s = layer.generateStream(peticion());
      const it = s[Symbol.asyncIterator]();
      await expect(it.next()).rejects.toBeInstanceOf(LicenseError);
      await expect(s.result).rejects.toBeInstanceOf(LicenseError);
      expect(await it.next()).toEqual({ done: true, value: undefined });
      expect(p.llamadasStream + p.llamadasGenerate).toBe(0);

      // Tampoco por la entrega entera.
      const s2 = layer.generateStream(peticion({ response: { contractId: "respuesta", schema: ESQUEMA } }));
      await expect(s2.result).rejects.toBeInstanceOf(LicenseError);
      expect(p.llamadasStream + p.llamadasGenerate).toBe(0);
    } finally {
      if (guardado !== undefined) process.env.BVSALA_DEV_OPEN = guardado;
    }
  });

  it("un SavingsStream solo se puede iterar una vez", async () => {
    const layer = createSavingsLayer({ provider: new Falso(), devUnlicensed: true });
    const s = layer.generateStream(peticion());
    s[Symbol.asyncIterator]();
    expect(() => s[Symbol.asyncIterator]()).toThrow(/iterated only once/);
    await s.result;
  });

  it("result nunca se muta: el bloque streaming es de este informe y de ningún otro", async () => {
    const p = new Falso({
      generate: async () => {
        await dormir(50);
        return { text: '{"answer":8}', usage: USO, finishReason: "stop" };
      },
    });
    const layer = createSavingsLayer({ provider: p, devUnlicensed: true });
    const req = peticion({ response: { contractId: "respuesta", schema: ESQUEMA } });
    const s = layer.generateStream(req);
    // Una petición entera idéntica, a la vez: se coalesce con la del stream.
    const g = layer.generate(req);
    const [rs, rg] = await Promise.all([s.result, g]);
    expect(p.llamadasGenerate).toBe(1);
    expect([rs.report.cache.result, rg.report.cache.result].sort()).toEqual(["miss", "singleflight"]);
    expect(rs.report.streaming).toEqual({ delivery: "whole", wholeReason: "output-contract" });
    expect("streaming" in rg.report).toBe(false);
  });
});

describe("generateStream — la verja de la caché de prefijo", () => {
  it("una llamada sin contador no se apunta como medición de la verja", async () => {
    const POLITICA = "Eres el asistente de una tienda. ".repeat(40);
    const p = new Falso({
      stream: () => guion(["ok"], { usage: { inputTokens: 0, outputTokens: 0, complete: false } }),
    });
    const pipeline = new SavingsPipeline({
      provider: p,
      tokenizer: new TokenizerRegistry(),
      devUnlicensed: true,
    } as never);
    const r = await pipeline.generateStream(
      {
        model: "anthropic/claude-sonnet-4-5",
        messages: [
          { role: "system", content: POLITICA },
          { role: "user", content: "¿Cuánto tarda un envío a Canarias?" },
        ],
      },
      {},
    ).result;
    const trazas = r.report.traces.filter((t) => t.stage === "prefix-cache");
    expect(trazas.some((t) => t.outcome === "marked")).toBe(true);
    expect(
      trazas.some((t) => t.outcome === "not measured: the provider reported no usage for this call"),
    ).toBe(true);
    expect(trazas.some((t) => t.outcome === "measured")).toBe(false);
  });
});

describe("generateStream — el sondeo de toolDiscovery y el abort", () => {
  /** Un esquema gordo: con él el sondeo compensa y la verja económica lo deja salir. */
  const lecturaGorda = (id: string) => {
    const properties: Record<string, { type: "string"; description: string; maxLength: number }> = {};
    for (let i = 0; i < 12; i++) {
      properties[`${id}_field_${i}`] = {
        type: "string",
        description: `The ${id} field number ${i}, expressed as a fully qualified value`,
        maxLength: 120,
      };
    }
    return {
      id,
      intents: [`customer ${id} lookup`],
      risk: "read" as const,
      description: `Look up ${id} for a customer`,
      parameters: { type: "object" as const, properties, required: Object.keys(properties) },
    };
  };
  const conCatalogo = (): SavingsRequest =>
    peticion({
      messages: [{ role: "user", content: "Explain what the product catalogue lookup returns" }],
      tools: Array.from({ length: 8 }, (_, i) => lecturaGorda(`tool_${i}`)),
      savings: { toolDiscovery: true },
    } as Partial<SavingsRequest>);
  const PRECIOS = { "openai/gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 } };

  it("sin abort, el sondeo sale (por generate) antes de la primaria en stream", async () => {
    const p = new Falso({
      generate: () => ({
        text: "",
        usage: { inputTokens: 500, outputTokens: 10 },
        finishReason: "tool_calls",
        toolCalls: [{ id: "c0", name: "tool_1", arguments: "{}" }],
      }),
    });
    const layer = createSavingsLayer({ provider: p, devUnlicensed: true, costModels: PRECIOS });
    await layer.generateStream(conCatalogo()).result;
    expect(p.llamadasGenerate).toBe(1);
    expect(p.llamadasStream).toBe(1);
  });

  it("un abort que llega ANTES del sondeo no lo paga: ninguna llamada y requestSent false", async () => {
    let soltar!: () => void;
    const bloqueo = new Promise<void>((r) => (soltar = r));
    let avisarGet!: () => void;
    const enGet = new Promise<void>((r) => (avisarGet = r));
    const exactCache: ExactCache = {
      async get() {
        avisarGet();
        await bloqueo;
        return null;
      },
      async set() {},
      async delete() {},
    };
    const p = new Falso();
    const layer = createSavingsLayer({ provider: p, devUnlicensed: true, costModels: PRECIOS, exactCache });
    const s = layer.generateStream(conCatalogo());
    await enGet;
    s.abort();
    soltar();
    await expect(s.result).rejects.toBeInstanceOf(StreamAbortedError);
    await expect(s.result).rejects.toMatchObject({ requestSent: false });
    expect(p.llamadasGenerate + p.llamadasStream).toBe(0);
  });
});
