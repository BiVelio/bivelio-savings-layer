import { describe, it, expect } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import type { SavingsRequest } from "../src/contracts/types.js";

/**
 * El fail-open existe para que un fallo INTERNO del optimizador no tumbe la
 * petición del cliente. Se le habían colado dos casos que no son eso:
 *
 *  1. Un fallo DEL PROVEEDOR provocaba otra llamada completa contra el mismo
 *     proveedor que acababa de fallar. El docstring decía «a genuine provider
 *     error propagates» desde el principio; el código no lo hacía.
 *  2. Cualquier excepción posterior a una llamada YA FACTURADA provocaba otra
 *     llamada, y `failOpenDirect` construye un ledger nuevo desde cero, así que
 *     las anteriores desaparecían del informe: 3 llamadas facturadas publicadas
 *     como `actualLlm: 1`, `retries: 0` y el coste de un solo intento.
 *
 * `test/fail-open.test.ts` se titula «a genuine provider failure still
 * propagates» y pasaba en verde mientras el proveedor se invocaba dos veces:
 * nunca contaba invocaciones. Estos tests cuentan.
 */

const peticion = (): SavingsRequest => ({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "una pregunta cualquiera" }],
  savings: { exactCache: false },
});

describe("el fail-open no puede volver a cobrar", () => {
  it("un fallo del proveedor se propaga y NO dispara una segunda llamada", async () => {
    class SiempreFalla implements Provider {
      readonly id = "falla";
      llamadas = 0;
      async generate(_r: ProviderRequest): Promise<ProviderResponse> {
        this.llamadas += 1;
        throw new Error("provider 429: rate limited");
      }
    }
    const proveedor = new SiempreFalla();
    const capa = createSavingsLayer({
      provider: proveedor,
      costModels: { "openai/gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 } },
    });

    await expect(capa.generate(peticion())).rejects.toThrow(/429/);
    // ESTE es el defecto: antes eran 2. El fail-open reintentaba contra el mismo
    // proveedor que acababa de fallar — no arregla nada y duplica el gasto.
    expect(proveedor.llamadas).toBe(1);
  });

  it("el escenario de la auditoría: primaria OK, reparación 429 → NO hay tercera llamada", async () => {
    // Es el caso exacto que reprodujo la auditoría con TRES llamadas facturadas y
    // un informe que decía `actualLlm: 1`, `retries: 0` y el coste de una sola.
    class PrimariaOkReparacionCae implements Provider {
      readonly id = "primaria-ok-reparacion-cae";
      llamadas = 0;
      async generate(_r: ProviderRequest): Promise<ProviderResponse> {
        this.llamadas += 1;
        if (this.llamadas === 1) {
          // Responde y FACTURA, pero no cumple el contrato → dispara reparación.
          return { text: "{esto no es json", usage: { inputTokens: 900, outputTokens: 180 } };
        }
        throw new Error("provider 429: rate limited");
      }
    }
    const proveedor = new PrimariaOkReparacionCae();
    const capa = createSavingsLayer({
      provider: proveedor,
      costModels: { "openai/gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 } },
    });

    await expect(
      capa.generate({
        ...peticion(),
        response: {
          contractId: "c1",
          version: "v1",
          schema: {
            type: "object",
            properties: { answer: { type: "string" } },
            required: ["answer"],
          },
        },
      }),
    ).rejects.toThrow(/429/);

    // Antes: 3. La primaria ya estaba facturada, así que el fail-open no puede
    // rescatar nada — solo encarecer y además borrar las dos anteriores del informe.
    expect(proveedor.llamadas).toBe(2);
  });

  it("un fallo interno ANTES de gastar nada sí se rescata con una llamada directa", async () => {
    class Normal implements Provider {
      readonly id = "normal";
      llamadas = 0;
      async generate(_r: ProviderRequest): Promise<ProviderResponse> {
        this.llamadas += 1;
        return { text: "ok", usage: { inputTokens: 100, outputTokens: 10 } };
      }
    }
    const proveedor = new Normal();
    const capa = createSavingsLayer({
      provider: proveedor,
      costModels: { "openai/gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 } },
      // Un componente del camino optimizado que revienta antes de llamar a nadie.
      exactCache: {
        get() {
          throw new Error("backend de cache caido");
        },
        set: async () => {},
      } as never,
    });

    const res = await capa.generate(peticion());
    expect(res.text).toBe("ok");
    // El rescate es legítimo: no se había gastado nada todavía.
    expect(proveedor.llamadas).toBe(1);
  });
});
