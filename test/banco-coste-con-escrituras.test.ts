import { describe, it, expect } from "vitest";

import {
  MENSAJE_DE_COMPACTACION,
  PRECIO_ILUSTRATIVO,
  costeDeLlamada,
  escriturasDeLlamada,
  leerEscrituras,
  precioYPrima,
  usoCrudo,
} from "../benchmarks/coste.js";
import { CATALOGO } from "../src/pricing/catalogo.js";
import type { ProviderResponse } from "../src/providers/types.js";

/**
 * EL BANCO COBRA LA ESCRITURA DE CACHÉ A SU PRIMA, EN TODOS LOS BRAZOS.
 *
 * Hasta el 2026-09-27 `cost()` cobraba la escritura a 1×. Con eso la ventaja
 * del brazo B2 en GPT-5.6+ (el modo de caché explícito, que no escribe un
 * prefijo que nunca se va a leer) era invisible, y en Anthropic todos los
 * brazos salían más baratos de lo que factura el proveedor.
 */

const PRECIO = { inputPer1k: 0.001, outputPer1k: 0.004, cachedInputPer1k: 0.0001 };

describe("costeDeLlamada: (entrada − leída − escrita)·in + leída·cacheada + escrita·in·prima + salida·out", () => {
  it("sin caché es entrada por salida, como siempre", () => {
    expect(costeDeLlamada(PRECIO, 1.25, { inputTokens: 1000, outputTokens: 100 }, 0)).toBeCloseTo(0.001 + 0.0004, 12);
  });

  it("la escritura se paga a la prima y SALE de la entrada normal (no se cobra dos veces)", () => {
    const c = costeDeLlamada(PRECIO, 1.25, { inputTokens: 1000, outputTokens: 0 }, 800);
    expect(c).toBeCloseTo((200 / 1000) * 0.001 + (800 / 1000) * 0.001 * 1.25, 12);
    // Con prima 1 la escritura cuesta lo mismo que la entrada normal.
    expect(costeDeLlamada(PRECIO, 1, { inputTokens: 1000, outputTokens: 0 }, 800)).toBeCloseTo(0.001, 12);
  });

  it("lectura y escritura a la vez, cada una a su tarifa", () => {
    const c = costeDeLlamada(PRECIO, 1.25, { inputTokens: 5000, outputTokens: 10, cachedInputTokens: 3000 }, 1500);
    expect(c).toBeCloseTo(
      (500 / 1000) * 0.001 + (3000 / 1000) * 0.0001 + (1500 / 1000) * 0.001 * 1.25 + (10 / 1000) * 0.004,
      12,
    );
  });

  it("un contador incoherente nunca produce entrada negativa", () => {
    expect(costeDeLlamada(PRECIO, 1.25, { inputTokens: 100, outputTokens: 0, cachedInputTokens: 90 }, 50)).toBeGreaterThan(0);
    expect(costeDeLlamada(PRECIO, 1.25, { inputTokens: 100, outputTokens: 0 }, -5)).toBeCloseTo(0.0001, 12);
  });
});

describe("usoCrudo lee la respuesta del proveedor tal como llega", () => {
  it("OpenAI Chat Completions: cache_write_tokens y reasoning_tokens", () => {
    const u = usoCrudo({
      usage: {
        prompt_tokens: 3000,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 2048 },
        completion_tokens_details: { reasoning_tokens: 32 },
      },
    });
    expect(u).toEqual({ escrituraCache: 2048, escrituraInformada: true, razonamiento: 32, iteracionesDeCompactacion: false });
  });

  it("Anthropic: cache_creation_input_tokens", () => {
    const u = usoCrudo({ usage: { input_tokens: 40, output_tokens: 7, cache_creation_input_tokens: 7000 } });
    expect(u.escrituraCache).toBe(7000);
    expect(u.escrituraInformada).toBe(true);
  });

  it("sin el campo, la escritura NO está informada (y no se inventa un 0 medido)", () => {
    const u = usoCrudo({ usage: { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0 } } });
    expect(u).toEqual({ escrituraCache: 0, escrituraInformada: false, iteracionesDeCompactacion: false });
    expect(usoCrudo(undefined).escrituraInformada).toBe(false);
    expect(usoCrudo({ usage: { prompt_tokens_details: { cache_write_tokens: "12" } } }).escrituraInformada).toBe(false);
  });

  it("una iteración de compactación se detecta: el uso de arriba ya no es el total", () => {
    const raw = { usage: { input_tokens: 23000, output_tokens: 1000, iterations: [{ type: "compaction" }, { type: "message" }] } };
    expect(usoCrudo(raw).iteracionesDeCompactacion).toBe(true);
  });
});

