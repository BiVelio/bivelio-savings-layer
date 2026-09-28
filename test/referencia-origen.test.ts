import { describe, expect, it } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import { InMemoryExactCache } from "../src/cache/exact.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { atestiguarOrigen, origenAtestiguado } from "../src/providers/atestado-del-cable.js";
import { apiOficialDe, CLAVE_DEL_ORIGEN, origenDeLaUrl } from "../src/providers/origen-oficial.js";
import { registroDeReferencia, type HechosDeLaPoblada } from "../src/pipeline/referencia.js";
import type { SavingsLayerConfig } from "../src/pipeline/config.js";
import type { Provider } from "../src/providers/types.js";
import type { SavingsRequest, SavingsResult } from "../src/contracts/types.js";

/**
 * E0-BIS · EL ORIGEN DE LA FACTURA (2026-09-28, decisión del dueño: alinear el
 * SDK con el gateway).
 *
 * Una repetición se valora al precio cacheado de LISTA, y ese precio solo es la
 * factura en el origen oficial del proveedor. El adaptador propio atestigua a
 * quién habla por su `baseUrl`; si NO es el origen oficial, la llamada que corre
 * no deja registro de referencia (`unofficial-origin`) y su repetición sigue
 * `estimated`. Con el origen oficial, o con un origen DESCONOCIDO (un proveedor
 * propio del cliente), todo sigue exactamente igual: misma base, mismo registro.
 *
 * Sin red: cada adaptador habla con un `fetch` falso.
 */

const DIA = 24 * 60 * 60 * 1000;
const MINI = "openai/gpt-4o-mini";

const HECHOS_INTACTOS: HechosDeLaPoblada = {
  contadorSimulado: false,
  usoPrimario: { inputTokens: 1736, outputTokens: 282, reasoningTokens: 0 },
  eliminatedInput: 0,
  compressedInput: 0,
  elididoLocal: 0,
  sentLocalSinSondeo: 40,
  baselineInput: 40,
  codebookAplicado: false,
  tokensDelSondeo: 0,
  sondeoAplicado: false,
  hayEsquema: false,
  esquemaNativo: false,
  esquemaEnFormatoNativo: false,
  esquemaEstricto: false,
  esquemaPorPrompt: false,
  piezasDelAdaptador: 0,
  modeloPedido: MINI,
  modeloServido: MINI,
  cacheable: true,
  mensajesDeLaCapa: 0,
  requestId: "req-poblada",
  at: 1_000,
  textoServido: "Paris.",
  huella: () => "huella",
};

describe("la regla pura: E0-bis, justo después de E0", () => {
  it("un origen atestiguado como no oficial no deja registro: unofficial-origin", () => {
    expect(registroDeReferencia({ ...HECHOS_INTACTOS, origen: "no-oficial" })).toBe("unofficial-origin");
  });

  it("E0 va antes: el contador del mock sigue siendo simulated-provider", () => {
    expect(registroDeReferencia({ ...HECHOS_INTACTOS, contadorSimulado: true, origen: "no-oficial" })).toBe(
      "simulated-provider",
    );
  });

  it("y E0-bis va antes que E1 y que todo lo demás: el motivo es el primero que falla", () => {
    expect(registroDeReferencia({ ...HECHOS_INTACTOS, origen: "no-oficial", usoPrimario: undefined })).toBe(
      "unofficial-origin",
    );
    expect(registroDeReferencia({ ...HECHOS_INTACTOS, usoPrimario: undefined })).toBe("no-usage");
    expect(
      registroDeReferencia({ ...HECHOS_INTACTOS, origen: "no-oficial", eliminatedInput: 12, cacheable: false }),
    ).toBe("unofficial-origin");
    expect(registroDeReferencia({ ...HECHOS_INTACTOS, origen: "no-oficial", modeloServido: "otro" })).toBe(
      "unofficial-origin",
    );
  });

  it("oficial y desconocido dejan EL MISMO registro que sin el campo", () => {
    const sin = registroDeReferencia(HECHOS_INTACTOS);
    expect(typeof sin).toBe("object");
    expect(registroDeReferencia({ ...HECHOS_INTACTOS, origen: "oficial" })).toEqual(sin);
    expect(registroDeReferencia({ ...HECHOS_INTACTOS, origen: undefined })).toEqual(sin);
    // Y los demás motivos no cambian por decir «oficial».
    expect(registroDeReferencia({ ...HECHOS_INTACTOS, origen: "oficial", usoPrimario: undefined })).toBe("no-usage");
    expect(registroDeReferencia({ ...HECHOS_INTACTOS, origen: "oficial", cacheable: false })).toBe("not-cacheable");
  });
});

