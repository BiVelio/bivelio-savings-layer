import { beforeEach, describe, expect, it } from "vitest";

import { AnthropicProvider } from "../src/providers/anthropic.js";
import { usoDeMensajes } from "../src/providers/anthropic-uso.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { createSavingsLayer } from "../src/pipeline/create.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";
import type { ProviderRequest } from "../src/providers/types.js";
import type { SavingsRequest, SavingsResult } from "../src/contracts/types.js";
import { CacheAnthropicSimulada, dolares } from "../benchmarks/colocador-de-cache/simulador.js";
import { agente, capaSobre, chatLento, ragDeUnSoloUso, reloj } from "../benchmarks/colocador-de-cache/escenarios.js";

/**
 * EL COLOCADOR (`cacheBreakpoints: "auto"`) DE PUNTA A PUNTA: el pipeline de
 * verdad, el adaptador de Anthropic de verdad, y un `fetch` que factura con las
 * reglas oficiales de la caché de prefijo (ver benchmarks/colocador-de-cache/simulador.ts).
 *
 * Tres cosas se fijan aquí y las tres son dinero:
 *  1. Con la colocación fija (el defecto) el cable no cambia ni un byte.
 *  2. Con el colocador la factura simulada baja donde el tráfico reutiliza, y
 *     NO sube donde no reutiliza.
 *  3. `cost.actual` cuadra al céntimo con la factura del simulador, incluidas
 *     las escrituras de 1 h a 2×: la prima que provoca la capa se carga entera.
 */

const PRECIO_SONNET_4_5 = { inputPer1k: 0.003, outputPer1k: 0.015, cachedInputPer1k: 0.0003 };

beforeEach(() => reiniciarAvisos());

/** Envuelve `generate` para sumar `cost.actual` y guardar los informes. */
function contable(layer: ReturnType<typeof createSavingsLayer>) {
  const informes: SavingsResult<unknown>["report"][] = [];
  const orig = layer.generate.bind(layer);
  (layer as { generate: typeof layer.generate }).generate = (async (req: SavingsRequest) => {
    const r = await orig(req);
    informes.push(r.report);
    return r;
  }) as typeof layer.generate;
  return {
    informes,
    actual: () => informes.reduce((a, r) => a + r.cost.actual, 0),
    trazas: (etapa: string) => informes.flatMap((r) => r.traces.filter((t) => t.stage === etapa)),
  };
}

async function correr(
  modo: "fixed" | "auto" | "cola-siempre",
  escenario: (l: ReturnType<typeof createSavingsLayer>, r: ReturnType<typeof reloj>) => Promise<void>,
  preparar?: (sim: CacheAnthropicSimulada) => void,
) {
  const r = reloj();
  const sim = new CacheAnthropicSimulada(r.ahora);
  preparar?.(sim);
  const layer = capaSobre(sim, r, modo);
  const c = contable(layer);
  await escenario(layer, r);
  return { sim, ...c, factura: dolares(sim.total(), PRECIO_SONNET_4_5) };
}

const AGENTE = (l: ReturnType<typeof createSavingsLayer>, r: ReturnType<typeof reloj>) =>
  agente(l, r, { runs: 6, pasos: 12, huecoMs: 4000, entreRuns: 30_000 });
const RAG = (l: ReturnType<typeof createSavingsLayer>, r: ReturnType<typeof reloj>) =>
  ragDeUnSoloUso(l, r, { n: 80, huecoMs: 10_000 });
const CHAT_LENTO = (l: ReturnType<typeof createSavingsLayer>, r: ReturnType<typeof reloj>) =>
  chatLento(l, r, { conversaciones: 10, turnos: 6, huecoMs: 8 * 60_000 });

describe("colocación fija (el defecto): el cable no cambia", () => {
  it("sin `cacheBreakpoints` no viaja ni un `ttl` ni un punto en la cola", async () => {
    const { sim, trazas } = await correr("fixed", AGENTE);
    for (const cuerpo of sim.cuerpos) expect(JSON.stringify(cuerpo)).not.toContain('"ttl"');
    expect(sim.facturas.every((f) => f.puntos.every((p) => p.bloque < f.totalBloques - 1))).toBe(true);
    expect(trazas("prefix-cache-placement")).toHaveLength(0);
  });

  it("con `auto` y sin muestras, la primera petición sale IDÉNTICA a la fija", async () => {
    const fija = await correr("fixed", (l, r) => agente(l, r, { runs: 1, pasos: 1, huecoMs: 1, entreRuns: 0 }));
    const auto = await correr("auto", (l, r) => agente(l, r, { runs: 1, pasos: 1, huecoMs: 1, entreRuns: 0 }));
    expect(auto.sim.cuerpos[0]).toEqual(fija.sim.cuerpos[0]);
  });
});

