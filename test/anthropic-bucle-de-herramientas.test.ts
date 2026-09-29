import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import { SavingsPipeline } from "../src/pipeline/pipeline.js";
import { huellasDePrefijos } from "../src/economics/colocador-de-cache.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { lotesDelProveedor } from "../src/providers/lotes-del-proveedor.js";
import { TokenizerRegistry } from "../src/tokenizer/registry.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";
import type { ChatMessage, SavingsRequest, SavingsResult, ToolDescriptor } from "../src/contracts/types.js";
import type { ProviderRequest } from "../src/providers/types.js";
import { apiDeMensajes, reglasDelBucle, sinMarcas, type Turnada } from "./helpers/api-de-mensajes-falsa.js";
import { CASOS, CASOS_ANTIGUOS, RUTA_DEL_FIXTURE, cuerposDe } from "./helpers/cuerpos-anthropic-sin-herramientas.js";

/**
 * EL BUCLE DE HERRAMIENTAS ATRAVIESA EL ADAPTADOR DE ANTHROPIC.
 *
 * Antes cada mensaje neutro salía como `{role, content: [{type: "text", text}]}`:
 * el turno del asistente que solo pide herramientas (`content: ""` con
 * `toolCalls`, lo que devuelve la capa y lo que el README manda devolver) salía
 * como un bloque de texto VACÍO —un 400 de la API en el segundo turno de
 * cualquier agente—, las llamadas se tiraban y los resultados viajaban como
 * texto de usuario.
 *
 * La API falsa (`helpers/api-de-mensajes-falsa.ts`) hace cumplir las reglas
 * documentadas del bucle, con sus fuentes. Con el adaptador anterior, el bucle
 * de varios turnos de abajo muere en la segunda petición con «text content
 * blocks must be non-empty».
 */

type Bloque = Record<string, unknown>;
type Mensaje = { role: string; content: Bloque[] };

const tiempo: ToolDescriptor = {
  id: "get_weather",
  intents: ["weather", "tiempo"],
  risk: "read",
  description: "Current weather for a city",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
};
const hora: ToolDescriptor = {
  id: "get_time",
  intents: ["time", "hora"],
  risk: "read",
  description: "Local time in a city",
  parameters: {
    type: "object",
    properties: { city: { type: "string" }, tz: { type: "string" } },
    required: ["city"],
  },
};
const HERRAMIENTAS = [tiempo, hora];

const POLITICA = "Eres el asistente de viajes de una agencia. Contesta en castellano, breve. ".repeat(30);

const texto = (t: string): Bloque => ({ type: "text", text: t });
const llamada = (id: string, name: string, input: Record<string, unknown>): Bloque => ({ type: "tool_use", id, name, input });
const fin = (...content: Bloque[]): Turnada => ({ content, stop_reason: "end_turn" });
const pide = (...content: Bloque[]): Turnada => ({ content, stop_reason: "tool_use" });

/**
 * El guion del «modelo» en el bucle: pide sin preámbulo, pide dos en paralelo con
 * preámbulo, reintenta la que falló y contesta. Una respuesta por petición.
 */
const GUION: Turnada[] = [
  pide(llamada("toolu_01", "get_weather", { city: "Madrid" })),
  fin(texto("En Madrid hace 21 °C.")),
  pide(texto("Consulto las dos cosas."), llamada("toolu_02", "get_weather", { city: "Paris" }), llamada("toolu_03", "get_time", { city: "Paris" })),
  pide(llamada("toolu_04", "get_time", { city: "Paris", tz: "Europe/Paris" })),
  fin(texto("En París hace 18 °C y son las 10:00.")),
];

/** Lo que el llamante «ejecuta»: `get_time` sin zona horaria falla. */
function ejecutar(nombre: string, args: Record<string, unknown>): { content: string; isError?: true } {
  if (nombre === "get_weather") return { content: args["city"] === "Madrid" ? "21 °C, despejado" : "18 °C, nublado" };
  if (args["tz"] == null) return { content: "Error: missing tz. Retry with an IANA time zone.", isError: true };
  return { content: "10:00" };
}

type Modo = "json" | "sse";

function capa(provider: AnthropicProvider, extra: Record<string, unknown> = {}): SavingsPipeline {
  return new SavingsPipeline({ provider, tokenizer: new TokenizerRegistry(), devUnlicensed: true, ...extra } as never);
}

