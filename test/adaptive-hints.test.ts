import { describe, it, expect } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";

/**
 * Avisar al modelo de las restricciones que el proveedor no impone cuesta
 * tokens de entrada en CADA petición. Medido: 27 tokens sobre prompts de 60-72,
 * o sea más de lo que cualquier palanca puede quitar ahí.
 *
 * Y hace un daño doble que no se ve venir: decirle a un modelo que dispone de
 * 400 caracteres le hace usarlos. En el escenario FAQ la salida subió de 18 a
 * 34 tokens frente al brazo naive — y la salida cuesta 4x por token. Se pagaba
 * dos veces por avisar de un límite que nadie iba a rozar.
 *
 * Así que el aviso se gana: solo lo llevan los contratos a los que un modelo ya
 * les incumplió una restricción de VALOR.
 */

const contrato = {
  contractId: "aviso:v1",
  schema: {
    type: "object" as const,
    additionalProperties: false,
    required: ["answer"],
    properties: { answer: { type: "string" as const, maxLength: 40 } },
  },
};

// Sin caché exacta: si no, la segunda petición idéntica la sirve la caché y no
// llega al proveedor, que es justo lo que hay que observar aquí.
const peticion = {
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user" as const, content: "¿Cuántos días dura la ventana de reembolso?" }],
  response: contrato,
  savings: { exactCache: false as const },
};

/** Captura lo que se manda y decide qué responder en cada llamada. */
class Espia implements Provider {
  readonly id = "espia";
  enviados: ProviderRequest[] = [];
  constructor(private readonly respuestas: string[]) {}
  async generate(r: ProviderRequest): Promise<ProviderResponse> {
    this.enviados.push(r);
    const texto = this.respuestas[Math.min(this.enviados.length - 1, this.respuestas.length - 1)]!;
    return { text: texto, finishReason: "stop", usage: { inputTokens: 60, outputTokens: 18 } };
  }
}

const llevaAviso = (r: ProviderRequest): boolean =>
  r.messages.some((m) => m.content.includes("JSON limits"));

const valida = JSON.stringify({ answer: "30 días" });
const demasiadoLarga = JSON.stringify({ answer: "x".repeat(80) });

describe("el aviso de restricciones se gana, no se regala", () => {
  it("un contrato que nunca ha incumplido NO paga el aviso", async () => {
    const provider = new Espia([valida]);
    const layer = createSavingsLayer({ provider, devUnlicensed: true });
    await layer.generate(peticion);

    expect(provider.enviados).toHaveLength(1);
    expect(llevaAviso(provider.enviados[0]!)).toBe(false);
  });

  it("tras un incumplimiento de VALOR, las siguientes sí lo llevan", async () => {
    // Primera: se pasa de maxLength -> reparación. A partir de ahí, avisado.
    const provider = new Espia([demasiadoLarga, valida, valida]);
    const layer = createSavingsLayer({ provider, devUnlicensed: true });

    await layer.generate(peticion);
    expect(llevaAviso(provider.enviados[0]!)).toBe(false); // la que aprendió

    await layer.generate(peticion);
    expect(llevaAviso(provider.enviados[provider.enviados.length - 1]!)).toBe(true);
  });

  it("un fallo de FORMA no hace pagar el aviso para siempre", async () => {
    // JSON mal formado: eso lo cubre el modo estructurado del proveedor. Contarle
    // un maxLength no lo arregla, así que apuntarlo sería cobrar sin ganar nada.
    const provider = new Espia(["esto no es json", valida, valida]);
    const layer = createSavingsLayer({ provider, devUnlicensed: true });

    await layer.generate(peticion);
    await layer.generate(peticion);

    expect(llevaAviso(provider.enviados[provider.enviados.length - 1]!)).toBe(false);
  });

  it("lo aprendido NO se filtra entre capas distintas", async () => {
    // La memoria vive en la instancia. Dos inquilinos con capas separadas no
    // comparten nada: uno no puede hacer pagar tokens al otro.
    const a = new Espia([demasiadoLarga, valida]);
    const capaA = createSavingsLayer({ provider: a, devUnlicensed: true });
    await capaA.generate(peticion);
    await capaA.generate(peticion);
    expect(llevaAviso(a.enviados[a.enviados.length - 1]!)).toBe(true);

    const b = new Espia([valida]);
    const capaB = createSavingsLayer({ provider: b, devUnlicensed: true });
    await capaB.generate(peticion);
    expect(llevaAviso(b.enviados[0]!)).toBe(false);
  });
});
