import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import { SavingsPipeline } from "../src/pipeline/pipeline.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { TokenizerRegistry } from "../src/tokenizer/registry.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";
import type { Provider, ProviderRequest, ProviderStreamEvent } from "../src/providers/types.js";
import type { SavingsRequest, SavingsReport, ToolDescriptor } from "../src/contracts/types.js";

/**
 * LA BÚSQUEDA NATIVA EN EL CABLE: lo que sale por la red, lo que se lee de
 * vuelta y lo que el informe dice (y NO dice) de ella.
 *
 * Tres propiedades, y las tres se comprueban sobre el cuerpo que se envía, no
 * sobre una bandera:
 *
 *   1. El prefijo que renderiza el proveedor —la herramienta de búsqueda, las
 *      no diferidas y el `system` hasta el punto de ruptura— es el MISMO byte a
 *      byte pregunte lo que se pregunte y aunque el catálogo diferido crezca.
 *      Es la ley del 10-09 cumplida: nada se borra a mitad del prompt.
 *   2. Ninguna herramienta del llamante se queda fuera (el selector, con un
 *      catálogo sin tipar, manda solo las 8 primeras).
 *   3. La capa no se apunta nada: ni libro 2, ni ahorro, ni registro por
 *      referencia.
 */

// ── Utilidades ────────────────────────────────────────────────────────────────

type Cuerpo = Record<string, unknown>;
type HerramientaEnElCable = Record<string, unknown>;

const RESPUESTA_SIMPLE = {
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 100, output_tokens: 10 },
};