/**
 * El bucle de un agente, como lo escribe un llamante que sigue el contrato de
 * `ChatMessage`: devuelve el turno del asistente con sus `toolCalls` (ids
 * incluidos) y contesta cada llamada con un `role: "tool"` con su `toolCallId`.
 */
async function bucle(layer: SavingsPipeline, modo: Modo, preguntas: string[]): Promise<{ historial: ChatMessage[]; respuestas: SavingsResult[] }> {
  const historial: ChatMessage[] = [{ role: "system", content: POLITICA }];
  const respuestas: SavingsResult[] = [];
  const pedir = async (): Promise<SavingsResult> => {
    const req: SavingsRequest = { model: "anthropic/claude-sonnet-4-6", messages: [...historial], tools: HERRAMIENTAS };
    const r = modo === "json" ? await layer.generate(req) : await layer.generateStream(req).result;
    respuestas.push(r);
    return r;
  };
  for (const pregunta of preguntas) {
    historial.push({ role: "user", content: pregunta });
    let r = await pedir();
    while (r.toolCalls?.length) {
      historial.push({ role: "assistant", content: r.text, toolCalls: r.toolCalls });
      for (const c of r.toolCalls) {
        const hecho = ejecutar(c.name, JSON.parse(c.arguments) as Record<string, unknown>);
        historial.push({ role: "tool", toolCallId: c.id!, name: c.name, content: hecho.content, ...(hecho.isError ? { isError: true } : {}) });
      }
      r = await pedir();
    }
    historial.push({ role: "assistant", content: r.text });
  }
  return { historial, respuestas };
}

const PREGUNTAS = ["¿Qué tiempo hace en Madrid?", "¿Y en París? Dime también la hora."];

const tipos = (m: Mensaje): unknown[] => m.content.map((b) => b["type"]);

let aviso: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  reiniciarAvisos();
  aviso = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => aviso.mockRestore());

const avisosDelBucle = (): string[] =>
  aviso.mock.calls.map((c: unknown[]) => String(c[0])).filter((m: string) => /tool (conversation|exchange)/.test(m));

// ── 1 · El bucle de un agente, de punta a punta ──────────────────────────────

describe.each<Modo>(["json", "sse"])("un agente de varios turnos por la capa, contra la API falsa (%s)", (modo) => {
  it("ningún cuerpo rompe una regla documentada, y el agente llega a sus dos respuestas", async () => {
    const api = apiDeMensajes((_c, n) => GUION[n]!);
    const { respuestas } = await bucle(capa(new AnthropicProvider({ fetchImpl: api.fetchImpl })), modo, PREGUNTAS);
    expect(api.rechazos).toEqual([]);
    expect(api.cuerpos).toHaveLength(GUION.length);
    expect(respuestas.map((r) => r.text)).toEqual([
      "",
      "En Madrid hace 21 °C.",
      "Consulto las dos cosas.",
      "",
      "En París hace 18 °C y son las 10:00.",
    ]);
  });

  it("el cable lleva `tool_use` en el turno del asistente y los `tool_result` juntos en el siguiente", async () => {
    const api = apiDeMensajes((_c, n) => GUION[n]!);
    await bucle(capa(new AnthropicProvider({ fetchImpl: api.fetchImpl })), modo, PREGUNTAS);
    const ultimo = sinMarcas(api.cuerpos[api.cuerpos.length - 1]!["messages"] as Mensaje[]);
    expect(ultimo.map((m) => [m.role, ...tipos(m)])).toEqual([
      ["user", "text"],
      ["assistant", "tool_use"], // el turno que solo pide: sin texto vacío
      ["user", "tool_result"],
      ["assistant", "text"],
      ["user", "text"],
      ["assistant", "text", "tool_use", "tool_use"], // preámbulo y dos en paralelo
      ["user", "tool_result", "tool_result"], // los dos resultados en UN turno
      ["assistant", "tool_use"],
      ["user", "tool_result"],
    ]);
    expect(ultimo[1]!.content[0]).toEqual({ type: "tool_use", id: "toolu_01", name: "get_weather", input: { city: "Madrid" } });
    expect(ultimo[2]!.content[0]).toEqual({ type: "tool_result", tool_use_id: "toolu_01", content: "21 °C, despejado" });
    expect(ultimo[6]!.content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_02", content: "18 °C, nublado" },
      { type: "tool_result", tool_use_id: "toolu_03", content: "Error: missing tz. Retry with an IANA time zone.", is_error: true },
    ]);
  });

  it("el modelo vuelve a ver sus propias llamadas, con el mismo id, nombre e `input`", async () => {
    const api = apiDeMensajes((_c, n) => GUION[n]!);
    await bucle(capa(new AnthropicProvider({ fetchImpl: api.fetchImpl })), modo, PREGUNTAS);
    const enElHistorial = (api.cuerpos[api.cuerpos.length - 1]!["messages"] as Mensaje[])
      .flatMap((m) => m.content)
      .filter((b) => b["type"] === "tool_use")
      .map((b) => sinMarcas(b));
    expect(enElHistorial).toEqual(api.emitidas);
  });

  it("el historial de cada petición es prefijo byte a byte del de la siguiente (la caché de prefijo puede acertar)", async () => {
    const api = apiDeMensajes((_c, n) => GUION[n]!);
    await bucle(capa(new AnthropicProvider({ fetchImpl: api.fetchImpl })), modo, PREGUNTAS);
    const cuerpos = sinMarcas(api.cuerpos);
    for (let i = 1; i < cuerpos.length; i++) {
      const antes = cuerpos[i - 1]!["messages"] as Mensaje[];
      const ahora = cuerpos[i]!["messages"] as Mensaje[];
      expect(JSON.stringify(ahora.slice(0, antes.length))).toBe(JSON.stringify(antes));
      // `tools` no se compara: el selector de la capa elige por pregunta (y con
      // eso ya renuncia al prefijo, ver la traza `prefix-cache`). Lo que pone el
      // adaptador es el historial, y ese solo crece por el final.
      expect(JSON.stringify(cuerpos[i]!["system"])).toBe(JSON.stringify(cuerpos[i - 1]!["system"]));
    }
  });

  it("un llamante que sigue el contrato no recibe ningún aviso", async () => {
    const api = apiDeMensajes((_c, n) => GUION[n]!);
    await bucle(capa(new AnthropicProvider({ fetchImpl: api.fetchImpl })), modo, PREGUNTAS);
    expect(avisosDelBucle()).toEqual([]);
  });
});

