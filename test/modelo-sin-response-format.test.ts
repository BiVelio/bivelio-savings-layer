import { describe, it, expect, vi, beforeEach } from "vitest";

import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { createSavingsLayer } from "../src/pipeline/create.js";
import { providerNativeBackend } from "../src/constraints/backends.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";

/**
 * MEDIDO CONTRA LA API REAL: gpt-3.5-turbo, gpt-4 y gpt-4-turbo son anteriores a
 * los structured outputs y rechazan `response_format` con un 400. El error del
 * proveedor llegaba crudo al cliente, sin nombrar la causa, así que una elección
 * de modelo legítima parecía una avería de la capa.
 *
 * Lo que se exige aquí es lo caro de acertar: que la petición NO se rompa, que no
 * se convierta en un bucle de reintentos, y sobre todo que el informe diga que la
 * garantía fue la débil. Un "sí" dudoso vale menos que un "no" honesto.
 */

const contrato = {
  type: "object" as const,
  additionalProperties: false,
  required: ["answer"],
  properties: { answer: { type: "string" as const } },
};

/** El cuerpo exacto con el que OpenAI rechaza el parámetro. */
const CUERPO_400 = JSON.stringify({
  error: {
    message:
      "Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model.",
    type: "invalid_request_error",
    param: "response_format",
  },
});

interface Envio {
  response_format?: unknown;
  messages: { role: string; content: string }[];
  model: string;
}

/**
 * Endpoint doble: contesta 400 mientras vea `response_format`, y 200 en cuanto
 * deje de verlo. Es la forma del proveedor real, no un mock a medida.
 */
function endpointAntiguo(respuesta = '{"answer":"ok"}') {
  const envios: Envio[] = [];
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Envio;
    envios.push(body);
    if (body.response_format !== undefined) {
      return new Response(CUERPO_400, { status: 400 });
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: respuesta }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 4 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { envios, fetchImpl };
}

beforeEach(() => reiniciarAvisos());