describe("qué origen es oficial: exactamente los que tarifa el catálogo", () => {
  it.each([
    ["https://api.openai.com/v1", "openai"],
    ["https://api.anthropic.com/v1", "anthropic"],
    ["https://api.anthropic.com", "anthropic"],
    ["https://generativelanguage.googleapis.com/v1beta/openai/", "google"],
    // `URL` normaliza mayúsculas y el puerto por defecto.
    ["HTTPS://API.OPENAI.COM/v1", "openai"],
    ["https://api.openai.com:443/v1", "openai"],
  ] as const)("%s → %s", (url, api) => {
    expect(apiOficialDe(url)).toBe(api);
    expect(origenDeLaUrl(url)).toBe("oficial");
  });

  it.each([
    // Un proxy o un gateway, aunque sirva nombres del catálogo.
    "http://127.0.0.1:4000/v1",
    "http://localhost:4000/v1",
    "https://litellm.example.com/v1",
    "https://openrouter.ai/api/v1",
    "https://ai-gateway.vercel.sh/v1",
    // Otra factura: Azure, Bedrock, Vertex.
    "https://mi-recurso.openai.azure.com/openai/v1",
    "https://bedrock-runtime.us-east-1.amazonaws.com",
    "https://us-east5-aiplatform.googleapis.com/v1",
    // Un proveedor que el catálogo no tarifa, aunque sea su propio host.
    "https://api.deepseek.com/v1",
    // El host oficial, pero no el API oficial: http, otro puerto, un subdominio, otro host que lo contiene.
    "http://api.openai.com/v1",
    "https://api.openai.com:8443/v1",
    "https://eu.api.openai.com/v1",
    "https://api.openai.com.proxy.example/v1",
    // Ni siquiera una URL.
    "api.openai.com",
    "",
  ])("%s → no oficial", (url) => {
    expect(apiOficialDe(url)).toBeNull();
    expect(origenDeLaUrl(url)).toBe("no-oficial");
  });
});

