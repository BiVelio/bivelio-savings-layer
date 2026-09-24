import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";

/**
 * Un JSON cortado a media cadena por el tope de salida NO se arregla
 * reintentando con el mismo tope: vuelve a cortarse en el mismo sitio.
 *
 * Medido contra el proveedor real con el escenario de la tabla:
 *
 *   finish_reason : "length"
 *   salida        : 180 tokens exactos (el tope)
 *   JSON          : Unterminated string in JSON at position 522
 *
 * El layer no distinguía una respuesta MALA de una respuesta CORTADA —el
 * adaptador ni siquiera leía `finish_reason`— así que disparaba la reparación,
 * volvía a truncar, y el cliente pagaba DOS llamadas para acabar con salida
 * inválida igualmente.
 *
 * Tampoco cabe subir el tope por nuestra cuenta: lo fijó quien llama, y puede
 * haberlo puesto para controlar el gasto.
 */

const contrato = {
  contractId: "test:v1",
  schema: {
    type: "object" as const,
    additionalProperties: false,
    required: ["answer"],
    properties: { answer: { type: "string" as const } },
  },
  maxOutputTokens: 180,
};

/** Devuelve JSON truncado y lo declara: es lo que hace un proveedor de verdad. */
class ProveedorQueTrunca implements Provider {
  readonly id = "trunca";
  llamadas = 0;
  constructor(private readonly declaraFinish: boolean) {}
  async generate(_r: ProviderRequest): Promise<ProviderResponse> {
    this.llamadas++;
    return {
      text: '{"answer":"Los administradores son 15 en total, de los cuales activos',
      ...(this.declaraFinish ? { finishReason: "length" as const } : {}),
      usage: { inputTokens: 900, outputTokens: 180 },
    };
  }
}

const peticion = {
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user" as const, content: "Resume la tabla adjunta." }],
  response: contrato,
};

describe("salida cortada por el tope", () => {
  it("NO se gasta una segunda llamada en algo que un reintento no arregla", async () => {
    const provider = new ProveedorQueTrunca(true);
    const layer = createSavingsLayer({ exactTokenizer: false, provider, devUnlicensed: true });
    const r = await layer.generate(peticion);

    // Una sola llamada. Antes eran dos, y la segunda truncaba igual.
    expect(provider.llamadas).toBe(1);
    expect(r.report.calls.retries).toBe(0);
    // Y se dice la verdad sobre lo que se sirvió: no valida.
    expect(r.report.constraints.structurallyValid).toBe(false);
  });

  it("una salida inválida que NO se truncó sí merece su reintento (sin regresión)", async () => {
    // El arreglo no puede costar las reparaciones legítimas: un modelo que
    // devuelve JSON mal formado con finish_reason "stop" sí puede corregirse.
    const provider = new ProveedorQueTrunca(false);
    const layer = createSavingsLayer({ exactTokenizer: false, provider, devUnlicensed: true });
    const r = await layer.generate(peticion);

    expect(provider.llamadas).toBe(2);
    expect(r.report.calls.retries).toBe(1);
  });

  it("el motivo queda en la traza, no solo en un aviso de consola", async () => {
    const provider = new ProveedorQueTrunca(true);
    const layer = createSavingsLayer({ exactTokenizer: false, provider, devUnlicensed: true });
    const r = await layer.generate(peticion);

    const paso = r.report.traces.find((t) => t.outcome === "repair-skipped");
    expect(paso).toBeDefined();
    expect(JSON.stringify(paso)).toMatch(/truncated by maxOutputTokens/);
  });
});

/**
 * MEDIA RESPUESTA, GUARDADA UN DÍA Y COBRADA COMO EL MAYOR AHORRO DEL DÍA.
 *
 * La verja de caché miraba si la respuesta INCUMPLE SU CONTRATO, y eso deja
 * fuera el caso más largo de todos: una petición sin esquema no tiene nada que
 * validar, sale con `structurallyValid` en true y se archiva aunque el proveedor
 * haya dicho que paró por el tope. Ni siquiera hace falta que el llamante haya
 * puesto tope — la API de Anthropic EXIGE `max_tokens` y el adaptador manda 4096
 * por defecto, así que una generación larga se corta sin que nadie lo pidiera.
 *
 * A partir de ahí, cada petición idéntica se sirve de caché con `avoidedLlm: 1`
 * y se publica como 100% de ahorro sobre una respuesta cortada a media frase.
 */
class ProveedorCortado implements Provider {
  readonly id = "cortado";
  llamadas = 0;
  async generate(_r: ProviderRequest): Promise<ProviderResponse> {
    this.llamadas++;
    return {
      text: "El informe trimestral muestra un crecimiento sostenido en los mercados europeos y una",
      finishReason: "length",
      usage: { inputTokens: 120, outputTokens: 4096 },
    };
  }
}

const sinContrato = {
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user" as const, content: "Redacta el informe trimestral completo para el consejo." }],
};

