import { describe, it, expect } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import type { SavingsRequest } from "../src/contracts/types.js";

/**
 * La clase de fallo más cara de una capa de caché: servir a un usuario la
 * respuesta de otro. Y encima contarlo como acierto, o sea, como ahorro.
 *
 * La clave exacta lleva `tenant` y `authorizationScope`, pero canonicalize()
 * los rellena con "anonymous" y "default" cuando no se pasa contexto, así que
 * por sí solos no separan a dos personas de la misma organización.
 */

/** Proveedor que responde algo distinto a cada llamada, para poder detectar la fuga. */
class ProveedorPersonalizado implements Provider {
  readonly id = "personalizado";
  private n = 0;
  async generate(_req: ProviderRequest): Promise<ProviderResponse> {
    this.n++;
    return {
      text: `saldo de la persona ${this.n}`,
      usage: { inputTokens: 50, outputTokens: 10 },
    };
  }
}

const pregunta = (sessionId?: string): SavingsRequest => ({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "cuál es el saldo de mi cuenta" }],
  context: { tenantId: "acme", ...(sessionId ? { sessionId } : {}) },
});

describe("caché exacta: una respuesta personalizada no cruza de usuario", () => {
  it("dos personas del MISMO tenant no comparten respuesta", async () => {
    const provider = new ProveedorPersonalizado();
    const layer = createSavingsLayer({ provider, devUnlicensed: true });

    const ana = await layer.generate(pregunta("sesion-de-ana"));
    const luis = await layer.generate(pregunta("sesion-de-luis"));

    // Sin el principal en la clave, Luis recibía literalmente la respuesta de Ana
    // y el informe lo apuntaba como acierto de caché — es decir, como ahorro.
    expect(luis.text).not.toBe(ana.text);
    expect(luis.report.cache.result).not.toBe("exact");
  });

  it("la MISMA persona sí reutiliza su propia respuesta", async () => {
    const provider = new ProveedorPersonalizado();
    const layer = createSavingsLayer({ provider, devUnlicensed: true });

    const primera = await layer.generate(pregunta("sesion-de-ana"));
    const segunda = await layer.generate(pregunta("sesion-de-ana"));

    // El arreglo no puede costar aciertos legítimos: aislar por persona sigue
    // permitiendo cachear, que es de lo que vive el producto.
    expect(segunda.text).toBe(primera.text);
    expect(segunda.report.cache.result).toBe("exact");
  });

  it("sin principal, una petición personalizada NO se cachea", async () => {
    const provider = new ProveedorPersonalizado();
    const layer = createSavingsLayer({ provider, devUnlicensed: true });

    const a = await layer.generate(pregunta());
    const b = await layer.generate(pregunta());

    // No se puede aislar a quien pregunta, así que la política apaga la caché
    // exacta en lugar de arriesgarse a cruzar respuestas.
    expect(b.text).not.toBe(a.text);
    expect(b.report.cache.result).not.toBe("exact");
  });

  it("el tráfico NO personalizado sigue cacheando igual (sin regresión)", async () => {
    const provider = new ProveedorPersonalizado();
    const layer = createSavingsLayer({ provider, devUnlicensed: true });
    const generica: SavingsRequest = {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "en qué año se firmó el tratado de Utrecht" }],
      context: { tenantId: "acme" },
    };

    const primera = await layer.generate(generica);
    const segunda = await layer.generate(generica);

    expect(segunda.report.cache.result).toBe("exact");
    expect(segunda.text).toBe(primera.text);
  });
});
