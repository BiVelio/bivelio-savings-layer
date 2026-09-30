import { describe, it, expect } from "vitest";

import {
  conReintentos,
  fetchConPlazo,
  proveedorDelBanco,
  transporteDeModelo,
  type ConfigDeTransporte,
} from "../benchmarks/transporte.js";
import type { Provider } from "../src/providers/types.js";
import {
  estadoDePalanca,
  noMedibleEnTransporte,
  scenarios,
  type Scenario,
} from "../benchmarks/scenarios.js";
import type { SavingsResult } from "../src/index.js";

/**
 * EL BANCO NUNCA LLEGÓ A USAR EL ADAPTADOR DE ANTHROPIC, Y PUBLICÓ SU CERO.
 *
 * Tirada real del 2026-08-16: `Anthropic stable-prefix agent turn` reportó 0
 * tokens cacheados en LOS DOS BRAZOS sobre un prefijo estable de 7.287 tokens.
 * No es que la palanca no ahorre — es que no se ejecutó: `makeProvider()`
 * instanciaba SIEMPRE `OpenAICompatibleProvider` y el endpoint configurado era
 * una pasarela que habla el protocolo de OpenAI, donde `cache_control` no cabe.
 * Anthropic NO cachea sola, así que sin ese campo el descuento del 90% en la
 * lectura no existe.
 *
 * Este fichero es la verja de las dos mitades del arreglo:
 *
 *   1. con endpoint nativo declarado, el modelo de esa familia sale por
 *      `AnthropicProvider` y `cache_control` VIAJA de verdad (se comprueba sobre
 *      el cuerpo que se pondría en el cable, con un `fetch` de mentira: probar
 *      esto en vivo cuesta dinero y no puede ser la única forma de saberlo);
 *   2. sin él, la palanca se declara NO MEDIBLE con el motivo y con qué hay que
 *      configurar — nunca como un cero, que es lo que se lee como un fracaso.
 */

const CFG_PASARELA: ConfigDeTransporte = {
  baseUrl: "https://pasarela.invalido/v1",
  apiKey: "no-es-una-clave",
  keepPrefix: true,
};
const CFG_CON_NATIVO: ConfigDeTransporte = {
  ...CFG_PASARELA,
  anthropicBaseUrl: "https://anthropic.invalido/v1",
  anthropicApiKey: "no-es-una-clave",
};

const escenarioAnthropic = (): Scenario => {
  const s = scenarios.find((x) => x.name === "Anthropic stable-prefix agent turn");
  expect(s, "falta el escenario que mide cache_control").toBeDefined();
  return s!;
};

/** Un `fetch` que no sale a la red: guarda lo que se le pide y contesta el mínimo. */
function fetchEspia(cuerpoDeRespuesta: unknown): {
  fetchImpl: typeof fetch;
  llamadas: { url: string; body: Record<string, unknown> }[];
} {
  const llamadas: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    llamadas.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(cuerpoDeRespuesta), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, llamadas };
}

