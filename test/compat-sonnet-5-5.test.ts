import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import {
  esMuestreoNoSoportado,
  esToolChoiceForzadoNoSoportado,
  rechazaMuestreo,
  rechazaToolChoiceForzado,
} from "../src/providers/anthropic-compat.js";
import { tramoAnthropicDelModelo } from "../src/economics/cache-tier.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";
import type { ChatMessage, JsonSchema, SavingsRequest, ToolDescriptor } from "../src/contracts/types.js";
import type { ProviderRequest } from "../src/providers/types.js";
import { CacheAnthropicSimulada, dolares } from "../benchmarks/colocador-de-cache/simulador.js";

/**
 * CLAUDE SONNET 5.5 (y la familia que comparte sus restricciones) CONTRA EL
 * ADAPTADOR DE ANTHROPIC Y EL COLOCADOR DE CACHÉ.
 *
 * Fuentes (leídas el 2026-09-29) y comprobación en vivo del mismo día contra
 * `claude-sonnet-5-5` (≈0,01 $): ver src/providers/anthropic-compat.ts.
 *
 *  1. `tool_choice` forzado es un 400 en Sonnet 5.5, Opus 5.5, Fable 5.1 y
 *     Mythos 5.1, con o sin pensamiento. El contrato de salida viaja entonces
 *     por salidas estructuradas (o sin forzar), y un modelo que la tabla no
 *     conoce se aprende con UN reintento.
 *  2. `temperature` no por defecto es un 400 en esos modelos (y en Opus 4.7/4.8,
 *     Opus 5, Sonnet 5, Fable 5, Mythos 5): se quita con un aviso.
 *  3. Los bloques de pensamiento van atados al prefijo: la capa no manda ninguno
 *     por el adaptador propio y no reescribe nada por el del SDK.
 *  4. El catálogo de herramientas sin `system` se marca en un bucle, y el
 *     primer seguimiento de una conversación no marca el historial.
 *
 * Cada `⛔` falla con el código anterior a este cambio; los «control» fijan que
 * los modelos sin la restricción no cambian ni un byte.
 */

type Cuerpo = Record<string, unknown>;

interface Api {
  fetchImpl: typeof fetch;
  cuerpos: Cuerpo[];
}

