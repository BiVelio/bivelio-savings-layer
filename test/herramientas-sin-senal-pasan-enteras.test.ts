import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import { SavingsPipeline } from "../src/pipeline/pipeline.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { TokenizerRegistry } from "../src/tokenizer/registry.js";
import { ToolSelector } from "../src/router/tool-selector.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";
import type { Provider } from "../src/providers/types.js";
import type { SavingsRequest, SavingsResult, ToolDescriptor } from "../src/contracts/types.js";

/**
 * SIN SEÑAL PARA SELECCIONAR, LA CAPA NO RECORTA NI UNA HERRAMIENTA.
 *
 * Hasta 0.4.30, con un catálogo que no declara `intents` ni `risk` —como llegan
 * los de MCP y los de OpenAI, o sea lo normal— `ToolSelector.passthrough`
 * mandaba solo las `maxTools` (8) PRIMERAS por posición. Lo destapó en vivo la
 * batería BFCL (`docs/benchmarks/2026-09-28/bfcl.md`, PR #379): en
 * multi_turn_base el primer paso acertó la llamada de referencia 8/10 directo y
 * 1/10 por la capa con gpt-4o-mini, la mitad contestó «no tengo acceso», en
 * OpenAI sin ningún aviso, y lo quitado se apuntaba en el libro 2 como ahorro.
 *
 * Lo que fija este fichero, sobre el cuerpo que sale por el cable:
 *
 *   1. 20 herramientas sin tipar → las 20 en la petición al proveedor, en
 *      OpenAI y en Anthropic, con `generate` y con `generateStream`.
 *   2. Ningún crédito por herramientas: `eliminatedInput` 0 y ninguna traza del
 *      selector con descartes.
 *   3. `router:false` tampoco recorta, aunque el catálogo sí esté tipado.
 *   4. Controles: un catálogo tipado sigue seleccionando por relevancia (y
 *      avisa); la búsqueda nativa de Anthropic sigue igual.
 *   5. El caso real: multi_turn_base_157 de BFCL, como fixture sin red.
 */

// ── El cable ──────────────────────────────────────────────────────────────────

type Cuerpo = Record<string, unknown>;

const SSE = { status: 200, headers: { "content-type": "text/event-stream" } };
const JSON_OK = { status: 200, headers: { "content-type": "application/json" } };

function sseOpenAI(): string {
  return (
    [
      { choices: [{ delta: { content: "ok" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 900, completion_tokens: 2 } },
    ]
      .map((c) => `data: ${JSON.stringify(c)}\n\n`)
      .join("") + "data: [DONE]\n\n"
  );
}

function sseAnthropic(): string {
  const ev = (tipo: string, data: Record<string, unknown>): string =>
    `event: ${tipo}\ndata: ${JSON.stringify({ type: tipo, ...data })}\n\n`;
  return (
    ev("message_start", { message: { id: "m", role: "assistant", content: [], usage: { input_tokens: 900, output_tokens: 1 } } }) +
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
    ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } }) +
    ev("content_block_stop", { index: 0 }) +
    ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }) +
    ev("message_stop", {})
  );
}

/** `fetch` que captura cada cuerpo y contesta en JSON o en SSE según `stream`. */
function cable(proveedor: "openai" | "anthropic"): { cuerpos: Cuerpo[]; fetchImpl: typeof fetch } {
  const cuerpos: Cuerpo[] = [];
  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    const cuerpo = JSON.parse(init.body) as Cuerpo;
    cuerpos.push(cuerpo);
    if (cuerpo["stream"] === true) return new Response(proveedor === "openai" ? sseOpenAI() : sseAnthropic(), SSE);
    const json =
      proveedor === "openai"
        ? { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 900, completion_tokens: 2 } }
        : { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 900, output_tokens: 2 } };
    return new Response(JSON.stringify(json), JSON_OK);
  }) as unknown as typeof fetch;
  return { cuerpos, fetchImpl };
}

function proveedorDe(p: "openai" | "anthropic", fetchImpl: typeof fetch): Provider {
  return p === "openai"
    ? new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", fetchImpl })
    : new AnthropicProvider({ fetchImpl });
}

