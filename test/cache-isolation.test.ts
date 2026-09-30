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

/**
 * La caché SEMÁNTICA tenía la misma clase de fuga que la exacta, por otra vía:
 * su filtro de metadatos solo miraba tenant, scope, epoch y contrato. La clave
 * exacta declara necesarios otros seis campos, y el embedding no ve ninguno.
 */
describe("caché semántica: el embedding no decide solo", () => {
  const embed = async (t: string): Promise<number[]> =>
    // Embedding de juguete: cuenta caracteres por clase. Dos preguntas
    // redactadas casi igual salen casi idénticas, que es justo el escenario.
    [0, 1, 2, 3].map((i) => [...t].filter((c) => c.charCodeAt(0) % 4 === i).length);

  it("no sirve una respuesta calculada sobre datos ADJUNTOS distintos", async () => {
    const { InMemorySemanticCache } = await import("../src/cache/semantic.js");
    const semanticCache = new InMemorySemanticCache({ embed, similarityThreshold: 0.3, acceptThreshold: 0.3 });
    const provider = new ProveedorPersonalizado();
    const layer = createSavingsLayer({ provider, semanticCacheStore: semanticCache, devUnlicensed: true });

    const base = {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user" as const, content: "cuantas filas tiene la tabla adjunta" }],
      savings: { semanticCache: true as const, exactCache: false },
      context: { tenantId: "acme", knowledgeEpoch: "e1" },
    };

    const conTablaA = await layer.generate({ ...base, structuredData: { filas: [1, 2, 3] } });
    const conTablaB = await layer.generate({ ...base, structuredData: { filas: [1, 2, 3, 4, 5, 6, 7] } });

    // Misma pregunta, datos distintos: el embedding las ve iguales, pero la
    // respuesta correcta NO lo es. Antes se servía la de la primera tabla.
    expect(conTablaB.report.cache.result).not.toBe("semantic");
    expect(conTablaB.text).not.toBe(conTablaA.text);
  });

  it("no sirve la respuesta de OTRO modelo", async () => {
    const { InMemorySemanticCache } = await import("../src/cache/semantic.js");
    const semanticCache = new InMemorySemanticCache({ embed, similarityThreshold: 0.3, acceptThreshold: 0.3 });
    const provider = new ProveedorPersonalizado();
    const layer = createSavingsLayer({ provider, semanticCacheStore: semanticCache, devUnlicensed: true });

    const base = {
      messages: [{ role: "user" as const, content: "explica el teorema de forma breve" }],
      savings: { semanticCache: true as const, exactCache: false },
      context: { tenantId: "acme", knowledgeEpoch: "e1" },
    };
    const barato = await layer.generate({ ...base, model: "openai/gpt-4o-mini" });
    const caro = await layer.generate({ ...base, model: "openai/gpt-4o" });

    expect(caro.report.cache.result).not.toBe("semantic");
    expect(caro.text).not.toBe(barato.text);
  });
});
