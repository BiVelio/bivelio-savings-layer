import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SavingsPipeline } from "../src/pipeline/pipeline.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { MemoriaDeBusquedas, paresDeBusqueda, type BloqueCrudo } from "../src/providers/busquedas-entre-turnos.js";
import { TokenizerRegistry } from "../src/tokenizer/registry.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";
import type { ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import type { ChatMessage, SavingsReport, SavingsRequest, SavingsResult, ToolDescriptor } from "../src/contracts/types.js";
import { reglasDelBucle } from "./helpers/api-de-mensajes-falsa.js";

/**
 * LA BÚSQUEDA NATIVA ENTRE TURNOS: los pares `server_tool_use` +
 * `tool_search_tool_result` de un turno vuelven en el historial del siguiente,
 * así que el modelo reutiliza lo que ya cargó en vez de volver a buscar.
 *
 * Documentación oficial (leída el 2026-09-27,
 * https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool):
 * «On the next request, pass the assistant's content back unchanged, including
 * the `server_tool_use` and `tool_search_tool_result` blocks. […] The API
 * expands `tool_reference` blocks throughout the conversation history, so Claude
 * can reuse discovered tools in later turns without re-searching.»
 *
 * El proveedor falso de abajo VALIDA las reglas documentadas que un historial
 * así puede romper (una referencia a una herramienta ausente es un 400, todo
 * diferido es un 400, un `server_tool_use` sin resultado…) y EMULA la conducta
 * documentada del modelo: busca una herramienta diferida que no tiene cargada y
 * llama directamente a una que ya lo está. Cuenta las búsquedas. No es el modelo:
 * prueba el TRANSPORTE; lo que el modelo real haga con él lo dirá una sonda en
 * vivo.
 */

// ── El proveedor falso ────────────────────────────────────────────────────────

type Cuerpo = Record<string, unknown>;
type Bloque = Record<string, unknown>;
type Mensaje = { role: string; content: Bloque[] };

interface ApiFalsa {
  fetchImpl: typeof fetch;
  cuerpos: Cuerpo[];
  /** Búsquedas que el «modelo» corrió, en total. */
  busquedas: () => number;
}

function error400(mensaje: string): Response {
  return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: mensaje } }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Las reglas documentadas que un historial con bloques de búsqueda puede romper,
 * y después las del bucle de herramientas (`tool_use` seguido de su
 * `tool_result`, texto no vacío…: ver `helpers/api-de-mensajes-falsa.ts`).
 */
function validar(cuerpo: Cuerpo): string | undefined {
  const tools = (cuerpo["tools"] as Bloque[] | undefined) ?? [];
  const nombres = new Set(tools.map((t) => t["name"] as string));
  const busqueda = tools.find((t) => String(t["type"] ?? "").startsWith("tool_search_tool"));
  if (busqueda && tools.every((t) => t["defer_loading"] === true)) {
    return "At least one tool must have defer_loading=false. All tools cannot be deferred.";
  }
  const vistos = new Set<string>();
  for (const m of cuerpo["messages"] as Mensaje[]) {
    for (const [i, b] of m.content.entries()) {
      if (b["type"] === "text" && b["text"] === "") return "text content blocks must be non-empty";
      if (b["type"] === "server_tool_use") {
        if (m.role !== "assistant") return "server_tool_use outside an assistant turn";
        if (!busqueda || b["name"] !== busqueda["name"]) return `server tool ${String(b["name"])} is not in tools`;
        const id = b["id"] as string;
        if (vistos.has(id)) return `duplicate server tool use id ${id}`;
        vistos.add(id);
        const resultado = m.content.slice(i + 1).find((x) => x["type"] === "tool_search_tool_result" && x["tool_use_id"] === id);
        if (!resultado) return `server tool use ${id} has no result`;
      }
      if (b["type"] === "tool_search_tool_result") {
        const previo = m.content.slice(0, i).some((x) => x["type"] === "server_tool_use" && x["id"] === b["tool_use_id"]);
        if (!previo) return "tool_search_tool_result without its server_tool_use";
        const refs = ((b["content"] as { tool_references?: { tool_name: string }[] })?.tool_references ?? []);
        for (const r of refs) {
          if (!nombres.has(r.tool_name)) return `Tool reference '${r.tool_name}' not found in available tools`;
        }
      }
    }
  }
  return reglasDelBucle(cuerpo);
}

