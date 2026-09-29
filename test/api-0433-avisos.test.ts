import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InMemorySemanticCache } from "../src/cache/semantic.js";
import { createSavingsLayer } from "../src/pipeline/create.js";
import { SavingsPipeline } from "../src/pipeline/pipeline.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { ToolSelector } from "../src/router/tool-selector.js";
import { TokenizerRegistry } from "../src/tokenizer/registry.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import type { SavingsRequest, ToolDescriptor } from "../src/contracts/types.js";
import {
  FLAGS_EN_ESPANOL,
  SILENCIAR_OBSOLETOS,
  VARIABLES_EN_ESPANOL,
  traducirEntorno,
  traducirFlags,
} from "../gateway/argumentos.js";

/**
 * LAS CUATRO DECISIONES DEL DUEÑO (2026-09-29) QUE ENTRAN EN LA 0.4.33, sin
 * romper a nadie. Lo rompiente queda para la 0.5 (docs/MIGRAR-A-0.5.md):
 *
 *   1. `maxTools` sin tope por defecto: el selector solo poda por relevancia si
 *      el cliente lo fija. Solo manda MÁS herramientas, y lo no podado no se
 *      acredita. Con un catálogo grande donde la búsqueda nativa saldría a
 *      cuenta, un aviso único y silenciable.
 *   2. CLI y variables en inglés; los nombres españoles son alias que avisan.
 *   3. `finishReason` no cambia aquí; su JSDoc anuncia el conjunto cerrado.
 *   4. `semanticCacheStore` (alias `semanticCache` con aviso) y, en `cost`,
 *      `netSavingsRatio` + `netSavingsUsd`.
 */

const raiz = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));

let aviso: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  reiniciarAvisos();
  aviso = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  aviso.mockRestore();
});
const avisos = (filtro: string): string[] => aviso.mock.calls.map((c) => String(c[0])).filter((m) => m.includes(filtro));

// ── 1 · maxTools sin tope por defecto ────────────────────────────────────────

const lectura = (id: string, intents: string[]): ToolDescriptor => ({ id, intents, risk: "read" });
const escritura = (id: string, intents: string[]): ToolDescriptor => ({ id, intents, risk: "write" });

describe("1 · el selector sin `maxTools` no poda por relevancia", () => {
  const catalogo = [
    lectura("envios", ["envío"]),
    lectura("facturas", ["factura"]),
    lectura("stock", ["stock"]),
    escritura("anular_pedido", ["anular pedido"]),
  ];

  it("fuera de una acción: todas las de lectura, aunque no casen; solo la verja de riesgo retira las de escritura", () => {
    const r = new ToolSelector().select("¿dónde está mi envío?", catalogo, "SINGLE_RETRIEVAL");
    expect(r.tools.map((t) => t.id)).toEqual(["envios", "facturas", "stock"]);
    expect(r.droppedIds).toEqual(["anular_pedido"]);
    expect(r.setIsStable).toBe(false);
  });

  it("en una acción: el catálogo entero, nada retirado y conjunto estable", () => {
    const r = new ToolSelector().select("anula el pedido 7", catalogo, "TOOL_ACTION");
    expect(r.tools).toHaveLength(catalogo.length);
    expect(r.droppedIds).toEqual([]);
    expect(r.setIsStable).toBe(true);
  });

  it("con clave de congelación y muchos turnos, no congela nada ni cuela una de escritura fuera de una acción", () => {
    const sel = new ToolSelector({ learningTurns: 2 });
    sel.select("anula el pedido", catalogo, "TOOL_ACTION", "sesion");
    for (let i = 0; i < 5; i++) {
      const r = sel.select(`pregunta ${i} sobre el stock`, catalogo, "NO_RETRIEVAL", "sesion");
      expect(r.tools.map((t) => t.id)).not.toContain("anular_pedido");
      expect(r.tools).toHaveLength(3);
    }
  });

  it("control: con `maxTools` fijado, poda por relevancia como hasta 0.4.32", () => {
    const r = new ToolSelector({ maxTools: 8 }).select("¿dónde está mi envío?", catalogo, "SINGLE_RETRIEVAL");
    expect(r.tools.map((t) => t.id)).toEqual(["envios"]);
    expect(r.droppedIds).toEqual(expect.arrayContaining(["facturas", "stock", "anular_pedido"]));
  });
});