function capa(provider: Provider, extra: Record<string, unknown> = {}): SavingsPipeline {
  return new SavingsPipeline({ provider, tokenizer: new TokenizerRegistry(), devUnlicensed: true, ...extra } as never);
}

/** Nombres de las herramientas del llamante que viajan en el cuerpo (sin la de búsqueda). */
function nombresEnElCable(c: Cuerpo): string[] {
  const tools = (c["tools"] as Record<string, unknown>[] | undefined) ?? [];
  return tools
    .filter((t) => !(typeof t["type"] === "string" && (t["type"] as string).startsWith("tool_search_tool")))
    .map((t) => String((t["function"] as Record<string, unknown> | undefined)?.["name"] ?? t["name"]));
}

const MODELO = { openai: "openai/gpt-4o-mini", anthropic: "anthropic/claude-sonnet-4-6" } as const;

/** Como llega de MCP: nombre, descripción y esquema. Ni `intents` ni `risk`. */
function catalogoSinTipar(n: number, relleno = ""): ToolDescriptor[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `servicio_${String(i).padStart(2, "0")}`,
    description: `Consulta el servicio ${i} y devuelve sus registros. ${relleno}`,
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  })) as unknown as ToolDescriptor[];
}

function peticion(model: string, tools: ToolDescriptor[], pregunta = "¿Qué pedidos siguen abiertos?", savings: SavingsRequest["savings"] = {}): SavingsRequest {
  return {
    model,
    messages: [{ role: "user", content: pregunta }],
    tools,
    savings: { exactCache: false, ...savings },
  } as SavingsRequest;
}

async function pedir(p: SavingsPipeline, req: SavingsRequest, modo: "json" | "stream"): Promise<SavingsResult> {
  if (modo === "json") return await p.generate(req);
  const s = p.generateStream(req);
  for await (const _ of s) {
    // se consume entero: el cuerpo ya salió al crear el stream
  }
  return await s.result;
}

const trazasDelSelector = (r: SavingsResult) => r.report.traces.filter((t) => t.stage === "tool-selector");

let aviso: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  reiniciarAvisos();
  aviso = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => aviso.mockRestore());

const avisosDePoda = () => aviso.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("tool selector sent"));

// ── 1-2 · Sin tipar: las 20, sin crédito ────────────────────────────────────

describe("catálogo de 20 herramientas sin `intents` ni `risk`", () => {
  for (const proveedor of ["openai", "anthropic"] as const) {
    for (const modo of ["json", "stream"] as const) {
      it(`${proveedor} · ${modo}: viajan las 20, en su orden, y no se acredita nada por ellas`, async () => {
        const { cuerpos, fetchImpl } = cable(proveedor);
        const tools = catalogoSinTipar(20);
        const r = await pedir(capa(proveedorDe(proveedor, fetchImpl)), peticion(MODELO[proveedor], tools), modo);

        expect(cuerpos).toHaveLength(1);
        // ANTES: las 8 primeras. `servicio_08`..`servicio_19` no existían para el modelo.
        expect(nombresEnElCable(cuerpos[0]!)).toEqual(tools.map((t) => t.id));
        expect(r.report.calls.baselineTools).toBe(20);
        expect(r.report.calls.actualTools).toBe(20);
        // ANTES: las 12 quitadas iban al libro 2 como ahorro.
        expect(r.report.tokens.eliminatedInput).toBe(0);
        expect(trazasDelSelector(r)).toHaveLength(0);
        // Nada se quitó: nada que avisar.
        expect(avisosDePoda()).toHaveLength(0);
      });
    }
  }

  it("el selector, directamente: 55 sin tipar salen 55 y `droppedIds` vacío", async () => {
    const sel = new ToolSelector({ maxTools: 8 });
    for (const clase of ["NO_RETRIEVAL", "SINGLE_RETRIEVAL", "TOOL_ACTION"] as const) {
      const r = sel.select("lee el fichero", catalogoSinTipar(55), clase, "clave");
      expect(r.tools).toHaveLength(55);
      expect(r.droppedIds).toEqual([]);
      expect(r.setIsStable).toBe(true);
    }
  });
});

// ── 3 · router:false ─────────────────────────────────────────────────────────