// ── 2 · La caché de prefijo sigue cayendo donde acaba lo estable ──────────────

describe("el punto de ruptura con los resultados agrupados", () => {
  const conversacion: ChatMessage[] = [
    { role: "system", content: POLITICA },
    { role: "user", content: "¿Tiempo y hora en París?" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "toolu_a", name: "get_weather", arguments: '{"city":"Paris"}' },
        { id: "toolu_b", name: "get_time", arguments: '{"city":"Paris","tz":"Europe/Paris"}' },
      ],
    },
    { role: "tool", toolCallId: "toolu_a", content: "18 °C" },
    { role: "tool", toolCallId: "toolu_b", content: "10:00" },
  ];

  async function cuerpo(req: Partial<ProviderRequest>, opciones: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const api = apiDeMensajes(() => fin(texto("ok")));
    await new AnthropicProvider({ fetchImpl: api.fetchImpl, ...opciones }).generate({
      model: "claude-sonnet-4-6",
      messages: conversacion,
      tools: HERRAMIENTAS,
      ...req,
    });
    expect(api.rechazos).toEqual([]);
    return api.cuerpos[0]!;
  }
  /** [mensaje, bloque, tipo] de cada `cache_control` en `messages`. */
  const marcas = (c: Record<string, unknown>): [number, number, unknown][] =>
    (c["messages"] as Mensaje[]).flatMap((m, i) =>
      m.content.flatMap((b, j) => (b["cache_control"] ? [[i, j, b["type"]] as [number, number, unknown]] : [])),
    );

  it("un prefijo que acaba entre dos resultados marca el PRIMERO, no el último del turno", async () => {
    // Mensajes del llamante 0-3 (system, pregunta, llamadas, primer resultado).
    expect(marcas(await cuerpo({ stablePrefixMessages: 4 }))).toEqual([[2, 0, "tool_result"]]);
  });

  it("un prefijo que acaba en el turno de las llamadas marca su último `tool_use`", async () => {
    expect(marcas(await cuerpo({ stablePrefixMessages: 3 }))).toEqual([[1, 1, "tool_use"]]);
  });

  it("un prefijo que cubre los dos resultados marca el segundo", async () => {
    expect(marcas(await cuerpo({ stablePrefixMessages: 5 }))).toEqual([[2, 1, "tool_result"]]);
  });

  it("la cola del colocador (#346) cae en el último resultado, y el historial en su sitio", async () => {
    const c = await cuerpo({ stablePrefixMessages: 3, cachePlacement: { tail: true, ttl: "1h" } });
    expect(marcas(c)).toEqual([
      [1, 1, "tool_use"],
      [2, 1, "tool_result"],
    ]);
    expect(JSON.stringify(c).match(/"ttl":"1h"/g)).toHaveLength(3); // system, historial y cola
  });

  it("con «(continue)» delante, el punto se desplaza con él", async () => {
    const c = await cuerpo({ messages: conversacion.slice(2), stablePrefixMessages: 2 });
    const mensajes = c["messages"] as Mensaje[];
    expect(mensajes[0]).toEqual({ role: "user", content: [{ type: "text", text: "(continue)" }] });
    // Mensajes del llamante 0-1: las llamadas y el primer resultado.
    expect(marcas(c)).toEqual([[2, 0, "tool_result"]]);
  });

  it("la caché automática y un tope de un punto siguen respetando el presupuesto", async () => {
    const auto = await cuerpo({ stablePrefixMessages: 4 }, { automaticCache: true });
    expect(auto["cache_control"]).toEqual({ type: "ephemeral" });
    const uno = await cuerpo({ stablePrefixMessages: 4 }, { maxCacheBreakpoints: 1 });
    expect(marcas(uno)).toEqual([]); // el único punto se lo lleva `system`
  });

  it("por la capa: el punto del historial cae en el último bloque anterior a la pregunta, aunque haya herramientas detrás", async () => {
    const api = apiDeMensajes((_c, n) => GUION[n]!);
    await bucle(capa(new AnthropicProvider({ fetchImpl: api.fetchImpl })), "json", PREGUNTAS);
    // A partir de la segunda pregunta, el prefijo estable acaba en la respuesta
    // «En Madrid hace 21 °C.» (el último mensaje antes de la última pregunta).
    // La PRIMERA petición de esa pregunta no lo marca todavía: es el primer
    // seguimiento y nada dice aún que el historial se vaya a reenviar. Los pasos
    // del bucle que la siguen sí: ellos son esa evidencia (reenvían el historial
    // idéntico), y ahí empieza a pagar la marca.
    const conHistorial = api.cuerpos.slice(2).map(marcas);
    expect(conHistorial.length).toBe(3);
    expect(conHistorial[0]).not.toContainEqual([3, 0, "text"]);
    for (const m of conHistorial.slice(1)) expect(m).toContainEqual([3, 0, "text"]);
    const respuesta = (api.cuerpos[2]!["messages"] as Mensaje[])[3]!.content[0]!;
    expect(respuesta["text"]).toBe("En Madrid hace 21 °C.");
  });
});