function sse(contenido: Bloque[], stopReason: string, uso: { input_tokens: number; output_tokens: number }): string {
  const ev = (tipo: string, data: Record<string, unknown>): string => `event: ${tipo}\ndata: ${JSON.stringify({ type: tipo, ...data })}\n\n`;
  let s = ev("message_start", { message: { id: "msg", role: "assistant", content: [], usage: { input_tokens: uso.input_tokens, output_tokens: 1 } } });
  contenido.forEach((b, index) => {
    if (b["type"] === "text") {
      s += ev("content_block_start", { index, content_block: { type: "text", text: "" } });
      s += ev("content_block_delta", { index, delta: { type: "text_delta", text: b["text"] } });
    } else if (b["type"] === "server_tool_use" || b["type"] === "tool_use") {
      const { input, ...inicio } = b;
      s += ev("content_block_start", { index, content_block: { ...inicio, input: {} } });
      s += ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
    } else {
      s += ev("content_block_start", { index, content_block: b });
    }
    s += ev("content_block_stop", { index });
  });
  s += ev("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: uso.output_tokens } });
  s += ev("message_stop", {});
  return s;
}

/**
 * El «modelo»: si el último turno es el resultado de una herramienta, contesta.
 * Si pide datos del «servicio N», necesita `servicio_N_consultar`: la llama
 * directamente si está cargada (no diferida, o referenciada por una búsqueda del
 * historial) y, si no, la busca primero.
 */
function apiFalsa(): ApiFalsa {
  const cuerpos: Cuerpo[] = [];
  let busquedas = 0;
  let n = 0;
  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    const cuerpo = JSON.parse(init.body) as Cuerpo;
    cuerpos.push(cuerpo);
    const fallo = validar(cuerpo);
    if (fallo) return error400(fallo);

    const tools = (cuerpo["tools"] as Bloque[] | undefined) ?? [];
    const busqueda = tools.find((t) => String(t["type"] ?? "").startsWith("tool_search_tool"));
    const mensajes = cuerpo["messages"] as Mensaje[];
    const cargadas = new Set(tools.filter((t) => t["defer_loading"] !== true && t["name"]).map((t) => t["name"] as string));
    for (const m of mensajes) {
      for (const b of m.content) {
        if (b["type"] !== "tool_search_tool_result") continue;
        for (const r of (b["content"] as { tool_references: { tool_name: string }[] }).tool_references) cargadas.add(r.tool_name);
      }
    }
    const ultimo = mensajes[mensajes.length - 1]!;
    // Lo que el «modelo» lee del último turno: su texto y, si son resultados de
    // herramienta, su contenido.
    const texto = ultimo.content
      .map((b) => String(b["type"] === "tool_result" ? (b["content"] ?? "") : (b["text"] ?? "")))
      .join("");
    const pedido = /servicio (\d+)/.exec(texto);
    const necesaria = pedido ? `servicio_${pedido[1]}_consultar` : undefined;

    let contenido: Bloque[];
    let stop = "tool_use";
    if (texto.startsWith("RESULT") || !necesaria || !tools.some((t) => t["name"] === necesaria)) {
      contenido = [{ type: "text", text: "Hecho." }];
      stop = "end_turn";
    } else if (cargadas.has(necesaria)) {
      n += 1;
      // Con un preámbulo: un turno del asistente con `content: ""` sale hoy como
      // un bloque de texto vacío, que la API rechaza (ver el informe, fuera de
      // esta línea); aquí no se prueba eso.
      contenido = [
        { type: "text", text: "Consulto. " },
        { type: "tool_use", id: `toolu_${n}`, name: necesaria, input: { id: "abiertos" } },
      ];
    } else if (busqueda) {
      n += 1;
      busquedas += 1;
      contenido = [
        { type: "text", text: "Busco. " },
        { type: "server_tool_use", id: `srvtoolu_${n}`, name: busqueda["name"], input: { query: `servicio ${pedido![1]}` } },
        {
          type: "tool_search_tool_result",
          tool_use_id: `srvtoolu_${n}`,
          content: { type: "tool_search_tool_search_result", tool_references: [{ type: "tool_reference", tool_name: necesaria }] },
        },
        { type: "tool_use", id: `toolu_${n}`, name: necesaria, input: { id: "abiertos" } },
      ];
    } else {
      n += 1;
      contenido = [
        { type: "text", text: "Consulto. " },
        { type: "tool_use", id: `toolu_${n}`, name: necesaria, input: { id: "abiertos" } },
      ];
    }
    const uso = { input_tokens: Math.ceil(init.body.length / 4), output_tokens: 20 };
    if (cuerpo["stream"] === true) {
      return new Response(sse(contenido, stop, uso), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response(JSON.stringify({ content: contenido, stop_reason: stop, usage: uso }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, cuerpos, busquedas: () => busquedas };
}

// ── Utilidades ────────────────────────────────────────────────────────────────

/** Un catálogo como llega de MCP: nombre, descripción y esquema; ni `intents` ni `risk`. */
function catalogoMcp(n: number): ToolDescriptor[] {
  const relleno = "It reads records from the service and returns them with every field the caller asked for. ".repeat(6);
  return Array.from({ length: n }, (_, i) => ({
    id: `servicio_${i}_consultar`,
    description: `Service ${i}. ${relleno}`,
    parameters: { type: "object", properties: { id: { type: "string", description: "Record id" } }, required: ["id"] },
  })) as unknown as ToolDescriptor[];
}

const POLITICA = "Eres el asistente de operaciones de una tienda de electrónica. ".repeat(40);

function capa(provider: AnthropicProvider): SavingsPipeline {
  return new SavingsPipeline({ provider, tokenizer: new TokenizerRegistry(), devUnlicensed: true } as never);
}

const traza = (r: SavingsReport, etapa: string) => r.traces.filter((t) => t.stage === etapa);

/** Quita los `cache_control`: el punto de ruptura se mueve con el prefijo y no es contenido. */
function sinMarcas<T>(x: T): T {
  return JSON.parse(JSON.stringify(x), (k, v: unknown) => (k === "cache_control" ? undefined : v)) as T;
}

type Modo = "json" | "sse";

/**
 * Una conversación de varios turnos, como la lleva un llamante que sigue el
 * contrato de `ChatMessage`: devuelve el turno del asistente con su `toolCalls`
 * y contesta cada llamada con un `role: "tool"` que lleva su `toolCallId`.
 */
async function conversar(
  layer: () => SavingsPipeline,
  modo: Modo,
  toolSearch: NonNullable<SavingsRequest["savings"]>["toolSearch"],
  tools: ToolDescriptor[],
  preguntas: string[],
): Promise<SavingsResult[]> {
  const historial: ChatMessage[] = [{ role: "system", content: POLITICA }];
  const resultados: SavingsResult[] = [];
  const pedir = async (): Promise<SavingsResult> => {
    const req: SavingsRequest = {
      model: "anthropic/claude-sonnet-4-6",
      messages: [...historial],
      tools,
      savings: { exactCache: false, toolSearch },
    };
    const r = modo === "json" ? await layer().generate(req) : await layer().generateStream(req).result;
    resultados.push(r);
    return r;
  };
  for (const pregunta of preguntas) {
    historial.push({ role: "user", content: pregunta });
    let r = await pedir();
    // Un turno que pide herramienta se contesta y se vuelve a llamar, como en el README.
    while (r.toolCalls?.length) {
      historial.push({ role: "assistant", content: r.text, toolCalls: r.toolCalls });
      for (const c of r.toolCalls) historial.push({ role: "tool", toolCallId: c.id!, name: c.name, content: "RESULT: 3 pedidos" });
      r = await pedir();
    }
    historial.push({ role: "assistant", content: r.text });
  }
  return resultados;
}

const PREGUNTAS = [
  "¿Qué pedidos del servicio 17 siguen abiertos?",
  "¿Y los cerrados del servicio 17?",
  "Ahora mira el servicio 42.",
  "¿Y otra vez el servicio 17?",
];

// ── 1 · La conversación entera, por el pipeline ───────────────────────────────

describe.each<Modo>(["json", "sse"])("una conversación de varios turnos con `toolSearch` (%s)", (modo) => {
  let aviso: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    reiniciarAvisos();
    aviso = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => aviso.mockRestore());

  it("el turno que vuelve a necesitar una herramienta ya encontrada NO vuelve a buscarla", async () => {
    const api = apiFalsa();
    const p = capa(new AnthropicProvider({ fetchImpl: api.fetchImpl }));
    await conversar(() => p, modo, "always", catalogoMcp(60), PREGUNTAS);
    // Una búsqueda por herramienta distinta (17 y 42), no una por turno que la necesita.
    expect(api.busquedas()).toBe(2);
    // Y ningún cuerpo rompió una regla documentada: el falso habría contestado 400.
    expect(api.cuerpos.map(validar).filter(Boolean)).toEqual([]);
  });

  it("el control: sin la memoria entre turnos (un adaptador nuevo por petición, como otro proceso) vuelve a buscar", async () => {
    const api = apiFalsa();
    await conversar(() => capa(new AnthropicProvider({ fetchImpl: api.fetchImpl })), modo, "always", catalogoMcp(60), PREGUNTAS);
    // 17 en el primer turno, otra vez en el segundo, 42 y 17 de nuevo: cuatro.
    expect(api.busquedas()).toBe(4);
    expect(api.cuerpos.map(validar).filter(Boolean)).toEqual([]);
  });

  it("el prefijo que se envía es estable entre turnos: el historial solo crece por el final, con los pares dentro", async () => {
    const api = apiFalsa();
    const p = capa(new AnthropicProvider({ fetchImpl: api.fetchImpl }));
    await conversar(() => p, modo, "always", catalogoMcp(60), PREGUNTAS);
    const cuerpos = sinMarcas(api.cuerpos);
    expect(cuerpos.length).toBeGreaterThan(4);
    for (let i = 1; i < cuerpos.length; i++) {
      const antes = cuerpos[i - 1]!;
      const ahora = cuerpos[i]!;
      expect(JSON.stringify(ahora["tools"])).toBe(JSON.stringify(antes["tools"]));
      expect(JSON.stringify(ahora["system"])).toBe(JSON.stringify(antes["system"]));
      const previos = antes["messages"] as Mensaje[];
      expect(JSON.stringify((ahora["messages"] as Mensaje[]).slice(0, previos.length))).toBe(JSON.stringify(previos));
    }
    // Y el par del primer turno está en el historial del último, delante del texto
    // y de la llamada, que ya viaja como `tool_use` con su `tool_result` detrás
    // (test/anthropic-bucle-de-herramientas.test.ts).
    const ultimo = cuerpos[cuerpos.length - 1]!["messages"] as Mensaje[];
    const primerAsistente = ultimo.find((m) => m.role === "assistant")!;
    expect(primerAsistente.content.map((b) => b["type"])).toEqual(["server_tool_use", "tool_search_tool_result", "text", "tool_use"]);
    expect(primerAsistente.content[0]).toEqual({ type: "server_tool_use", id: "srvtoolu_1", name: "tool_search_tool_bm25", input: { query: "servicio 17" } });
  });

  it("la traza `tool-search` dice qué se devolvió; nada se acredita (E4-bis)", async () => {
    const api = apiFalsa();
    const p = capa(new AnthropicProvider({ fetchImpl: api.fetchImpl }));
    const rs = await conversar(() => p, modo, "always", catalogoMcp(60), PREGUNTAS);
    const hizo = rs.map((r) => traza(r.report, "tool-search").find((t) => t.outcome === "provider")!.detail!);
    // Primera petición: nada que devolver. Segunda (el resultado de la herramienta): el par del 17.
    expect(hizo[0]).toMatchObject({ searches: 1, resentResults: 0, resentTools: [] });
    expect(hizo[1]).toMatchObject({ searches: 0, resentResults: 1, resentTools: ["servicio_17_consultar"] });
    // La última petición lleva los dos pares, el del 17 y el del 42.
    expect(hizo[hizo.length - 1]).toMatchObject({ resentResults: 2 });
    for (const r of rs) {
      expect(r.report.tokens.eliminatedInput).toBe(0);
      expect(traza(r.report, "reference")[0]!.detail?.["reason"]).toBe("native-tool-search");
    }
  });
});

// ── 2 · Con la palanca apagada, NADA cambia ───────────────────────────────────

describe("con `toolSearch` apagado, la memoria de búsquedas no cambia ni un byte", () => {
  // Un historial con las MISMAS ids de llamada que la memoria tiene guardadas.
  const HISTORIAL: ChatMessage[] = [
    { role: "system", content: "Sistema." },
    { role: "user", content: "¿Qué pedidos del servicio 1 siguen abiertos?" },
    { role: "assistant", content: "Consulto.", toolCalls: [{ id: "toolu_1", name: "servicio_1_consultar", arguments: '{"id":"abiertos"}' }] },
    { role: "tool", toolCallId: "toolu_1", name: "servicio_1_consultar", content: "RESULT: 3 pedidos" },
  ];
  const tools = catalogoMcp(3);

  /** Un adaptador cuya memoria ya tiene el par de `toolu_1`. */
  async function conMemoria(api: ApiFalsa): Promise<AnthropicProvider> {
    const proveedor = new AnthropicProvider({ fetchImpl: api.fetchImpl });
    await proveedor.generate({
      model: "claude-sonnet-4-6",
      messages: HISTORIAL.slice(0, 2),
      tools,
      toolSearch: { variant: "bm25", alwaysLoaded: [] },
    });
    expect(api.busquedas()).toBe(1);
    return proveedor;
  }

  it("el adaptador que recuerda un par manda, sin `toolSearch`, exactamente lo que manda uno que no recuerda nada", async () => {
    const api = apiFalsa();
    const recuerda = await conMemoria(api);
    const req: ProviderRequest = { model: "claude-sonnet-4-6", messages: HISTORIAL, tools };
    await recuerda.generate(req);
    const otra = apiFalsa();
    await new AnthropicProvider({ fetchImpl: otra.fetchImpl }).generate(req);
    const conMemoriaCuerpo = JSON.stringify(api.cuerpos[1]);
    expect(conMemoriaCuerpo).toBe(JSON.stringify(otra.cuerpos[0]));
    expect(conMemoriaCuerpo).not.toContain("server_tool_use");
  });

  it("y ese cuerpo es el de la versión anterior del adaptador, fijado a mano", async () => {
    const api = apiFalsa();
    const recuerda = await conMemoria(api);
    const enviado: string[] = [];
    const espia = (async (_u: unknown, init: { body: string }) => {
      enviado.push(init.body);
      return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    // El mismo adaptador (con su memoria) mandando por otro `fetch` no es posible;
    // se compara el cuerpo que mandó por la API falsa con el literal, y otro
    // adaptador por el espía, para fijar que los dos coinciden con él.
    //
    // Con `tools.slice(0, 1)` la herramienta llamada (`servicio_1_consultar`) no
    // viaja, así que el intercambio no puede ir como `tool_use`/`tool_result` y
    // sale como texto: el cuerpo de la versión anterior, literal.
    await recuerda.generate({ model: "claude-sonnet-4-6", messages: HISTORIAL, tools: tools.slice(0, 1) });
    await new AnthropicProvider({ fetchImpl: espia }).generate({ model: "claude-sonnet-4-6", messages: HISTORIAL, tools: tools.slice(0, 1) });
    const t = tools[0]!;
    const literal = JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      messages: [
        { role: "user", content: [{ type: "text", text: "¿Qué pedidos del servicio 1 siguen abiertos?" }] },
        { role: "assistant", content: [{ type: "text", text: "Consulto." }] },
        { role: "user", content: [{ type: "text", text: "RESULT: 3 pedidos" }] },
      ],
      system: [{ type: "text", text: "Sistema." }],
      tools: [{ name: t.id, description: t.description, input_schema: t.parameters }],
    });
    expect(JSON.stringify(api.cuerpos[1])).toBe(literal);
    expect(enviado[0]).toBe(literal);
  });

  it("por el pipeline: una conversación con la palanca apagada sale igual con un adaptador que recuerda que con uno nuevo", async () => {
    const api = apiFalsa();
    const recuerda = await conMemoria(api);
    const nueva = apiFalsa();
    const req = (): SavingsRequest => ({
      model: "anthropic/claude-sonnet-4-6",
      messages: [...HISTORIAL],
      tools: catalogoMcp(3),
      savings: { exactCache: false },
    });
    await capa(recuerda).generate(req());
    await capa(recuerda).generateStream(req()).result;
    await capa(new AnthropicProvider({ fetchImpl: nueva.fetchImpl })).generate(req());
    await capa(new AnthropicProvider({ fetchImpl: nueva.fetchImpl })).generateStream(req()).result;
    const [, jsonA, sseA] = api.cuerpos;
    const [jsonB, sseB] = nueva.cuerpos;
    expect(JSON.stringify(jsonA)).toBe(JSON.stringify(jsonB));
    expect(JSON.stringify(sseA)).toBe(JSON.stringify(sseB));
    expect(JSON.stringify(api.cuerpos.slice(1))).not.toContain("server_tool_use");
  });
});

// ── 3 · El adaptador: qué se devuelve y qué no ────────────────────────────────

describe("el adaptador devuelve un par ENTERO o no lo devuelve", () => {
  const base = (over: Partial<ProviderRequest> = {}): ProviderRequest => ({
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "¿Qué pedidos del servicio 1 siguen abiertos?" }],
    tools: catalogoMcp(3),
    toolSearch: { variant: "bm25", alwaysLoaded: [] },
    ...over,
  });
  const turnoDos = (r: ProviderResponse, over: Partial<ProviderRequest> = {}): ProviderRequest =>
    base({
      messages: [
        { role: "user", content: "¿Qué pedidos del servicio 1 siguen abiertos?" },
        { role: "assistant", content: r.text, toolCalls: r.toolCalls! },
        { role: "tool", toolCallId: r.toolCalls![0]!.id!, content: "RESULT: 3 pedidos" },
      ],
      ...over,
    });
  const asistente = (c: Cuerpo): Mensaje => (c["messages"] as Mensaje[]).find((m) => m.role === "assistant")!;

  it("JSON: el par vuelve tal cual lo devolvió la API, delante del texto y del `tool_use`, y la respuesta lo cuenta", async () => {
    const api = apiFalsa();
    const p = new AnthropicProvider({ fetchImpl: api.fetchImpl });
    const r1 = await p.generate(base());
    const r2 = await p.generate(turnoDos(r1));
    const raw = (r1.raw as { content: Bloque[] }).content;
    expect(asistente(api.cuerpos[1]!).content).toEqual([raw[1], raw[2], { type: "text", text: "Busco. " }, raw[3]]);
    expect(r2.toolSearch).toEqual({ searches: 0, loaded: [], errors: 0, resent: { results: 1, tools: ["servicio_1_consultar"] } });
  });

  it("SSE: lo recordado de un stream es byte a byte lo que se recuerda de la misma respuesta en JSON", async () => {
    const api = apiFalsa();
    const p = new AnthropicProvider({ fetchImpl: api.fetchImpl });
    let r1: ProviderResponse | undefined;
    for await (const e of p.generateStream(base())) if (e.type === "done") r1 = e.response;
    for await (const _ of p.generateStream(turnoDos(r1!))) void _;
    const json = apiFalsa();
    const q = new AnthropicProvider({ fetchImpl: json.fetchImpl });
    await q.generate(turnoDos(await q.generate(base())));
    expect(JSON.stringify(asistente(api.cuerpos[1]!))).toBe(JSON.stringify(asistente(json.cuerpos[1]!)));
    expect(asistente(api.cuerpos[1]!).content[0]).toEqual({
      type: "server_tool_use",
      id: "srvtoolu_1",
      name: "tool_search_tool_bm25",
      input: { query: "servicio 1" },
    });
  });

  it("no se devuelve si esta petición no lleva la herramienta que el par carga (la regla del 400 y la verja de escrituras)", async () => {
    const api = apiFalsa();
    const p = new AnthropicProvider({ fetchImpl: api.fetchImpl });
    const r1 = await p.generate(base());
    const r2 = await p.generate(turnoDos(r1, { tools: catalogoMcp(3).filter((t) => t.id !== "servicio_1_consultar") }));
    expect(JSON.stringify(api.cuerpos[1])).not.toContain("tool_search_tool_result");
    expect(r2.toolSearch?.resent).toBeUndefined();
    expect(api.cuerpos.map(validar).filter(Boolean)).toEqual([]);
  });

  it("no se devuelve si la búsqueda que viaja ahora es otra variante", async () => {
    const api = apiFalsa();
    const p = new AnthropicProvider({ fetchImpl: api.fetchImpl });
    const r1 = await p.generate(base());
    await p.generate(turnoDos(r1, { toolSearch: { variant: "regex", alwaysLoaded: [] } }));
    expect(JSON.stringify(api.cuerpos[1])).not.toContain("server_tool_use");
    expect(api.cuerpos.map(validar).filter(Boolean)).toEqual([]);
  });

  it("un turno repetido por el llamante no duplica el par", async () => {
    const api = apiFalsa();
    const p = new AnthropicProvider({ fetchImpl: api.fetchImpl });
    const r1 = await p.generate(base());
    const dos = turnoDos(r1);
    await p.generate({ ...dos, messages: [...dos.messages, ...dos.messages.slice(1)] });
    expect(JSON.stringify(api.cuerpos[1]).match(/"server_tool_use"/g)).toHaveLength(1);
    expect(api.cuerpos.map(validar).filter(Boolean)).toEqual([]);
  });

  it("el `cache_control` que el adaptador pone sobre un par no se queda pegado en la memoria", async () => {
    const api = apiFalsa();
    const p = new AnthropicProvider({ fetchImpl: api.fetchImpl });
    const r1 = await p.generate(base({ messages: [{ role: "user", content: "¿Qué pedidos del servicio 1 siguen abiertos?" }] }));
    // Asistente con texto vacío y SIN el resultado de su llamada (el llamante
    // sigue hablando): el intercambio no puede ir en nativo, así que el turno
    // lleva solo el par, su último bloque es el resultado de la búsqueda, y el
    // prefijo estable declarado lo cubre. Con el resultado, el último bloque
    // sería el `tool_use` y la marca no tocaría el par.
    const conResultado = turnoDos({ ...r1, text: "" });
    const dos = { ...conResultado, messages: [...conResultado.messages.slice(0, 2), { role: "user" as const, content: "¿Y bien?" }] };
    await p.generate({ ...dos, stablePrefixMessages: 2 });
    await p.generate(dos);
    const marcado = asistente(api.cuerpos[1]!).content;
    expect(marcado.map((b) => b["type"])).toEqual(["server_tool_use", "tool_search_tool_result"]);
    expect(marcado[1]!["cache_control"]).toEqual({ type: "ephemeral" });
    expect(JSON.stringify(api.cuerpos[2])).not.toContain("cache_control");
    expect(api.cuerpos.map(validar).filter(Boolean)).toEqual([]);
  });

  it("por el pipeline, con un catálogo tipado: la verja de riesgo retira la de escritura y su par no vuelve", async () => {
    const tipadas: ToolDescriptor[] = [
      ...Array.from({ length: 12 }, (_, i) => ({ id: `servicio_${i}_consultar`, intents: [`consultar servicio ${i}`], risk: "read" as const })),
      { id: "servicio_99_consultar", intents: ["elimina el servicio 99"], risk: "destructive" as const },
    ];
    const api = apiFalsa();
    const p = new AnthropicProvider({ fetchImpl: api.fetchImpl });
    // Turno 1, una ACCIÓN («elimina»): la de escritura viaja y la búsqueda la carga.
    const r1 = await capa(p).generate({
      model: "anthropic/claude-sonnet-4-6",
      messages: [{ role: "user", content: "Elimina los pedidos del servicio 99" }],
      tools: tipadas,
      savings: { exactCache: false, toolSearch: "always" },
    });
    expect(r1.report.routing.executionClass).toBe("TOOL_ACTION");
    expect(r1.toolCalls?.[0]?.name).toBe("servicio_99_consultar");
    // Turno 2 con un historial que ya no pide ninguna acción: la etapa 6 retira
    // la destructiva, así que el par que la cargó NO puede volver por detrás.
    const r2 = await capa(p).generate({
      model: "anthropic/claude-sonnet-4-6",
      messages: [
        { role: "user", content: "¿Qué pedidos del servicio 99 hay?" },
        { role: "assistant", content: r1.text, toolCalls: r1.toolCalls! },
        { role: "tool", toolCallId: r1.toolCalls![0]!.id!, content: "RESULT: 3 pedidos" },
      ],
      tools: tipadas,
      savings: { exactCache: false, toolSearch: "always" },
    });
    expect(r2.report.routing.executionClass).not.toBe("TOOL_ACTION");
    const nombres = ((api.cuerpos[1]!["tools"] as Bloque[]) ?? []).map((t) => t["name"]);
    expect(nombres).not.toContain("servicio_99_consultar");
    expect(JSON.stringify(api.cuerpos[1])).not.toContain("tool_search_tool_result");
    expect(api.cuerpos.map(validar).filter(Boolean)).toEqual([]);
  });
});

// ── 4 · La memoria ────────────────────────────────────────────────────────────

describe("la memoria de búsquedas", () => {
  const par = (n: number, herramienta = `h_${n}`): BloqueCrudo[] => [
    { type: "server_tool_use", id: `srv_${n}`, name: "tool_search_tool_bm25", input: { query: `q${n}` } },
    {
      type: "tool_search_tool_result",
      tool_use_id: `srv_${n}`,
      content: { type: "tool_search_tool_search_result", tool_references: [{ type: "tool_reference", tool_name: herramienta }] },
    },
  ];

  it("solo toma pares completos que cargan algo: sin resultado, con error o vacío, no", () => {
    const sinResultado: BloqueCrudo = { type: "server_tool_use", id: "srv_x", name: "tool_search_tool_bm25", input: {} };
    const conError: BloqueCrudo[] = [
      { type: "server_tool_use", id: "srv_e", name: "tool_search_tool_bm25", input: {} },
      { type: "tool_search_tool_result", tool_use_id: "srv_e", content: { type: "tool_search_tool_result_error", error_code: "unavailable" } },
    ];
    const vacio: BloqueCrudo[] = [
      { type: "server_tool_use", id: "srv_v", name: "tool_search_tool_bm25", input: {} },
      { type: "tool_search_tool_result", tool_use_id: "srv_v", content: { type: "tool_search_tool_search_result", tool_references: [] } },
    ];
    const web: BloqueCrudo = { type: "server_tool_use", id: "srv_w", name: "web_search", input: {} };
    const pares = paresDeBusqueda([sinResultado, ...conError, ...vacio, web, ...par(1)]);
    expect(pares.map((p) => p.id)).toEqual(["srv_1"]);
    expect(pares[0]!.herramientas).toEqual(["h_1"]);
  });

  it("está acotada: expulsa la usada hace más tiempo, y usar una la renueva", () => {
    const m = new MemoriaDeBusquedas({ bytes: 1_000_000, porEntrada: 10_000, claves: 3 });
    for (const n of [1, 2, 3]) m.recordar([`toolu_${n}`], paresDeBusqueda(par(n)));
    expect(m.para(["toolu_1"])).toBeDefined(); // renueva la 1
    m.recordar(["toolu_4"], paresDeBusqueda(par(4)));
    expect(m.tamano).toBe(3);
    expect(m.para(["toolu_2"])).toBeUndefined(); // la más vieja sin usar
    expect(m.para(["toolu_1"])).toBeDefined();
  });

  it("acota también por bytes, y no guarda una entrada que por sí sola pase del tope", () => {
    const peso = JSON.stringify(paresDeBusqueda(par(1))).length;
    const m = new MemoriaDeBusquedas({ bytes: peso * 2, porEntrada: peso, claves: 100 });
    for (const n of [1, 2, 3]) m.recordar([`toolu_${n}`], paresDeBusqueda(par(n)));
    expect(m.tamano).toBe(2);
    m.recordar(["toolu_grande"], paresDeBusqueda(par(9, "una_herramienta_con_un_nombre_mucho_mas_largo")));
    expect(m.para(["toolu_grande"])).toBeUndefined();
  });

  it("devuelve copias: mutar lo devuelto no cambia lo recordado", () => {
    const m = new MemoriaDeBusquedas();
    m.recordar(["toolu_1"], paresDeBusqueda(par(1)));
    const a = m.para(["toolu_1"])!;
    (a[0]!.resultado as Record<string, unknown>)["cache_control"] = { type: "ephemeral" };
    expect(JSON.stringify(m.para(["toolu_1"]))).not.toContain("cache_control");
  });
});
