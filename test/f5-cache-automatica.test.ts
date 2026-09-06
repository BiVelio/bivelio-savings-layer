import { describe, expect, it } from "vitest";

import { ANTHROPIC_CACHE_TIER, tramoAnthropicDelModelo } from "../src/economics/cache-tier.js";
import { tramoDeCache } from "../src/economics/politica-compresion.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import type { ProviderRequest } from "../src/providers/types.js";

/**
 * F5 · la caché del proveedor con los datos OFICIALES del 2026-09-06:
 * mínimos cacheables POR MODELO (dejan de ser el supuesto de 1024) y el punto
 * de ruptura AUTOMÁTICO a nivel de petición (opt-in del adaptador).
 */

describe("mínimos cacheables por modelo de Anthropic (página oficial, 2026-09-06)", () => {
  it("la generación 5 de Fable/Mythos/Opus cachea desde 512", () => {
    for (const m of ["claude-fable-5", "claude-mythos-5", "claude-opus-5", "claude-fable-5-1", "claude-mythos-5-1"]) {
      expect(tramoAnthropicDelModelo(m).minimumCacheTokens, m).toBe(512);
    }
  });

  it("⛔ los mínimos ALTOS también son reales: haiku-4-5 y opus-4-5/4-6 exigen 4096", () => {
    // Con el supuesto viejo de 1024, un prompt de 2000 en haiku-4-5 se creía
    // cacheable y la capa protegía una caché que NO existe (renunciaba a
    // compresiones rentables). El dato oficial cierra ese error también.
    for (const m of ["claude-haiku-4-5", "claude-opus-4-5", "claude-opus-4-6"]) {
      expect(tramoAnthropicDelModelo(m).minimumCacheTokens, m).toBe(4096);
    }
    expect(tramoAnthropicDelModelo("claude-opus-4-7").minimumCacheTokens).toBe(2048);
    expect(tramoAnthropicDelModelo("claude-3-5-haiku").minimumCacheTokens).toBe(2048);
  });

  it("sin cifra publicada se conserva el 1024 conservador", () => {
    for (const m of ["claude-sonnet-5", "claude-sonnet-4-5", "claude-opus-4-8", "claude-desconocido"]) {
      expect(tramoAnthropicDelModelo(m).minimumCacheTokens, m).toBe(1024);
    }
    expect(ANTHROPIC_CACHE_TIER.minimumCacheTokens).toBe(1024);
  });

  it("una instantánea FECHADA hereda de su modelo; la versión menor NO cae en la mayor", () => {
    // La misma trampa de herencia que el catálogo de precios: fable-5-1 no es
    // fable-5 (aquí da igual, ambos 512, pero haiku-4-5-20251001 vs un
    // hipotético haiku-4-51 no daría igual).
    expect(tramoAnthropicDelModelo("claude-haiku-4-5-20251001").minimumCacheTokens).toBe(4096);
    expect(tramoAnthropicDelModelo("claude-opus-5-20260301").minimumCacheTokens).toBe(512);
    expect(tramoAnthropicDelModelo("claude-haiku-4-51").minimumCacheTokens).toBe(1024);
  });

  it("tramoDeCache resuelve por modelo, y la declaración del cliente sigue mandando", () => {
    expect(tramoDeCache("anthropic/claude-fable-5").minimumCacheTokens).toBe(512);
    expect(tramoDeCache("claude-haiku-4-5").minimumCacheTokens).toBe(4096);
    const propio = { minimumCacheTokens: 7777, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 };
    expect(tramoDeCache("claude-fable-5", { cacheTier: propio }).minimumCacheTokens).toBe(7777);
  });
});

describe("punto de ruptura AUTOMÁTICO (cache_control a nivel de petición)", () => {
  function fetchEspia(capturas: Record<string, unknown>[]): typeof fetch {
    return (async (_url: unknown, init: { body: string }) => {
      capturas.push(JSON.parse(init.body) as Record<string, unknown>);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 100, output_tokens: 10 },
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  const peticion = (sobre?: Partial<ProviderRequest>): ProviderRequest =>
    ({
      model: "claude-sonnet-4-5",
      messages: [
        { role: "system", content: "política estable ".repeat(50) },
        { role: "user", content: "turno viejo" },
        { role: "assistant", content: "respuesta vieja" },
        { role: "user", content: "pregunta de hoy" },
      ],
      stablePrefixMessages: 3,
      ...sobre,
    }) as ProviderRequest;

  it("encendida y con prefijo marcado → viaja el cache_control top-level ADEMÁS de los explícitos", async () => {
    const capturas: Record<string, unknown>[] = [];
    const p = new AnthropicProvider({ fetchImpl: fetchEspia(capturas), automaticCache: true });
    await p.generate(peticion());
    expect(capturas[0]!["cache_control"]).toEqual({ type: "ephemeral" });
    // Los dos puntos explícitos de siempre siguen ahí: el automático SUMA.
    const system = capturas[0]!["system"] as { cache_control?: unknown }[];
    expect(system.some((b) => b.cache_control != null)).toBe(true);
  });

  it("⛔ apagada por defecto: el cuerpo no cambia para nadie sin opt-in", async () => {
    const capturas: Record<string, unknown>[] = [];
    const p = new AnthropicProvider({ fetchImpl: fetchEspia(capturas) });
    await p.generate(peticion());
    expect(capturas[0]!["cache_control"]).toBeUndefined();
  });

  it("⛔ si la verja económica NO marcó, el automático tampoco dispara", async () => {
    // stablePrefixMessages ausente = el pipeline decidió que marcar pierde
    // dinero (h < 21,7%). El punto móvil pagaría la misma prima perdedora.
    const capturas: Record<string, unknown>[] = [];
    const p = new AnthropicProvider({ fetchImpl: fetchEspia(capturas), automaticCache: true });
    await p.generate(peticion({ stablePrefixMessages: undefined }));
    expect(capturas[0]!["cache_control"]).toBeUndefined();
  });

  it("⛔ respeta el presupuesto de puntos: con el tope ya gastado en explícitos, no se añade", async () => {
    // Pisar el tope de 4 de la API es un 400; y quien bajó el tope a 2 dejó
    // sitio CERO para el automático (los 2 explícitos lo consumen).
    const capturas: Record<string, unknown>[] = [];
    const p = new AnthropicProvider({ fetchImpl: fetchEspia(capturas), automaticCache: true, maxCacheBreakpoints: 2 });
    await p.generate(peticion());
    expect(capturas[0]!["cache_control"]).toBeUndefined();
    const conSitio: Record<string, unknown>[] = [];
    const q = new AnthropicProvider({ fetchImpl: fetchEspia(conSitio), automaticCache: true, maxCacheBreakpoints: 3 });
    await q.generate(peticion());
    expect(conSitio[0]!["cache_control"]).toEqual({ type: "ephemeral" });
  });
});