describe("un modelo sin structured outputs no rompe la petición", () => {
  it("degrada a pedir el JSON por prompt en vez de propagar el 400", async () => {
    const { envios, fetchImpl } = endpointAntiguo();
    const p = new OpenAICompatibleProvider({ baseUrl: "https://x/v1", fetchImpl });

    const r = await p.generate({
      model: "gpt-4",
      messages: [{ role: "user", content: "hola" }],
      schema: contrato,
    });

    expect(r.text).toBe('{"answer":"ok"}');
    expect(envios).toHaveLength(2);
    // El primer envío intenta la vía nativa; el segundo ya no la lleva.
    expect(envios[0]!.response_format).toBeDefined();
    expect(envios[1]!.response_format).toBeUndefined();
  });

  it("el esquema SIGUE viajando: sin él el modelo no tiene nada que cumplir", async () => {
    const { envios, fetchImpl } = endpointAntiguo();
    const p = new OpenAICompatibleProvider({ baseUrl: "https://x/v1", fetchImpl });
    await p.generate({
      model: "gpt-4",
      messages: [{ role: "user", content: "hola" }],
      schema: contrato,
    });

    const instruccion = envios[1]!.messages.at(-1)!;
    expect(instruccion.role).toBe("system");
    expect(instruccion.content).toContain(JSON.stringify(contrato));
    // Y el mensaje original no se pierde por el camino.
    expect(envios[1]!.messages[0]).toEqual({ role: "user", content: "hola" });
  });

  it("NO afirma una garantía nativa que no obtuvo", async () => {
    const { fetchImpl } = endpointAntiguo();
    const p = new OpenAICompatibleProvider({ baseUrl: "https://x/v1", fetchImpl });
    const r = await p.generate({
      model: "gpt-4",
      messages: [{ role: "user", content: "hola" }],
      schema: contrato,
    });
    expect(r.structuredNatively).toBe(false);
  });

  it("el modelo rechazado se recuerda: un viaje de más por modelo, no por petición", async () => {
    const { envios, fetchImpl } = endpointAntiguo();
    const p = new OpenAICompatibleProvider({ baseUrl: "https://x/v1", fetchImpl });
    const req = {
      model: "gpt-4",
      messages: [{ role: "user" as const, content: "hola" }],
      schema: contrato,
    };

    await p.generate(req);
    await p.generate(req);
    await p.generate(req);

    // 2 del primer descubrimiento + 1 por cada petición posterior. Sin el memo
    // serían 6: cada petición pagaría su propio 400.
    expect(envios).toHaveLength(4);
    expect(envios.filter((e) => e.response_format !== undefined)).toHaveLength(1);
  });

  it("un modelo moderno no paga nada por esto", async () => {
    const envios: Envio[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      envios.push(JSON.parse(String(init.body)) as Envio);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"answer":"ok"}' } }],
          usage: { prompt_tokens: 9, completion_tokens: 3 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const p = new OpenAICompatibleProvider({ baseUrl: "https://x/v1", fetchImpl });
    const r = await p.generate({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hola" }],
      schema: contrato,
    });

    expect(envios).toHaveLength(1);
    expect(envios[0]!.response_format).toBeDefined();
    expect(r.structuredNatively).toBe(true);
  });
});

describe("qué 400 SÍ y qué 400 NO merecen el segundo intento", () => {
  const cuerpo = (mensaje: string) => JSON.stringify({ error: { message: mensaje } });

  const conCuerpo = (mensaje: string) => {
    const envios: Envio[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      envios.push(JSON.parse(String(init.body)) as Envio);
      return new Response(cuerpo(mensaje), { status: 400 });
    }) as unknown as typeof fetch;
    return { envios, fetchImpl };
  };

  it("⛔ un esquema INVÁLIDO no se degrada, aunque el mensaje diga «not supported»", async () => {
    // EL FIXTURE IMPORTA MÁS QUE LA ASERCIÓN. El primero que se usó aquí no casaba
    // con la alternancia positiva, así que el test pasaba con o sin la exclusión de
    // «invalid schema»: la línea que decía probar era código muerto para la suite,
    // y una mutación que la borraba sobrevivía. Este cuerpo SÍ casa —es la forma
    // real del error de OpenAI cuando el esquema usa algo que no admite— de modo
    // que ahora lo único que separa degradar de no degradar es esa exclusión.
    // Aquí `response_format` sí existe. Degradar convertiría un error de
    // configuración visible en una garantía silenciosamente más débil.
    const { envios, fetchImpl } = conCuerpo(
      "Invalid schema for response_format 'bvsala_contract': In context=(), 'anyOf' is not supported",
    );
    const p = new OpenAICompatibleProvider({ baseUrl: "https://x/v1", fetchImpl });

    await expect(
      p.generate({ model: "gpt-4o", messages: [{ role: "user", content: "x" }], schema: contrato }),
    ).rejects.toThrow(/Invalid schema for response_format/);
    expect(envios).toHaveLength(1);
  });

  it("un 400 ajeno al parámetro tampoco: no se reintenta lo que no va a cambiar", async () => {
    const { envios, fetchImpl } = conCuerpo("This model's maximum context length is 8192 tokens");
    const p = new OpenAICompatibleProvider({ baseUrl: "https://x/v1", fetchImpl });

    await expect(
      p.generate({ model: "gpt-4", messages: [{ role: "user", content: "x" }], schema: contrato }),
    ).rejects.toThrow(/maximum context length/);
    expect(envios).toHaveLength(1);
  });

  it("otros endpoints compatibles dicen 'Unrecognized request argument' y también valen", async () => {
    const envios: Envio[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Envio;
      envios.push(body);
      if (body.response_format !== undefined) {
        return new Response(cuerpo("Unrecognized request argument supplied: response_format"), {
          status: 400,
        });
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"answer":"ok"}' } }],
          usage: { prompt_tokens: 7, completion_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const p = new OpenAICompatibleProvider({ baseUrl: "https://x/v1", fetchImpl });
    const r = await p.generate({
      model: "vllm/qwen",
      messages: [{ role: "user", content: "x" }],
      schema: contrato,
    });
    expect(r.text).toBe('{"answer":"ok"}');
    expect(envios).toHaveLength(2);
  });

  it("un 500 sigue siendo un 500: no se degrada ni se reintenta", async () => {
    const envios: Envio[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      envios.push(JSON.parse(String(init.body)) as Envio);
      return new Response("upstream exploded", { status: 500 });
    }) as unknown as typeof fetch;

    const p = new OpenAICompatibleProvider({ baseUrl: "https://x/v1", fetchImpl });
    await expect(
      p.generate({ model: "gpt-4", messages: [{ role: "user", content: "x" }], schema: contrato }),
    ).rejects.toThrow(/provider 500/);
    expect(envios).toHaveLength(1);
  });
});

describe("el informe no puede mentir sobre la garantía que se obtuvo", () => {
  const capa = (fetchImpl: typeof fetch) =>
    createSavingsLayer({
      provider: new OpenAICompatibleProvider({ baseUrl: "https://x/v1", fetchImpl }),
      devUnlicensed: true,
      // El backend nativo DECLARA soportarlo todo. Es la configuración en la que
      // el informe publica "provider-native" sin mirar la respuesta, así que es la
      // única que puede demostrar que ahora sí la mira.
      constraintBackends: [providerNativeBackend()],
    });

  it("un modelo sin response_format se publica como backend 'none'", async () => {
    const { fetchImpl } = endpointAntiguo();
    const r = await capa(fetchImpl).generate({
      model: "gpt-4",
      messages: [{ role: "user", content: "hola" }],
      response: { contractId: "r:v1", schema: contrato, maxOutputTokens: 80 },
    });

    expect(r.report.constraints.backend).toBe("none");
    // Y la validez estructural sigue diciendo la verdad de lo que se sirvió.
    expect(r.report.constraints.structurallyValid).toBe(true);
    expect(r.report.traces.some((t) => t.detail?.["downgradedFrom"] === "provider-native")).toBe(true);
  });

  it("un modelo moderno conserva 'provider-native' (sin regresión)", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"answer":"ok"}' } }],
            usage: { prompt_tokens: 9, completion_tokens: 3 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ) as unknown as typeof fetch;

    const r = await capa(fetchImpl).generate({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hola" }],
      response: { contractId: "r:v1", schema: contrato, maxOutputTokens: 80 },
    });

    expect(r.report.constraints.backend).toBe("provider-native");
  });

  it("un adaptador que NO informa no se degrada: callar no es negar", async () => {
    // La degradación exige un `false` explícito. Con `!== true` bastaría con que
    // un adaptador ajeno omitiera el campo para que el informe empezara a
    // declarar menos garantía de la que hubo — mentir a la baja también es mentir.
    const mudo = {
      id: "mudo",
      generate: async () => ({
        text: '{"answer":"ok"}',
        usage: { inputTokens: 9, outputTokens: 3 },
      }),
    };
    const layer = createSavingsLayer({
      provider: mudo,
      devUnlicensed: true,
      constraintBackends: [providerNativeBackend()],
    });

    const r = await layer.generate({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hola" }],
      response: { contractId: "r:v1", schema: contrato, maxOutputTokens: 80 },
    });

    expect(r.report.constraints.backend).toBe("provider-native");
  });
});
