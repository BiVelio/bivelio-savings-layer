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
import { RETIRED_ENV_VARS, RETIRED_FLAGS, retiredNameErrors } from "../gateway/argumentos.js";

/**
 * LAS CUATRO DECISIONES DEL DUEÑO (2026-09-29) QUE ENTRAN EN LA 0.4.33, sin
 * romper a nadie. Lo rompiente queda para la 0.5 (docs/MIGRAR-A-0.5.md):
 *
 *   1. `maxTools` sin tope por defecto: el selector solo poda por relevancia si
 *      el cliente lo fija. Solo manda MÁS herramientas, y lo no podado no se
 *      acredita. Con un catálogo grande donde la búsqueda nativa saldría a
 *      cuenta, un aviso único y silenciable.
 *   2. CLI y variables en inglés; los nombres españoles son alias que avisan.
 *   3. `finishReason` es el conjunto cerrado (desde la 0.5).
 *   4. `semanticCacheStore` (el alias `semanticCache` se retiró en la 0.5) y,
 *      en `cost`, `netSavingsRatio` + `netSavingsUsd` (sin `netSavings`).
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
//
// Alias con aviso en la 0.4.33 y la 0.4.34; en la 0.5 el nombre español es un
// ERROR que dice el nuevo (docs/MIGRAR-A-0.5.md §9). Nunca se ignora en
// silencio: `--puerto 9000` acabaría en el 8402 y una variable ignorada apagaría
// una palanca que el cliente cree encendida.

describe("2 · los nombres españoles del CLI se retiraron en la 0.5: error que dice el nuevo", () => {
  const PARES: Array<[string, string]> = [
    ["--puerto", "--port"],
    ["--proyecto", "--project"],
    ["--forzar", "--force"],
  ];

  it.each(PARES)("%s → error que nombra %s", (viejo, nuevo) => {
    const errores = retiredNameErrors([viejo, "9000"], {}, { checkEnv: true });
    expect(errores).toEqual([`[bvsala] ${viejo} was removed in 0.5: use ${nuevo}.`]);
  });

  it("también con `=` y UN error por flag aunque se repita", () => {
    const errores = retiredNameErrors(["--puerto=9000", "--forzar", "--puerto", "1"], {}, { checkEnv: false });
    expect(errores).toHaveLength(2);
    expect(errores[0]).toContain("--puerto was removed in 0.5: use --port");
    expect(errores[1]).toContain("--forzar was removed in 0.5: use --force");
  });

  it.each([
    ["BVSALA_GATEWAY_ESFUERZO", "BVSALA_GATEWAY_EFFORT"],
    ["BVSALA_GATEWAY_MODELO_HERMANO", "BVSALA_GATEWAY_SIBLING_MODEL"],
  ])("%s puesta → error que nombra %s (aunque esté también la nueva)", (viejo, nuevo) => {
    for (const env of [{ [viejo]: "1" }, { [viejo]: "1", [nuevo]: "1" }, { [viejo]: "" }]) {
      const errores = retiredNameErrors([], env, { checkEnv: true });
      expect(errores).toHaveLength(1);
      expect(errores[0]).toContain(`${viejo} was removed in 0.5`);
      expect(errores[0]).toContain(`rename it to ${nuevo}`);
    }
  });

  it("los nombres ingleses pasan sin error", () => {
    const env = { BVSALA_GATEWAY_EFFORT: "low", BVSALA_GATEWAY_SIBLING_MODEL: "1" };
    expect(retiredNameErrors(["--port", "9000", "--project", "--force", "--upstream", "openai"], env, { checkEnv: true })).toEqual([]);
  });

  it("las variables solo se miran donde se leen (checkEnv), los flags siempre que se pasan", () => {
    expect(retiredNameErrors([], { BVSALA_GATEWAY_ESFUERZO: "low" }, { checkEnv: false })).toEqual([]);
  });

  it("bin.ts no lee los nombres españoles, sale con 1 ante uno retirado, y la ayuda y el README lo dicen", () => {
    const bin = readFileSync(raiz("gateway/bin.ts"), "utf8");
    for (const espanol of Object.keys(RETIRED_ENV_VARS)) {
      expect(bin, espanol).not.toContain(`process.env.${espanol}`);
      expect(bin, espanol).toContain(espanol); // en la ayuda, como retirada
    }
    for (const espanol of Object.keys(RETIRED_FLAGS)) {
      expect(bin, espanol).not.toContain(`"${espanol}"`);
    }
    expect(bin).toMatch(/retiredNameErrors\([\s\S]*?process\.exit\(1\)/);
    expect(bin).not.toContain("still work until 0.5");
    for (const nuevo of ["--port N", "--project", "--force", "BVSALA_GATEWAY_EFFORT", "BVSALA_GATEWAY_SIBLING_MODEL"]) {
      expect(bin, nuevo).toContain(nuevo);
    }
    const readme = readFileSync(raiz("README.md"), "utf8");
    expect(readme).toContain("BVSALA_GATEWAY_EFFORT");
    expect(readme).toContain("were removed in 0.5");
    expect(readme).not.toContain("keep working until 0.5");
  });
});

// ── 3 · finishReason: el conjunto cerrado llegó en la 0.5 ─────────────────────
// (el comportamiento, por proveedor y por modo, en test/finish-reason-cerrado.test.ts)

describe("3 · finishReason es el conjunto cerrado desde la 0.5", () => {
  it("SavingsResult.finishReason se declara con los cinco valores y remite a `finishReasonDetail`", () => {
    const tipos = readFileSync(raiz("src/contracts/types.ts"), "utf8");
    const i = tipos.indexOf("export interface SavingsResult");
    const cierre = 'finishReason?: "stop" | "length" | "tool_calls" | "content_filter" | "other";';
    const j = tipos.indexOf(cierre, i);
    expect(j, "SavingsResult.finishReason no es la unión cerrada").toBeGreaterThan(i);
    expect(tipos.slice(i, j)).toContain("finishReasonDetail");
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

describe("4 · `semanticCacheStore` en el constructor; el alias `semanticCache` se retiró en la 0.5", () => {
  const FILTRO = "`createSavingsLayer({ semanticCache })` was removed in 0.5";
  // Desde JavaScript (sin tipos) el nombre viejo todavía puede llegar: se pasa
  // sin comprobación de tipos, como lo haría un cliente sin TypeScript.
  const sinTipos = (c: Record<string, unknown>) => createSavingsLayer(c as never);

  it("`semanticCacheStore` es el almacén que usa la capa, sin aviso", async () => {
    const store = new InMemorySemanticCache({ embed, similarityThreshold: 0.5, acceptThreshold: 0.5 });
    const capa = createSavingsLayer({ provider: new Fijo(), devUnlicensed: true, semanticCacheStore: store });
    await capa.generate(pregunta("¿Cuál es la capital de Francia?"));
    await store.settled();
    const r = await capa.generate(pregunta("¿Cuál es la capital de Francia, por favor?"));
    expect(r.report.cache.result).toBe("semantic");
    expect(avisos(FILTRO)).toEqual([]);
  });

  it("el nombre viejo ya NO es un almacén: se ignora y avisa UNA vez, nombrando el nuevo", async () => {
    const store = new InMemorySemanticCache({ embed, similarityThreshold: 0.5, acceptThreshold: 0.5 });
    const capa = sinTipos({ provider: new Fijo(), devUnlicensed: true, semanticCache: store });
    sinTipos({ provider: new Fijo(), devUnlicensed: true, semanticCache: store });
    await capa.generate(pregunta("¿Cuál es la capital de Francia?"));
    await store.settled();
    const r = await capa.generate(pregunta("¿Cuál es la capital de Francia, por favor?"));
    expect(r.report.cache.result).not.toBe("semantic");
    expect(store.size).toBe(0);
    const a = avisos(FILTRO);
    expect(a).toHaveLength(1);
    expect(a[0]).toContain("semanticCacheStore");
  });

  it("`silenceWarnings` calla el aviso", () => {
    sinTipos({ provider: new Fijo(), devUnlicensed: true, silenceWarnings: true, semanticCache: new InMemorySemanticCache({ embed }) });
    expect(avisos(FILTRO)).toEqual([]);
  });

  it("`SavingsLayerConfig` ya no declara `semanticCache`", () => {
    const config = readFileSync(raiz("src/pipeline/config.ts"), "utf8");
    expect(config).not.toMatch(/^\s*semanticCache\??:/m);
    expect(config).toMatch(/^\s*semanticCacheStore\?:/m);
  });
});

describe("4 · `cost.netSavingsRatio` y `cost.netSavingsUsd`", () => {
  const redondeo = (n: number) => Math.round(n * 1e10) / 1e10;

  it("en una llamada evitada: la razón es 1 y los dólares, baseline − actual; `netSavings` ya no existe", async () => {
    const r = await createSavingsLayer({ provider: new Fijo(), devUnlicensed: true }).generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "What is 2 + 2 * 3?" }],
    });
    const c = r.report.cost;
    expect(r.report.calls.avoidedLlm).toBe(1);
    expect("netSavings" in c).toBe(false);
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
    expect("netSavings" in c).toBe(false);
    expect(c.netSavingsUsd).toBe(redondeo(c.baselineEstimate - c.actual));
  });
});
