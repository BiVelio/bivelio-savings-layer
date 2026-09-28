import { describe, it, expect, vi, beforeEach } from "vitest";

import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { createSavingsLayer } from "../src/pipeline/create.js";
import {
  comprobarTopeDePeticion,
  salidaEstimadaDeReferencia,
  topeDeSalida,
} from "../src/contracts/tope-de-salida.js";
import type { SavingsRequest } from "../src/contracts/types.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";

/**
 * EL TOPE DE SALIDA, EN EL CABLE Y EN LA PETICIÓN.
 *
 * Dos fallos vistos en vivo con la 0.4.30 (gpt-5.4-mini, banco GSM8K):
 *
 *  1. El adaptador de Chat Completions mandaba siempre `max_tokens`, y OpenAI
 *     lo rechaza en sus modelos de razonamiento (o-series, gpt-5.x) con el 400
 *     de abajo. `max_tokens` está deprecado desde el 2024-09-12 (SDK oficial
 *     openai-node 4.60.0, el de o1).
 *  2. Una petición de TEXTO LIBRE no podía fijar tope: `maxOutputTokens` solo
 *     existía dentro de `OutputContract`, que exige `schema`.
 */

/** El cuerpo exacto con el que OpenAI rechaza `max_tokens` en gpt-5.x / o-series. */
const RECHAZO_MAX_TOKENS = JSON.stringify({
  error: {
    message:
      "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
    type: "invalid_request_error",
    param: "max_tokens",
    code: "unsupported_parameter",
  },
});

/** Un servidor compatible con validador estricto (pydantic) que no conoce el campo nuevo. */
const RECHAZO_MAX_COMPLETION_TOKENS = JSON.stringify({
  detail: [
    {
      type: "extra_forbidden",
      loc: ["body", "max_completion_tokens"],
      msg: "Extra inputs are not permitted",
    },
  ],
});

type Cuerpo = Record<string, unknown>;