describe("bucle de agente: la cola es donde vive el dinero", () => {
  it("la colocación fija solo cachea la cabecera: cada paso repaga todos los resultados de herramienta", async () => {
    // Los resultados llegan con rol `tool` y la frontera estable acaba en la
    // última pregunta del USUARIO, que en un bucle de agente es la tarea del
    // principio. La colocación fija no puede cachear nada de lo que el agente
    // acumula. Es el hueco que el colocador cierra.
    const { sim } = await correr("fixed", AGENTE);
    const t = sim.total();
    expect(t.input).toBeGreaterThan(3 * t.read);
  });

  it("auto marca la cola en cuanto la medición es concluyente, y la factura cae a menos del 40 %", async () => {
    const fija = await correr("fixed", AGENTE);
    const auto = await correr("auto", AGENTE);
    expect(auto.factura).toBeLessThan(0.4 * fija.factura);
    // Concluyente con 5 de 5 (Wilson): la cola se enciende en la primera tarea.
    const primeraConCola = auto.sim.facturas.findIndex((f) => f.puntos.some((p) => p.bloque === f.totalBloques - 1 && p.bloque > 0));
    expect(primeraConCola).toBeGreaterThan(0);
    expect(primeraConCola).toBeLessThan(12);
    const razones = auto.trazas("prefix-cache-placement").map((t) => String(t.detail?.["reason"] ?? ""));
    expect(razones.some((r) => /tail marked/.test(r))).toBe(true);
  });

  it("⛔ `cost.actual` cuadra con la factura del simulador (la prima de la capa se carga entera)", async () => {
    for (const modo of ["fixed", "auto"] as const) {
      const { actual, factura } = await correr(modo, AGENTE);
      expect(actual()).toBeCloseTo(factura, 6);
    }
  });

  it("el contador del proveedor confirma cada lectura que el espejo predijo", async () => {
    const { trazas } = await correr("auto", AGENTE);
    const verificadas = trazas("prefix-cache-placement").filter((t) => t.outcome === "verified");
    expect(verificadas.length).toBeGreaterThan(20);
    expect(verificadas.every((t) => t.detail?.["confirmed"] === true)).toBe(true);
  });
});

describe("RAG de un solo uso: no pagar prima sobre lo que nadie relee", () => {
  it("auto baja el punto a la cabecera cuando es concluyente que el historial no se reenvía, y nunca escribe más que la fija", async () => {
    const fija = await correr("fixed", RAG);
    const auto = await correr("auto", RAG);
    const escrito = (s: CacheAnthropicSimulada) => s.total().write5m + s.total().write1h;
    expect(escrito(auto.sim)).toBeLessThan(0.7 * escrito(fija.sim));
    expect(auto.factura).toBeLessThan(fija.factura);
    // Las últimas peticiones llevan UN solo punto: el de la cabecera.
    expect(auto.sim.facturas.at(-1)!.puntos).toHaveLength(1);
    const razones = auto.trazas("prefix-cache-placement").map((t) => String(t.detail?.["reason"] ?? ""));
    expect(razones.some((r) => /moved back to the system header/.test(r))).toBe(true);
  });

  it("⛔ el punto en la cola SIEMPRE (lo que hacen los gateways con `caching: auto`) no ahorra nada aquí", async () => {
    const fija = await correr("fixed", RAG);
    const siempre = await correr("cola-siempre", RAG);
    expect(siempre.factura).toBeGreaterThanOrEqual(fija.factura);
  });
});

describe("chat a ritmo humano (8 min entre turnos): la hora", () => {
  it("auto pasa a 1 h, la factura baja más de un 40 %, y `cost.actual` carga la hora a 2×", async () => {
    const fija = await correr("fixed", CHAT_LENTO);
    const auto = await correr("auto", CHAT_LENTO);
    expect(auto.sim.total().write1h).toBeGreaterThan(0);
    expect(auto.factura).toBeLessThan(0.6 * fija.factura);
    expect(auto.actual()).toBeCloseTo(auto.factura, 6);
    expect(auto.sim.cuerpos.some((c) => JSON.stringify(c).includes('"ttl":"1h"'))).toBe(true);
  });

  it("⛔ con la fija, la verja no llega a medir en una conversación: cada turno estrena huella", async () => {
    // La verja aprende por huella del prefijo estable, que crece en cada turno.
    // Ninguna se ve dos veces, así que todas se quedan en «exploring (0/8)» y
    // se marca siempre, pierda o no. Con el colocador la llave es la clase.
    const fija = await correr("fixed", CHAT_LENTO);
    const razones = fija.trazas("prefix-cache").map((t) => String(t.detail?.["reason"] ?? ""));
    // 10 conversaciones × 6 turnos: los 50 turnos con historial estrenan huella.
    expect(razones.filter((r) => /exploring the prefix cache \(0\/8\)/.test(r)).length).toBeGreaterThanOrEqual(50);
    // Solo la cabecera sola (el primer turno de cada conversación) llega a medirse.
    expect(razones.filter((r) => /measured hit rate/.test(r)).length).toBeLessThanOrEqual(10);
  });

  it("⛔ con 5 min, la fija escribe cada turno y no lee nunca: el hueco que la hora cierra", async () => {
    const fija = await correr("fixed", CHAT_LENTO);
    expect(fija.sim.total().read).toBe(0);
  });
});

