import { describe, it, expect } from "vitest";

import { createSavingsLayer, OpenAICompatibleProvider } from "../src/index.js";
import type { SavingsLayerConfig, SavingsResult } from "../src/index.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import { CATALOGO, PRECIOS_AL_DIA, claveDeCatalogo, precioDeLista, precioDeListaPropio } from "../src/pricing/catalogo.js";
import { primaDeEscritura, primaDeEscritura1h } from "../src/pricing/primas.js";
import { salidaNoRepetible } from "../src/pricing/razonamiento.js";
import { tarifaDeTier, tarifaEstandar } from "../src/pricing/tarifas-de-tier.js";
import { tramoAnthropicDelModelo } from "../src/economics/cache-tier.js";
import { rechazaMuestreo, rechazaToolChoiceForzado } from "../src/providers/anthropic-compat.js";

/**
 * N5 (auditoría del 2026-11-19) · LAS DOS FILAS QUE FALTABAN: claude-fable-5-2 Y
 * gemini-2.5-flash-lite.
 *
 * Sin fila, su tráfico se tarifaba con el precio ilustrativo y salía
 * `estimated`, y su repetición desde caché nunca podía ser `reference`. El dueño
 * decidió añadirlas. Las cifras, USD por 1M, leídas el 2026-11-19 en las páginas
 * OFICIALES (y aquí divididas entre mil, la unidad de CostModel):
 *
 *   · Claude Fable 5.2 — https://platform.claude.com/docs/en/about-claude/pricing
 *     entrada $8 · escritura 5 min $10 · escritura 1 h $16 · lectura $0.20 ·
 *     salida $40. Lote: $4 / $20.
 *   · Gemini 2.5 Flash-Lite — https://ai.google.dev/gemini-api/docs/pricing
 *     («Standard», «Paid Tier», texto): entrada $0.10 · salida $0.40 · caché
 *     $0.01. Flex: $0.05 / $0.20 / $0.01.
 *
 * Servidor simulado; textos inventados. Cada bloque falla en origin/main
 * (85e5ec2c), donde ninguno de los dos ids tiene fila.
 */

const FABLE = "claude-fable-5-2";
const LITE = "gemini-2.5-flash-lite";
const AL_DIA = Date.parse(`${PRECIOS_AL_DIA}T12:00:00Z`);

/** Lo que publica cada página, USD por 1K. */
const OFICIAL = {
  [FABLE]: { inputPer1k: 0.008, outputPer1k: 0.04, cachedInputPer1k: 0.0002 },
  [LITE]: { inputPer1k: 0.0001, outputPer1k: 0.0004, cachedInputPer1k: 0.00001 },
} as const;

const ENTRADA = 1200;
const SALIDA = 90;
const PREGUNTA = [{ role: "user" as const, content: "Resume en una línea qué es una clave primaria." }];

