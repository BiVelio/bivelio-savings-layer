import { afterEach, describe, expect, it, vi } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import type { SavingsLayerConfig } from "../src/pipeline/config.js";
import { RequestTimeoutError } from "../src/pipeline/errors.js";
import { MAX_REQUEST_TIMEOUT_MS } from "../src/pipeline/request-deadline.js";
import { RequestTimeoutError as PublicRequestTimeoutError } from "../src/index.js";
import type { ExactCache } from "../src/cache/exact.js";
import type {
  Provider,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamOptions,
} from "../src/providers/types.js";
import type { SavingsRequest } from "../src/contracts/types.js";

const USO = { inputTokens: 12, outputTokens: 3 };
const CONTRATO = {
  contractId: "answer:v1",
  schema: {
    type: "object" as const,
    additionalProperties: false,
    required: ["answer"],
    properties: { answer: { type: "string" as const } },
  },
};
const PRECIOS = {
  "openai/gpt-4o": { inputPer1k: 0.0025, outputPer1k: 0.01, cachedInputPer1k: 0.00125 },
  "openai/gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006, cachedInputPer1k: 0.000075 },
};

const dormir = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const respuesta = (text = "ok"): ProviderResponse => ({ text, usage: USO, finishReason: "stop" });
const peticion = (extra: Partial<SavingsRequest> = {}): SavingsRequest => ({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "una pregunta cualquiera" }],
  ...extra,
});

type Comportamiento = (
  llamada: number,
  signal: AbortSignal | undefined,
  req: ProviderRequest,
) => Promise<ProviderResponse> | ProviderResponse;

class Controlado implements Provider {
  readonly id = "controlado";
  llamadas = 0;
  readonly senales: (AbortSignal | undefined)[] = [];
  readonly modelos: string[] = [];
  constructor(private readonly comportamiento: Comportamiento = () => respuesta()) {}

  async generate(req: ProviderRequest, options?: ProviderStreamOptions): Promise<ProviderResponse> {
    this.llamadas += 1;
    this.senales.push(options?.signal);
    this.modelos.push(req.model);
    return await this.comportamiento(this.llamadas, options?.signal, req);
  }
}

const capa = (
  provider: Provider,
  extra: Partial<SavingsLayerConfig> & { devUnlicensed?: boolean } = {},
) =>
  createSavingsLayer({
    provider,
    devUnlicensed: true,
    exactTokenizer: false,
    silenceWarnings: true,
    costModels: PRECIOS,
    ...extra,
  });