/** Una API de Mensajes falsa: `rechazar` decide un 400 por cuerpo (su mensaje de error, o nada). */
function api(o: { rechazar?: (c: Cuerpo) => string | undefined; contenido?: (c: Cuerpo) => unknown[] } = {}): Api {
  const cuerpos: Cuerpo[] = [];
  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    const c = JSON.parse(init.body) as Cuerpo;
    cuerpos.push(c);
    const error = o.rechazar?.(c);
    if (error !== undefined) {
      return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: error } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    if (c["stream"] === true) {
      const ev = (e: string, d: unknown) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`;
      const sse =
        ev("message_start", { type: "message_start", message: { id: "msg_s", usage: { input_tokens: 10, output_tokens: 1 } } }) +
        ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
        ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }) +
        ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }) +
        ev("message_stop", { type: "message_stop" });
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response(
      JSON.stringify({
        id: "msg_1",
        content: o.contenido?.(c) ?? [{ type: "text", text: '{"answer":"Paris"}' }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, cuerpos };
}

const TOOL_CHOICE_400 = 'tool_choice: type "tool" and "any" are not supported for this model.';
const TEMPERATURA_400 = "`temperature` is deprecated for this model.";

/** Rechaza como el API real de un modelo sin `tool_choice` forzado ni muestreo. */
const comoSonnet55 = (c: Cuerpo): string | undefined => {
  const e = c["tool_choice"] as { type?: string } | undefined;
  if (e?.type === "any" || e?.type === "tool") return TOOL_CHOICE_400;
  if (typeof c["temperature"] === "number" && c["temperature"] !== 1) return TEMPERATURA_400;
  return undefined;
};

const ESTRICTO: JsonSchema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
} as JsonSchema;
// Sin `additionalProperties: false` ni todas las claves en `required`: no cumple `strict`.
const LAXO: JsonSchema = { type: "object", properties: { answer: { type: "string" }, note: { type: "string" } } } as JsonSchema;

const TIEMPO: ToolDescriptor = {
  id: "get_weather",
  intents: ["weather"],
  risk: "read",
  description: "Current weather for a city",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
};

const PREGUNTA: ChatMessage[] = [{ role: "user", content: "What's the capital of France?" }];

const req = (model: string, over: Partial<ProviderRequest> = {}): ProviderRequest => ({ model, messages: PREGUNTA, ...over });

let aviso: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  reiniciarAvisos();
  aviso = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => aviso.mockRestore());
const avisos = (re: RegExp): string[] => aviso.mock.calls.map((c: unknown[]) => String(c[0])).filter((m: string) => re.test(m));

// ── La tabla ────────────────────────────────────────────────────────────────

describe("la tabla de compatibilidad (documentación oficial, 2026-09-29)", () => {
  it("tool_choice forzado: exactamente Sonnet 5.5, Opus 5.5, Fable 5.1 y Mythos 5.1, con cualquier forma de id", () => {
    for (const m of [
      "claude-sonnet-5-5",
      "anthropic/claude-sonnet-5-5",
      "anthropic.claude-sonnet-5-5",
      "us.anthropic.claude-sonnet-5-5-v1:0",
      "claude-sonnet-5-5-20260928",
      "claude-opus-5-5",
      "claude-fable-5-1",
      "claude-mythos-5-1",
    ]) {
      expect(rechazaToolChoiceForzado(m), m).toBe(true);
    }
    // Control: el pensamiento adaptativo por sí solo NO lo bloquea (Opus 5 lo
    // admite con pensamiento), ni Sonnet 5, ni Fable 5, ni los 4.x.
    for (const m of ["claude-opus-5", "claude-sonnet-5", "claude-fable-5", "claude-mythos-5", "claude-opus-4-8", "claude-haiku-4-5", "claude-sonnet-4-6", "gpt-5.5"]) {
      expect(rechazaToolChoiceForzado(m), m).toBe(false);
    }
  });

  it("muestreo: los que la referencia marca «Removed - 400»; control: 4.6, Haiku 4.5 y Sonnet 4.5 lo admiten", () => {
    for (const m of ["claude-sonnet-5-5", "claude-sonnet-5", "claude-opus-5", "claude-opus-5-5", "claude-opus-4-7", "claude-opus-4-8", "claude-fable-5", "claude-fable-5-1", "claude-mythos-5-1"]) {
      expect(rechazaMuestreo(m), m).toBe(true);
    }
    for (const m of ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5", "claude-sonnet-4-5", "gpt-4o"]) {
      expect(rechazaMuestreo(m), m).toBe(false);
    }
  });

  it("los 400 se reconocen por su texto medido, y un 400 de otra causa no", () => {
    expect(esToolChoiceForzadoNoSoportado(TOOL_CHOICE_400)).toBe(true);
    expect(esMuestreoNoSoportado(TEMPERATURA_400)).toBe(true);
    expect(esMuestreoNoSoportado("Setting `top_p` to a non-default value is not supported")).toBe(true);
    // Un `tool_choice` que nombra una herramienta que no existe es error del llamante.
    expect(esToolChoiceForzadoNoSoportado("tool_choice.name: tool 'x' not found in tools")).toBe(false);
    expect(esMuestreoNoSoportado("max_tokens: must be positive")).toBe(false);
  });

  it("el mínimo cacheable de Sonnet 5.5 es 512 (Sonnet 5 sigue en 1024)", () => {
    expect(tramoAnthropicDelModelo("claude-sonnet-5-5").minimumCacheTokens).toBe(512);
    expect(tramoAnthropicDelModelo("claude-sonnet-5").minimumCacheTokens).toBe(1024);
    expect(tramoAnthropicDelModelo("claude-haiku-4-5").minimumCacheTokens).toBe(4096);
  });
});

// ── 1 · tool_choice forzado ─────────────────────────────────────────────────

describe("1 · el contrato de salida sin `tool_choice` forzado", () => {
  it("⛔ Sonnet 5.5, esquema estricto y sin herramientas: salidas estructuradas, garantía nativa, una sola llamada", async () => {
    const a = api({ rechazar: comoSonnet55 });
    const r = await new AnthropicProvider({ fetchImpl: a.fetchImpl }).generate(req("claude-sonnet-5-5", { schema: ESTRICTO }));
    expect(a.cuerpos).toHaveLength(1);
    const c = a.cuerpos[0]!;
    expect(c["tool_choice"]).toBeUndefined();
    expect(c["tools"]).toBeUndefined();
    expect(c["output_config"]).toEqual({ format: { type: "json_schema", schema: ESTRICTO } });
    expect(r.text).toBe('{"answer":"Paris"}');
    expect(r.structuredNatively).toBe(true);
  });

  it("⛔ Sonnet 5.5, esquema estricto CON herramientas: las del llamante con `auto` y el contrato como formato de la respuesta final", async () => {
    const a = api({ rechazar: comoSonnet55 });
    const r = await new AnthropicProvider({ fetchImpl: a.fetchImpl }).generate(
      req("claude-sonnet-5-5", { schema: ESTRICTO, tools: [TIEMPO] }),
    );
    const c = a.cuerpos[0]!;
    expect(a.cuerpos).toHaveLength(1);
    expect(c["tool_choice"]).toBeUndefined();
    expect((c["tools"] as Cuerpo[]).map((t) => t["name"])).toEqual(["get_weather"]);
    expect(c["output_config"]).toEqual({ format: { type: "json_schema", schema: ESTRICTO } });
    // La garantía sigue siendo de la capa: el modelo puede llamar antes a la suya.
    expect(r.structuredNatively).toBe(false);
    expect(avisos(/does not accept a forced `tool_choice`/)).toHaveLength(1);
  });

  it("⛔ Sonnet 5.5, esquema NO estricto con herramientas: contrato como herramienta, sin forzar, y la instrucción en `system`", async () => {
    const a = api({ rechazar: comoSonnet55 });
    await new AnthropicProvider({ fetchImpl: a.fetchImpl }).generate(req("claude-sonnet-5-5", { schema: LAXO, tools: [TIEMPO] }));
    const c = a.cuerpos[0]!;
    expect(a.cuerpos).toHaveLength(1);
    expect(c["tool_choice"]).toBeUndefined();
    expect(c["output_config"]).toBeUndefined();
    expect((c["tools"] as Cuerpo[]).map((t) => t["name"])).toEqual(["get_weather", "bvsala_contract"]);
    expect(JSON.stringify(c["system"])).toContain("calling the `bvsala_contract` tool");
  });

  it("⛔ lo mismo para Opus 5.5, Fable 5.1, Mythos 5.1 y el id de Bedrock", async () => {
    for (const m of ["claude-opus-5-5", "claude-fable-5-1", "claude-mythos-5-1", "us.anthropic.claude-sonnet-5-5-v1:0"]) {
      const a = api({ rechazar: comoSonnet55 });
      await new AnthropicProvider({ fetchImpl: a.fetchImpl }).generate(req(m, { schema: ESTRICTO }));
      await new AnthropicProvider({ fetchImpl: a.fetchImpl }).generate(req(m, { schema: ESTRICTO, tools: [TIEMPO] }));
      expect(a.cuerpos.every((c) => c["tool_choice"] === undefined), m).toBe(true);
      expect(a.cuerpos).toHaveLength(2);
    }
  });

  it("control: Opus 5, Sonnet 5 y Sonnet 4.6 siguen forzando exactamente como antes", async () => {
    for (const m of ["claude-opus-5", "claude-sonnet-5", "claude-sonnet-4-6"]) {
      const a = api({ contenido: () => [{ type: "tool_use", id: "t", name: "bvsala_contract", input: { answer: "Paris" } }] });
      const p = new AnthropicProvider({ fetchImpl: a.fetchImpl });
      const r = await p.generate(req(m, { schema: ESTRICTO }));
      await p.generate(req(m, { schema: ESTRICTO, tools: [TIEMPO] }));
      expect(a.cuerpos[0]!["tool_choice"], m).toEqual({ type: "tool", name: "bvsala_contract" });
      expect(a.cuerpos[0]!["output_config"], m).toBeUndefined();
      expect(a.cuerpos[1]!["tool_choice"], m).toEqual({ type: "any" });
      expect(r.structuredNatively).toBe(true);
    }
  });

  it("⛔ un modelo que la tabla no conoce: UN reintento degradado tras el 400, anotado por modelo, y un aviso", async () => {
    const a = api({ rechazar: comoSonnet55 });
    const p = new AnthropicProvider({ fetchImpl: a.fetchImpl });
    const r = await p.generate(req("claude-sonnet-6", { schema: ESTRICTO }));
    expect(r.text).toBe('{"answer":"Paris"}');
    expect(a.cuerpos).toHaveLength(2);
    expect(a.cuerpos[0]!["tool_choice"]).toEqual({ type: "tool", name: "bvsala_contract" });
    expect(a.cuerpos[1]!["tool_choice"]).toBeUndefined();
    expect(a.cuerpos[1]!["output_config"]).toBeDefined();
    // La siguiente petición del mismo modelo sale ya degradada: sin viaje de más.
    await p.generate(req("claude-sonnet-6", { schema: ESTRICTO, tools: [TIEMPO] }));
    expect(a.cuerpos).toHaveLength(3);
    expect(a.cuerpos[2]!["tool_choice"]).toBeUndefined();
    expect(avisos(/does not accept a forced `tool_choice`/)).toHaveLength(1);
  });

  it("control: un 400 por otra causa no se reintenta", async () => {
    const a = api({ rechazar: () => "tool_choice.name: tool 'x' not found in tools" });
    await expect(new AnthropicProvider({ fetchImpl: a.fetchImpl }).generate(req("claude-sonnet-6", { schema: ESTRICTO }))).rejects.toThrow(/provider 400/);
    expect(a.cuerpos).toHaveLength(1);
  });

  it("⛔ de punta a punta: la capa con un contrato sobre Sonnet 5.5 contesta, con una llamada", async () => {
    const a = api({ rechazar: comoSonnet55 });
    const layer = createSavingsLayer({ provider: new AnthropicProvider({ fetchImpl: a.fetchImpl }), silenceWarnings: true });
    const r = await layer.generate({
      model: "anthropic/claude-sonnet-5-5",
      messages: PREGUNTA,
      response: { schema: ESTRICTO },
      savings: { exactCache: false },
    } as SavingsRequest);
    expect(r.data).toEqual({ answer: "Paris" });
    expect(a.cuerpos).toHaveLength(1);
  });
});

// ── 2 · temperature ─────────────────────────────────────────────────────────

describe("2 · `temperature` en un modelo que la rechaza", () => {
  it("⛔ Sonnet 5.5 con temperature 0: sale sin ella, contesta, y avisa UNA vez", async () => {
    const a = api({ rechazar: comoSonnet55 });
    const p = new AnthropicProvider({ fetchImpl: a.fetchImpl });
    await p.generate(req("claude-sonnet-5-5", { temperature: 0 }));
    await p.generate(req("claude-sonnet-5-5", { temperature: 0.2 }));
    expect(a.cuerpos).toHaveLength(2);
    expect(a.cuerpos.every((c) => !("temperature" in c))).toBe(true);
    expect(avisos(/rejects a non-default `temperature`/)).toHaveLength(1);
  });

  it("⛔ también en stream", async () => {
    const a = api({ rechazar: comoSonnet55 });
    const eventos = [];
    for await (const e of new AnthropicProvider({ fetchImpl: a.fetchImpl }).generateStream(req("claude-sonnet-5-5", { temperature: 0 }))) eventos.push(e);
    expect(a.cuerpos[0]!["temperature"]).toBeUndefined();
    expect(eventos.at(-1)!.type).toBe("done");
  });

  it("⛔ un modelo que la tabla no conoce: un reintento sin `temperature` y queda anotado", async () => {
    const a = api({ rechazar: comoSonnet55 });
    const p = new AnthropicProvider({ fetchImpl: a.fetchImpl });
    await p.generate(req("claude-sonnet-6", { temperature: 0 }));
    expect(a.cuerpos.map((c) => c["temperature"])).toEqual([0, undefined]);
    await p.generate(req("claude-sonnet-6", { temperature: 0 }));
    expect(a.cuerpos).toHaveLength(3);
  });

  it("control: `temperature: 1` (el valor por defecto, admitido) viaja; Sonnet 4.6 y Haiku 4.5 reciben la suya", async () => {
    const a = api();
    const p = new AnthropicProvider({ fetchImpl: a.fetchImpl });
    await p.generate(req("claude-sonnet-5-5", { temperature: 1 }));
    await p.generate(req("claude-sonnet-4-6", { temperature: 0 }));
    await p.generate(req("claude-haiku-4-5", { temperature: 0.3 }));
    expect(a.cuerpos.map((c) => c["temperature"])).toEqual([1, 0, 0.3]);
    expect(avisos(/temperature/)).toHaveLength(0);
  });

  it("el aviso se silencia con `silenceWarnings`", async () => {
    const a = api();
    const layer = createSavingsLayer({ provider: new AnthropicProvider({ fetchImpl: a.fetchImpl }), silenceWarnings: true });
    await layer.generate({ model: "anthropic/claude-sonnet-5-5", messages: PREGUNTA, temperature: 0 } as SavingsRequest);
    expect(a.cuerpos[0]!["temperature"]).toBeUndefined();
    expect(avisos(/temperature/)).toHaveLength(0);
  });
});

// ── 3 · los bloques de pensamiento, atados al prefijo ───────────────────────

describe("3 · la capa no edita nada anterior a un bloque de pensamiento", () => {
  it("el adaptador propio no manda NUNCA un bloque de pensamiento: el check de «preserved thinking» no tiene qué comprobar", async () => {
    // `ChatMessage` no tiene dónde llevar un bloque de pensamiento; ni siquiera
    // colado en `metadata` llega al cable. Por eso las palancas que reescriben
    // el historial (elisión, compactación de la cola, compresión) sobre este
    // adaptador no pueden disparar el 400 de un prefijo editado: no hay bloque
    // atado que reproducir. El coste es el de siempre —el razonamiento de turnos
    // anteriores no vuelve—, no un error.
    const a = api();
    const pensamiento = { type: "thinking", thinking: "", signature: "sig" };
    await new AnthropicProvider({ fetchImpl: a.fetchImpl }).generate(
      req("claude-sonnet-5-5", {
        tools: [TIEMPO],
        messages: [
          { role: "user", content: "Weather in Paris?" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "toolu_1", name: "get_weather", arguments: '{"city":"Paris"}' }],
            metadata: { content: [pensamiento] },
          },
          { role: "tool", toolCallId: "toolu_1", content: "Sunny" },
        ],
      }),
    );
    const cable = JSON.stringify(a.cuerpos[0]);
    expect(cable).not.toContain('"thinking"');
    expect(cable).not.toContain("redacted_thinking");
  });

  it("de punta a punta, con la compactación de la cola pedida sobre un bucle de Sonnet 5.5: tampoco", async () => {
    const a = api();
    const layer = createSavingsLayer({
      provider: new AnthropicProvider({ fetchImpl: a.fetchImpl }),
      silenceWarnings: true,
      devUnlicensed: true,
    } as Parameters<typeof createSavingsLayer>[0]);
    await layer.generate({
      model: "anthropic/claude-sonnet-5-5",
      tools: [TIEMPO],
      messages: [
        { role: "user", content: "Weather in Paris?" },
        { role: "assistant", content: "", toolCalls: [{ id: "toolu_1", name: "get_weather", arguments: '{"city":"Paris"}' }] },
        { role: "tool", toolCallId: "toolu_1", content: JSON.stringify({ sky: "sunny", temp: 21 }, null, 2) },
      ],
      savings: { toolOutputCompaction: true, exactCache: false },
    } as SavingsRequest);
    expect(JSON.stringify(a.cuerpos[0])).not.toContain('"thinking"');
  });
});

// ── 4 · el colocador de puntos de ruptura ───────────────────────────────────

interface FuncionBfcl {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
const BFCL = JSON.parse(readFileSync(new URL("./fixtures/bfcl/multi_turn_base_157.json", import.meta.url), "utf8")) as {
  question_turn_1: { role: "user"; content: string }[];
  functions: FuncionBfcl[];
};
const TIPO: Record<string, string> = { dict: "object", float: "number", tuple: "array", any: "string", list: "array", bool: "boolean" };
const aEsquema = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(aEsquema);
  if (v === null || typeof v !== "object") return v;
  const o: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) o[k] = k === "type" && typeof x === "string" ? (TIPO[x] ?? x) : aEsquema(x);
  return o;
};
/** Las 35 herramientas de multi_turn_base_157 (MathAPI + TravelAPI), como las pasa el arnés BFCL. */
const CATALOGO_BFCL = (): ToolDescriptor[] =>
  BFCL.functions.map((f) => ({
    id: f.name.replace(/\./g, "_"),
    description: f.description,
    parameters: aEsquema(f.parameters),
  })) as unknown as ToolDescriptor[];

/**
 * Un bucle de herramientas de `pasos` peticiones sobre el catálogo de BFCL: el
 * paso 0 es la pregunta; cada paso k reenvía la historia con k llamadas y sus
 * resultados. Es la forma del sondeo multi-turno del banco (#391): el catálogo
 * entero en cada paso, sin `system`.
 */
async function bucleBfcl(
  layer: ReturnType<typeof createSavingsLayer>,
  model: string,
  pasos: number,
  herramientas = 35,
): Promise<void> {
  const tools = CATALOGO_BFCL().slice(0, herramientas);
  const msgs: ChatMessage[] = [...BFCL.question_turn_1];
  for (let k = 0; k < pasos; k++) {
    await layer.generate({ model, messages: [...msgs], tools, savings: { exactCache: false } } as SavingsRequest);
    const id = `toolu_${k}`;
    msgs.push({ role: "assistant", content: "", toolCalls: [{ id, name: "list_all_airports", arguments: "{}" }] });
    msgs.push({ role: "tool", toolCallId: id, content: `["RMS","SBK","JFK","LAX","HND","CDG","step ${k}"]` });
  }
}

function capaSobreSimulador(sim: CacheAnthropicSimulada, sinMarcas = false): ReturnType<typeof createSavingsLayer> {
  // El brazo «antes» factura el MISMO cable sin un solo `cache_control`: lo que
  // la 0.4.31 puso en el cable en el banco (0 marcas en B).
  const fetchImpl = sinMarcas
    ? ((async (u: unknown, init: { body: string }) =>
        sim.fetch(u as string, { body: init.body.replace(/,"cache_control":\{"type":"ephemeral"(,"ttl":"1h")?\}/g, "") } as RequestInit)) as unknown as typeof fetch)
    : sim.fetch;
  return createSavingsLayer({ provider: new AnthropicProvider({ fetchImpl }), silenceWarnings: true });
}

const PRECIO_SONNET_5_5 = { inputPer1k: 0.002, outputPer1k: 0.01, cachedInputPer1k: 0.0002 };

describe("4 · el catálogo de herramientas sin `system`, en un bucle", () => {
  const marcasEnHerramientas = (c: Cuerpo): number[] =>
    ((c["tools"] as Cuerpo[] | undefined) ?? []).flatMap((t, i) => (t["cache_control"] ? [i] : []));

  it("⛔ BFCL multi_turn_base_157 en Sonnet 5.5: el paso 0 no marca; desde el 1, la última herramienta lleva `cache_control`", async () => {
    const sim = new CacheAnthropicSimulada(() => 0, 512);
    sim.bloquesCompletos = true;
    await bucleBfcl(capaSobreSimulador(sim), "anthropic/claude-sonnet-5-5", 4);
    const marcas = sim.cuerpos.map(marcasEnHerramientas);
    expect(marcas[0]).toEqual([]);
    for (const m of marcas.slice(1)) expect(m).toEqual([34]);
    // Ninguna marca en los mensajes: el historial del bucle es la cola.
    expect(sim.cuerpos.every((c) => !JSON.stringify(c["messages"]).includes("cache_control"))).toBe(true);
    // Y el proveedor (simulado) lee el catálogo desde el tercer paso.
    expect(sim.facturas[1]!.write5m).toBeGreaterThan(0);
    expect(sim.facturas[2]!.read).toBeGreaterThan(0);
    expect(sim.facturas[3]!.read).toBe(sim.facturas[2]!.read);
  });

  it("⛔ el coste esperado de 12 pasos baja más de un 60 % (simulado; el ahorro NO se acredita a la capa)", async () => {
    const antes = new CacheAnthropicSimulada(() => 0, 512);
    const despues = new CacheAnthropicSimulada(() => 0, 512);
    antes.bloquesCompletos = true;
    despues.bloquesCompletos = true;
    await bucleBfcl(capaSobreSimulador(antes, true), "anthropic/claude-sonnet-5-5", 12);
    const layer = capaSobreSimulador(despues);
    const informes: number[] = [];
    const orig = layer.generate.bind(layer);
    (layer as { generate: typeof layer.generate }).generate = (async (r: SavingsRequest) => {
      const res = await orig(r);
      informes.push(res.report.cost.baselineEstimate - res.report.cost.actual);
      return res;
    }) as typeof layer.generate;
    await bucleBfcl(layer, "anthropic/claude-sonnet-5-5", 12);
    const A = dolares(antes.total(), PRECIO_SONNET_5_5);
    const B = dolares(despues.total(), PRECIO_SONNET_5_5);
    expect(antes.total().read + antes.total().write5m).toBe(0);
    expect(B).toBeLessThan(0.4 * A);
    // #260: el descuento de la caché del proveedor sobre bytes del cliente no es
    // mérito de la capa. Ninguna petición declara ahorro por él.
    expect(informes.every((x) => x <= 1e-12)).toBe(true);
  });

  it("el mínimo es el DEL MODELO: 15 herramientas (~2k tokens) no llegan a los 4096 de Haiku 4.5 y sí a los 1024 de Sonnet 5", async () => {
    const haiku = new CacheAnthropicSimulada(() => 0, 4096);
    await bucleBfcl(capaSobreSimulador(haiku), "anthropic/claude-haiku-4-5", 3, 15);
    expect(haiku.cuerpos.every((c) => marcasEnHerramientas(c).length === 0)).toBe(true);
    const sonnet5 = new CacheAnthropicSimulada(() => 0, 1024);
    await bucleBfcl(capaSobreSimulador(sonnet5), "anthropic/claude-sonnet-5", 3, 15);
    expect(sonnet5.cuerpos.map(marcasEnHerramientas)).toEqual([[], [14], [14]]);
  });

  it("control: una herramienta pequeña en Sonnet 5.5 no llega a 512 y no se marca", async () => {
    const a = api();
    const layer = createSavingsLayer({ provider: new AnthropicProvider({ fetchImpl: a.fetchImpl }), silenceWarnings: true });
    const msgs: ChatMessage[] = [
      { role: "user", content: "Weather in Paris?" },
      { role: "assistant", content: "", toolCalls: [{ id: "toolu_1", name: "get_weather", arguments: '{"city":"Paris"}' }] },
      { role: "tool", toolCallId: "toolu_1", content: "Sunny" },
    ];
    await layer.generate({ model: "anthropic/claude-sonnet-5-5", messages: msgs, tools: [TIEMPO], savings: { exactCache: false } } as SavingsRequest);
    expect(JSON.stringify(a.cuerpos[0])).not.toContain("cache_control");
  });

  it("control: con `system` el punto sigue en `system` (que ya cubre las herramientas), no en la última herramienta", async () => {
    const sim = new CacheAnthropicSimulada(() => 0, 512);
    sim.bloquesCompletos = true;
    const layer = capaSobreSimulador(sim);
    const tools = CATALOGO_BFCL();
    await layer.generate({
      model: "anthropic/claude-sonnet-5-5",
      messages: [{ role: "system", content: "You are a travel assistant. ".repeat(40) }, ...BFCL.question_turn_1],
      tools,
      savings: { exactCache: false },
    } as SavingsRequest);
    expect(marcasEnHerramientas(sim.cuerpos[0]!)).toEqual([]);
    expect(JSON.stringify(sim.cuerpos[0]!["system"])).toContain("cache_control");
  });

  it("control: OpenAI no recibe `stablePrefixMessages: 0` (su caché es implícita y sin prima)", async () => {
    const vistas: ProviderRequest[] = [];
    const openai = new OpenAICompatibleProvider({
      apiKey: "test-not-a-key",
      baseUrl: "https://x.test/v1",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch,
    });
    const orig = openai.generate.bind(openai);
    (openai as { generate: typeof openai.generate }).generate = async (r, o) => {
      vistas.push(r);
      return orig(r, o);
    };
    const layer = createSavingsLayer({ provider: openai, silenceWarnings: true });
    const msgs: ChatMessage[] = [
      ...BFCL.question_turn_1,
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "list_all_airports", arguments: "{}" }] },
      { role: "tool", toolCallId: "c1", content: "[]" },
    ];
    await layer.generate({ model: "openai/gpt-4o", messages: msgs, tools: CATALOGO_BFCL(), savings: { exactCache: false } } as SavingsRequest);
    expect(vistas[0]!.stablePrefixMessages).not.toBe(0);
  });
});

describe("4 · el primer seguimiento de una conversación no marca el historial", () => {
  const SISTEMA = "Eres el asistente de una aseguradora. Sé breve y no inventes coberturas. ".repeat(80);
  const largo = (s: string) => `${s} `.repeat(400);
  const marcasEnMensajes = (c: Cuerpo): number =>
    ((c["messages"] as { content: Cuerpo[] }[]) ?? []).flatMap((m) => m.content).filter((b) => b["cache_control"]).length;

  it("⛔ MT-Bench (dos turnos): el turno 2 marca `system` y NO la respuesta del turno 1", async () => {
    const a = api();
    const layer = createSavingsLayer({ provider: new AnthropicProvider({ fetchImpl: a.fetchImpl }), silenceWarnings: true });
    const r = await layer.generate({
      model: "anthropic/claude-sonnet-5-5",
      messages: [
        { role: "system", content: SISTEMA },
        { role: "user", content: largo("pregunta uno") },
        { role: "assistant", content: largo("respuesta uno") },
        { role: "user", content: "pregunta dos" },
      ],
      savings: { exactCache: false },
    } as SavingsRequest);
    expect(marcasEnMensajes(a.cuerpos[0]!)).toBe(0);
    expect(JSON.stringify(a.cuerpos[0]!["system"])).toContain("cache_control");
    expect(r.report.traces.some((t) => t.stage === "prefix-cache-history" && t.outcome === "deferred")).toBe(true);
  });

  it("control: en el turno 3 (la conversación ya siguió) el historial SÍ se marca", async () => {
    const a = api();
    const layer = createSavingsLayer({ provider: new AnthropicProvider({ fetchImpl: a.fetchImpl }), silenceWarnings: true });
    await layer.generate({
      model: "anthropic/claude-sonnet-5-5",
      messages: [
        { role: "system", content: SISTEMA },
        { role: "user", content: largo("pregunta uno") },
        { role: "assistant", content: largo("respuesta uno") },
        { role: "user", content: largo("pregunta dos") },
        { role: "assistant", content: largo("respuesta dos") },
        { role: "user", content: "pregunta tres" },
      ],
      savings: { exactCache: false },
    } as SavingsRequest);
    expect(marcasEnMensajes(a.cuerpos[0]!)).toBe(1);
  });

  it("control: en OpenAI (escritura sin prima) el historial del turno 2 se sigue declarando entero", async () => {
    const vistas: ProviderRequest[] = [];
    const openai = new OpenAICompatibleProvider({
      apiKey: "test-not-a-key",
      baseUrl: "https://x.test/v1",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch,
    });
    const orig = openai.generate.bind(openai);
    (openai as { generate: typeof openai.generate }).generate = async (r, o) => {
      vistas.push(r);
      return orig(r, o);
    };
    await createSavingsLayer({ provider: openai, silenceWarnings: true }).generate({
      model: "openai/gpt-4o",
      messages: [
        { role: "system", content: SISTEMA },
        { role: "user", content: largo("pregunta uno") },
        { role: "assistant", content: largo("respuesta uno") },
        { role: "user", content: "pregunta dos" },
      ],
      savings: { exactCache: false },
    } as SavingsRequest);
    expect(vistas[0]!.stablePrefixMessages).toBe(3);
  });
});