describe("una respuesta cortada por el tope no se archiva", () => {
  it("NO se cachea, aunque no haya contrato que la declare inválida", async () => {
    const provider = new ProveedorCortado();
    const layer = createSavingsLayer({ exactTokenizer: false, provider, devUnlicensed: true });

    const primera = await layer.generate(sinContrato);
    // Sin esquema no hay nada que validar, y el informe lo AFIRMA en positivo:
    // ésa es exactamente la puerta por la que media respuesta entraba en caché.
    expect(primera.report.constraints.structurallyValid).toBe(true);
    expect(primera.finishReason).toBe("length");

    // La misma petición, byte a byte. Si se hubiera archivado, ésta se serviría
    // de caché con `avoidedLlm: 1` y sin tocar al proveedor.
    const segunda = await layer.generate(sinContrato);
    expect(segunda.report.cache.result).not.toBe("exact");
    expect(
      provider.llamadas,
      "la segunda petición se sirvió de una caché que guarda media respuesta",
    ).toBe(2);
  });

  it("y la traza dice por qué, para que no parezca que la caché falló", async () => {
    const provider = new ProveedorCortado();
    const layer = createSavingsLayer({ exactTokenizer: false, provider, devUnlicensed: true });
    const r = await layer.generate(sinContrato);

    const paso = r.report.traces.find((t) => t.stage === "cache-write");
    expect(paso?.outcome).toMatch(/cut off by the output cap/);
  });
});

/**
 * EL AVISO SE DEDUP POR PROCESO, ASÍ QUE LA CLAVE TIENE QUE LLEVAR DE QUÉ AVISA.
 *
 * Con la clave constante `"salida-truncada"`, el primer contrato que se cortaba
 * consumía el aviso para todos los demás y para todos los modelos. El caso que
 * lo destapó es el que más importa: cambiar de modelo sin recalibrar el contrato
 * —la tirada del 2026-08-16 midió tres modelos EN EL MISMO PROCESO—, y ahí el
 * cambio de modelo pasaba en silencio.
 */
describe("el aviso de truncado distingue contrato y modelo", () => {
  let avisos: string[];
  let espia: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    reiniciarAvisos();
    avisos = [];
    espia = vi.spyOn(console, "warn").mockImplementation((m: unknown) => {
      avisos.push(String(m));
    });
  });
  afterEach(() => espia.mockRestore());

  it("el mismo contrato contra DOS modelos avisa dos veces", async () => {
    const provider = new ProveedorQueTrunca(true);
    const layer = createSavingsLayer({ exactTokenizer: false, provider, devUnlicensed: true });

    await layer.generate(peticion);
    await layer.generate({ ...peticion, model: "anthropic/claude-sonnet-4-5" });

    const truncados = avisos.filter((a) => a.includes("cut off after exhausting"));
    expect(truncados).toHaveLength(2);
    expect(truncados[1]).toContain("anthropic/claude-sonnet-4-5");
  });

  it("cuando el esquema autoriza MÁS de lo que el tope permite, el aviso da la aritmética", async () => {
    // El contrato del banco que reventó la tirada: 400 caracteres de `answer` más
    // tres referencias de 120. La capa cuenta lo que eso ocupa con el tokenizador
    // del modelo de destino y lo compara con el tope, que es la cuenta que hubo
    // que hacer a mano leyendo un CSV.
    const provider = new ProveedorQueTrunca(true);
    const layer = createSavingsLayer({ exactTokenizer: false, provider, devUnlicensed: true });
    await layer.generate({
      ...peticion,
      response: {
        contractId: "demo-answer:v1",
        schema: {
          type: "object" as const,
          additionalProperties: false,
          required: ["answer"],
          properties: {
            answer: { type: "string" as const, maxLength: 400 },
            refs: { type: "array" as const, maxItems: 3, items: { type: "string" as const, maxLength: 120 } },
          },
        },
        maxOutputTokens: 180,
      },
    });

    const aviso = avisos.find((a) => a.includes("cut off after exhausting"));
    expect(aviso).toContain("demo-answer:v1");
    expect(aviso).toMatch(/allows responses of up to ~\d+ tokens/);
    expect(aviso, "hay que decir CUÁL de los dos números mover").toContain(
      "no response that uses what the schema itself permits fits",
    );
  });

  it("y cuando el esquema SÍ cabe, dice lo contrario: el tope no es el problema", async () => {
    // Distinguirlos importa porque el arreglo es el opuesto. Aquí el modelo está
    // escribiendo por encima de lo que su propio esquema autoriza, y subir el
    // tope solo compraría respuestas más largas que siguen incumpliendo.
    const provider = new ProveedorQueTrunca(true);
    const layer = createSavingsLayer({ exactTokenizer: false, provider, devUnlicensed: true });
    await layer.generate({
      ...peticion,
      response: {
        contractId: "contrato-holgado:v1",
        schema: {
          type: "object" as const,
          additionalProperties: false,
          required: ["answer"],
          properties: { answer: { type: "string" as const, maxLength: 40 } },
        },
        maxOutputTokens: 180,
      },
    });

    const aviso = avisos.find((a) => a.includes("cut off after exhausting"));
    expect(aviso).toContain("the cap is not the problem");
  });
});