describe("el atestado de los adaptadores propios", () => {
  const fetchNunca = (async () => {
    throw new Error("[test] sin red");
  }) as unknown as typeof fetch;

  it("OpenAICompatibleProvider lo decide por su baseUrl, Google y el endpoint compatible de Anthropic incluidos", () => {
    const de = (baseUrl: string) => origenAtestiguado(new OpenAICompatibleProvider({ baseUrl, fetchImpl: fetchNunca }));
    expect(de("https://api.openai.com/v1")).toBe("oficial");
    expect(de("https://generativelanguage.googleapis.com/v1beta/openai/")).toBe("oficial");
    expect(de("https://api.anthropic.com/v1/")).toBe("oficial");
    expect(de("http://127.0.0.1:4000/v1")).toBe("no-oficial");
    expect(de("https://openrouter.ai/api/v1")).toBe("no-oficial");
    expect(de("https://mi-recurso.openai.azure.com/openai/v1")).toBe("no-oficial");
  });

  it("AnthropicProvider: sin baseUrl, el API oficial; contra un proxy, no", () => {
    expect(origenAtestiguado(new AnthropicProvider({ fetchImpl: fetchNunca }))).toBe("oficial");
    expect(origenAtestiguado(new AnthropicProvider({ baseUrl: "https://api.anthropic.com/v1", fetchImpl: fetchNunca }))).toBe(
      "oficial",
    );
    expect(origenAtestiguado(new AnthropicProvider({ baseUrl: "http://127.0.0.1:4000/v1", fetchImpl: fetchNunca }))).toBe(
      "no-oficial",
    );
    // `esHostOficial` (la forma del cable) admite http y subdominios; la factura, no.
    expect(origenAtestiguado(new AnthropicProvider({ baseUrl: "http://api.anthropic.com/v1", fetchImpl: fetchNunca }))).toBe(
      "no-oficial",
    );
  });

  it("un proveedor de terceros no atestigua nada: desconocido", () => {
    const propio: Provider = { id: "propio", generate: async () => ({ text: "", usage: { inputTokens: 1, outputTokens: 1 } }) };
    expect(origenAtestiguado(propio)).toBeUndefined();
    expect(origenAtestiguado(undefined)).toBeUndefined();
    expect(origenAtestiguado("no-es-un-proveedor")).toBeUndefined();
  });

  it("el canal de los adaptadores de marcos: solo vale una respuesta exacta, y el WeakMap manda", () => {
    const conCanal = (f: () => unknown): object => ({ id: "puente", [CLAVE_DEL_ORIGEN]: f });
    expect(origenAtestiguado(conCanal(() => "no-oficial"))).toBe("no-oficial");
    expect(origenAtestiguado(conCanal(() => "oficial"))).toBe("oficial");
    expect(origenAtestiguado(conCanal(() => undefined))).toBeUndefined();
    expect(origenAtestiguado(conCanal(() => "unofficial"))).toBeUndefined();
    expect(origenAtestiguado(conCanal(() => true))).toBeUndefined();
    expect(
      origenAtestiguado(
        conCanal(() => {
          throw new Error("roto");
        }),
      ),
    ).toBeUndefined();
    expect(origenAtestiguado({ id: "x", [CLAVE_DEL_ORIGEN]: "no-oficial" })).toBeUndefined();
    // La clave es la del registro GLOBAL: la misma que ve otro bundle.
    expect(CLAVE_DEL_ORIGEN).toBe(Symbol.for("@bivelio/savings-layer:provider-origin"));
    const declarado = conCanal(() => "no-oficial");
    atestiguarOrigen(declarado, "oficial");
    expect(origenAtestiguado(declarado)).toBe("oficial");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// De punta a punta, con los adaptadores de verdad
// ─────────────────────────────────────────────────────────────────────────────

/** Un `fetch` que contesta siempre lo mismo y cuenta las llamadas (y sus URL). */
function servidor(cuerpo: unknown, sse?: string) {
  const urls: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    urls.push(String(url));
    const pedido = JSON.parse(String(init.body)) as { stream?: boolean };
    if (pedido.stream && sse !== undefined) {
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response(JSON.stringify(cuerpo), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { urls, fetchImpl };
}

const CHAT = {
  id: "chatcmpl-1",
  object: "chat.completion",
  model: "gpt-4o-mini",
  choices: [{ index: 0, message: { role: "assistant", content: "Paris." }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1736, completion_tokens: 282, completion_tokens_details: { reasoning_tokens: 0 } },
};

const CHAT_SSE =
  `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Paris." }, finish_reason: null }] })}\n\n` +
  `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
  `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 1736, completion_tokens: 282, completion_tokens_details: { reasoning_tokens: 0 } } })}\n\n` +
  "data: [DONE]\n\n";

const MENSAJE = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-haiku-4-5",
  content: [{ type: "text", text: "Paris." }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1736, output_tokens: 20 },
};

function montar(provider: Provider, extra: Partial<SavingsLayerConfig> = {}) {
  let n = 0;
  const reloj = { t: 1_780_000_000_000 };
  return createSavingsLayer({
    provider,
    devUnlicensed: true,
    exactTokenizer: false,
    silenceWarnings: true,
    generateId: () => `req-${n++}`,
    now: () => reloj.t,
    exactCache: new InMemoryExactCache({ now: () => reloj.t }),
    exactCacheTtlMs: 60 * DIA,
    ...extra,
  });
}

const peticion = (model = MINI): SavingsRequest => ({
  model,
  messages: [{ role: "user", content: "What is the capital of France?" }],
  temperature: 0,
});

const trazaDeReferencia = (r: SavingsResult) => r.report.traces.find((t) => t.stage === "reference");

/** Dos veces la misma petición: la poblada y la repetición. */
async function dosVeces(provider: Provider, model = MINI) {
  const layer = montar(provider);
  try {
    const primera = await layer.generate(peticion(model));
    const repeticion = await layer.generate(peticion(model));
    return { primera, repeticion };
  } finally {
    layer.close();
  }
}

/** Un proveedor PROPIO del cliente que llama por dentro a un adaptador: no atestigua origen. */
const propio = (adaptador: Provider): Provider => ({
  id: "propio-del-cliente",
  generate: (req, o) => adaptador.generate(req, o),
});

describe("de punta a punta · Chat Completions", () => {
  it("contra el API oficial: registro escrito y la repetición sale reference (como siempre)", async () => {
    const s = servidor(CHAT);
    const { primera, repeticion } = await dosVeces(
      new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", fetchImpl: s.fetchImpl }),
    );
    expect(s.urls).toEqual(["https://api.openai.com/v1/chat/completions"]);
    expect(trazaDeReferencia(primera)?.outcome).toBe("written");
    expect(repeticion.report.cache.result).toBe("exact");
    expect(repeticion.report.cost.basis).toBe("reference");
    expect(repeticion.report.cache.reference?.requestId).toBe(primera.report.requestId);
  });

  it("contra un proxy: la poblada no deja registro (unofficial-origin) y la repetición sale estimated", async () => {
    const s = servidor(CHAT);
    const { primera, repeticion } = await dosVeces(
      new OpenAICompatibleProvider({ baseUrl: "http://127.0.0.1:4000/v1", fetchImpl: s.fetchImpl }),
    );
    expect(s.urls).toHaveLength(1);
    // La poblada se mide igual: el contador es de verdad, lo que no vale es su precio de lista.
    expect(primera.report.cost.basis).toBe("measured");
    expect(trazaDeReferencia(primera)?.outcome).toBe("not-written");
    expect(trazaDeReferencia(primera)?.detail).toEqual({ reason: "unofficial-origin" });
    // La repetición se sirve igual, sin llamar, y queda estimated: como siempre que no hay registro.
    expect(repeticion.report.cache.result).toBe("exact");
    expect(repeticion.report.calls.avoidedLlm).toBe(1);
    expect(repeticion.report.cost.actual).toBe(0);
    expect(repeticion.report.cost.basis).toBe("estimated");
    expect(repeticion.report.cache.referenceRejected).toBe("absent");
    expect(repeticion.report.cache.reference).toBeUndefined();
  });

  it("…también en stream: el origen se lee tras la primaria en vivo", async () => {
    const s = servidor(CHAT, CHAT_SSE);
    const layer = montar(new OpenAICompatibleProvider({ baseUrl: "http://127.0.0.1:4000/v1", fetchImpl: s.fetchImpl }));
    try {
      const h = layer.generateStream(peticion());
      for await (const _ of h) {
        // se consume
      }
      const primera = await h.result;
      expect(primera.report.cost.basis).toBe("measured");
      expect(trazaDeReferencia(primera)?.detail).toEqual({ reason: "unofficial-origin" });
      const repeticion = await layer.generate(peticion());
      expect(repeticion.report.cache.result).toBe("exact");
      expect(repeticion.report.cost.basis).toBe("estimated");
    } finally {
      layer.close();
    }
  });

  it("desconocido (un proveedor propio del cliente contra el mismo proxy): todo igual que con el origen oficial", async () => {
    const oficial = await dosVeces(
      new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", fetchImpl: servidor(CHAT).fetchImpl }),
    );
    const desconocido = await dosVeces(
      propio(new OpenAICompatibleProvider({ baseUrl: "http://127.0.0.1:4000/v1", fetchImpl: servidor(CHAT).fetchImpl })),
    );
    expect(desconocido.repeticion.report.cost.basis).toBe("reference");
    // Mismo registro (traza de la poblada), misma base y mismo crédito.
    expect(trazaDeReferencia(desconocido.primera)?.detail).toEqual(trazaDeReferencia(oficial.primera)?.detail);
    expect(desconocido.repeticion.report.cache.reference).toEqual(oficial.repeticion.report.cache.reference);
    expect(desconocido.repeticion.report.cost.baselineEstimate).toBe(oficial.repeticion.report.cost.baselineEstimate);
  });

  it("Gemini por su endpoint compatible OFICIAL: la repetición sale reference", async () => {
    const s = servidor({ ...CHAT, model: "gemini-2.5-flash" });
    const { primera, repeticion } = await dosVeces(
      new OpenAICompatibleProvider({
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
        fetchImpl: s.fetchImpl,
      }),
      "google/gemini-2.5-flash",
    );
    expect(trazaDeReferencia(primera)?.outcome).toBe("written");
    expect(repeticion.report.cost.basis).toBe("reference");
  });
});

describe("de punta a punta · Mensajes de Anthropic", () => {
  it("contra api.anthropic.com: reference; contra un proxy: unofficial-origin y estimated", async () => {
    const oficial = await dosVeces(new AnthropicProvider({ fetchImpl: servidor(MENSAJE).fetchImpl }), "anthropic/claude-haiku-4-5");
    expect(trazaDeReferencia(oficial.primera)?.outcome).toBe("written");
    expect(oficial.repeticion.report.cost.basis).toBe("reference");

    const s = servidor(MENSAJE);
    const proxy = await dosVeces(
      new AnthropicProvider({ baseUrl: "http://127.0.0.1:4000/v1", stripProviderPrefix: true, fetchImpl: s.fetchImpl }),
      "anthropic/claude-haiku-4-5",
    );
    expect(s.urls).toEqual(["http://127.0.0.1:4000/v1/messages"]);
    expect(trazaDeReferencia(proxy.primera)?.detail).toEqual({ reason: "unofficial-origin" });
    expect(proxy.repeticion.report.cache.result).toBe("exact");
    expect(proxy.repeticion.report.cost.basis).toBe("estimated");
    expect(proxy.repeticion.report.cache.referenceRejected).toBe("absent");
  });
});
