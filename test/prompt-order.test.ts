import { describe, it, expect } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";

/**
 * El orden del prompt decidía el 100% de los fallos de calidad del banco.
 *
 * Medido contra el proveedor real, 8 pares por variante sobre la tabla de 50
 * filas, cambiando SOLO la posición del bloque de datos:
 *
 *   pregunta primero, datos al final   403 tokens de salida · trunca 4/8 · válidas 4/8
 *   datos primero, pregunta al final   193 tokens          · trunca 0/8 · válidas 8/8
 *   petición naive (JSON, sin capa)    279 tokens          · trunca 0/8 · válidas 8/8
 *
 * Mismo contenido, mismo rol, misma instrucción. Con la pregunta delante el
 * modelo divaga sobre los datos que acaba de leer y agota el tope de salida; el
 * JSON queda cortado a media cadena y no valida. Esos truncados eran lo único
 * que impedía publicar una cifra demostrada.
 *
 * Con el orden correcto la capa emite un 30,8% MENOS de salida que la petición
 * sin optimizar — y la salida es el 63,7% de la factura.
 */

class Espia implements Provider {
  readonly id = "espia";
  visto: ProviderRequest | null = null;
  async generate(r: ProviderRequest): Promise<ProviderResponse> {
    this.visto = r;
    return { text: '{"answer":"ok"}', finishReason: "stop", usage: { inputTokens: 800, outputTokens: 200 } };
  }
}

const tabla = {
  users: Array.from({ length: 50 }, (_, i) => ({
    id: 1000 + i, name: `user_${i}`, role: i % 3 === 0 ? "admin" : "member",
    plan: i % 2 ? "pro" : "free", active: i % 4 !== 0,
  })),
};

/** Índice del último mensaje del usuario, que es la pregunta de verdad. */
const indicePregunta = (r: ProviderRequest): number =>
  r.messages.map((m) => m.role).lastIndexOf("user");
const indiceDatos = (r: ProviderRequest): number =>
  r.messages.findIndex((m) => m.role === "system" && m.content.includes("user_49"));

describe("los datos van ANTES de la pregunta", () => {
  it("el bloque de datos precede al mensaje del usuario", async () => {
    const provider = new Espia();
    const layer = createSavingsLayer({ provider, devUnlicensed: true });
    await layer.generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "Summarize the attached user table." }],
      structuredData: tabla,
    });

    const r = provider.visto!;
    const datos = indiceDatos(r), pregunta = indicePregunta(r);
    expect(datos).toBeGreaterThanOrEqual(0);
    // Esta es la propiedad. Antes el bloque se empujaba al FINAL con push(),
    // detrás de la pregunta, y el modelo se desbocaba.
    expect(datos).toBeLessThan(pregunta);
  });

  it("también cuando el selector de formato está apagado", async () => {
    const provider = new Espia();
    const layer = createSavingsLayer({ provider, devUnlicensed: true });
    await layer.generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "Summarize the attached user table." }],
      structuredData: tabla,
      savings: { serialization: false },
    });

    const r = provider.visto!;
    expect(indiceDatos(r)).toBeLessThan(indicePregunta(r));
  });

  it("respeta un system prompt previo: los datos no se cuelan delante de él", async () => {
    // El system del cliente marca el papel del modelo y debe seguir primero;
    // además es la parte ESTABLE del prompt, que es la que la caché de prefijo
    // del proveedor reutiliza.
    const provider = new Espia();
    const layer = createSavingsLayer({ provider, devUnlicensed: true });
    await layer.generate({
      model: "openai/gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a precise data analyst." },
        { role: "user", content: "Summarize the attached user table." },
      ],
      structuredData: tabla,
    });

    const r = provider.visto!;
    expect(r.messages[0]!.content).toContain("precise data analyst");
    expect(indiceDatos(r)).toBeLessThan(indicePregunta(r));
  });

  it("sin mensaje de usuario no se pierde el bloque de datos", async () => {
    const provider = new Espia();
    const layer = createSavingsLayer({ provider, devUnlicensed: true });
    await layer.generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "system", content: "Report on the data." }],
      structuredData: tabla,
    });

    expect(indiceDatos(provider.visto!)).toBeGreaterThanOrEqual(0);
  });
});