describe("de dónde sale la escritura de una llamada", () => {
  const resp = (usage: ProviderResponse["usage"], raw: unknown): Pick<ProviderResponse, "usage" | "raw"> => ({ usage, raw });

  it("el adaptador manda; si no la trae, la respuesta cruda; si tampoco, «none»", () => {
    expect(escriturasDeLlamada(resp({ inputTokens: 10, outputTokens: 1, cacheWriteInputTokens: 5 }, {}))).toEqual({
      escrituras: 5, informada: true, fuente: "adapter",
    });
    expect(
      escriturasDeLlamada(resp({ inputTokens: 10, outputTokens: 1 }, { usage: { prompt_tokens_details: { cache_write_tokens: 7 } } })),
    ).toEqual({ escrituras: 7, informada: true, fuente: "raw-usage" });
    expect(escriturasDeLlamada(resp({ inputTokens: 10, outputTokens: 1 }, {}))).toEqual({ escrituras: 0, informada: false, fuente: "none" });
  });

  it("una compactación que ningún brazo pidió PARA la llamada en el sitio que la usa", () => {
    const r = resp({ inputTokens: 10, outputTokens: 1 }, { usage: { iterations: [{ type: "compaction" }] } });
    expect(() => escriturasDeLlamada(r)).toThrow(MENSAJE_DE_COMPACTACION);
    // Dentro de la capa se lee sin lanzar, y la tirada lo comprueba fuera.
    expect(leerEscrituras(r).compactacion).toBe(true);
  });
});

describe("precioYPrima: el catálogo del SDK y nada más", () => {
  it("la fila del propio modelo y su prima", () => {
    const c = precioYPrima("anthropic/claude-sonnet-4-5");
    expect(c.conocido).toBe(true);
    expect(c.precio).toEqual(CATALOGO["claude-sonnet-4-5"]);
    expect(c.prima).toBe(1.25);
    expect(precioYPrima("openai/gpt-4o-mini")).toMatchObject({ conocido: true, prima: 1, clave: "gpt-4o-mini" });
  });

  it("un modelo sin fila es ILUSTRATIVO y lo dice (la fila de gpt-4o-mini, no una cifra tecleada)", () => {
    const c = precioYPrima("acme/modelo-que-no-existe");
    expect(c.conocido).toBe(false);
    expect(c.precio).toBe(PRECIO_ILUSTRATIVO);
    expect(PRECIO_ILUSTRATIVO).toEqual(CATALOGO["gpt-4o-mini"]);
  });

  it("el banco ya no tiene tabla de precios propia", async () => {
    const { readFileSync } = await import("node:fs");
    const fuente = readFileSync(new URL("../benchmarks/ab-live.ts", import.meta.url), "utf8");
    expect(fuente).not.toMatch(/^const PRICES\b/m);
    expect(fuente).not.toMatch(/FALLBACK_PRICE/);
    // Y cada brazo se tarifa con sus escrituras.
    expect(fuente).toMatch(/cost\(model, uA, eA\.escrituras\)/);
    expect(fuente).toMatch(/cost\(model, uA1, eA1\.escrituras\)/);
    expect(fuente).toMatch(/cost\(model, uA2, eA2\.escrituras\)/);
    expect(fuente).toMatch(/cost\(model, uB, escriturasEnEstaRep\)/);
  });
});