async function timeoutDe(promesa: Promise<unknown>): Promise<RequestTimeoutError> {
  const error = await promesa.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RequestTimeoutError);
  return error as RequestTimeoutError;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("requestTimeoutMs: contrato y entrada pública", () => {
  it("rechaza valores no enteros, no positivos, infinitos y por encima del máximo defensivo", async () => {
    const provider = new Controlado();
    const layer = capa(provider);
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_REQUEST_TIMEOUT_MS + 1]) {
      await expect(layer.generate(peticion(), { requestTimeoutMs: value })).rejects.toBeInstanceOf(RangeError);
    }
    expect(provider.llamadas).toBe(0);
    expect(new PublicRequestTimeoutError(false, 10)).toBeInstanceOf(RequestTimeoutError);
  });

  it("vence durante preprocess antes del primer envío y no abre fail-open", async () => {
    const provider = new Controlado();
    const exactCache: ExactCache = {
      async get() {
        await dormir(30);
        return null;
      },
      async set() {
        throw new Error("no debe escribir");
      },
      async delete() {},
    };
    const layer = capa(provider, { exactCache });
    const error = await timeoutDe(layer.generate(peticion(), { requestTimeoutMs: 5 }));
    expect(error).toMatchObject({
      name: "RequestTimeoutError",
      code: "REQUEST_TIMEOUT",
      requestSent: false,
      timeoutMs: 5,
    });
    expect(provider.llamadas).toBe(0);
  });

  it("tras una ronda de retrieval vencida no inicia la siguiente ni la primaria", async () => {
    let ahora = 0;
    let lecturas = 0;
    const provider = new Controlado();
    const layer = capa(provider, {
      now: () => ahora,
      retriever: {
        async retrieve() {
          lecturas += 1;
          ahora = 50;
          return [];
        },
      },
    });
    const error = await timeoutDe(
      layer.generate(peticion({ retrieval: { mode: "multi", maxRounds: 2 } }), { requestTimeoutMs: 10 }),
    );
    expect(error.requestSent).toBe(false);
    expect(lecturas).toBe(1);
    expect(provider.llamadas).toBe(0);
  });

  it("una señal externa ya abortada tampoco se convierte en una llamada de fail-open", async () => {
    const provider = new Controlado();
    const controller = new AbortController();
    controller.abort();
    const layer = capa(provider);
    await expect(layer.generate(peticion(), { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(provider.llamadas).toBe(0);
  });
});

describe("deadline durante la primaria y efectos tardíos", () => {
  it("un provider que respeta abort se detiene; el error es estable y requestSent es true", async () => {
    let detenido = 0;
    const provider = new Controlado((_n, signal) =>
      new Promise<ProviderResponse>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          detenido += 1;
          reject(signal.reason ?? new DOMException("aborted", "AbortError"));
        }, { once: true });
      }),
    );
    let escrituras = 0;
    const exactCache: ExactCache = {
      async get() { return null; },
      async set() { escrituras += 1; },
      async delete() {},
    };
    const layer = capa(provider, { exactCache });
    const error = await timeoutDe(layer.generate(peticion(), { requestTimeoutMs: 10 }));
    expect(error).toMatchObject({ requestSent: true, timeoutMs: 10, code: "REQUEST_TIMEOUT" });
    expect(detenido).toBe(1);
    expect(provider.llamadas).toBe(1);
    await dormir(25);
    expect(escrituras).toBe(0);
  });

  it("un provider que ignora abort es esperado y su respuesta tardía no se cachea ni se aprende", async () => {
    let terminado = 0;
    const provider = new Controlado(async () => {
      await dormir(200);
      terminado += 1;
      return respuesta("not json");
    });
    let cache = 0;
    let aprendizaje = 0;
    const exactCache: ExactCache = {
      async get() { return null; },
      async set() { cache += 1; },
      async delete() {},
    };
    const layer = capa(provider, {
      exactCache,
      constraintMemoryStore: {
        async has() { return false; },
        async remember() { aprendizaje += 1; },
      },
    });
    // Márgenes amplios: el deadline (40 ms) vence MUCHO después de que la
    // petición esté marcada como enviada (sobrecarga del CI aparte) y el
    // proveedor termina mucho después (200 ms). Antes eran 5/30 ms y la
    // aserción `requestSent` caía en falso cuando el runner iba cargado.
    const error = await timeoutDe(
      layer.generate(peticion({ response: CONTRATO }), { requestTimeoutMs: 40 }),
    );
    expect(error.requestSent).toBe(true);
    expect(terminado).toBe(1);
    expect(provider.llamadas).toBe(1);
    await dormir(260);
    expect(cache).toBe(0);
    expect(aprendizaje).toBe(0);
  });

  it("limpia el timer y el listener externo al terminar sin vencer", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const provider = new Controlado();
    const layer = capa(provider);
    const result = await layer.generate(peticion(), {
      signal: controller.signal,
      requestTimeoutMs: MAX_REQUEST_TIMEOUT_MS,
    });
    expect(result.report.cost.basis).toBe("measured");
    expect(result.report.calls.actualLlm).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("sin opciones conserva la llamada de siempre; con tiempo suficiente conserva la contabilidad y la caché", async () => {
    const provider = new Controlado();
    const layer = capa(provider);
    await layer.generate(peticion());
    expect(provider.senales).toEqual([undefined]);
    const repetida = await layer.generate(peticion(), { requestTimeoutMs: 1_000 });
    expect(repetida.report.cache.result).toBe("exact");
    expect(repetida.report.calls.actualLlm).toBe(0);
    expect(provider.llamadas).toBe(1);
  });
});

