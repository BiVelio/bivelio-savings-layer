import { describe, it, expect } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
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
    const layer = createSavingsLayer({ provider, devUnlicensed: true });
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
    const layer = createSavingsLayer({ provider, devUnlicensed: true });
    const r = await layer.generate(peticion);

    expect(provider.llamadas).toBe(2);
    expect(r.report.calls.retries).toBe(1);
  });

  it("el motivo queda en la traza, no solo en un aviso de consola", async () => {
    const provider = new ProveedorQueTrunca(true);
    const layer = createSavingsLayer({ provider, devUnlicensed: true });
    const r = await layer.generate(peticion);

    const paso = r.report.traces.find((t) => t.outcome === "repair-skipped");
    expect(paso).toBeDefined();
    expect(JSON.stringify(paso)).toMatch(/truncated by maxOutputTokens/);
  });
});
