import { describe, it, expect } from "vitest";
import { createSavingsLayer } from "../../src/index.js";
import type { Provider, ProviderResponse, SavingsRequest } from "../../src/index.js";

/**
 * `ProviderResponse.replayable === false`: una respuesta que la capa no puede
 * reproducir desde un texto (ficheros, fuentes, herramientas que ejecutó el
 * proveedor, razonamiento que el proveedor espera de vuelta) se sirve SOLO a
 * quien la pidió. Ni se escribe en la caché exacta ni se la lleva un seguidor
 * concurrente: cada uno paga y mide su propia llamada.
 *
 * Y sin el campo, nada cambia: es la mitad del contrato que protege a todos los
 * proveedores que ya existen.
 */

const PREGUNTA = "Summarise the attached report in one line.";

function peticion(): SavingsRequest {
  return {
    model: "openai/gpt-4o-mini",
    temperature: 0,
    messages: [{ role: "user", content: PREGUNTA }],
    // Las palancas que reescriben el prompt, fuera: aquí solo se mira la reutilización.
    savings: { compression: false, elision: false, serialization: false, router: false },
  };
}

function proveedor(replayable: boolean | undefined, esperaMs = 0): Provider & { llamadas: number } {
  const p = {
    id: "stub",
    llamadas: 0,
    async generate(): Promise<ProviderResponse> {
      p.llamadas += 1;
      if (esperaMs > 0) await new Promise((r) => setTimeout(r, esperaMs));
      return {
        text: "A one-line summary.",
        finishReason: "stop",
        usage: { inputTokens: 40, outputTokens: 5, reasoningTokens: 0 },
        ...(replayable === undefined ? {} : { replayable }),
      };
    },
    async *generateStream() {
      p.llamadas += 1;
      yield { type: "text" as const, delta: "A one-line summary." };
      yield {
        type: "done" as const,
        response: {
          text: "A one-line summary.",
          finishReason: "stop",
          usage: { inputTokens: 40, outputTokens: 5, reasoningTokens: 0 },
          ...(replayable === undefined ? {} : { replayable }),
        },
      };
    },
  };
  return p;
}

describe("replayable:false — la respuesta se sirve solo a quien la pidió", () => {
  it("no se escribe en la caché exacta, y la traza dice por qué", async () => {
    const p = proveedor(false);
    const capa = createSavingsLayer({ provider: p, silenceWarnings: true });
    const a = await capa.generate(peticion());
    expect(a.report.cost.basis).toBe("measured");
    const escritura = a.report.traces.find((t) => t.stage === "cache-write");
    expect(escritura?.outcome).toBe("skipped: the provider answer carries content this layer cannot replay");

    const b = await capa.generate(peticion());
    expect(p.llamadas).toBe(2);
    expect(b.report.cache.result).toBe("miss");
    expect(b.report.cost.basis).toBe("measured");
    capa.close();
  });

  it("un seguidor concurrente idéntico hace su propia llamada, y las dos salen medidas", async () => {
    const p = proveedor(false, 20);
    const capa = createSavingsLayer({ provider: p, silenceWarnings: true });
    const [a, b] = await Promise.all([capa.generate(peticion()), capa.generate(peticion())]);
    expect(p.llamadas).toBe(2);
    expect([a.report.cache.result, b.report.cache.result]).toEqual(["miss", "miss"]);
    expect([a.report.cost.basis, b.report.cost.basis]).toEqual(["measured", "measured"]);
    const seguidor = [a, b].find((r) => r.report.traces.some((t) => t.stage === "singleflight" && t.outcome.startsWith("not coalesced")));
    expect(seguidor, "el seguidor deja constancia de por qué no se coalesció").toBeDefined();
    capa.close();
  });

  it("un stream que se une a un generate() en vuelo tampoco se lo lleva", async () => {
    const p = proveedor(false, 20);
    const capa = createSavingsLayer({ provider: p, silenceWarnings: true });
    const lider = capa.generate(peticion());
    // El stream no lidera: solo puede unirse a un generate() idéntico en vuelo.
    await new Promise((r) => setTimeout(r, 5));
    const stream = capa.generateStream(peticion());
    const [a, b] = await Promise.all([lider, stream.result]);
    expect(p.llamadas).toBe(2);
    expect(a.report.cost.basis).toBe("measured");
    expect(b.report.cost.basis).toBe("measured");
    expect(b.report.cache.result).toBe("miss");
    capa.close();
  });
});

describe("sin el campo, todo igual", () => {
  it("la repetición sale de la caché exacta sin llamar", async () => {
    const p = proveedor(undefined);
    const capa = createSavingsLayer({ provider: p, silenceWarnings: true });
    await capa.generate(peticion());
    const b = await capa.generate(peticion());
    expect(p.llamadas).toBe(1);
    expect(b.report.cache.result).toBe("exact");
    capa.close();
  });

  it("control del stream: sin el campo, el stream SÍ se une al generate() en vuelo", async () => {
    // Sin este control, el test del stream de arriba pasaría también si el stream
    // no llegara nunca a la puerta del singleflight.
    const p = proveedor(undefined, 20);
    const capa = createSavingsLayer({ provider: p, silenceWarnings: true });
    const lider = capa.generate(peticion());
    await new Promise((r) => setTimeout(r, 5));
    const stream = capa.generateStream(peticion());
    const [, b] = await Promise.all([lider, stream.result]);
    expect(p.llamadas).toBe(1);
    expect(b.report.cache.result).toBe("singleflight");
    capa.close();
  });

  it("con replayable:true explícito, también", async () => {
    const p = proveedor(true, 20);
    const capa = createSavingsLayer({ provider: p, silenceWarnings: true });
    const [a, b] = await Promise.all([capa.generate(peticion()), capa.generate(peticion())]);
    expect(p.llamadas).toBe(1);
    expect([a.report.cache.result, b.report.cache.result].sort()).toEqual(["miss", "singleflight"]);
    capa.close();
  });
});