function fetchEspia(capturas: Cuerpo[], respuesta: unknown = RESPUESTA_SIMPLE): typeof fetch {
  return (async (_url: unknown, init: { body: string }) => {
    capturas.push(JSON.parse(init.body) as Cuerpo);
    return new Response(JSON.stringify(respuesta), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

function capa(provider: Provider, extra: Record<string, unknown> = {}): SavingsPipeline {
  return new SavingsPipeline({
    provider,
    tokenizer: new TokenizerRegistry(),
    devUnlicensed: true,
    ...extra,
  } as never);
}

/** Un catálogo como llega de MCP: nombre, descripción y esquema; ni `intents` ni `risk`. */
function catalogoMcp(n: number, desde = 0): ToolDescriptor[] {
  const relleno = "It reads records from the service and returns them with every field the caller asked for. ".repeat(6);
  return Array.from({ length: n }, (_, k) => {
    const i = desde + k;
    return {
      id: `servicio_${i}_consultar`,
      description: `Service ${i}. ${relleno}`,
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "Record id" }, campos: { type: "array", items: { type: "string" } } },
        required: ["id"],
      },
    } as unknown as ToolDescriptor;
  });
}

const POLITICA = "Eres el asistente de operaciones de una tienda de electrónica. ".repeat(40);

function peticion(pregunta: string, tools: ToolDescriptor[], savings: SavingsRequest["savings"] = {}, over: Partial<SavingsRequest> = {}): SavingsRequest {
  return {
    model: "anthropic/claude-sonnet-4-6",
    messages: [
      { role: "system", content: POLITICA },
      { role: "user", content: pregunta },
    ],
    tools,
    savings: { exactCache: false, ...savings },
    ...over,
  } as SavingsRequest;
}

const herramientasDe = (b: Cuerpo): HerramientaEnElCable[] => (b["tools"] as HerramientaEnElCable[] | undefined) ?? [];
const esBusqueda = (t: HerramientaEnElCable): boolean => typeof t["type"] === "string" && (t["type"] as string).startsWith("tool_search_tool");

/**
 * El tramo que el PROVEEDOR puede reutilizar, en su orden de renderizado
 * (tools → system → messages), con la regla documentada de la búsqueda: las
 * herramientas diferidas NO están en el prefijo. Se corta en el último punto
 * de ruptura.
 */
function prefijoDelProveedor(b: Cuerpo): string {
  const partes: string[] = [];
  let hastaAqui = -1;
  for (const t of herramientasDe(b)) {
    if (t["defer_loading"] !== true) partes.push(`tool:${JSON.stringify(t)}`);
  }
  for (const s of (b["system"] as { text: string; cache_control?: unknown }[] | undefined) ?? []) {
    partes.push(`system:${s.text}`);
    if (s.cache_control != null) hastaAqui = partes.length;
  }
  for (const m of (b["messages"] as { role: string; content: { text: string; cache_control?: unknown }[] }[]) ?? []) {
    for (const c of m.content) {
      partes.push(`${m.role}:${c.text}`);
      if (c.cache_control != null) hastaAqui = partes.length;
    }
  }
  return hastaAqui < 0 ? "" : partes.slice(0, hastaAqui).join("\n");
}

const traza = (r: SavingsReport, etapa: string) => r.traces.filter((t) => t.stage === etapa);

// ── 1 · El adaptador ─────────────────────────────────────────────────────────

describe("el adaptador de Anthropic y `toolSearch`", () => {
  const tools = catalogoMcp(3);
  const base: ProviderRequest = {
    model: "claude-sonnet-4-6",
    messages: [
      { role: "system", content: "Sistema." },
      { role: "user", content: "Hola" },
    ],
    tools,
  };

  it("sin `toolSearch` el cuerpo es el de siempre: ni herramienta de búsqueda ni `defer_loading`", async () => {
    const capturas: Cuerpo[] = [];
    await new AnthropicProvider({ fetchImpl: fetchEspia(capturas) }).generate(base);
    const ts = herramientasDe(capturas[0]!);
    expect(ts).toHaveLength(3);
    expect(ts.some(esBusqueda)).toBe(false);
    expect(ts.some((t) => "defer_loading" in t)).toBe(false);
  });

  it("con `toolSearch` la de búsqueda va PRIMERA y sin diferir, y todas las demás diferidas salvo las fijas", async () => {
    const capturas: Cuerpo[] = [];
    await new AnthropicProvider({ fetchImpl: fetchEspia(capturas) }).generate({
      ...base,
      toolSearch: { variant: "regex", alwaysLoaded: ["servicio_1_consultar"] },
    });
    const ts = herramientasDe(capturas[0]!);
    expect(ts).toHaveLength(4);
    expect(ts[0]).toEqual({ type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" });
    expect(ts.slice(1).map((t) => [t["name"], t["defer_loading"] === true])).toEqual([
      ["servicio_0_consultar", true],
      ["servicio_1_consultar", false],
      ["servicio_2_consultar", true],
    ]);
    // Las diferidas viajan ENTERAS: la API las necesita para buscar y expandir.
    expect(ts[1]!["input_schema"]).toEqual(tools[0]!.parameters);
    // Y ninguna herramienta lleva `cache_control` (con `defer_loading`, un 400).
    expect(ts.some((t) => "cache_control" in t)).toBe(false);
  });

  it("lee lo que hizo la búsqueda: búsquedas, herramientas cargadas y errores; y la llamada de verdad sigue siendo la única toolCall", async () => {
    const respuesta = {
      content: [
        { type: "text", text: "Busco una herramienta. " },
        { type: "server_tool_use", id: "srvtoolu_1", name: "tool_search_tool_bm25", input: { query: "weather" } },
        {
          type: "tool_search_tool_result",
          tool_use_id: "srvtoolu_1",
          content: { type: "tool_search_tool_search_result", tool_references: [{ type: "tool_reference", tool_name: "get_weather" }] },
        },
        { type: "server_tool_use", id: "srvtoolu_2", name: "tool_search_tool_bm25", input: { query: "(" } },
        {
          type: "tool_search_tool_result",
          tool_use_id: "srvtoolu_2",
          content: { type: "tool_search_tool_result_error", error_code: "invalid_tool_input" },
        },
        { type: "text", text: "La encontré." },
        { type: "tool_use", id: "toolu_1", name: "get_weather", input: { location: "Madrid" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 900, output_tokens: 60 },
    };
    const capturas: Cuerpo[] = [];
    const r = await new AnthropicProvider({ fetchImpl: fetchEspia(capturas, respuesta) }).generate({
      ...base,
      toolSearch: { variant: "bm25", alwaysLoaded: [] },
    });
    expect(r.toolSearch).toEqual({ searches: 2, loaded: ["get_weather"], errors: 1 });
    expect(r.toolCalls).toEqual([{ id: "toolu_1", name: "get_weather", arguments: JSON.stringify({ location: "Madrid" }) }]);
    expect(r.text).toBe("Busco una herramienta. La encontré.");
    expect(r.finishReason).toBe("tool_calls");
  });

  it("sin `toolSearch` en la petición no se informa de búsqueda alguna", async () => {
    const r = await new AnthropicProvider({ fetchImpl: fetchEspia([]) }).generate(base);
    expect(r.toolSearch).toBeUndefined();
  });

  it("en streaming lee lo mismo: el resultado llega entero en su content_block_start", async () => {
    const ev = (tipo: string, data: Record<string, unknown>): string =>
      `event: ${tipo}\ndata: ${JSON.stringify({ type: tipo, ...data })}\n\n`;
    const sse =
      ev("message_start", { message: { id: "m", role: "assistant", content: [], usage: { input_tokens: 800, output_tokens: 1 } } }) +
      ev("content_block_start", { index: 0, content_block: { type: "server_tool_use", id: "srvtoolu_x", name: "tool_search_tool_bm25" } }) +
      ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"weather"}' } }) +
      ev("content_block_stop", { index: 0 }) +
      ev("content_block_start", {
        index: 1,
        content_block: {
          type: "tool_search_tool_result",
          tool_use_id: "srvtoolu_x",
          content: { type: "tool_search_tool_search_result", tool_references: [{ type: "tool_reference", tool_name: "get_weather" }] },
        },
      }) +
      ev("content_block_stop", { index: 1 }) +
      ev("content_block_start", { index: 2, content_block: { type: "tool_use", id: "toolu_9", name: "get_weather", input: {} } }) +
      ev("content_block_delta", { index: 2, delta: { type: "input_json_delta", partial_json: '{"location":"Madrid"}' } }) +
      ev("content_block_stop", { index: 2 }) +
      ev("message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 40 } }) +
      ev("message_stop", {});
    const fetchImpl = (async () =>
      new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
    const eventos: ProviderStreamEvent[] = [];
    for await (const e of new AnthropicProvider({ fetchImpl }).generateStream({ ...base, toolSearch: { variant: "bm25", alwaysLoaded: [] } })) {
      eventos.push(e);
    }
    const hecho = eventos[eventos.length - 1]!;
    if (hecho.type !== "done") throw new Error("sin done");
    expect(hecho.response.toolSearch).toEqual({ searches: 1, loaded: ["get_weather"], errors: 0 });
    // El `input_json_delta` de la búsqueda NO se cuela en los argumentos de nadie.
    expect(hecho.response.toolCalls).toEqual([{ id: "toolu_9", name: "get_weather", arguments: '{"location":"Madrid"}' }]);
  });
});

// ── 2 · El pipeline ──────────────────────────────────────────────────────────

describe("el pipeline con `savings.toolSearch`", () => {
  let aviso: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    reiniciarAvisos();
    aviso = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => aviso.mockRestore());

  it("`auto` contra la API oficial con un catálogo grande: viaja ENTERO y diferido tras la búsqueda del proveedor", async () => {
    const capturas: Cuerpo[] = [];
    const tools = catalogoMcp(200);
    const { report } = await capa(new AnthropicProvider({ fetchImpl: fetchEspia(capturas) })).generate(
      peticion("¿Qué pedidos del servicio 17 siguen abiertos?", tools, { toolSearch: "auto" }),
    );
    const ts = herramientasDe(capturas[0]!);
    expect(ts).toHaveLength(201);
    expect(ts[0]).toEqual({ type: "tool_search_tool_bm25_20251119", name: "tool_search_tool_bm25" });
    expect(ts.slice(1).every((t) => t["defer_loading"] === true)).toBe(true);
    expect(ts.slice(1).map((t) => t["name"])).toEqual(tools.map((t) => t.id));

    const decision = traza(report, "tool-search")[0]!;
    expect(decision.outcome).toBe("native");
    expect(decision.detail?.["deferred"]).toBe(200);
  });

  it("la capa NO se apunta nada: ni libro 2, ni ahorro, ni registro por referencia (E4-bis)", async () => {
    const capturas: Cuerpo[] = [];
    const { report } = await capa(new AnthropicProvider({ fetchImpl: fetchEspia(capturas) })).generate(
      peticion("¿Qué pedidos del servicio 17 siguen abiertos?", catalogoMcp(200), { toolSearch: "auto" }),
    );
    expect(report.tokens.eliminatedInput).toBe(0);
    expect(report.cost.netSavings).toBe(0);
    expect(traza(report, "tool-selector")).toHaveLength(0);
    const referencia = traza(report, "reference")[0]!;
    expect(referencia.outcome).toBe("not-written");
    expect(referencia.detail?.["reason"]).toBe("native-tool-search");
  });

  it("el prefijo del proveedor es el MISMO byte a byte con otra pregunta y con el catálogo diferido más grande", async () => {
    const capturas: Cuerpo[] = [];
    const p = capa(new AnthropicProvider({ fetchImpl: fetchEspia(capturas) }));
    const tools = catalogoMcp(200);
    await p.generate(peticion("¿Qué pedidos del servicio 17 siguen abiertos?", tools, { toolSearch: "auto" }));
    await p.generate(peticion("Dame el stock del almacén de Valencia", tools, { toolSearch: "auto" }));
    // Un servidor MCP más conectado: el catálogo crece por el FINAL y por el PRINCIPIO.
    await p.generate(
      peticion("¿Qué pedidos del servicio 17 siguen abiertos?", [...catalogoMcp(1, 900), ...tools, ...catalogoMcp(5, 1000)], {
        toolSearch: "auto",
      }),
    );
    const prefijos = capturas.map(prefijoDelProveedor);
    expect(prefijos[0]!.length).toBeGreaterThan(0);
    expect(prefijos[0]!.startsWith('tool:{"type":"tool_search_tool_bm25_20251119"')).toBe(true);
    expect(prefijos[1]).toBe(prefijos[0]);
    expect(prefijos[2]).toBe(prefijos[0]);
  });

  it("con `alwaysLoaded` las fijas entran en el prefijo y siguen siendo las mismas en cada pregunta", async () => {
    const capturas: Cuerpo[] = [];
    const p = capa(new AnthropicProvider({ fetchImpl: fetchEspia(capturas) }));
    const tools = catalogoMcp(200);
    const opciones = { toolSearch: { mode: "auto" as const, alwaysLoaded: ["servicio_3_consultar"] } };
    await p.generate(peticion("¿Qué pedidos del servicio 17 siguen abiertos?", tools, opciones));
    await p.generate(peticion("Dame el stock del almacén de Valencia", tools, opciones));
    const fijas = herramientasDe(capturas[0]!).filter((t) => t["defer_loading"] !== true).map((t) => t["name"]);
    expect(fijas).toEqual(["tool_search_tool_bm25", "servicio_3_consultar"]);
    expect(prefijoDelProveedor(capturas[1]!)).toBe(prefijoDelProveedor(capturas[0]!));
  });

  it("`auto` contra un proxy NO se enciende (se queda el selector) y `always` sí", async () => {
    const tools = catalogoMcp(200);
    const auto: Cuerpo[] = [];
    const r1 = await capa(new AnthropicProvider({ baseUrl: "http://localhost:8787/v1", fetchImpl: fetchEspia(auto) })).generate(
      peticion("¿Qué pedidos del servicio 17 siguen abiertos?", tools, { toolSearch: "auto" }),
    );
    expect(herramientasDe(auto[0]!).some(esBusqueda)).toBe(false);
    expect(herramientasDe(auto[0]!)).toHaveLength(8);
    expect(traza(r1.report, "tool-search")[0]!.outcome).toBe("selector");

    const siempre: Cuerpo[] = [];
    const r2 = await capa(new AnthropicProvider({ baseUrl: "http://localhost:8787/v1", fetchImpl: fetchEspia(siempre) })).generate(
      peticion("¿Qué pedidos del servicio 17 siguen abiertos?", tools, { toolSearch: "always" }),
    );
    expect(herramientasDe(siempre[0]!)).toHaveLength(201);
    expect(traza(r2.report, "tool-search")[0]!.outcome).toBe("native");
  });

  it("con el adaptador de OpenAI (Chat Completions) se queda el selector, y la traza dice por qué", async () => {
    const vistas: Cuerpo[] = [];
    const fetchImpl = (async (_u: unknown, init: { body: string }) => {
      vistas.push(JSON.parse(init.body) as Cuerpo);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 5 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const { report } = await capa(new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", fetchImpl })).generate(
      peticion("¿Qué pedidos del servicio 17 siguen abiertos?", catalogoMcp(200), { toolSearch: "always" }, { model: "openai/gpt-6-luna" }),
    );
    const d = traza(report, "tool-search")[0]!;
    expect(d.outcome).toBe("selector");
    expect(String(d.detail?.["reason"])).toContain("Chat Completions");
    expect(JSON.stringify(vistas[0])).not.toContain("defer_loading");
  });

  it("con un catálogo TIPADO, una petición que no es acción sigue sin recibir herramientas de escritura", async () => {
    const tipadas: ToolDescriptor[] = [
      ...Array.from({ length: 12 }, (_, i) => ({ id: `leer_${i}`, intents: [`consultar cosa ${i}`], risk: "read" as const })),
      { id: "borrar_pedido", intents: ["borrar pedido"], risk: "destructive" as const },
    ];
    const capturas: Cuerpo[] = [];
    const { report } = await capa(new AnthropicProvider({ fetchImpl: fetchEspia(capturas) })).generate(
      peticion("¿Cuántos pedidos hay abiertos?", tipadas, { toolSearch: "always" }),
    );
    expect(report.routing.executionClass).not.toBe("TOOL_ACTION");
    const nombres = herramientasDe(capturas[0]!).map((t) => t["name"]);
    expect(nombres).not.toContain("borrar_pedido");
    // Las 12 de lectura viajan todas: la relevancia no poda, elige el modelo.
    expect(nombres.filter((n) => String(n).startsWith("leer_"))).toHaveLength(12);
    // Y lo que retiró la verja de riesgo se apunta como hoy lo apunta el selector.
    expect(report.tokens.eliminatedInput).toBeGreaterThan(0);
  });

  it("con un contrato de salida se queda el selector", async () => {
    const { report } = await capa(new AnthropicProvider({ fetchImpl: fetchEspia([], { ...RESPUESTA_SIMPLE, content: [{ type: "text", text: '{"ok":true}' }] }) })).generate(
      peticion("¿Qué pedidos del servicio 17 siguen abiertos?", catalogoMcp(200), { toolSearch: "always" }, {
        response: { contractId: "c:v1", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } },
      }),
    );
    expect(traza(report, "tool-search")[0]!.outcome).toBe("selector");
  });

  it("si también se pidió `toolDiscovery`, gana la búsqueda nativa y el sondeo no corre", async () => {
    const capturas: Cuerpo[] = [];
    const { report } = await capa(new AnthropicProvider({ fetchImpl: fetchEspia(capturas) })).generate(
      peticion("¿Qué pedidos del servicio 17 siguen abiertos?", catalogoMcp(200), { toolSearch: "auto", toolDiscovery: true }),
    );
    expect(capturas).toHaveLength(1);
    expect(traza(report, "tool-discovery")[0]!.outcome).toBe("skipped (native tool search applies)");
  });

  it("lo que hizo la búsqueda del proveedor queda en la traza, y la toolCall llega al llamante", async () => {
    const respuesta = {
      content: [
        { type: "server_tool_use", id: "srvtoolu_1", name: "tool_search_tool_bm25", input: { query: "orders service 17" } },
        {
          type: "tool_search_tool_result",
          tool_use_id: "srvtoolu_1",
          content: { type: "tool_search_tool_search_result", tool_references: [{ type: "tool_reference", tool_name: "servicio_17_consultar" }] },
        },
        { type: "tool_use", id: "toolu_1", name: "servicio_17_consultar", input: { id: "abiertos" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 1200, output_tokens: 45 },
    };
    const r = await capa(new AnthropicProvider({ fetchImpl: fetchEspia([], respuesta) })).generate(
      peticion("¿Qué pedidos del servicio 17 siguen abiertos?", catalogoMcp(200), { toolSearch: "auto" }),
    );
    expect(r.toolCalls?.map((t) => t.name)).toEqual(["servicio_17_consultar"]);
    const hizo = traza(r.report, "tool-search").find((t) => t.outcome === "provider")!;
    expect(hizo.detail).toMatchObject({ searches: 1, loaded: ["servicio_17_consultar"], errors: 0 });
  });

  it("con la palanca APAGADA y un catálogo sin tipar recortado, avisa UNA vez de que existe la búsqueda nativa", async () => {
    const p = capa(new AnthropicProvider({ fetchImpl: fetchEspia([]) }));
    await p.generate(peticion("¿Qué pedidos del servicio 17 siguen abiertos?", catalogoMcp(20)));
    await p.generate(peticion("Otra pregunta", catalogoMcp(20)));
    const avisos = aviso.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("toolSearch"));
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toContain("first 8 of 20");
  });

  it("no avisa si el modelo no admite la búsqueda nativa, ni si el catálogo cabe entero", async () => {
    const p = capa(new AnthropicProvider({ fetchImpl: fetchEspia([]) }));
    await p.generate(peticion("¿Qué pedidos siguen abiertos?", catalogoMcp(20), {}, { model: "anthropic/claude-sonnet-5" }));
    await p.generate(peticion("¿Qué pedidos siguen abiertos?", catalogoMcp(5)));
    expect(aviso.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("toolSearch"))).toHaveLength(0);
  });
});