class Espia implements Provider {
  readonly id = "espia";
  enviados: ProviderRequest[] = [];
  async generate(req: ProviderRequest): Promise<ProviderResponse> {
    this.enviados.push(req);
    return { text: "ok", usage: { inputTokens: 400, outputTokens: 10 } };
  }
}

describe("1 · en el pipeline: lo que no se poda no se acredita", () => {
  const tipadas = [lectura("envios", ["envío"]), lectura("facturas", ["factura"]), lectura("stock", ["stock"])];
  const peticion: SavingsRequest = {
    model: "openai/gpt-4o-mini",
    messages: [{ role: "user", content: "¿Dónde está mi envío?" }],
    tools: tipadas,
    savings: { exactCache: false },
  };

  it("sin `maxTools`: las tres viajan, el libro 2 queda a 0 y no hay traza de poda ni aviso de poda", async () => {
    const espia = new Espia();
    const r = await createSavingsLayer({ provider: espia, devUnlicensed: true }).generate(peticion);
    expect(espia.enviados[0]!.tools?.map((t) => t.id)).toEqual(["envios", "facturas", "stock"]);
    expect(r.report.calls.actualTools).toBe(3);
    expect(r.report.calls.baselineTools).toBe(3);
    expect(r.report.tokens.eliminatedInput).toBe(0);
    expect(r.report.traces.filter((t) => t.stage === "tool-selector")).toEqual([]);
    expect(avisos("tool selector")).toEqual([]);
  });

  it("control: con `maxTools` la poda vuelve, y con ella el crédito del libro 2", async () => {
    const espia = new Espia();
    const r = await createSavingsLayer({
      provider: espia,
      devUnlicensed: true,
      toolSelector: new ToolSelector({ maxTools: 8 }),
    }).generate(peticion);
    expect(espia.enviados[0]!.tools?.map((t) => t.id)).toEqual(["envios"]);
    expect(r.report.tokens.eliminatedInput).toBeGreaterThan(0);
  });
});

describe("1 · el aviso del catálogo grande donde la búsqueda nativa saldría a cuenta", () => {
  const relleno = "It reads records from the service and returns them with every field the caller asked for. ".repeat(6);
  const grande = (n: number): ToolDescriptor[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `servicio_${i}_consultar`,
      description: `Service ${i}. ${relleno}`,
      intents: [`servicio ${i}`],
      risk: "read" as const,
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    })) as ToolDescriptor[];
  const respuesta = {
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 10 },
  };
  const fetchImpl = (async () =>
    new Response(JSON.stringify(respuesta), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const capa = (extra: Record<string, unknown> = {}, provider: Provider = new AnthropicProvider({ fetchImpl })) =>
    new SavingsPipeline({ provider, tokenizer: new TokenizerRegistry(), devUnlicensed: true, ...extra } as never);
  const peticion = (tools: ToolDescriptor[], extra: Partial<SavingsRequest> = {}): SavingsRequest =>
    ({
      model: "anthropic/claude-sonnet-4-6",
      messages: [{ role: "user", content: "¿Qué pedidos del servicio 17 siguen abiertos?" }],
      tools,
      savings: { exactCache: false, ...(extra.savings ?? {}) },
      ...(extra.model ? { model: extra.model } : {}),
    }) as SavingsRequest;
  const FILTRO = "of its tools in the prompt";

  it("avisa UNA vez, dice cómo encenderla y no enciende nada por su cuenta", async () => {
    const p = capa();
    const r = await p.generate(peticion(grande(200)));
    await p.generate(peticion(grande(200)));
    await capa().generate(peticion(grande(200)));
    const a = avisos(FILTRO);
    expect(a).toHaveLength(1);
    expect(a[0]).toContain("all 200 of its tools");
    expect(a[0]).toContain('toolSearch: "auto"');
    expect(a[0]).toContain("maxTools");
    expect(r.report.traces.find((t) => t.stage === "tool-search")).toBeUndefined();
    expect(r.report.tokens.eliminatedInput).toBe(0);
  });

  it("`silenceWarnings` lo calla", async () => {
    await capa({ silenceWarnings: true }).generate(peticion(grande(200)));
    expect(avisos(FILTRO)).toEqual([]);
  });

  it("no avisa si el llamante ya decidió sobre `toolSearch`, con un catálogo pequeño, con `maxTools` que poda, ni sin búsqueda nativa", async () => {
    await capa().generate(peticion(grande(200), { savings: { toolSearch: "off" } }));
    await capa().generate(peticion(grande(5)));
    await capa({ toolSelector: new ToolSelector({ maxTools: 8 }) }).generate(peticion(grande(200)));
    await capa().generate(peticion(grande(200), { model: "anthropic/claude-sonnet-5" }));
    await capa({}, new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch })).generate({ ...peticion(grande(200)), model: "openai/gpt-4o-mini" });
    expect(avisos(FILTRO)).toEqual([]);
  });
});