function capa(config: Partial<SavingsLayerConfig> = {}) {
  const estado = { llamadas: 0 };
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
    estado.llamadas += 1;
    const cuerpo = JSON.parse(String(init?.body)) as { model: string };
    return new Response(
      JSON.stringify({
        model: cuerpo.model,
        choices: [{ index: 0, message: { role: "assistant", content: "La columna que identifica cada fila sin repetirse." }, finish_reason: "stop" }],
        usage: { prompt_tokens: ENTRADA, completion_tokens: SALIDA, total_tokens: ENTRADA + SALIDA },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  const layer = createSavingsLayer({
    provider: new OpenAICompatibleProvider({ baseUrl: "https://pasarela.test/v1", apiKey: "k-inventada", fetchImpl }),
    silenceWarnings: true,
    ...config,
  });
  return { layer, estado };
}

const trazaDePrecio = (r: SavingsResult<unknown>) => r.report.traces.find((t) => t.stage === "price");

/**
 * Para la repetición, un proveedor de contador fijo y origen SIN atestiguar (como
 * el `ProveedorFijo` de medido-por-referencia.test.ts): una pasarela atestiguada
 * como no oficial no deja registro por referencia (E0-bis), así que la capa de
 * arriba no sirve para probar `reference`. Declara 0 tokens de razonamiento.
 */
class ProveedorFijo implements Provider {
  readonly id = "fijo";
  llamadas = 0;
  async generate(_r: ProviderRequest): Promise<ProviderResponse> {
    this.llamadas += 1;
    return {
      text: "La columna que identifica cada fila sin repetirse.",
      usage: { inputTokens: ENTRADA, outputTokens: SALIDA, reasoningTokens: 0 },
    };
  }
}

describe("N5 · las filas nuevas son las de la página oficial", () => {
  it.each([FABLE, LITE] as const)("%s: fila propia con las cifras publicadas, con y sin prefijo de proveedor", (id) => {
    expect(CATALOGO[id]).toEqual(OFICIAL[id]);
    const vendor = id === FABLE ? "anthropic" : "google";
    for (const m of [id, `${vendor}/${id}`, `openrouter/${vendor}/${id}`]) {
      expect(claveDeCatalogo(m), m).toBe(id);
      expect(precioDeLista(m, AL_DIA), m).toBe(CATALOGO[id]);
      expect(precioDeListaPropio(m, AL_DIA), m).toBe(CATALOGO[id]);
    }
  });

  it("una instantánea FECHADA de Fable 5 sigue siendo Fable 5, aunque empiece por «claude-fable-5-2»", () => {
    // `claude-fable-5-20260401` empieza, carácter a carácter, por la clave
    // nueva. Con el corte por separador como final se quedaba sin precio; es
    // prefijo por piezas lo que cuenta (corte 4-bis de buscarPorModelo).
    for (const id of ["claude-fable-5-20260401", "anthropic/claude-fable-5-20260401", "claude-fable-5-2026-04-01"]) {
      expect(claveDeCatalogo(id), id).toBe("claude-fable-5");
      expect(precioDeListaPropio(id, AL_DIA), id).toBe(CATALOGO["claude-fable-5"]);
    }
    // Y la de Fable 5.2, si un día la hay, es Fable 5.2.
    expect(claveDeCatalogo("claude-fable-5-2-20270101")).toBe(FABLE);
    expect(precioDeListaPropio("claude-fable-5-2-20270101", AL_DIA)).toBe(CATALOGO[FABLE]);
    // Lo que no es ni fecha ni pieza entera sigue sin precio.
    expect(precioDeLista("claude-fable-5-2x")).toBeUndefined();
    expect(precioDeLista("claude-fable-5-21")).toBeUndefined();
  });

  it("Fable 5.2 no es la fila de Fable 5 ni la de 5.1, y Flash-Lite no es la de Flash", () => {
    expect(CATALOGO[FABLE]).not.toEqual(CATALOGO["claude-fable-5"]);
    expect(CATALOGO[FABLE]).not.toEqual(CATALOGO["claude-fable-5-1"]);
    expect(CATALOGO[LITE]).not.toEqual(CATALOGO["gemini-2.5-flash"]);
    // Y las versiones vecinas que NO tienen fila siguen sin heredar la nueva.
    expect(precioDeLista("claude-fable-5-3")).toBeUndefined();
    expect(precioDeLista("claude-mythos-5-2")).toBeUndefined();
    expect(precioDeLista("gemini-2.5-flash-lite-tts")).toBeUndefined();
  });

  it("escrituras de caché: Fable 5.2 a $10 (5 min) y $16 (1 h); Gemini sin prima", () => {
    expect(CATALOGO[FABLE]!.inputPer1k * primaDeEscritura(FABLE)).toBeCloseTo(0.01, 12);
    expect(CATALOGO[FABLE]!.inputPer1k * primaDeEscritura1h(FABLE)).toBeCloseTo(0.016, 12);
    expect(tarifaEstandar(`anthropic/${FABLE}`)?.cacheWritePer1k).toBeCloseTo(0.01, 12);
    expect(primaDeEscritura(LITE)).toBe(1);
    expect(tarifaEstandar(`google/${LITE}`)?.cacheWritePer1k).toBeCloseTo(0.0001, 12);
  });

  it("tiers: el lote de Fable 5.2 es la mitad exacta; el Flex de Flash-Lite no descuenta la caché", () => {
    const lote = tarifaDeTier("anthropic", "batch", FABLE);
    expect(lote).toMatchObject({ inputPer1k: 0.004, outputPer1k: 0.02, cachedInputPer1k: 0.0001, cacheWritePer1k: 0.005 });
    expect(lote?.fuente).toBe("https://platform.claude.com/docs/en/about-claude/pricing");
    expect(lote?.consultado).toBe("2026-11-19");
    const flex = tarifaDeTier("google", "flex", `google/${LITE}`);
    expect(flex).toMatchObject({ inputPer1k: 0.00005, outputPer1k: 0.0002, cachedInputPer1k: 0.00001 });
    expect(flex?.cachedInputPer1k).toBe(CATALOGO[LITE]!.cachedInputPer1k);
    expect(flex?.fuente).toBe("https://ai.google.dev/gemini-api/docs/pricing");
    expect(flex?.consultado).toBe("2026-11-19");
  });

  it("lo que acompaña a una fila de Anthropic: razona, mínimo cacheable 512, sin tool_choice forzado ni muestreo", () => {
    expect(salidaNoRepetible(FABLE)).toBe("reasoning-model");
    expect(salidaNoRepetible(LITE)).toBe("reasoning-model");
    expect(tramoAnthropicDelModelo(FABLE).minimumCacheTokens).toBe(512);
    expect(rechazaToolChoiceForzado(FABLE)).toBe(true);
    expect(rechazaToolChoiceForzado(`anthropic/${FABLE}`)).toBe(true);
    expect(rechazaMuestreo(FABLE)).toBe(true);
  });
});

describe("N5 · una petición a cada modelo se valora con su precio, y ya no sale «estimated»", () => {
  const casos = [
    [FABLE, FABLE],
    [`anthropic/${FABLE}`, FABLE],
    [LITE, LITE],
    [`google/${LITE}`, LITE],
  ] as const;

  it.each(casos)("«%s»: measured, al precio de la página y sin traza de precio ilustrativo", async (model, clave) => {
    const { layer } = capa();
    const r = await layer.generate({ model, messages: PREGUNTA });
    expect(r.report.cache.result).toBe("miss");
    expect(r.report.cost.basis).toBe("measured");
    expect(trazaDePrecio(r)).toBeUndefined();
    const p = OFICIAL[clave];
    expect(r.report.cost.actual).toBeCloseTo((ENTRADA * p.inputPer1k + SALIDA * p.outputPer1k) / 1000, 9);
  });

  it.each(casos)("«%s»: su repetición idéntica desde caché sale «reference», con la entrada a la lectura de caché", async (model, clave) => {
    const proveedor = new ProveedorFijo();
    const layer = createSavingsLayer({ provider: proveedor, devUnlicensed: true, exactTokenizer: false, silenceWarnings: true });
    const peticion = { model, messages: PREGUNTA, temperature: 0 };
    await layer.generate(peticion);
    const repetida = await layer.generate(peticion);
    expect(proveedor.llamadas).toBe(1);
    expect(repetida.report.cache.result).toBe("exact");
    expect(repetida.report.cost.basis).toBe("reference");
    expect(repetida.report.cache.referenceRejected).toBeUndefined();
    expect(repetida.report.cache.reference?.cachedInputPer1k).toBe(OFICIAL[clave].cachedInputPer1k);
    // Los dos razonan (o pueden razonar sin que la capa lo vea): la salida no se acredita.
    expect(repetida.report.cache.reference?.creditedOutputTokens).toBe(0);
    expect(repetida.report.cost.baselineEstimate).toBeCloseTo((ENTRADA * OFICIAL[clave].cachedInputPer1k) / 1000, 10);
  });
});