describe("⛔ el contador del proveedor manda sobre el espejo", () => {
  const conCola = (f: { puntos: { bloque: number }[]; totalBloques: number }) =>
    f.totalBloques > 2 && f.puntos.some((p) => p.bloque === f.totalBloques - 1);

  it("si el proveedor lee la cabecera pero nunca la cola que el espejo predijo, esa clase vuelve a la colocación fija", async () => {
    // La verja de aciertos no lo vería: la cabecera se lee y la tasa global
    // supera el equilibrio. Lo ve la comprobación de la predicción: lo leído
    // ahora contra lo que el proveedor dijo haber cacheado en el turno anterior.
    // Resultados cortos: la cabecera domina lo leído y la tasa de aciertos
    // global se queda por encima del equilibrio, así que la verja no se apaga.
    const { sim, trazas } = await correr(
      "auto",
      (l, r) => agente(l, r, { runs: 6, pasos: 12, huecoMs: 4000, entreRuns: 30_000, resultadoChars: 200 }),
      (s) => {
        s.leerSoloHastaBloque = 1;
      },
    );
    expect(trazas("prefix-cache").some((t) => /marking OFF/.test(String(t.detail?.["reason"] ?? "")))).toBe(false);
    const verificadas = trazas("prefix-cache-placement").filter((t) => t.outcome === "verified");
    expect(verificadas.some((t) => t.detail?.["confirmed"] === false)).toBe(true);
    expect(verificadas.some((t) => /goes back to the fixed placement/.test(String(t.detail?.["reason"] ?? "")))).toBe(true);
    expect(sim.facturas.slice(-24).some(conCola)).toBe(false);
  });

  it("si el proveedor no lee nada, la verja de aciertos apaga la marca antes que nada", async () => {
    const { sim, trazas } = await correr("auto", AGENTE, (s) => {
      s.sinLecturas = true;
    });
    expect(trazas("prefix-cache").some((t) => /marking OFF/.test(String(t.detail?.["reason"] ?? "")))).toBe(true);
    expect(sim.facturas.slice(-24).some(conCola)).toBe(false);
  });
});