// ── 2 · CLI y variables en inglés ────────────────────────────────────────────

describe("2 · los nombres españoles del CLI son alias que avisan una vez", () => {
  it("cada flag español se traduce a su nombre inglés, con UN aviso por flag aunque se repita", () => {
    const r = traducirFlags(["--puerto", "9000", "--proyecto", "--forzar", "--puerto", "9001"]);
    expect(r.resto).toEqual(["--port", "9000", "--project", "--force", "--port", "9001"]);
    expect(r.avisos).toHaveLength(3);
    expect(r.avisos[0]).toContain("--puerto is deprecated: use --port");
    expect(r.avisos.every((a) => a.includes(`${SILENCIAR_OBSOLETOS}=1`))).toBe(true);
  });

  it("los ingleses pasan tal cual y sin aviso", () => {
    const r = traducirFlags(["--port", "9000", "--project", "--force", "--upstream", "openai"]);
    expect(r.resto).toEqual(["--port", "9000", "--project", "--force", "--upstream", "openai"]);
    expect(r.avisos).toEqual([]);
  });

  it(`${SILENCIAR_OBSOLETOS}=1 calla los avisos, pero el alias sigue funcionando`, () => {
    const env = { [SILENCIAR_OBSOLETOS]: "1", BVSALA_GATEWAY_ESFUERZO: "low" };
    const f = traducirFlags(["--puerto", "0"], env);
    expect(f.resto).toEqual(["--port", "0"]);
    expect(f.avisos).toEqual([]);
    const e = traducirEntorno(env);
    expect(e.env.BVSALA_GATEWAY_EFFORT).toBe("low");
    expect(e.avisos).toEqual([]);
  });

  it("las variables españolas alimentan las inglesas, con aviso; si están las dos, gana la inglesa", () => {
    const solo = traducirEntorno({ BVSALA_GATEWAY_ESFUERZO: "medium", BVSALA_GATEWAY_MODELO_HERMANO: "1" });
    expect(solo.env.BVSALA_GATEWAY_EFFORT).toBe("medium");
    expect(solo.env.BVSALA_GATEWAY_SIBLING_MODEL).toBe("1");
    expect(solo.avisos).toHaveLength(2);
    expect(solo.avisos[0]).toContain("BVSALA_GATEWAY_ESFUERZO is deprecated: use BVSALA_GATEWAY_EFFORT");

    const dos = traducirEntorno({ BVSALA_GATEWAY_ESFUERZO: "medium", BVSALA_GATEWAY_EFFORT: "low" });
    expect(dos.env.BVSALA_GATEWAY_EFFORT).toBe("low");
    expect(dos.avisos[0]).toContain("Both are set: BVSALA_GATEWAY_EFFORT is the one in use.");

    const ingles = traducirEntorno({ BVSALA_GATEWAY_EFFORT: "low" });
    expect(ingles.env.BVSALA_GATEWAY_EFFORT).toBe("low");
    expect(ingles.avisos).toEqual([]);
  });

  it("no toca el entorno que recibe", () => {
    const env = { BVSALA_GATEWAY_MODELO_HERMANO: "1" };
    traducirEntorno(env);
    expect(env).toEqual({ BVSALA_GATEWAY_MODELO_HERMANO: "1" });
  });

  it("bin.ts lee solo los nombres ingleses y la ayuda los documenta (los españoles, como obsoletos)", () => {
    const bin = readFileSync(raiz("gateway/bin.ts"), "utf8");
    for (const espanol of [...Object.keys(VARIABLES_EN_ESPANOL)]) {
      expect(bin, espanol).not.toContain(`process.env.${espanol}`);
    }
    for (const espanol of Object.keys(FLAGS_EN_ESPANOL)) {
      expect(bin, espanol).not.toContain(`"${espanol}"`);
    }
    for (const nuevo of ["--port N", "--project", "--force", "BVSALA_GATEWAY_EFFORT", "BVSALA_GATEWAY_SIBLING_MODEL", SILENCIAR_OBSOLETOS]) {
      expect(bin, nuevo).toContain(nuevo);
    }
    const readme = readFileSync(raiz("README.md"), "utf8");
    expect(readme).toContain("BVSALA_GATEWAY_EFFORT");
    expect(readme).toContain(SILENCIAR_OBSOLETOS);
  });
});

