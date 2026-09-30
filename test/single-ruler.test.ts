import { describe, it, expect } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import { heuristicEstimator } from "../src/tokenizer/estimator.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import type { SavingsRequest } from "../src/contracts/types.js";

/**
 * La regla de una sola regla.
 *
 * `baselineInput` se contaba con el estimador LOCAL y `actualInput` con el
 * contador del PROVEEDOR, y el coste dividía uno entre otro: dos reglas de medir
 * distintas, así que el sesgo del estimador se convertía en "ahorro".
 *
 * Ningún test podía verlo porque `createMockProvider` cuenta con el MISMO
 * estimador heurístico que el baseline, así que en mock baseline == actual por
 * construcción. Este proveedor cuenta como un BPE real (~3,6 caracteres por
 * token), que es lo que hace uno de verdad.
 */
class ProveedorBPE implements Provider {
  readonly id = "bpe";
  llamadas = 0;
  constructor(private readonly salida = 40) {}
  async generate(req: ProviderRequest): Promise<ProviderResponse> {
    this.llamadas++;
    const texto = req.messages.map((m) => m.content).join("\n");
    return {
      text: "respuesta",
      usage: { inputTokens: Math.ceil(texto.length / 3.6), outputTokens: this.salida },
    };
  }
}

/** Carga estructurada: donde el estimador heurístico más se desvía (1 token por signo). */
const PAYLOAD = {
  users: Array.from({ length: 40 }, (_, i) => ({
    id: 1000 + i,
    name: `user_${i}`,
    email: `u${i}@acme.com`,
    role: i % 3 ? "viewer" : "admin",
  })),
};

describe("con CERO optimización el ahorro es CERO, no el sesgo del estimador", () => {
  const sinOptimizar: SavingsRequest = {
    model: "openai/gpt-4o-mini",
    messages: [{ role: "user", content: "Resume la tabla adjunta." }],
    structuredData: PAYLOAD,
    // Todas las palancas apagadas: la capa no puede quitar ni un token.
    savings: {
      exactCache: false,
      semanticCache: false,
      compression: false,
      serialization: false,
      deterministicResolvers: false,
      router: false,
    },
  };

  it("netSavings es 0 aunque el estimador local sobrecuente casi el doble", async () => {
    const provider = new ProveedorBPE();
    const layer = createSavingsLayer({ provider, devUnlicensed: true });
    const res = await layer.generate(sinOptimizar);

    // Se comprueba primero que el sesgo del estimador ES grande en esta entrada:
    // si no, el test no probaría nada.
    const textoLocal = [sinOptimizar.messages[0]!.content, JSON.stringify(PAYLOAD)].join("\n");
    const local = heuristicEstimator.count(textoLocal);
    const real = res.report.tokens.actualInput;
    expect(local / real).toBeGreaterThan(1.4); // sesgo real y sustancial

    // Y aun así no se reclama nada: baseline == actual por construcción.
    expect(res.report.tokens.eliminatedInput).toBe(0);
    expect(res.report.tokens.compressedInput).toBe(0);
    expect(res.report.tokens.baselineInput).toBe(res.report.tokens.actualInput);
    expect(res.report.cost.netSavingsRatio).toBe(0);
  });

  it("y el informe dice que ese baseline está MEDIDO, no estimado", async () => {
    const layer = createSavingsLayer({ provider: new ProveedorBPE(), devUnlicensed: true });
    const res = await layer.generate(sinOptimizar);
    expect(res.report.cost.basis).toBe("measured");
  });
});

describe("una optimización REAL sí se acredita", () => {
  it("lo eliminado se convierte a la regla del proveedor y sale como ahorro", async () => {
    const provider = new ProveedorBPE();
    const layer = createSavingsLayer({ provider, devUnlicensed: true });
    // Con la serialización activa, el payload se recodifica y salen menos tokens.
    const res = await layer.generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "Resume la tabla adjunta." }],
      structuredData: PAYLOAD,
      savings: { exactCache: false, semanticCache: false, deterministicResolvers: false },
    });

    if (res.report.tokens.compressedInput + res.report.tokens.eliminatedInput > 0) {
      // Si la capa quitó algo, el baseline tiene que ser MAYOR que el actual…
      expect(res.report.tokens.baselineInput).toBeGreaterThan(res.report.tokens.actualInput);
      // …y el ahorro, positivo pero no disparatado.
      expect(res.report.cost.netSavingsRatio).toBeGreaterThan(0);
      expect(res.report.cost.netSavingsRatio).toBeLessThan(1);
    } else {
      // Y si no quitó nada, cero. Nunca "algo por si acaso".
      expect(res.report.cost.netSavingsRatio).toBe(0);
    }
  });
});

describe("el descuento de caché del proveedor no se acredita a la capa", () => {
  it("una petición sin optimizar pero con prefijo cacheado sigue dando 0%", async () => {
    class ConPrefijoCacheado implements Provider {
      readonly id = "cached";
      async generate(req: ProviderRequest): Promise<ProviderResponse> {
        const texto = req.messages.map((m) => m.content).join("\n");
        const entrada = Math.ceil(texto.length / 3.6);
        return {
          text: "respuesta",
          // El proveedor sirve el 70% del prompt de su caché de prefijo.
          usage: { inputTokens: entrada, outputTokens: 30, cachedInputTokens: Math.floor(entrada * 0.7) },
        };
      }
    }
    const layer = createSavingsLayer({
      provider: new ConPrefijoCacheado(),
      devUnlicensed: true,
      costModels: { "gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006, cachedInputPer1k: 0.000075 } },
    });
    const res = await layer.generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "Una pregunta cualquiera sobre el contenido." }],
      savings: {
        exactCache: false, semanticCache: false, compression: false,
        serialization: false, deterministicResolvers: false, router: false,
      },
    });

    // El recuento SÍ se publica —es el libro 4, y es información útil—
    expect(res.report.tokens.providerCachedInput).toBeGreaterThan(0);
    // …pero el descuento es del proveedor, no nuestro: sin la capa se habría
    // aplicado igual. Tarifándolo solo en el lado "actual", esta petición
    // reportaba ahorro sin que la capa hubiera hecho absolutamente nada.
    expect(res.report.cost.netSavingsRatio).toBe(0);
  });
});
