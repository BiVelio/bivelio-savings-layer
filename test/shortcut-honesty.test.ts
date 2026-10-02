import { describe, it, expect } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import { createMockProvider } from "../src/providers/mock.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import type { SavingsRequest } from "../src/contracts/types.js";

/**
 * Las CUATRO rutas de atajo del pipeline —resolver determinista, caché exacta,
 * caché semántica y seguidor de singleflight— devuelven sin llamar al proveedor.
 * Son justo las que más ahorro acreditan, y eran las que menos comprobaban.
 */

describe("resolver determinista: no puede afirmar un contrato que no ha validado", () => {
  const req: SavingsRequest = {
    model: "openai/gpt-4o-mini",
    messages: [{ role: "user", content: "What is (2 + 2) * 3?" }],
    response: {
      contractId: "calc:v1",
      // El resolver aritmético devuelve { value: 8 }. Este contrato pide
      // { answer: string } y prohíbe propiedades extra: {value: 8} lo viola por
      // partida doble (falta `answer`, sobra `value`).
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["answer"],
        properties: { answer: { type: "string" } },
      },
    },
  };

  it("no sirve la respuesta del resolver cuando viola el esquema: la petición sigue al proveedor", async () => {
    // Antes se servía y el informe decía structurallyValid=false (y, antes aún,
    // `true` por un valor por defecto). Ahora el resolver se aparta: ni se
    // sirve lo que incumple el contrato ni se cuenta como llamada evitada.
    const layer = createSavingsLayer({
      provider: createMockProvider({ answer: "unused" }),
      devUnlicensed: true,
    });
    const res = await layer.generate(req);

    expect(res.report.cache.result).not.toBe("deterministic");
    expect(res.report.calls.avoidedLlm).toBe(0);
    // El proveedor simulado contesta en la forma del contrato.
    expect(res.data).toHaveProperty("answer");
    expect(res.report.constraints.structurallyValid).toBe(true);
  });

  it("sigue diciendo true cuando no hay contrato que cumplir (control negativo)", async () => {
    const layer = createSavingsLayer({
      provider: createMockProvider({ answer: "unused" }),
      devUnlicensed: true,
    });
    const sinEsquema: SavingsRequest = {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "What is (2 + 2) * 3?" }],
    };
    const res = await layer.generate(sinEsquema);
    expect(res.report.cache.result).toBe("deterministic");
    expect(res.report.constraints.structurallyValid).toBe(true);
  });
});

describe("seguidor de singleflight: no hereda los tokens del líder", () => {
  /** Proveedor lento: mantiene la llamada abierta para que las peticiones
   *  concurrentes se coalescan de verdad en lugar de resolverse por caché. */
  class SlowProvider implements Provider {
    readonly id = "slow";
    llamadas = 0;
    async generate(_req: ProviderRequest): Promise<ProviderResponse> {
      this.llamadas++;
      await new Promise((r) => setTimeout(r, 40));
      return {
        text: "una respuesta cualquiera",
        usage: { inputTokens: 1200, outputTokens: 40, cachedInputTokens: 800 },
      };
    }
  }

  const req: SavingsRequest = {
    model: "openai/gpt-4o-mini",
    messages: [{ role: "user", content: "explica el mecanismo de coalescencia en detalle" }],
    context: { tenantId: "t1" },
  };

  it("cada seguidor reporta SUS tokens, no los que el proveedor facturó al líder", async () => {
    const provider = new SlowProvider();
    const layer = createSavingsLayer({ provider, devUnlicensed: true });

    const [a, b, c] = await Promise.all([
      layer.generate(req),
      layer.generate(req),
      layer.generate(req),
    ]);

    // El proveedor se llamó UNA sola vez: hubo coalescencia real.
    expect(provider.llamadas).toBe(1);

    const seguidores = [a, b, c].filter((r) => r.report.cache.result === "singleflight");
    expect(seguidores.length).toBe(2);

    for (const s of seguidores) {
      // El seguidor no tocó al proveedor: no puede imputarse su gasto.
      expect(s.report.tokens.actualInput).toBe(0);
      expect(s.report.tokens.actualOutput).toBe(0);
      // Ni los descuentos de caché de prefijo que el proveedor aplicó al líder.
      // Con `{...leader.report}` cada seguidor reemitía los 800 tokens cacheados
      // del líder, así que con N seguidores se contaban N+1 veces en usage_daily.
      expect(s.report.tokens.providerCachedInput ?? 0).toBe(0);
      expect(s.report.tokens.compressedInput).toBe(0);
      // Y se valora con el contador de la llamada idéntica que corrió.
      expect(s.report.cost.basis).toBe("reference");
    }
  });

  it("el id del resultado y el del informe coinciden", async () => {
    const provider = new SlowProvider();
    const layer = createSavingsLayer({ provider, devUnlicensed: true });
    const rs = await Promise.all([layer.generate(req), layer.generate(req)]);
    // Se generaba un id distinto para el resultado y para el informe, así que
    // correlacionar una petición con su registro de medición era imposible.
    for (const r of rs) expect(r.requestId).toBe(r.report.requestId);
  });
});