const RESPUESTA_ANTHROPIC = {
  content: [{ type: "text", text: "vale" }],
  stop_reason: "end_turn",
  usage: {
    input_tokens: 40,
    output_tokens: 7,
    cache_read_input_tokens: 7_000,
    cache_creation_input_tokens: 0,
  },
};
const RESPUESTA_OPENAI = {
  model: "claude-sonnet-4-5",
  choices: [{ message: { content: "vale" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 7_040, completion_tokens: 7 },
};

describe("el transporte del banco se elige por el modelo", () => {
  it("sin NINGÚN endpoint la tirada es MOCK; con uno solo por familia, esa familia ya es LIVE", () => {
    expect(transporteDeModelo("anthropic/claude-sonnet-4-5", {})).toBe("mock");
    // Desde el 2026-09-27 el endpoint nativo basta: un tercero con su clave de
    // Anthropic y sin pasarela puede medir Claude.
    expect(
      transporteDeModelo("anthropic/claude-sonnet-4-5", { anthropicBaseUrl: "https://x.invalido" }),
    ).toBe("anthropic-nativo");
    // …y un modelo de otra familia sin endpoint para ella no cae en MOCK a
    // escondidas: es un error que el prevuelo y `repartirEscenarios` descartan antes.
    expect(() => transporteDeModelo("openai/gpt-4o-mini", { anthropicBaseUrl: "https://x.invalido" })).toThrow(
      /no endpoint declared/,
    );
  });

  it("un modelo de Anthropic con endpoint nativo declarado va por el adaptador nativo", () => {
    expect(transporteDeModelo("anthropic/claude-sonnet-4-5", CFG_CON_NATIVO)).toBe("anthropic-nativo");
    expect(transporteDeModelo("claude-sonnet-4-5", CFG_CON_NATIVO)).toBe("anthropic-nativo");
  });

  it("sin endpoint nativo, ese mismo modelo cae en la pasarela — y por eso su palanca no se mide", () => {
    expect(transporteDeModelo("anthropic/claude-sonnet-4-5", CFG_PASARELA)).toBe("openai-compatible");
  });

  it("los modelos de OpenAI siguen yendo por la pasarela aunque haya endpoint nativo", () => {
    expect(transporteDeModelo("openai/gpt-4o-mini", CFG_CON_NATIVO)).toBe("openai-compatible");
    expect(transporteDeModelo("gpt-4o", CFG_CON_NATIVO)).toBe("openai-compatible");
  });
});

describe("por el endpoint nativo viaja `cache_control`, que es toda la palanca", () => {
  it("habla la API de Mensajes y marca el final del prefijo estable", async () => {
    const { fetchImpl, llamadas } = fetchEspia(RESPUESTA_ANTHROPIC);
    const p = proveedorDelBanco("anthropic/claude-sonnet-4-5", { ...CFG_CON_NATIVO, fetchImpl });
    await p.generate({
      model: "anthropic/claude-sonnet-4-5",
      messages: [
        { role: "system", content: "políticas largas y estables" },
        { role: "user", content: "¿qué le respondo al cliente?" },
      ],
      stablePrefixMessages: 1,
    });

    expect(llamadas).toHaveLength(1);
    const { url, body } = llamadas[0]!;
    // El dialecto: `/messages`, no `/chat/completions`.
    expect(url).toBe("https://anthropic.invalido/v1/messages");
    // EL CAMPO QUE NO VIAJABA. Sin él Anthropic no cachea, por muy estable que
    // sea el prompt: es la diferencia entre pagar la entrada entera y pagarla
    // al 10%.
    const system = body["system"] as { text: string; cache_control?: unknown }[];
    expect(system[0]?.cache_control, "sin cache_control la palanca no existe").toEqual({
      type: "ephemeral",
    });
    // Y el id del modelo sale SIN el prefijo de la pasarela: `anthropic/claude-…`
    // es un 404 contra la API nativa.
    expect(body["model"]).toBe("claude-sonnet-4-5");
  });

  it("la lectura cacheada vuelve como libro 4, y la escritura NO se cuenta como ahorro", async () => {
    const { fetchImpl } = fetchEspia(RESPUESTA_ANTHROPIC);
    const p = proveedorDelBanco("anthropic/claude-sonnet-4-5", { ...CFG_CON_NATIVO, fetchImpl });
    const r = await p.generate({
      model: "anthropic/claude-sonnet-4-5",
      messages: [{ role: "user", content: "hola" }],
      stablePrefixMessages: 0,
    });
    expect(r.usage.cachedInputTokens).toBe(7_000);
    // `input_tokens` de Anthropic es SÓLO el resto no cacheado; el total suma los tres.
    expect(r.usage.inputTokens).toBe(7_040);
  });

  it("por la pasarela ese mismo modelo NO puede llevar cache_control: no hay campo donde ponerlo", async () => {
    const { fetchImpl, llamadas } = fetchEspia(RESPUESTA_OPENAI);
    const p = proveedorDelBanco("anthropic/claude-sonnet-4-5", { ...CFG_PASARELA, fetchImpl });
    await p.generate({
      model: "anthropic/claude-sonnet-4-5",
      messages: [
        { role: "system", content: "políticas largas y estables" },
        { role: "user", content: "¿qué le respondo al cliente?" },
      ],
      stablePrefixMessages: 1,
    });
    const { url, body } = llamadas[0]!;
    expect(url).toBe("https://pasarela.invalido/v1/chat/completions");
    // Este es el HECHO que justifica declarar la palanca no medible en vez de
    // publicar su cero: el protocolo no tiene dónde llevarla.
    expect(JSON.stringify(body)).not.toContain("cache_control");
  });
});

describe("una palanca que el transporte no puede ejercitar se DECLARA, no se publica a cero", () => {
  it("el escenario de cache_control por una pasarela OpenAI es NO MEDIBLE, con cómo medirlo", () => {
    const d = noMedibleEnTransporte(escenarioAnthropic(), "openai-compatible");
    expect(d).not.toBeNull();
    expect(d!.palanca).toBe("providerPrefixCache");
    expect(d!.motivo).toMatch(/cache_control/);
    // Sin esta segunda mitad la declaración es una queja: el lector tiene que
    // poder ARREGLARLO, y el nombre de la variable es lo único que hace falta.
    expect(d!.comoMedirla).toMatch(/BVSALA_DEMO_ANTHROPIC_BASE_URL/);
  });

  it("con el endpoint nativo declarado, ese mismo escenario SÍ es medible", () => {
    expect(noMedibleEnTransporte(escenarioAnthropic(), "anthropic-nativo")).toBeNull();
  });

  it("en MOCK no se declara no medible: ahí ninguna cifra es una afirmación de ahorro", () => {
    expect(noMedibleEnTransporte(escenarioAnthropic(), "mock")).toBeNull();
  });

  it("ningún otro escenario se salta por transporte", () => {
    const saltados = scenarios
      .filter((s) => noMedibleEnTransporte(s, "openai-compatible"))
      .map((s) => s.name);
    expect(saltados).toEqual(["Anthropic stable-prefix agent turn"]);
  });
});

/**
 * EL OTRO CERO DESNUDO, el de `gpt-4o-mini`.
 *
 * En la misma tirada, `Stable-prefix agent turn` midió 5.120 tokens cacheados en
 * `gpt-4o` y CERO en `gpt-4o-mini` con el MISMO prompt byte a byte (~5.258
 * tokens; 5.120 son 40 tramos de 128, la granularidad de OpenAI). O sea que el
 * mínimo de tramo NO lo explica, y el informe tiene que decirlo: un 0 desnudo se
 * lee como «en el modelo pequeño la palanca no ahorra», que es justo lo que
 * nadie ha medido.
 */
const resultadoFalso = (opts: {
  entrada: number;
  marcado?: { outcome: string; reason?: string };
}): SavingsResult =>
  ({
    report: {
      tokens: { actualInput: opts.entrada },
      traces: opts.marcado
        ? [
            {
              stage: "prefix-cache",
              outcome: opts.marcado.outcome,
              ...(opts.marcado.reason ? { detail: { reason: opts.marcado.reason } } : {}),
              atMs: 1,
            },
          ]
        : [],
    },
  }) as unknown as SavingsResult;

describe("un cero de la caché de prefijo llega con su diagnóstico", () => {
  const s = () => escenarioAnthropic();

  it("por debajo del mínimo de tramo, el cero SÍ está explicado y se dice", () => {
    const e = estadoDePalanca(s(), resultadoFalso({ entrada: 300 }), 0, "openai-compatible");
    expect(e?.ejercitada).toBe(false);
    expect(e?.motivo).toMatch(/no llega al mínimo de tramo/);
  });

  it("por encima del mínimo y con el prefijo marcado, se dice que el tamaño NO lo explica", () => {
    const e = estadoDePalanca(
      s(),
      resultadoFalso({ entrada: 5_258, marcado: { outcome: "marked" } }),
      0,
      "openai-compatible",
    );
    expect(e?.ejercitada).toBe(false);
    expect(e?.motivo).toMatch(/NO explica este cero/);
    expect(e?.motivo).toMatch(/No lo leas como una medición/);
  });

  it("si la capa no marcó el prefijo, el cero no dice nada del proveedor", () => {
    const e = estadoDePalanca(
      s(),
      resultadoFalso({ entrada: 5_258, marcado: { outcome: "skipped", reason: "tool set varies" } }),
      0,
      "openai-compatible",
    );
    expect(e?.motivo).toMatch(/la capa NO marcó el prefijo/);
    expect(e?.motivo).toMatch(/tool set varies/);
  });

  it("en MOCK la causa se conoce y no se inventan otras", () => {
    const e = estadoDePalanca(s(), resultadoFalso({ entrada: 5_258 }), 0, "mock");
    expect(e?.motivo).toMatch(/proveedor simulado/);
  });

  it("con tokens cacheados de verdad, la palanca consta como EJERCITADA", () => {
    const e = estadoDePalanca(
      s(),
      resultadoFalso({ entrada: 7_287, marcado: { outcome: "marked" } }),
      7_000,
      "anthropic-nativo",
    );
    expect(e?.ejercitada).toBe(true);
    expect(e?.motivo).toMatch(/7000 tokens desde su caché de prefijo/);
  });
});

describe("los reintentos: un estornudo de red no puede tirar una tirada pagada", () => {
  // El incidente del 2026-08-24: un UND_ERR_HEADERS_TIMEOUT en UNA llamada del
  // cuarto modelo mató el proceso entero con ~2 horas de llamadas pagadas y los
  // artefactos sin escribir. Solo se reintenta lo lanzado SIN respuesta: ahí no
  // hay `usage`, así que reintentar no puede contar nada dos veces.
  const respuesta = { text: "ok", usage: { inputTokens: 1, outputTokens: 1 } };
  const peticion = { model: "google/gemini-3.7-flash", messages: [] };

  function proveedorQueFalla(fallos: unknown[]): { p: Provider; llamadas: () => number } {
    let n = 0;
    const p: Provider = {
      id: "de-mentira",
      generate: () => {
        n += 1;
        const fallo = fallos.shift();
        if (fallo !== undefined) return Promise.reject(fallo);
        return Promise.resolve(respuesta);
      },
    };
    return { p, llamadas: () => n };
  }

  const timeoutDeCabeceras = () =>
    new TypeError("fetch failed", { cause: Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" }) });

  it("un fallo transitorio se reintenta tras la pausa y la respuesta llega", async () => {
    const { p, llamadas } = proveedorQueFalla([timeoutDeCabeceras()]);
    const pausas: number[] = [];
    const conRed = conReintentos(p, [2_000, 8_000], (ms) => { pausas.push(ms); return Promise.resolve(); });
    await expect(conRed.generate(peticion)).resolves.toEqual(respuesta);
    expect(llamadas()).toBe(2);
    expect(pausas).toEqual([2_000]);
  });

  it("agotadas las pausas, el error original sube — no se insiste para siempre", async () => {
    const { p, llamadas } = proveedorQueFalla([timeoutDeCabeceras(), timeoutDeCabeceras(), timeoutDeCabeceras()]);
    const conRed = conReintentos(p, [1, 1], () => Promise.resolve());
    await expect(conRed.generate(peticion)).rejects.toThrow("fetch failed");
    expect(llamadas()).toBe(3);
  });

  it("⛔ un error que NO es de red no se reintenta: pudo haberse facturado", async () => {
    // Un 4xx/5xx del adaptador, o un error de contrato, ya tuvo respuesta.
    // Reintentarlo aquí sería pagar dos veces por decisión de la fontanería.
    const { p, llamadas } = proveedorQueFalla([new Error("Anthropic API error 429: rate limited")]);
    const conRed = conReintentos(p, [1, 1], () => Promise.resolve());
    await expect(conRed.generate(peticion)).rejects.toThrow("429");
    expect(llamadas()).toBe(1);
  });
});

describe("el plazo duro: una petición colgada se corta y se reintenta, no se espera para siempre", () => {
  // Segundo incidente del 2026-08-24: un fetch sin socket, sin CPU y sin error
  // dejó la tirada 23 minutos parada con tres modelos medidos y sin escribir.
  it("fetchConPlazo corta con TimeoutError y conReintentos lo trata como transitorio", async () => {
    const colgado: typeof fetch = (_i, init) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(init.signal!.reason as Error));
      });
    const conPlazo = fetchConPlazo(20, colgado);
    await expect(conPlazo("https://x.invalido/")).rejects.toMatchObject({ name: "TimeoutError" });

    let llamadas = 0;
    const p: Provider = {
      id: "de-mentira",
      generate: async () => {
        llamadas += 1;
        if (llamadas === 1) await conPlazo("https://x.invalido/");
        return { text: "ok", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const conRed = conReintentos(p, [1], () => Promise.resolve());
    await expect(conRed.generate({ model: "m", messages: [] })).resolves.toMatchObject({ text: "ok" });
    expect(llamadas).toBe(2);
  });

  it("la señal del llamante se respeta: abortar de fuera no cuenta como plazo", async () => {
    const colgado: typeof fetch = (_i, init) =>
      new Promise((_res, rej) => {
        // Una señal YA abortada no vuelve a emitir "abort": se mira primero.
        if (init?.signal?.aborted) return rej(init.signal.reason as Error);
        init?.signal?.addEventListener("abort", () => rej(init.signal!.reason as Error));
      });
    const conPlazo = fetchConPlazo(60_000, colgado);
    const mia = AbortSignal.abort(new Error("cancelada por el llamante"));
    await expect(conPlazo("https://x.invalido/", { signal: mia })).rejects.toThrow("cancelada por el llamante");
  });
});

/**
 * GEMINI POR SU API NATIVA (banco semanal, camino a la 0.5): con una base
 * `…/v1beta` el modelo de Google sale por `GoogleProvider` —`generateContent`,
 * la clave en `x-goog-api-key`, sin el prefijo `google/` en la ruta— y el
 * `usageMetadata` se exige. Con `…/v1beta/openai`, el endpoint compatible de
 * antes, sin cambios.
 */
describe("transporte del banco · Gemini nativo", () => {
  const NATIVA = "https://generativelanguage.googleapis.com/v1beta";
  const RESPUESTA = {
    candidates: [{ content: { parts: [{ text: "391", thoughtSignature: "Ev8BCvwBAWkUfROE" }], role: "model" }, finishReason: "STOP", index: 0 }],
    usageMetadata: { promptTokenCount: 16, candidatesTokenCount: 3, totalTokenCount: 92, thoughtsTokenCount: 73, serviceTier: "standard" },
    modelVersion: "gemini-3.8-flash",
  };

  it("la URL decide el dialecto: …/v1beta es google-nativo y …/v1beta/openai el compatible", () => {
    expect(transporteDeModelo("google/gemini-3.8-flash", { googleBaseUrl: NATIVA, googleApiKey: "k" })).toBe("google-nativo");
    expect(transporteDeModelo("google/gemini-3.8-flash", { googleBaseUrl: `${NATIVA}/openai`, googleApiKey: "k" })).toBe("openai-compatible");
  });

  it("habla generateContent con la clave en su cabecera, sin el prefijo google/, y cobra el pensamiento como salida", async () => {
    const llamadas: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      llamadas.push({ url, headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify(RESPUESTA), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const p = proveedorDelBanco("google/gemini-3.8-flash", { googleBaseUrl: NATIVA, googleApiKey: "no-es-una-clave", fetchImpl });
    const r = await p.generate({ model: "google/gemini-3.8-flash", messages: [{ role: "system", content: "Sé breve." }, { role: "user", content: "17*23?" }], maxOutputTokens: 256, temperature: 0 });
    expect(llamadas[0]!.url).toBe(`${NATIVA}/models/gemini-3.8-flash:generateContent`);
    expect(llamadas[0]!.headers["x-goog-api-key"]).toBe("no-es-una-clave");
    expect(llamadas[0]!.body["systemInstruction"]).toEqual({ parts: [{ text: "Sé breve." }] });
    expect(llamadas[0]!.body["generationConfig"]).toMatchObject({ maxOutputTokens: 256, temperature: 0 });
    expect(r.text).toBe("391");
    expect(r.usage).toMatchObject({ inputTokens: 16, outputTokens: 76, reasoningTokens: 73 });
  });

  it("sin usageMetadata no hay medida: requireUsage", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ candidates: RESPUESTA.candidates }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const p = proveedorDelBanco("google/gemini-3.8-flash", { googleBaseUrl: NATIVA, googleApiKey: "k", fetchImpl });
    await expect(p.generate({ model: "google/gemini-3.8-flash", messages: [{ role: "user", content: "x" }] })).rejects.toThrow();
  });
});