// ── 3 · Lo que no puede viajar nativo, sale como antes (y sin texto vacío) ────

describe("lo que no puede viajar como `tool_use`/`tool_result` sale como texto, con un aviso", () => {
  async function enviar(messages: ChatMessage[], req: Partial<ProviderRequest> = {}): Promise<Mensaje[]> {
    const api = apiDeMensajes(() => fin(texto("ok")));
    await new AnthropicProvider({ fetchImpl: api.fetchImpl }).generate({ model: "claude-sonnet-4-6", messages, tools: HERRAMIENTAS, ...req });
    expect(api.rechazos).toEqual([]);
    return api.cuerpos[0]!["messages"] as Mensaje[];
  }
  const pregunta: ChatMessage = { role: "user", content: "¿Tiempo en Madrid?" };

  it("un llamante antiguo sin ids: el turno vacío no se manda, el resultado va como texto y se avisa UNA vez", async () => {
    const antiguo: ChatMessage[] = [
      pregunta,
      { role: "assistant", content: "", toolCalls: [{ name: "get_weather", arguments: '{"city":"Madrid"}' }] },
      { role: "tool", name: "get_weather", content: "21 °C" },
    ];
    expect(await enviar(antiguo)).toEqual([
      { role: "user", content: [texto("¿Tiempo en Madrid?")] },
      { role: "user", content: [texto("21 °C")] },
    ]);
    await enviar(antiguo);
    expect(avisosDelBucle()).toHaveLength(1);
    expect(avisosDelBucle()[0]).toMatch(/without its call ids/);
  });

  it("una herramienta que esta petición no lleva en `tools` no viaja como `tool_use`", async () => {
    const m: ChatMessage[] = [
      pregunta,
      { role: "assistant", content: "Miro.", toolCalls: [{ id: "toolu_1", name: "get_weather", arguments: '{"city":"Madrid"}' }] },
      { role: "tool", toolCallId: "toolu_1", content: "21 °C" },
    ];
    const sinEsa = await enviar(m, { tools: [hora] });
    expect(sinEsa.map((x) => [x.role, ...tipos(x)])).toEqual([["user", "text"], ["assistant", "text"], ["user", "text"]]);
    const sinNinguna = await enviar(m, { tools: [] });
    expect(JSON.stringify(sinNinguna)).not.toContain("tool_use");
    expect(avisosDelBucle()).toHaveLength(1);
    expect(avisosDelBucle()[0]).toMatch(/does not make available/);
  });

  it("una llamada sin resultado, un resultado de más o un id repetido: texto, y un aviso", async () => {
    const llamadaA = { id: "toolu_1", name: "get_weather", arguments: '{"city":"Madrid"}' };
    const casos: ChatMessage[][] = [
      // sin resultado: el llamante sigue hablando
      [pregunta, { role: "assistant", content: "Miro.", toolCalls: [llamadaA] }, { role: "user", content: "¿Y bien?" }],
      // un resultado que no es de esta llamada
      [pregunta, { role: "assistant", content: "Miro.", toolCalls: [llamadaA] }, { role: "tool", toolCallId: "toolu_9", content: "x" }],
      // dos resultados para una llamada
      [
        pregunta,
        { role: "assistant", content: "Miro.", toolCalls: [llamadaA] },
        { role: "tool", toolCallId: "toolu_1", content: "x" },
        { role: "tool", toolCallId: "toolu_1", content: "y" },
      ],
    ];
    for (const c of casos) expect(JSON.stringify(await enviar(c))).not.toMatch(/tool_use|tool_result/);
    // El mismo id en dos turnos: el primero viaja nativo, el segundo como texto.
    const repetido = await enviar([
      pregunta,
      { role: "assistant", content: "", toolCalls: [llamadaA] },
      { role: "tool", toolCallId: "toolu_1", content: "21 °C" },
      { role: "assistant", content: "Otra vez.", toolCalls: [llamadaA] },
      { role: "tool", toolCallId: "toolu_1", content: "21 °C" },
    ]);
    expect(repetido.map((x) => [x.role, ...tipos(x)])).toEqual([
      ["user", "text"],
      ["assistant", "tool_use"],
      ["user", "tool_result"],
      ["assistant", "text"],
      ["user", "text"],
    ]);
    expect(avisosDelBucle()).toHaveLength(1);
    expect(avisosDelBucle()[0]).toMatch(/does not pair up/);
  });

  it("`arguments` que no es un objeto JSON (un corte por `max_tokens`): texto; vacío es una llamada sin argumentos", async () => {
    const con = (args: string): ChatMessage[] => [
      pregunta,
      { role: "assistant", content: "", toolCalls: [{ id: "toolu_1", name: "get_weather", arguments: args }] },
      { role: "tool", toolCallId: "toolu_1", content: "Error: truncated call", isError: true },
    ];
    expect(JSON.stringify(await enviar(con('{"city":"Mad')))).not.toContain("tool_use");
    expect(JSON.stringify(await enviar(con("[1,2]")))).not.toContain("tool_use");
    const vacio = await enviar(con(""));
    expect(vacio[1]!.content).toEqual([{ type: "tool_use", id: "toolu_1", name: "get_weather", input: {} }]);
  });

  it("un id con caracteres que la API no admite se normaliza igual a los dos lados", async () => {
    const m = await enviar([
      pregunta,
      { role: "assistant", content: "", toolCalls: [{ id: "call:1/a.b", name: "get_weather", arguments: '{"city":"Madrid"}' }] },
      { role: "tool", toolCallId: "call:1/a.b", content: "21 °C" },
    ]);
    expect(m[1]!.content[0]!["id"]).toBe("call_1_a_b");
    expect(m[2]!.content[0]!["tool_use_id"]).toBe("call_1_a_b");
  });

  it("un resultado vacío va sin `content`, y `isError` como `is_error: true`", async () => {
    const m = await enviar([
      pregunta,
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "toolu_1", name: "get_weather", arguments: '{"city":"Madrid"}' },
          { id: "toolu_2", name: "get_time", arguments: '{"city":"Madrid"}' },
        ],
      },
      { role: "tool", toolCallId: "toolu_1", content: "" },
      { role: "tool", toolCallId: "toolu_2", content: "Error: missing tz", isError: true },
    ]);
    expect(m[2]!.content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_1" },
      { type: "tool_result", tool_use_id: "toolu_2", content: "Error: missing tz", is_error: true },
    ]);
  });

  it("`silenceWarnings` de la capa también calla los avisos del adaptador", async () => {
    const api = apiDeMensajes(() => fin(texto("ok")));
    const layer = createSavingsLayer({ provider: new AnthropicProvider({ fetchImpl: api.fetchImpl }), silenceWarnings: true, devUnlicensed: true } as never);
    await layer.generate({
      model: "anthropic/claude-sonnet-4-6",
      messages: [pregunta, { role: "assistant", content: "Miro." }, { role: "tool", content: "21 °C" }],
      tools: HERRAMIENTAS,
    });
    expect(api.rechazos).toEqual([]);
    expect(avisosDelBucle()).toEqual([]);
  });
});