describe("ninguna rama adicional escapa al deadline", () => {
  it("la cascada no escala después de una primaria que ya venció", async () => {
    let ahora = 0;
    const provider = new Controlado(() => {
      ahora = 100;
      return respuesta("not json");
    });
    const layer = capa(provider, { now: () => ahora });
    const error = await timeoutDe(
      layer.generate(peticion({
        model: "openai/gpt-4o",
        response: CONTRATO,
        savings: { modelCascade: "on" },
      }), { requestTimeoutMs: 10 }),
    );
    expect(error.requestSent).toBe(true);
    expect(provider.modelos).toEqual(["openai/gpt-4o-mini"]);
  });

  it("la reparación no repite una primaria inválida que ya venció", async () => {
    let ahora = 0;
    const provider = new Controlado(() => {
      ahora = 100;
      return respuesta("not json");
    });
    const layer = capa(provider, { now: () => ahora });
    await timeoutDe(layer.generate(peticion({ response: CONTRATO }), { requestTimeoutMs: 10 }));
    expect(provider.llamadas).toBe(1);
  });

  it("el respaldo de capacidad no repite después del deadline", async () => {
    let ahora = 0;
    const provider = new Controlado(() => {
      ahora = 100;
      throw new Error("provider 429: Resource Unavailable");
    });
    const layer = capa(provider, {
      now: () => ahora,
      priceLevers: { onCapacityError: "standard" },
    });
    await timeoutDe(
      layer.generate(peticion({ savings: { deferrable: true } }), { requestTimeoutMs: 10 }),
    );
    expect(provider.llamadas).toBe(1);
  });

  it("un fallo interno sí permite fail-open antes del deadline y recibe su señal", async () => {
    const provider = new Controlado();
    const exactCache: ExactCache = {
      async get() { throw new Error("cache rota"); },
      async set() {},
      async delete() {},
    };
    const layer = capa(provider, { exactCache });
    const result = await layer.generate(peticion(), { requestTimeoutMs: 1_000 });
    expect(result.text).toBe("ok");
    expect(result.report.traces.some((t) => t.stage === "fail-open")).toBe(true);
    expect(provider.llamadas).toBe(1);
    expect(provider.senales[0]?.aborted).toBe(false);
  });

  it("la copia A/B diferida no sale si el deadline vence después de servir la primaria", async () => {
    let ahora = 0;
    const provider = new Controlado();
    const layer = capa(provider, {
      now: () => ahora,
      verification: { sampleRate: 1, onCheck: () => {} },
    });
    const result = await layer.generate(peticion(), { requestTimeoutMs: 10 });
    expect(result.text).toBe("ok");
    ahora = 100;
    await dormir(10);
    expect(provider.llamadas).toBe(1);
  });

  it("singleflight: el seguidor vence sin requestSent propio y sin cancelar/repetir al líder", async () => {
    const provider = new Controlado(async () => {
      await dormir(30);
      return respuesta();
    });
    const layer = capa(provider);
    const leader = layer.generate(peticion());
    const follower = layer.generate(peticion(), { requestTimeoutMs: 5 });
    const [a, b] = await Promise.allSettled([leader, follower]);
    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("rejected");
    expect(b.status === "rejected" && b.reason).toBeInstanceOf(RequestTimeoutError);
    expect(b.status === "rejected" && (b.reason as RequestTimeoutError).requestSent).toBe(false);
    expect(provider.llamadas).toBe(1);
  });
});

describe("deadline y señal en generateStream", () => {
  it("live: aborta la primaria, no entrega un informe parcial ni escribe caché", async () => {
    let llamadas = 0;
    let cache = 0;
    const provider: Provider = {
      id: "live-abort",
      async generate() { throw new Error("no debe entregar whole"); },
      async *generateStream(_req, options) {
        llamadas += 1;
        yield { type: "text", delta: "Hel" };
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
        });
      },
    };
    const exactCache: ExactCache = {
      async get() { return null; },
      async set() { cache += 1; },
      async delete() {},
    };
    const stream = capa(provider, { exactCache }).generateStream(peticion(), { requestTimeoutMs: 10 });
    const error = await timeoutDe(stream.result);
    expect(error.requestSent).toBe(true);
    expect(llamadas).toBe(1);
    expect(cache).toBe(0);
  });

  it("live: espera al iterador que ignora abort y descarta sus deltas tardíos", async () => {
    let terminado = 0;
    const provider: Provider = {
      id: "live-ignore",
      async generate() { throw new Error("no debe entregar whole"); },
      async *generateStream() {
        yield { type: "text", delta: "antes" };
        await dormir(30);
        yield { type: "text", delta: "después" };
        terminado += 1;
        yield { type: "done", response: respuesta("antesdespués") };
      },
    };
    const stream = capa(provider).generateStream(peticion(), { requestTimeoutMs: 5 });
    const error = await timeoutDe(stream.result);
    expect(error.requestSent).toBe(true);
    expect(terminado).toBe(1);
  });

  it.each(["output-contract", "deferrable", "provider-without-streaming"] as const)(
    "whole (%s): la señal llega a generate y no hay una segunda llamada",
    async (motivo) => {
      let llamadas = 0;
      let streams = 0;
      const generate = async (_req: ProviderRequest, options?: ProviderStreamOptions) => {
        llamadas += 1;
        return await new Promise<ProviderResponse>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
        });
      };
      const provider: Provider = motivo === "provider-without-streaming"
        ? { id: "whole", generate }
        : {
            id: "whole",
            generate,
            async *generateStream() {
              streams += 1;
              yield { type: "done", response: respuesta() };
            },
          };
      const request = motivo === "output-contract"
        ? peticion({ response: CONTRATO })
        : motivo === "deferrable"
          ? peticion({ savings: { deferrable: true } })
          : peticion();
      const stream = capa(provider).generateStream(request, { requestTimeoutMs: 10 });
      const error = await timeoutDe(stream.result);
      expect(error.requestSent).toBe(true);
      expect(llamadas).toBe(1);
      expect(streams).toBe(0);
    },
  );

  it("whole que termina antes del deadline conserva su resultado y limpia el timer", async () => {
    vi.useFakeTimers();
    const provider = new Controlado();
    const stream = capa(provider).generateStream(peticion({ response: CONTRATO }), { requestTimeoutMs: 100 });
    const result = await stream.result;
    expect(result.report.streaming).toEqual({ delivery: "whole", wholeReason: "output-contract" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