const OK = () =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: "42" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const SSE_OK = () =>
  new Response(
    [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "42" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 2 } })}`,
      "data: [DONE]",
      "",
    ].join("\n\n"),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

/**
 * Endpoint doble. `rechaza` decide, por cuerpo, si contesta el error de un
 * servidor real; si no, 200.
 */
function endpoint(rechaza: (c: Cuerpo) => Response | null = () => null) {
  const cuerpos: Cuerpo[] = [];
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    const c = JSON.parse(String(init.body)) as Cuerpo;
    cuerpos.push(c);
    return rechaza(c) ?? (c["stream"] === true ? SSE_OK() : OK());
  }) as unknown as typeof fetch;
  return { cuerpos, fetchImpl };
}

/**
 * Lo que hace OpenAI: 400 si un modelo de razonamiento (gpt-5.x, o-series) ve
 * `max_tokens`. gpt-4o-mini y los anteriores admiten los dos campos.
 */
const comoRazonamientoDeOpenAI = (c: Cuerpo): Response | null =>
  "max_tokens" in c && /^(gpt-5|o\d)/.test(String(c["model"]))
    ? new Response(RECHAZO_MAX_TOKENS, { status: 400 })
    : null;

const OFICIAL = "https://api.openai.com/v1";
const TERCERO = "http://localhost:4000/v1"; // un proxy compatible local

const pregunta = [{ role: "user" as const, content: "¿Cuánto es 6 × 7?" }];

beforeEach(() => reiniciarAvisos());

describe("el campo del tope en Chat Completions", () => {
  it.each(["gpt-5.4-mini", "o4-mini", "o3", "gpt-4o-mini"])(
    "contra api.openai.com, %s recibe `max_completion_tokens` y no `max_tokens`",
    async (model) => {
      const { cuerpos, fetchImpl } = endpoint(comoRazonamientoDeOpenAI);
      const p = new OpenAICompatibleProvider({ baseUrl: OFICIAL, fetchImpl });
      const r = await p.generate({ model, messages: pregunta, maxOutputTokens: 300 });

      expect(r.text).toBe("42");
      // Un solo viaje: no se descubre a base de 400 en el API oficial.
      expect(cuerpos).toHaveLength(1);
      expect(cuerpos[0]!["max_completion_tokens"]).toBe(300);
      expect(cuerpos[0]).not.toHaveProperty("max_tokens");
    },
  );

  it("el id con prefijo (`openai/gpt-5.4-mini`) contra el API oficial, igual", async () => {
    const { cuerpos, fetchImpl } = endpoint(comoRazonamientoDeOpenAI);
    const p = new OpenAICompatibleProvider({ baseUrl: OFICIAL, fetchImpl });
    await p.generate({ model: "openai/gpt-5.4-mini", messages: pregunta, maxOutputTokens: 64 });
    expect(cuerpos[0]!["model"]).toBe("gpt-5.4-mini");
    expect(cuerpos[0]!["max_completion_tokens"]).toBe(64);
  });

  it("contra un endpoint de terceros sigue viajando `max_tokens` (el que entienden todos)", async () => {
    const { cuerpos, fetchImpl } = endpoint();
    const p = new OpenAICompatibleProvider({ baseUrl: TERCERO, fetchImpl });
    await p.generate({ model: "gpt-4o-mini", messages: pregunta, maxOutputTokens: 300 });
    expect(cuerpos[0]!["max_tokens"]).toBe(300);
    expect(cuerpos[0]).not.toHaveProperty("max_completion_tokens");
  });

  it("sin tope no viaja ninguno de los dos (el cuerpo de siempre)", async () => {
    for (const baseUrl of [OFICIAL, TERCERO]) {
      const { cuerpos, fetchImpl } = endpoint();
      await new OpenAICompatibleProvider({ baseUrl, fetchImpl }).generate({ model: "gpt-5.4-mini", messages: pregunta });
      expect(cuerpos[0]).not.toHaveProperty("max_tokens");
      expect(cuerpos[0]).not.toHaveProperty("max_completion_tokens");
    }
  });

  it("un tercero que reenvía a gpt-5.4-mini y devuelve el 400 de OpenAI: se corrige UNA vez y se recuerda", async () => {
    const { cuerpos, fetchImpl } = endpoint(comoRazonamientoDeOpenAI);
    const p = new OpenAICompatibleProvider({ baseUrl: TERCERO, fetchImpl });

    const r1 = await p.generate({ model: "gpt-5.4-mini", messages: pregunta, maxOutputTokens: 300 });
    expect(r1.text).toBe("42");
    expect(cuerpos).toHaveLength(2);
    expect(cuerpos[0]!["max_tokens"]).toBe(300);
    expect(cuerpos[1]!["max_completion_tokens"]).toBe(300);
    expect(cuerpos[1]).not.toHaveProperty("max_tokens");

    // La siguiente va directa: el modelo quedó anotado.
    await p.generate({ model: "gpt-5.4-mini", messages: pregunta, maxOutputTokens: 50 });
    expect(cuerpos).toHaveLength(3);
    expect(cuerpos[2]!["max_completion_tokens"]).toBe(50);

    // Y es por MODELO: otro modelo del mismo endpoint sigue con `max_tokens`.
    await p.generate({ model: "gpt-4o-mini", messages: pregunta, maxOutputTokens: 50 });
    expect(cuerpos).toHaveLength(4);
    expect(cuerpos[3]!["max_tokens"]).toBe(50);
  });

  it("un servidor que no conoce `max_completion_tokens` (422 de pydantic) vuelve a `max_tokens`", async () => {
    // La dirección contraria de la corrección: por defecto se manda el campo
    // nuevo (aquí, porque la URL es la oficial) y quien contesta no lo conoce.
    let llamadas = 0;
    const { cuerpos, fetchImpl } = endpoint((c) => {
      llamadas++;
      return "max_completion_tokens" in c ? new Response(RECHAZO_MAX_COMPLETION_TOKENS, { status: 422 }) : null;
    });
    const p = new OpenAICompatibleProvider({ baseUrl: OFICIAL, fetchImpl });
    const r = await p.generate({ model: "gpt-4o-mini", messages: pregunta, maxOutputTokens: 80 });
    expect(r.text).toBe("42");
    expect(llamadas).toBe(2);
    expect(cuerpos[1]!["max_tokens"]).toBe(80);
  });

  it("un 400 por el VALOR del tope no se toca: llega al cliente con el detalle", async () => {
    const { cuerpos, fetchImpl } = endpoint(
      () =>
        new Response(
          JSON.stringify({ error: { message: "max_tokens is too large: 900000. This model supports at most 16384 completion tokens." } }),
          { status: 400 },
        ),
    );
    const p = new OpenAICompatibleProvider({ baseUrl: TERCERO, fetchImpl });
    await expect(
      p.generate({ model: "gpt-4o-mini", messages: pregunta, maxOutputTokens: 900000 }),
    ).rejects.toThrow(/provider 400: .*too large/);
    expect(cuerpos).toHaveLength(1);
  });

  it("con `maxTokensParam` explícito manda ese campo y NUNCA lo cambia", async () => {
    const forzadoNuevo = endpoint();
    await new OpenAICompatibleProvider({
      baseUrl: TERCERO,
      fetchImpl: forzadoNuevo.fetchImpl,
      maxTokensParam: "max_completion_tokens",
    }).generate({ model: "gpt-4o-mini", messages: pregunta, maxOutputTokens: 70 });
    expect(forzadoNuevo.cuerpos[0]!["max_completion_tokens"]).toBe(70);
    expect(forzadoNuevo.cuerpos[0]).not.toHaveProperty("max_tokens");

    const forzadoViejo = endpoint(comoRazonamientoDeOpenAI);
    const p = new OpenAICompatibleProvider({ baseUrl: OFICIAL, fetchImpl: forzadoViejo.fetchImpl, maxTokensParam: "max_tokens" });
    await expect(p.generate({ model: "gpt-5.4-mini", messages: pregunta, maxOutputTokens: 70 })).rejects.toThrow(
      /Unsupported parameter: 'max_tokens'/,
    );
    expect(forzadoViejo.cuerpos).toHaveLength(1);
  });

  it("se compone con la degradación de `response_format` (gpt-4 detrás de un tercero con el 400 de OpenAI)", async () => {
    const RECHAZO_RF = JSON.stringify({
      error: { message: "Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model." },
    });
    const { cuerpos, fetchImpl } = endpoint((c) =>
      c["response_format"] !== undefined
        ? new Response(RECHAZO_RF, { status: 400 })
        : "max_tokens" in c
          ? new Response(RECHAZO_MAX_TOKENS, { status: 400 })
          : null,
    );
    const p = new OpenAICompatibleProvider({ baseUrl: TERCERO, fetchImpl });
    const r = await p.generate({
      model: "gpt-4",
      messages: pregunta,
      schema: { type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "string" } } },
      maxOutputTokens: 40,
    });
    expect(r.structuredNatively).toBe(false);
    expect(cuerpos).toHaveLength(3);
    expect(cuerpos[2]).not.toHaveProperty("response_format");
    expect(cuerpos[2]!["max_completion_tokens"]).toBe(40);
  });

  it("en stream: corrige el campo y CONSERVA `stream_options` (el usage no se pierde)", async () => {
    const { cuerpos, fetchImpl } = endpoint(comoRazonamientoDeOpenAI);
    const p = new OpenAICompatibleProvider({ baseUrl: TERCERO, fetchImpl });
    let texto = "";
    let fin: { usage: { outputTokens: number; complete?: boolean } } | undefined;
    for await (const ev of p.generateStream({ model: "gpt-5.4-mini", messages: pregunta, maxOutputTokens: 30 })) {
      if (ev.type === "text") texto += ev.delta;
      if (ev.type === "done") fin = ev.response;
    }
    expect(texto).toBe("42");
    expect(cuerpos).toHaveLength(2);
    expect(cuerpos[1]!["max_completion_tokens"]).toBe(30);
    expect(cuerpos[1]!["stream_options"]).toEqual({ include_usage: true });
    expect(fin!.usage.outputTokens).toBe(2);
    expect(fin!.usage.complete).not.toBe(false);
  });

  it("en stream contra el API oficial va a la primera con `max_completion_tokens`", async () => {
    const { cuerpos, fetchImpl } = endpoint(comoRazonamientoDeOpenAI);
    const p = new OpenAICompatibleProvider({ baseUrl: OFICIAL, fetchImpl });
    for await (const _ of p.generateStream({ model: "gpt-5.4-mini", messages: pregunta, maxOutputTokens: 30 })) {
      // consumir
    }
    expect(cuerpos).toHaveLength(1);
    expect(cuerpos[0]!["max_completion_tokens"]).toBe(30);
  });
});

// ─── El tope de PETICIÓN, en texto libre ────────────────────────────────────

function anthropicDoble() {
  const cuerpos: Cuerpo[] = [];
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    cuerpos.push(JSON.parse(String(init.body)) as Cuerpo);
    return new Response(
      JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "42" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 12, output_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { cuerpos, fetchImpl };
}

const capa = (provider: OpenAICompatibleProvider | AnthropicProvider) =>
  createSavingsLayer({ provider, devUnlicensed: true, silenceWarnings: true } as never);

describe("`maxOutputTokens` a nivel de petición (texto libre)", () => {
  it("Anthropic: viaja como `max_tokens` sin contrato", async () => {
    const api = anthropicDoble();
    const r = await capa(new AnthropicProvider({ fetchImpl: api.fetchImpl })).generate({
      model: "anthropic/claude-sonnet-4-6",
      messages: pregunta,
      maxOutputTokens: 120,
    });
    expect(r.text).toBe("42");
    expect(api.cuerpos[0]!["max_tokens"]).toBe(120);
  });

  it("Anthropic: sin tope, el 4096 de siempre", async () => {
    const api = anthropicDoble();
    await capa(new AnthropicProvider({ fetchImpl: api.fetchImpl })).generate({
      model: "anthropic/claude-sonnet-4-6",
      messages: pregunta,
    });
    expect(api.cuerpos[0]!["max_tokens"]).toBe(4096);
  });

  it("OpenAI oficial: viaja como `max_completion_tokens` sin contrato", async () => {
    const { cuerpos, fetchImpl } = endpoint(comoRazonamientoDeOpenAI);
    const r = await capa(new OpenAICompatibleProvider({ baseUrl: OFICIAL, fetchImpl })).generate({
      model: "openai/gpt-5.4-mini",
      messages: pregunta,
      maxOutputTokens: 200,
    });
    expect(r.text).toBe("42");
    expect(cuerpos[0]!["max_completion_tokens"]).toBe(200);
  });

  it("OpenAI de terceros: viaja como `max_tokens`", async () => {
    const { cuerpos, fetchImpl } = endpoint();
    await capa(new OpenAICompatibleProvider({ baseUrl: TERCERO, fetchImpl })).generate({
      model: "openai/gpt-4o-mini",
      messages: pregunta,
      maxOutputTokens: 200,
    });
    expect(cuerpos[0]!["max_tokens"]).toBe(200);
  });

  it("con contrato Y petición, viaja el menor (en los dos sentidos)", async () => {
    const schema = { type: "object" as const, additionalProperties: false, required: ["a"], properties: { a: { type: "string" as const } } };
    for (const [dePeticion, delContrato] of [[50, 300], [300, 50]] as const) {
      const api = anthropicDoble();
      await capa(new AnthropicProvider({ fetchImpl: api.fetchImpl })).generate({
        model: "anthropic/claude-sonnet-4-6",
        messages: pregunta,
        maxOutputTokens: dePeticion,
        response: { contractId: "c:v1", schema, maxOutputTokens: delContrato },
        savings: { exactCache: false },
      });
      expect(api.cuerpos[0]!["max_tokens"]).toBe(50);
    }
  });

  it("el informe dice que el tope lo puso el cliente, y una respuesta cortada no se cachea", async () => {
    let llamadas = 0;
    const fetchImpl = vi.fn(async () => {
      llamadas++;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "La respuesta es cuarenta y" }, finish_reason: "length" }],
          usage: { prompt_tokens: 12, completion_tokens: 8 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const layer = capa(new OpenAICompatibleProvider({ baseUrl: OFICIAL, fetchImpl }));
    const req: SavingsRequest = { model: "openai/gpt-4o-mini", messages: pregunta, maxOutputTokens: 8 };

    const r1 = await layer.generate(req);
    expect(r1.report.qualityLedger?.truncation).toEqual({
      truncated: true,
      finishReason: "length",
      capSetByCaller: true,
      outputLimit: 8,
    });
    // La segunda idéntica vuelve al proveedor: media respuesta no se sirve de caché.
    await layer.generate(req);
    expect(llamadas).toBe(2);
  });

  it("un tope que no es un entero positivo se rechaza en claro y sin llamar al proveedor", async () => {
    const { cuerpos, fetchImpl } = endpoint();
    const layer = capa(new OpenAICompatibleProvider({ baseUrl: OFICIAL, fetchImpl }));
    for (const malo of [0, -5, 1.5, Number.NaN]) {
      await expect(
        layer.generate({ model: "openai/gpt-4o-mini", messages: pregunta, maxOutputTokens: malo }),
      ).rejects.toThrow(/maxOutputTokens must be a positive integer/);
    }
    expect(cuerpos).toHaveLength(0);
  });
});

describe("la regla del tope, pura", () => {
  const base: SavingsRequest = { model: "m", messages: pregunta };
  const schema = { type: "object" as const };

  it("topeDeSalida: el menor de los dos, uno solo, o ninguno", () => {
    expect(topeDeSalida(base)).toBeUndefined();
    expect(topeDeSalida({ ...base, maxOutputTokens: 90 })).toBe(90);
    expect(topeDeSalida({ ...base, response: { contractId: "c", schema, maxOutputTokens: 70 } })).toBe(70);
    expect(topeDeSalida({ ...base, maxOutputTokens: 90, response: { contractId: "c", schema, maxOutputTokens: 70 } })).toBe(70);
    expect(topeDeSalida({ ...base, maxOutputTokens: 40, response: { contractId: "c", schema, maxOutputTokens: 70 } })).toBe(40);
  });

  it("un tope del cliente NUNCA sube la salida estimada de una evitada: solo la baja", () => {
    // Sin tope de petición, lo de siempre.
    expect(salidaEstimadaDeReferencia(base)).toBe(256);
    expect(salidaEstimadaDeReferencia({ ...base, response: { contractId: "c", schema, maxOutputTokens: 600 } })).toBe(600);
    // Un techo enorme en texto libre no se convierte en 100 000 tokens «evitados».
    expect(salidaEstimadaDeReferencia({ ...base, maxOutputTokens: 100_000 })).toBe(256);
    expect(salidaEstimadaDeReferencia({ ...base, maxOutputTokens: 64 })).toBe(64);
    expect(
      salidaEstimadaDeReferencia({ ...base, maxOutputTokens: 100_000, response: { contractId: "c", schema, maxOutputTokens: 600 } }),
    ).toBe(600);
  });

  it("comprobarTopeDePeticion deja pasar lo ausente y los enteros positivos", () => {
    expect(() => comprobarTopeDePeticion(base)).not.toThrow();
    expect(() => comprobarTopeDePeticion({ ...base, maxOutputTokens: 1 })).not.toThrow();
    expect(() => comprobarTopeDePeticion({ ...base, maxOutputTokens: 0 })).toThrow(TypeError);
  });
});