describe("adaptador de Anthropic: la colocación en el cable", () => {
  function espia(capturas: Record<string, unknown>[]): typeof fetch {
    return (async (_u: unknown, init: { body: string }) => {
      capturas.push(JSON.parse(init.body) as Record<string, unknown>);
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 1 } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
  }
  const req = (sobre: Partial<ProviderRequest> = {}): ProviderRequest => ({
    model: "claude-sonnet-4-5",
    messages: [
      { role: "system", content: "política ".repeat(300) },
      { role: "user", content: "turno viejo" },
      { role: "assistant", content: "respuesta vieja" },
      { role: "user", content: "pregunta de hoy" },
    ],
    stablePrefixMessages: 3,
    ...sobre,
  });

  it("cola + 1 h: tres puntos, todos con `ttl: 1h` (uno por petición: no hay orden que romper)", async () => {
    const c: Record<string, unknown>[] = [];
    await new AnthropicProvider({ fetchImpl: espia(c) }).generate(req({ cachePlacement: { tail: true, ttl: "1h" } }));
    const cuerpo = JSON.stringify(c[0]);
    expect(cuerpo.match(/"cache_control"/g)).toHaveLength(3);
    expect(cuerpo.match(/"ttl":"1h"/g)).toHaveLength(3);
    const mensajes = c[0]!["messages"] as { content: { cache_control?: unknown }[] }[];
    expect(mensajes.at(-1)!.content.at(-1)!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("con el colocador, `automaticCache` no añade el punto de petición (un TTL distinto en el último bloque es un 400)", async () => {
    const c: Record<string, unknown>[] = [];
    await new AnthropicProvider({ fetchImpl: espia(c), automaticCache: true }).generate(
      req({ cachePlacement: { tail: true, ttl: "1h" } }),
    );
    expect(c[0]!["cache_control"]).toBeUndefined();
  });

  it("con presupuesto de 2 puntos: cabecera y COLA (con la cola, el del historial es el prescindible)", async () => {
    const c: Record<string, unknown>[] = [];
    await new AnthropicProvider({ fetchImpl: espia(c), maxCacheBreakpoints: 2 }).generate(
      req({ cachePlacement: { tail: true, ttl: "5m" } }),
    );
    const mensajes = c[0]!["messages"] as { content: { cache_control?: unknown }[] }[];
    expect(mensajes.at(-1)!.content.at(-1)!.cache_control).toEqual({ type: "ephemeral" });
    expect(mensajes[1]!.content[0]!.cache_control).toBeUndefined();
  });

  it("sin `cachePlacement` el cuerpo es el de siempre, sin `ttl`", async () => {
    const c: Record<string, unknown>[] = [];
    await new AnthropicProvider({ fetchImpl: espia(c) }).generate(req());
    expect(JSON.stringify(c[0])).not.toContain('"ttl"');
    expect(JSON.stringify(c[0]).match(/"cache_control"/g)).toHaveLength(2);
  });
});

describe("el contador de 1 h", () => {
  it("`ephemeral_1h_input_tokens` se publica aparte y nunca por encima del total", () => {
    const { usage } = usoDeMensajes(
      { input_tokens: 10, cache_creation_input_tokens: 300, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 } },
      5,
      false,
    );
    expect(usage.cacheWriteInputTokens).toBe(300);
    expect(usage.cacheWrite1hInputTokens).toBe(200);
    const incoherente = usoDeMensajes(
      { input_tokens: 10, cache_creation_input_tokens: 50, cache_creation: { ephemeral_1h_input_tokens: 999 } },
      5,
      false,
    ).usage;
    expect(incoherente.cacheWrite1hInputTokens).toBe(50);
  });

  it("sin desglose no se inventa: el campo no aparece", () => {
    const { usage } = usoDeMensajes({ input_tokens: 10, cache_creation_input_tokens: 300 }, 5, false);
    expect(usage.cacheWrite1hInputTokens).toBeUndefined();
  });
});

describe("OpenAI GPT-5.6+: el modo explícito por medición", () => {
  const OFICIAL = "https://api.openai.com/v1";
  const SISTEMA = "Eres un clasificador de incidencias. ".repeat(200);

  function servidor() {
    const cuerpos: Record<string, unknown>[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      cuerpos.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 1800, cache_write_tokens: 0 } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    return { cuerpos, fetchImpl };
  }

  async function unSoloUso(standalone?: boolean) {
    const r = reloj();
    const s = servidor();
    const layer = createSavingsLayer({
      provider: new OpenAICompatibleProvider({ baseUrl: OFICIAL, fetchImpl: s.fetchImpl }),
      cacheBreakpoints: "auto",
      now: r.ahora,
      silenceWarnings: true,
    });
    const informes: SavingsResult<unknown>["report"][] = [];
    for (let i = 0; i < 40; i++) {
      const res = await layer.generate({
        model: "openai/gpt-6-luna",
        messages: [
          { role: "system", content: SISTEMA },
          { role: "user", content: `Incidencia ${i}: ¿es urgente?` },
        ],
        ...(standalone !== undefined ? { savings: { standalone } } : {}),
      } as SavingsRequest);
      informes.push(res.report);
      r.avanzar(2 * 60_000);
    }
    return { cuerpos: s.cuerpos, informes };
  }

  it("tráfico de un solo uso: pasa a modo explícito cuando es concluyente, y lo publica en `report.cacheWrites`", async () => {
    const { cuerpos, informes } = await unSoloUso();
    expect(cuerpos[0]!["prompt_cache_options"]).toBeUndefined();
    const ultima = cuerpos.at(-1)!;
    expect(ultima["prompt_cache_options"]).toEqual({ mode: "explicit" });
    const escrituras = informes.at(-1)!.cacheWrites!;
    expect(escrituras.mode).toBe("explicit");
    expect(escrituras.reason).toMatch(/cacheBreakpoints: "auto"/);
    expect(escrituras.avoidedWritePremium?.basis ?? "estimated").toBe("estimated");
  });

  it("⛔ `savings.standalone: false` declarado manda sobre la medición", async () => {
    const { cuerpos } = await unSoloUso(false);
    expect(cuerpos.every((c) => c["prompt_cache_options"] === undefined)).toBe(true);
  });
});