describe("`savings: { router: false }` tampoco recorta", () => {
  it("un catálogo TIPADO de 30 con el router apagado viaja entero y sin crédito", async () => {
    const { cuerpos, fetchImpl } = cable("openai");
    const tipadas: ToolDescriptor[] = Array.from({ length: 30 }, (_, i) => ({
      id: `tool_${String(i).padStart(2, "0")}`,
      intents: [`intent ${i}`],
      risk: i % 2 === 0 ? ("read" as const) : ("write" as const),
    }));
    const r = await capa(proveedorDe("openai", fetchImpl)).generate(
      peticion(MODELO.openai, tipadas, "haz algo", { router: false }),
    );
    expect(nombresEnElCable(cuerpos[0]!)).toEqual(tipadas.map((t) => t.id));
    expect(r.report.tokens.eliminatedInput).toBe(0);
  });
});

// ── 4 · Controles ────────────────────────────────────────────────────────────

describe("controles: lo que tenía señal sigue igual", () => {
  const tipadas: ToolDescriptor[] = [
    { id: "envios", intents: ["envío"], risk: "read", description: "Estado de un envío" },
    { id: "facturas", intents: ["factura"], risk: "read", description: "Datos de una factura" },
    { id: "stock", intents: ["stock", "almacén"], risk: "read", description: "Stock por almacén" },
  ];

  for (const proveedor of ["openai", "anthropic"] as const) {
    it(`${proveedor}: con \`maxTools\`, un catálogo con intents se sigue seleccionando por relevancia, se acredita y AVISA una vez`, async () => {
      const { cuerpos, fetchImpl } = cable(proveedor);
      // Desde 0.4.33 la poda por relevancia es opt-in: sin `maxTools` viaja entero.
      const p = capa(proveedorDe(proveedor, fetchImpl), { toolSelector: new ToolSelector({ maxTools: 8 }) });
      const r = await p.generate(peticion(MODELO[proveedor], tipadas, "¿Dónde está mi envío?"));
      await p.generate(peticion(MODELO[proveedor], tipadas, "¿Y la factura?"));

      expect(nombresEnElCable(cuerpos[0]!)).toEqual(["envios"]);
      expect(r.report.tokens.eliminatedInput).toBeGreaterThan(0);
      expect(trazasDelSelector(r)[0]!.detail?.["dropped"]).toEqual(["facturas", "stock"]);
      // Nunca en silencio, en NINGÚN proveedor (antes OpenAI no avisaba nunca).
      const avisos = avisosDePoda();
      expect(avisos).toHaveLength(1);
      expect(avisos[0]).toContain("sent 1 of 3 tools");
      // Donde existe la búsqueda nativa, se dice.
      expect(avisos[0]!.includes("toolSearch")).toBe(proveedor === "anthropic");
    });
  }

  it("`silenceWarnings` lo calla (la traza sigue)", async () => {
    const { fetchImpl } = cable("openai");
    const p = new SavingsPipeline({
      provider: proveedorDe("openai", fetchImpl),
      tokenizer: new TokenizerRegistry(),
      devUnlicensed: true,
      silenceWarnings: true,
      toolSelector: new ToolSelector({ maxTools: 8 }),
    } as never);
    const r = await p.generate(peticion(MODELO.openai, tipadas, "¿Dónde está mi envío?"));
    expect(avisosDePoda()).toHaveLength(0);
    expect(trazasDelSelector(r)).toHaveLength(1);
  });

  it("la búsqueda nativa de Anthropic sigue igual: 200 sin tipar con `auto` viajan diferidas tras la búsqueda", async () => {
    const { cuerpos, fetchImpl } = cable("anthropic");
    // Definiciones de tamaño real: con esquemas diminutos la verja de `auto`
    // (con razón) no ve ahorro en diferirlas y se queda el selector.
    const tools = catalogoSinTipar(200, "It reads records from the service and returns every field the caller asked for. ".repeat(6));
    const r = await capa(proveedorDe("anthropic", fetchImpl)).generate(
      peticion(MODELO.anthropic, tools, "¿Qué pedidos del servicio 17 siguen abiertos?", { toolSearch: "auto" }),
    );
    const enviadas = (cuerpos[0]!["tools"] as Record<string, unknown>[]) ?? [];
    expect(enviadas).toHaveLength(201);
    expect(enviadas[0]!["type"]).toBe("tool_search_tool_bm25_20251119");
    expect(enviadas.slice(1).every((t) => t["defer_loading"] === true)).toBe(true);
    expect(r.report.traces.find((t) => t.stage === "tool-search")!.outcome).toBe("native");
    expect(r.report.tokens.eliminatedInput).toBe(0);
    expect(avisosDePoda()).toHaveLength(0);
  });
});