// ── 3 · finishReason: sin cambios en la 0.4.x ────────────────────────────────

describe("3 · finishReason no cambia en la 0.4.33; su documentación anuncia la 0.5", () => {
  it("el JSDoc de SavingsResult.finishReason nombra el conjunto cerrado y `finishReasonDetail`", () => {
    const tipos = readFileSync(raiz("src/contracts/types.ts"), "utf8");
    const i = tipos.indexOf("export interface SavingsResult");
    const bloque = tipos.slice(i, tipos.indexOf("finishReason?: string;", i));
    expect(bloque).toContain("In 0.5 this becomes a CLOSED set");
    for (const v of ['"stop"', '"length"', '"tool_calls"', '"content_filter"', '"other"', "finishReasonDetail"]) {
      expect(bloque).toContain(v);
    }
  });
});

// ── 4 · semanticCacheStore y las dos cifras de ahorro ────────────────────────

class Fijo implements Provider {
  readonly id = "fijo";
  llamadas = 0;
  async generate(): Promise<ProviderResponse> {
    this.llamadas++;
    return { text: "París.", usage: { inputTokens: 50, outputTokens: 5 } };
  }
}
const embed = async (t: string): Promise<number[]> => {
  const v = new Array(26).fill(0);
  for (const c of t.toLowerCase()) {
    const k = c.charCodeAt(0) - 97;
    if (k >= 0 && k < 26) v[k]++;
  }
  return v;
};
const pregunta = (content: string): SavingsRequest => ({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content }],
  savings: { semanticCache: true, exactCache: false },
});

