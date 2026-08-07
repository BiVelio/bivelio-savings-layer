import { describe, it, expect } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";

/**
 * La pista de restricciones provocaba el fallo que pretende evitar.
 *
 * Anunciar `answer<=1200ch` cuando el tope de salida son 600 tokens hace que el
 * modelo escriba hasta los 1200 caracteres prometidos, se quede sin presupuesto
 * y se corte a media cadena — con lo que el JSON no valida.
 *
 * Medido con 40 ensayos pareados contra el proveedor real, escenario de la tabla:
 *
 *   brazo naive (mismo tope, SIN pista)   39/40 respuestas válidas
 *   nuestro brazo (mismo tope, CON pista) 27/40
 *
 * Producíamos salida inválida bastante MÁS que el baseline sin optimizar, y la
 * única diferencia era la pista. Así que se anuncia el límite VINCULANTE: el
 * menor entre el del contrato y el que permite el presupuesto de salida.
 */

class Espia implements Provider {
  readonly id = "espia";
  enviados: ProviderRequest[] = [];
  async generate(r: ProviderRequest): Promise<ProviderResponse> {
    this.enviados.push(r);
    // Primera respuesta: incumple maxLength, para que el contrato "aprenda" y
    // las siguientes lleven la pista.
    const texto = this.enviados.length === 1
      ? JSON.stringify({ answer: "x".repeat(3000) })
      : JSON.stringify({ answer: "ok" });
    return { text: texto, finishReason: "stop", usage: { inputTokens: 80, outputTokens: 30 } };
  }
}

const pista = (r: ProviderRequest): string | undefined =>
  r.messages.find((m) => m.content.includes("JSON limits"))?.content;

const peticion = (maxOutputTokens: number | undefined, maxLength: number) => ({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user" as const, content: "Resume la tabla adjunta." }],
  savings: { exactCache: false as const },
  response: {
    contractId: `limite-${maxOutputTokens ?? "sin"}-${maxLength}:v1`,
    schema: {
      type: "object" as const,
      additionalProperties: false,
      required: ["answer"],
      properties: { answer: { type: "string" as const, maxLength } },
    },
    ...(maxOutputTokens != null ? { maxOutputTokens } : {}),
  },
});

describe("la pista anuncia el límite vinculante", () => {
  it("cuando el presupuesto de salida es más estricto, se anuncia ÉSE", async () => {
    const provider = new Espia();
    const layer = createSavingsLayer({ provider, devUnlicensed: true });
    const req = peticion(600, 1200); // 600 tokens ~ 1920 car... pero el contrato pide 1200

    await layer.generate(req); // aprende
    await layer.generate(req); // ya con pista

    const p = pista(provider.enviados[provider.enviados.length - 1]!)!;
    expect(p).toBeDefined();
    // 600 * 3,2 = 1920 > 1200, así que manda el del contrato.
    expect(p).toContain("1200ch");
  });

  it("un tope de salida pequeño RECORTA lo que se promete", async () => {
    const provider = new Espia();
    const layer = createSavingsLayer({ provider, devUnlicensed: true });
    const req = peticion(120, 1200); // 120 * 3,2 = 384 car reales

    await layer.generate(req);
    await layer.generate(req);

    const p = pista(provider.enviados[provider.enviados.length - 1]!)!;
    // Prometer 1200 caracteres con 120 tokens de tope garantiza el corte.
    expect(p).not.toContain("1200ch");
    expect(p).toContain("384ch");
  });

  it("sin tope de salida se anuncia el del contrato, tal cual", async () => {
    const provider = new Espia();
    const layer = createSavingsLayer({ provider, devUnlicensed: true });
    const req = peticion(undefined, 1200);

    await layer.generate(req);
    await layer.generate(req);

    expect(pista(provider.enviados[provider.enviados.length - 1]!)).toContain("1200ch");
  });
});
