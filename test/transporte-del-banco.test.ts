import { describe, it, expect } from "vitest";

import {
  proveedorDelBanco,
  transporteDeModelo,
  type ConfigDeTransporte,
} from "../benchmarks/transporte.js";
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
  it("sin endpoint principal la tirada es MOCK, haya o no endpoint nativo", () => {
    expect(transporteDeModelo("anthropic/claude-sonnet-4-5", {})).toBe("mock");
    expect(
      transporteDeModelo("anthropic/claude-sonnet-4-5", { anthropicBaseUrl: "https://x.invalido" }),
    ).toBe("mock");
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