describe("4 · `semanticCacheStore` en el constructor; `semanticCache` sigue valiendo con aviso", () => {
  const FILTRO = "`createSavingsLayer({ semanticCache })` is deprecated";

  it("`semanticCacheStore` es el almacén que usa la capa, sin aviso de obsoleto", async () => {
    const store = new InMemorySemanticCache({ embed, similarityThreshold: 0.5, acceptThreshold: 0.5 });
    const capa = createSavingsLayer({ provider: new Fijo(), devUnlicensed: true, semanticCacheStore: store });
    await capa.generate(pregunta("¿Cuál es la capital de Francia?"));
    await store.settled();
    const r = await capa.generate(pregunta("¿Cuál es la capital de Francia, por favor?"));
    expect(r.report.cache.result).toBe("semantic");
    expect(avisos(FILTRO)).toEqual([]);
  });

  it("el alias `semanticCache` funciona igual y avisa UNA vez aunque se creen varias capas", async () => {
    const store = new InMemorySemanticCache({ embed, similarityThreshold: 0.5, acceptThreshold: 0.5 });
    const capa = createSavingsLayer({ provider: new Fijo(), devUnlicensed: true, semanticCache: store });
    createSavingsLayer({ provider: new Fijo(), devUnlicensed: true, semanticCache: store });
    await capa.generate(pregunta("¿Cuál es la capital de Francia?"));
    await store.settled();
    const r = await capa.generate(pregunta("¿Cuál es la capital de Francia, por favor?"));
    expect(r.report.cache.result).toBe("semantic");
    const a = avisos(FILTRO);
    expect(a).toHaveLength(1);
    expect(a[0]).toContain("semanticCacheStore");
  });

  it("`silenceWarnings` calla el aviso", () => {
    createSavingsLayer({ provider: new Fijo(), devUnlicensed: true, silenceWarnings: true, semanticCache: new InMemorySemanticCache({ embed }) });
    expect(avisos(FILTRO)).toEqual([]);
  });

  it("con los dos, gana `semanticCacheStore` y el aviso lo dice", async () => {
    const viejo = new InMemorySemanticCache({ embed, similarityThreshold: 0.5, acceptThreshold: 0.5 });
    const nuevo = new InMemorySemanticCache({ embed, similarityThreshold: 0.5, acceptThreshold: 0.5 });
    const capa = createSavingsLayer({ provider: new Fijo(), devUnlicensed: true, semanticCache: viejo, semanticCacheStore: nuevo });
    await capa.generate(pregunta("¿Cuál es la capital de Francia?"));
    await nuevo.settled();
    await viejo.settled();
    expect(nuevo.size).toBeGreaterThan(0);
    expect(viejo.size).toBe(0);
    expect(avisos(FILTRO)[0]).toContain("`semanticCacheStore` is the one in use");
  });
});

describe("4 · `cost.netSavingsRatio` y `cost.netSavingsUsd`", () => {
  const redondeo = (n: number) => Math.round(n * 1e10) / 1e10;

  it("en una llamada evitada: la razón es la de `netSavings` y los dólares, baseline − actual", async () => {
    const r = await createSavingsLayer({ provider: new Fijo(), devUnlicensed: true }).generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "What is 2 + 2 * 3?" }],
    });
    const c = r.report.cost;
    expect(r.report.calls.avoidedLlm).toBe(1);
    expect(c.netSavingsRatio).toBe(c.netSavings);
    expect(c.netSavingsRatio).toBe(1);
    expect(c.netSavingsUsd).toBe(redondeo(c.baselineEstimate - c.actual));
    expect(c.netSavingsUsd).toBeGreaterThan(0);
  });

  it("en una llamada que corrió con poda: cuadran igual, con signo", async () => {
    const r = await createSavingsLayer({
      provider: new Espia(),
      devUnlicensed: true,
      toolSelector: new ToolSelector({ maxTools: 8 }),
    }).generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "¿Dónde está mi envío?" }],
      tools: [lectura("envios", ["envío"]), lectura("facturas", ["factura"]), lectura("stock", ["stock"])],
      savings: { exactCache: false },
    });
    const c = r.report.cost;
    expect(r.report.calls.avoidedLlm).toBe(0);
    expect(c.netSavingsRatio).toBe(c.netSavings);
    expect(c.netSavingsUsd).toBe(redondeo(c.baselineEstimate - c.actual));
  });
});