// ── 4 · Nunca un cuerpo que rompa las reglas, sea cual sea la conversación ────

describe("propiedad: ninguna conversación neutra produce un cuerpo que rompa las reglas del bucle", () => {
  // Un generador determinista (mulberry32): mismas conversaciones en cada tirada.
  function azar(semilla: number): () => number {
    let a = semilla;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("600 conversaciones al azar: roles, textos vacíos, ids que faltan, sobran o se repiten", async () => {
    const r = azar(20260927);
    const elegir = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
    let nativas = 0;
    let comprobadas = 0;
    let siguienteId = 1;
    for (let caso = 0; caso < 600; caso++) {
      const messages: ChatMessage[] = [];
      if (r() < 0.7) messages.push({ role: "system", content: elegir(["S", ""]) });
      const n = 1 + Math.floor(r() * 7);
      for (let k = 0; k < n; k++) {
        const rol = elegir<ChatMessage["role"]>(["user", "user", "assistant", "assistant", "tool", "system"]);
        const content = elegir(["hola", "", "21 °C"]);
        if (rol === "assistant" && r() < 0.6) {
          const nLlamadas = 1 + Math.floor(r() * 3);
          // Casi siempre ids buenos y únicos; a veces sin id, raros o repetidos.
          const ids = Array.from({ length: nLlamadas }, () =>
            r() < 0.75 ? `toolu_${siguienteId++}` : elegir([undefined, "call:x", "toolu_0"]),
          );
          messages.push({
            role: "assistant",
            content,
            toolCalls: ids.map((id) => ({
              ...(id ? { id } : {}),
              name: r() < 0.85 ? elegir(["get_weather", "get_time"]) : "otra",
              arguments: r() < 0.85 ? elegir(['{"city":"Madrid"}', ""]) : elegir(["{", "[]"]),
            })),
          });
          // A veces el llamante contesta bien, a veces mal, a veces nada.
          const contestar = elegir(["bien", "bien", "bien", "mal", "nada"]);
          if (contestar !== "nada") {
            for (const id of ids) {
              messages.push({
                role: "tool",
                ...(contestar === "bien" && id ? { toolCallId: id } : r() < 0.5 ? { toolCallId: `toolu_${Math.floor(r() * 4)}` } : {}),
                content: elegir(["21 °C", ""]),
                ...(r() < 0.2 ? { isError: true } : {}),
              });
            }
          }
        } else {
          messages.push({ role: rol, content });
        }
      }
      const api = apiDeMensajes(() => fin(texto("ok")));
      const p = new AnthropicProvider({ fetchImpl: api.fetchImpl });
      const req: ProviderRequest = {
        model: "claude-sonnet-4-6",
        messages,
        ...(r() < 0.8 ? { tools: HERRAMIENTAS } : {}),
        ...(r() < 0.5 ? { stablePrefixMessages: Math.floor(r() * (messages.length + 1)) } : {}),
        ...(r() < 0.3 ? { cachePlacement: { tail: true, ttl: "5m" as const } } : {}),
      };
      try {
        await p.generate(req);
      } catch (e) {
        // La única salida permitida sin cuerpo: no queda ni un turno que mandar.
        expect(String(e)).toMatch(/no user\/assistant message/);
        continue;
      }
      comprobadas += 1;
      expect(api.rechazos, JSON.stringify(req.messages)).toEqual([]);
      if (JSON.stringify(api.cuerpos[0]).includes('"tool_use"')) nativas += 1;
    }
    // La batería ejercita las dos ramas.
    expect(comprobadas).toBeGreaterThan(400);
    expect(nativas).toBeGreaterThan(60);
  });
});

// ── 5 · Sin bucle de herramientas, el cuerpo de antes byte a byte ─────────────

describe("sin bucle de herramientas, el cuerpo es el de la versión anterior, byte a byte", () => {
  const fijado = JSON.parse(readFileSync(RUTA_DEL_FIXTURE, "utf8")) as Record<string, { json: string; sse: string; lote: string }>;

  it.each([...CASOS, ...CASOS_ANTIGUOS].map((c) => [c.nombre, c] as const))("%s (JSON, SSE y línea de lote)", async (_n, caso) => {
    const ahora = await cuerposDe(caso);
    expect(ahora.json).toBe(fijado[caso.nombre]!.json);
    expect(ahora.sse).toBe(fijado[caso.nombre]!.sse);
    expect(ahora.lote).toBe(fijado[caso.nombre]!.lote);
  });

  it("el fichero fijado cubre toda la batería (nadie añadió un caso sin fijarlo)", () => {
    expect(Object.keys(fijado).sort()).toEqual([...CASOS, ...CASOS_ANTIGUOS].map((c) => c.nombre).sort());
  });
});

// ── 6 · Lotes: el mismo cuerpo que generate() ─────────────────────────────────

describe("`layer.batches` manda el bucle igual que `generate()`", () => {
  const historial: ChatMessage[] = [
    { role: "system", content: "Eres un asistente de viajes." },
    { role: "user", content: "¿Tiempo en Madrid?" },
    { role: "assistant", content: "", toolCalls: [{ id: "toolu_01", name: "get_weather", arguments: '{"city":"Madrid"}' }] },
    { role: "tool", toolCallId: "toolu_01", content: "21 °C, despejado" },
  ];

  it("la línea de lote cumple las reglas y es el cuerpo de generate() sin `stream`", async () => {
    const api = apiDeMensajes(() => fin(texto("ok")));
    const p = new AnthropicProvider({ fetchImpl: api.fetchImpl });
    const req: ProviderRequest = { model: "claude-sonnet-4-6", messages: historial, tools: HERRAMIENTAS };
    await p.generate(req);
    const linea = lotesDelProveedor(p)!.cuerpo(req);
    expect(reglasDelBucle(linea)).toBeUndefined();
    expect(JSON.stringify(linea)).toBe(JSON.stringify(api.cuerpos[0]));
  });

  it("de punta a punta: `layer.batches.submit` manda `tool_use`/`tool_result` en `params`", async () => {
    const enviados: Record<string, unknown>[] = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      if (String(url).endsWith("/messages/batches") && init.method === "POST") {
        enviados.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ id: "msgbatch_1", type: "message_batch", processing_status: "in_progress" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    const layer = createSavingsLayer({ provider: new AnthropicProvider({ apiKey: "k", fetchImpl }) });
    await layer.batches.submit([{ customId: "a", request: { model: "anthropic/claude-sonnet-4-6", messages: historial, tools: HERRAMIENTAS } }]);
    const params = (enviados[0]!["requests"] as { params: Record<string, unknown> }[])[0]!.params;
    expect(reglasDelBucle(params)).toBeUndefined();
    const m = params["messages"] as Mensaje[];
    expect(m.map((x) => [x.role, ...tipos(x)])).toEqual([["user", "text"], ["assistant", "tool_use"], ["user", "tool_result"]]);
  });
});

// ── 7 · Con la búsqueda nativa entre turnos (#354) ────────────────────────────

describe("con la búsqueda nativa: pares de búsqueda, texto y llamadas, en el orden de una respuesta", () => {
  const catalogo: ToolDescriptor[] = Array.from({ length: 4 }, (_, i) => ({
    id: `servicio_${i}_consultar`,
    description: `Service ${i}`,
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  })) as unknown as ToolDescriptor[];
  const busqueda = { variant: "bm25" as const, alwaysLoaded: [] };
  const conBusqueda = pide(
    texto("Busco. "),
    { type: "server_tool_use", id: "srvtoolu_1", name: "tool_search_tool_bm25", input: { query: "servicio 1" } },
    {
      type: "tool_search_tool_result",
      tool_use_id: "srvtoolu_1",
      content: { type: "tool_search_tool_search_result", tool_references: [{ type: "tool_reference", tool_name: "servicio_1_consultar" }] },
    },
    llamada("toolu_1", "servicio_1_consultar", { id: "abiertos" }),
  );

  async function dosTurnos(p: AnthropicProvider, api: ReturnType<typeof apiDeMensajes>, textoDelTurno?: string): Promise<Mensaje[]> {
    const pregunta: ChatMessage = { role: "user", content: "¿Pedidos del servicio 1?" };
    const r1 = await p.generate({ model: "claude-sonnet-4-6", messages: [pregunta], tools: catalogo, toolSearch: busqueda });
    await p.generate({
      model: "claude-sonnet-4-6",
      messages: [
        pregunta,
        { role: "assistant", content: textoDelTurno ?? r1.text, toolCalls: r1.toolCalls! },
        { role: "tool", toolCallId: r1.toolCalls![0]!.id!, content: "RESULT: 3 pedidos" },
      ],
      tools: catalogo,
      toolSearch: busqueda,
    });
    expect(api.rechazos).toEqual([]);
    return api.cuerpos[1]!["messages"] as Mensaje[];
  }

  it("el turno del asistente lleva [par de búsqueda, texto, `tool_use`] y el siguiente su `tool_result`", async () => {
    const api = apiDeMensajes((_c, n) => (n === 0 ? conBusqueda : fin(texto("Hay 3."))));
    const m = await dosTurnos(new AnthropicProvider({ fetchImpl: api.fetchImpl }), api);
    expect(m.map((x) => [x.role, ...tipos(x)])).toEqual([
      ["user", "text"],
      ["assistant", "server_tool_use", "tool_search_tool_result", "text", "tool_use"],
      ["user", "tool_result"],
    ]);
  });

  it("con el texto del turno vacío: [par, `tool_use`], sin texto vacío", async () => {
    const api = apiDeMensajes((_c, n) => (n === 0 ? conBusqueda : fin(texto("Hay 3."))));
    const m = await dosTurnos(new AnthropicProvider({ fetchImpl: api.fetchImpl }), api, "");
    expect(tipos(m[1]!)).toEqual(["server_tool_use", "tool_search_tool_result", "tool_use"]);
  });

  it("sin la búsqueda que la cargó (otro proceso), la diferida no viaja como `tool_use`: texto, como antes", async () => {
    const api = apiDeMensajes((_c, n) => (n === 0 ? conBusqueda : fin(texto("Hay 3."))));
    const p = new AnthropicProvider({ fetchImpl: api.fetchImpl });
    const r1 = await p.generate({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "¿Servicio 1?" }], tools: catalogo, toolSearch: busqueda });
    // Un adaptador nuevo no tiene el par en memoria.
    const otra = apiDeMensajes(() => fin(texto("Hay 3.")));
    await new AnthropicProvider({ fetchImpl: otra.fetchImpl }).generate({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: "¿Servicio 1?" },
        { role: "assistant", content: r1.text, toolCalls: r1.toolCalls! },
        { role: "tool", toolCallId: r1.toolCalls![0]!.id!, content: "RESULT: 3 pedidos" },
      ],
      tools: catalogo,
      toolSearch: busqueda,
    });
    expect(otra.rechazos).toEqual([]);
    expect(JSON.stringify(otra.cuerpos[0]!["messages"])).not.toMatch(/tool_use|tool_result/);
    expect(avisosDelBucle()[0]).toMatch(/deferred behind tool search/);
  });

  it("una herramienta que no se difiere (`alwaysLoaded`) viaja nativa aunque no haya par", async () => {
    const api = apiDeMensajes(() => fin(texto("ok")));
    await new AnthropicProvider({ fetchImpl: api.fetchImpl }).generate({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: "¿Servicio 2?" },
        { role: "assistant", content: "", toolCalls: [{ id: "toolu_9", name: "servicio_2_consultar", arguments: '{"id":"x"}' }] },
        { role: "tool", toolCallId: "toolu_9", content: "RESULT" },
      ],
      tools: catalogo,
      toolSearch: { variant: "bm25", alwaysLoaded: ["servicio_2_consultar"] },
    });
    expect(api.rechazos).toEqual([]);
    const m = api.cuerpos[0]!["messages"] as Mensaje[];
    expect(m.map((x) => [x.role, ...tipos(x)])).toEqual([["user", "text"], ["assistant", "tool_use"], ["user", "tool_result"]]);
  });
});

// ── 8 · La huella del colocador ve `isError` ──────────────────────────────────

describe("`isError` en la huella del colocador", () => {
  it("entra solo cuando es cierto: sin él, la huella es la de siempre", () => {
    const base: ChatMessage = { role: "tool", toolCallId: "toolu_1", content: "Error: x" };
    expect(huellasDePrefijos("r", [{ ...base, isError: false }])).toEqual(huellasDePrefijos("r", [base]));
    expect(huellasDePrefijos("r", [{ ...base, isError: true }])[1]).not.toBe(huellasDePrefijos("r", [base])[1]);
  });
});