// ── 5 · El caso real de BFCL ─────────────────────────────────────────────────

/**
 * multi_turn_base_157 de BFCL v4 (gorilla-llm, Apache-2.0), commit f7cf735,
 * extracto literal en `fixtures/bfcl/multi_turn_base_157.json` con la
 * procedencia y el sha256 de cada fichero de origen. 35 herramientas: MathAPI
 * (17) y TravelAPI (18), en ese orden. La pregunta del primer turno es «List all
 * international airports currently accessible for travel.» y la referencia es
 * `list_all_airports()`, que es de TravelAPI: con el corte a 8 por posición
 * quedaba fuera (solo viajaban `absolute_value`…`mean`), y en vivo gpt-4o-mini
 * contestó «I currently don't have access to a real-time database of
 * international airports».
 */
interface FuncionBfcl {
  name: string;
  description: string;
  parameters: { type: string; properties: Record<string, Record<string, unknown>>; required?: string[] };
}
const bfcl = JSON.parse(readFileSync(new URL("./fixtures/bfcl/multi_turn_base_157.json", import.meta.url), "utf8")) as {
  id: string;
  question_turn_1: { role: "user"; content: string }[];
  ground_truth_turn_1: string[];
  functions: FuncionBfcl[];
};

/** Tipos de Python de BFCL a JSON Schema: lo mínimo de `bfcl_eval` (`dict`→object, `float`→number…). */
const TIPO: Record<string, string> = { dict: "object", float: "number", tuple: "array", any: "string", list: "array", bool: "boolean" };
const aEsquema = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(aEsquema);
  if (v === null || typeof v !== "object") return v;
  const o: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) o[k] = k === "type" && typeof x === "string" ? (TIPO[x] ?? x) : aEsquema(x);
  return o;
};

/** El catálogo tal como lo pasa un cliente (y el arnés de BFCL): sin `intents` ni `risk`. */
const catalogoBfcl = (): ToolDescriptor[] =>
  bfcl.functions.map((f) => ({
    id: f.name.replace(/\./g, "_"),
    description: f.description,
    parameters: aEsquema(f.parameters),
  })) as unknown as ToolDescriptor[];

describe("BFCL multi_turn_base_157, sin red", () => {
  it("el fixture es el que dice ser", () => {
    expect(bfcl.id).toBe("multi_turn_base_157");
    expect(bfcl.functions).toHaveLength(35);
    expect(bfcl.ground_truth_turn_1).toEqual(["list_all_airports()"]);
    // La herramienta de la referencia está más allá de la octava posición.
    expect(bfcl.functions.findIndex((f) => f.name === "list_all_airports")).toBeGreaterThanOrEqual(8);
  });

  for (const proveedor of ["openai", "anthropic"] as const) {
    for (const modo of ["json", "stream"] as const) {
      it(`${proveedor} · ${modo}: las 35 viajan, \`list_all_airports\` incluida, y el libro 2 queda a 0`, async () => {
        const { cuerpos, fetchImpl } = cable(proveedor);
        const tools = catalogoBfcl();
        const r = await pedir(
          capa(proveedorDe(proveedor, fetchImpl)),
          { model: MODELO[proveedor], messages: bfcl.question_turn_1, tools, savings: { exactCache: false } } as SavingsRequest,
          modo,
        );
        const nombres = nombresEnElCable(cuerpos[0]!);
        expect(nombres).toEqual(tools.map((t) => t.id));
        expect(nombres).toContain("list_all_airports");
        expect(r.report.tokens.eliminatedInput).toBe(0);
        expect(trazasDelSelector(r)).toHaveLength(0);
      });
    }
  }
});
