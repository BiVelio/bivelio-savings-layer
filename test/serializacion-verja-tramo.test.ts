import { describe, it, expect } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import type { SavingsRequest, TraceEvent } from "../src/contracts/types.js";

/**
 * La selección de formato (etapa 8) pasa por la MISMA verja de dinero que la
 * compresión (etapa 9).
 *
 * Cambiar JSON por un formato tabular quita tokens SIEMPRE, pero si esa reducción
 * saca el prompt del tramo cacheable del proveedor —y hay un prefijo estable con
 * aciertos— el cliente paga MÁS mientras el libro 3 acredita ahorro. La etapa 8 lo
 * hacía sin mirar ninguna cuenta. Ahora, con un prefijo declarado, respeta
 * `politicaDeCompresion`; sin prefijo (el caso normal) sigue eligiendo el formato
 * más barato.
 */

class ProveedorEspia implements Provider {
  readonly id = "espia";
  ultima: ProviderRequest | null = null;
  async generate(r: ProviderRequest): Promise<ProviderResponse> {
    this.ultima = r;
    return { text: "ok", usage: { inputTokens: 100, outputTokens: 10 } };
  }
  enviado(): string {
    return (this.ultima?.messages ?? []).map((m) => m.content).join("\n");
  }
}

// Payload tabular grande y uniforme: compact-rows gana por mucho, así que la
// diferencia de tokens domina cualquier overhead de ensamblado.
const filas = Array.from({ length: 120 }, (_, i) => ({ id: 1000 + i, nombre: `usuario_${i}`, rol: i % 3 ? "member" : "admin", activo: i % 4 !== 0 }));

const peticion = (extra: Partial<SavingsRequest> = {}): SavingsRequest => ({
  model: "anthropic/claude-sonnet-4",
  messages: [{ role: "user", content: "resume" }],
  structuredData: { users: filas },
  savings: { serialization: true, compression: false, exactCache: false },
  ...extra,
});

const trazaSerial = (trazas: TraceEvent[]): TraceEvent => {
  const t = trazas.find((e) => e.stage === "serialization");
  expect(t, "tiene que haber traza de serialización").toBeDefined();
  return t!;
};

describe("verja de tramo de caché en la serialización", () => {
  it("SIN prefijo declarado, se aplica el formato más barato (caso normal)", async () => {
    const proveedor = new ProveedorEspia();
    const capa = createSavingsLayer({ provider: proveedor });
    const res = await capa.generate(peticion());
    const t = trazaSerial(res.report.traces);
    // El formato elegido no es JSON: se aplicó el ahorro de serialización.
    expect(t.outcome).not.toBe("json-compact");
    expect(res.report.tokens.compressedInput).toBeGreaterThan(0);
  });

  it("CON prefijo caliente, si el formato barato saca el prompt del tramo, se manda JSON y no se acredita", async () => {
    // 1) Medir los tamaños de payload en una corrida de control.
    const control = new ProveedorEspia();
    const capaControl = createSavingsLayer({ provider: control });
    const resControl = await capaControl.generate(peticion());
    const tControl = trazaSerial(resControl.report.traces);
    const jsonTokens = Number(tControl.detail?.jsonTokens);
    const chosenTokens = Number(tControl.detail?.chosenTokens);
    expect(jsonTokens).toBeGreaterThan(chosenTokens); // compact ahorra
    // 2) Elegir un mínimo de tramo ENTRE los dos: JSON queda dentro (cacheable),
    //    compact queda fuera. El payload domina, así que el overhead es ruido.
    const minimo = Math.round((jsonTokens + chosenTokens) / 2);

    const proveedor = new ProveedorEspia();
    const capa = createSavingsLayer({
      provider: proveedor,
      compressionEconomics: {
        cacheTier: { minimumCacheTokens: minimo, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 },
        // Prefijo estable y SIEMPRE caliente: leer a 0,1x hace la versión JSON
        // (cacheable) más barata que la compacta (que rompe el prefijo).
        prefix: { stableTokens: jsonTokens, hitRate: 1 },
      },
    });
    const res = await capa.generate(peticion());
    const t = trazaSerial(res.report.traces);

    // Se protegió la caché: se mandó JSON y no se acreditó ahorro de serialización.
    expect(t.outcome).toBe("json-compact");
    expect(res.report.tokens.compressedInput).toBe(0);
    // El payload que viajó es JSON, no la tabla compacta.
    expect(proveedor.enviado()).toContain('"nombre"');
  });
});
