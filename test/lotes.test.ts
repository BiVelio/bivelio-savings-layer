import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { AnthropicProvider } from "../src/providers/anthropic.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { MockProvider } from "../src/providers/mock.js";
import { createSavingsLayer } from "../src/pipeline/create.js";
import { BatchSubmitError } from "../src/pipeline/errors.js";
import { LicenseError } from "../src/license/errors.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";
import type { BatchJob, BatchRequest } from "../src/contracts/batch.js";
import type { JsonSchema, SavingsRequest } from "../src/contracts/types.js";
import type { Provider, ProviderRequest } from "../src/providers/types.js";

/**
 * LA SUPERFICIE DE LOTES (`layer.batches`): LO QUE SE ENVÍA, LO QUE SE LEE Y LO
 * QUE VALE.
 *
 * Tres promesas que este fichero fija contra un servidor de mentira que habla el
 * dialecto de cada Batch API (Message Batches de Anthropic; Files + Batches de
 * OpenAI):
 *
 *   1. Cada petición del lote viaja con el MISMO cuerpo que mandaría generate()
 *      por el mismo adaptador. Dos traducciones derivarían.
 *   2. Un resultado se valora con el `usage` del proveedor a las dos tarifas
 *      publicadas, y el tier sale del proveedor: Anthropic lo pone en cada
 *      resultado; en OpenAI es el del canal (su registro de lote). Sin tier
 *      leído no hay crédito.
 *   3. Nada se mide ni se cobra: el ahorro de lote se REPORTA.
 */

interface Llamada {
  url: string;
  method: string;
  headers: Record<string, string>;
  json?: Record<string, unknown>;
  form?: FormData;
}

type Respuesta = { estado?: number; json?: unknown; texto?: string };

/** Un servidor de mentira: registra cada llamada y contesta lo que diga `manejar`. */
function servidor(manejar: (ll: Llamada) => Respuesta | Promise<Respuesta>) {
  const llamadas: Llamada[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const ll: Llamada = {
      url: String(url),
      method: String(init.method ?? "GET"),
      headers,
      ...(typeof init.body === "string" ? { json: JSON.parse(init.body) as Record<string, unknown> } : {}),
      ...(init.body instanceof FormData ? { form: init.body } : {}),
    };
    llamadas.push(ll);
    const r = await manejar(ll);
    const cuerpo = r.texto ?? JSON.stringify(r.json ?? {});
    return new Response(cuerpo, {
      status: r.estado ?? 200,
      headers: { "content-type": r.texto !== undefined ? "application/x-jsonl" : "application/json" },
    });
  }) as unknown as typeof fetch;
  return { llamadas, fetchImpl };
}

const jsonl = (lineas: unknown[]): string => lineas.map((l) => JSON.stringify(l)).join("\n") + "\n";

const peticion = (contenido: string, extra: Partial<SavingsRequest> = {}): SavingsRequest => ({
  model: "anthropic/claude-haiku-4-5",
  messages: [
    { role: "system", content: "You label support tickets." },
    { role: "user", content: contenido },
  ],
  ...extra,
});

const lote = (n: number, extra: Partial<SavingsRequest> = {}): BatchRequest[] =>
  Array.from({ length: n }, (_, i) => ({ customId: `row-${i}`, request: peticion(`ticket ${i}`, extra) }));

beforeEach(() => {
  reiniciarAvisos();
});

// ── Anthropic: Message Batches ───────────────────────────────────────────────

const ANTHROPIC = "https://api.anthropic.com/v1";

/** Un mensaje de resultado con la forma de la API de Mensajes. */
function mensaje(uso: Record<string, unknown>, contenido: unknown[] = [{ type: "text", text: "billing" }]) {
  return { id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-4-5", content: contenido, stop_reason: "end_turn", usage: uso };
}

const USO_BATCH = {
  input_tokens: 1000,
  cache_read_input_tokens: 4000,
  cache_creation_input_tokens: 0,
  output_tokens: 200,
  service_tier: "batch",
};

function anthropic(opciones: {
  lineas?: unknown[];
  estado?: string;
  fallarCreacion?: number;
  baseUrl?: string;
} = {}) {
  let creados = 0;
  const srv = servidor((ll) => {
    const ruta = ll.url.replace(opciones.baseUrl ?? ANTHROPIC, "");
    if (ll.method === "POST" && ruta === "/messages/batches") {
      creados += 1;
      if (opciones.fallarCreacion === creados) return { estado: 500, json: { error: { message: "boom" } } };
      return { json: { id: `msgbatch_${creados}`, type: "message_batch", processing_status: "in_progress" } };
    }
    if (ll.method === "GET" && /^\/messages\/batches\/[^/]+$/.test(ruta)) {
      return {
        json: {
          id: ruta.split("/").pop(),
          processing_status: opciones.estado ?? "ended",
          request_counts: { processing: 0, succeeded: 3, errored: 1, canceled: 1, expired: 1 },
          // Un `results_url` a OTRO host: la capa no lo sigue nunca (llevaría la clave).
          results_url: "https://evil.example/results",
        },
      };
    }
    if (ll.method === "GET" && /^\/messages\/batches\/[^/]+\/results$/.test(ruta)) {
      return { texto: jsonl(opciones.lineas ?? []) };
    }
    if (ll.method === "POST" && /\/cancel$/.test(ruta)) return { json: { processing_status: "canceling" } };
    return { estado: 404, json: {} };
  });
  const provider = new AnthropicProvider({
    apiKey: "test-key",
    fetchImpl: srv.fetchImpl,
    ...(opciones.baseUrl ? { baseUrl: opciones.baseUrl } : {}),
  });
  return { ...srv, provider, layer: createSavingsLayer({ provider }) };
}

describe("Anthropic · submit", () => {
  it("cada línea lleva el MISMO cuerpo que mandaría generate(), y el trabajo es JSON plano sin contenido", async () => {
    const { llamadas, layer } = anthropic();
    const esquema: JsonSchema = { type: "object", properties: { label: { type: "string" } }, required: ["label"], additionalProperties: false };
    const peticiones: BatchRequest[] = [
      { customId: "a", request: peticion("ticket a") },
      { customId: "b", request: peticion("ticket b", { response: { contractId: "label:v1", schema: esquema, maxOutputTokens: 50 } }) },
      { customId: "c", request: peticion("ticket c", { response: { contractId: "label:v1", schema: esquema } }) },
    ];
    const job = await layer.batches.submit(peticiones);

    expect(llamadas).toHaveLength(1);
    const envio = llamadas[0]!;
    expect(envio.url).toBe(`${ANTHROPIC}/messages/batches`);
    expect(envio.method).toBe("POST");
    expect(envio.headers["x-api-key"]).toBe("test-key");
    expect(envio.headers["anthropic-version"]).toBe("2023-06-01");
    const reqs = envio.json!["requests"] as { custom_id: string; params: Record<string, unknown> }[];
    expect(reqs.map((r) => r.custom_id)).toEqual(["a", "b", "c"]);

    // Paridad con generate(): el mismo adaptador, la misma petición neutra.
    const capturados: Record<string, unknown>[] = [];
    const espia = (async (_u: string, init: RequestInit) => {
      capturados.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ content: [{ type: "text", text: "x" }], usage: { input_tokens: 1, output_tokens: 1 } }));
    }) as unknown as typeof fetch;
    const directo = new AnthropicProvider({ apiKey: "k", fetchImpl: espia });
    const neutra = (r: SavingsRequest): ProviderRequest => ({
      model: r.model,
      messages: r.messages,
      ...(r.response ? { schema: r.response.schema } : {}),
      ...(r.response?.maxOutputTokens != null ? { maxOutputTokens: r.response.maxOutputTokens } : {}),
    });
    for (const p of peticiones) await directo.generate(neutra(p.request));
    expect(reqs.map((r) => r.params)).toEqual(capturados);
    // Sin `stream` (un lote lo rechaza) y con el id desnudo del API oficial.
    expect(reqs[0]!.params["stream"]).toBeUndefined();
    expect(reqs[0]!.params["model"]).toBe("claude-haiku-4-5");
    // El contrato viaja como la herramienta del adaptador.
    expect(JSON.stringify(reqs[1]!.params["tools"])).toContain("bvsala_contract");

    expect(job).toEqual({
      kind: "bvsala.batch",
      version: 1,
      provider: "anthropic",
      endpoint: ANTHROPIC,
      batchIds: ["msgbatch_1"],
      submittedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      requests: [
        { customId: "a", model: "anthropic/claude-haiku-4-5", batch: 0 },
        { customId: "b", model: "anthropic/claude-haiku-4-5", batch: 0, schema: 0 },
        { customId: "c", model: "anthropic/claude-haiku-4-5", batch: 0, schema: 0 },
      ],
      schemas: [esquema],
    });
    // JSON de ida y vuelta, y sin una palabra del prompt dentro.
    expect(JSON.parse(JSON.stringify(job))).toEqual(job);
    expect(JSON.stringify(job)).not.toContain("ticket");
  });

  it("trocea por `maxRequestsPerBatch` y apunta en qué trozo va cada petición", async () => {
    const { llamadas, layer } = anthropic();
    const job = await layer.batches.submit(lote(5), { maxRequestsPerBatch: 2 });
    expect(llamadas.filter((l) => l.method === "POST")).toHaveLength(3);
    expect(job.batchIds).toEqual(["msgbatch_1", "msgbatch_2", "msgbatch_3"]);
    expect(job.requests.map((r) => r.batch)).toEqual([0, 0, 1, 1, 2]);
  });

  it("`cacheSharedPrefix` marca la cabecera de `system` con `cache_control`; sin él, nada", async () => {
    const con = anthropic();
    await con.layer.batches.submit(lote(1), { cacheSharedPrefix: true });
    const sin = anthropic();
    await sin.layer.batches.submit(lote(1));
    const sistema = (ll: Llamada) =>
      ((ll.json!["requests"] as { params: Record<string, unknown> }[])[0]!.params["system"]) as Record<string, unknown>[];
    expect(sistema(con.llamadas[0]!).at(-1)!["cache_control"]).toEqual({ type: "ephemeral" });
    expect(JSON.stringify(sin.llamadas[0]!.json)).not.toContain("cache_control");
  });

  it("rechaza ANTES de enviar nada: ids malos o repetidos, retrieval, structuredData, sin mensajes, sin turno de usuario", async () => {
    const casos: BatchRequest[][] = [
      [{ customId: "con espacio", request: peticion("x") }],
      [{ customId: "x".repeat(65), request: peticion("x") }],
      [
        { customId: "dup", request: peticion("x") },
        { customId: "dup", request: peticion("y") },
      ],
      [{ customId: "r", request: peticion("x", { retrieval: { mode: "auto" } }) }],
      [{ customId: "s", request: peticion("x", { structuredData: { rows: [1] } }) }],
      [{ customId: "m", request: { model: "anthropic/claude-haiku-4-5", messages: [] } }],
      // Solo `system`: la API de Mensajes exige un turno; lo dice el adaptador, con el id.
      [{ customId: "solo-system", request: { model: "anthropic/claude-haiku-4-5", messages: [{ role: "system", content: "x" }] } }],
    ];
    for (const caso of casos) {
      const { llamadas, layer } = anthropic();
      await expect(layer.batches.submit(caso)).rejects.toBeInstanceOf(TypeError);
      expect(llamadas).toHaveLength(0);
    }
    const { layer } = anthropic();
    await expect(layer.batches.submit([])).rejects.toThrow(/non-empty array/);
    await expect(layer.batches.submit(lote(1), { maxRequestsPerBatch: 0 })).rejects.toThrow(/positive integer/);
    await expect(
      layer.batches.submit([{ customId: "solo-system", request: { model: "anthropic/claude-haiku-4-5", messages: [{ role: "system", content: "x" }] } }]),
    ).rejects.toThrow(/solo-system/);
  });

  it("si un trozo falla después de crear otros, el error lleva el trabajo PARCIAL: lo creado se factura y no se pierde", async () => {
    const { layer } = anthropic({ fallarCreacion: 2 });
    const err = await layer.batches.submit(lote(5), { maxRequestsPerBatch: 2 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BatchSubmitError);
    const e = err as BatchSubmitError;
    expect(e.job.batchIds).toEqual(["msgbatch_1"]);
    expect(e.job.requests.map((r) => r.customId)).toEqual(["row-0", "row-1"]);
    expect(e.notSubmitted).toEqual(["row-2", "row-3", "row-4"]);
    expect(e.message).toMatch(/1 of 3 provider batches were created/);

    // Si falla el PRIMERO, no hay nada creado y el mensaje no dice lo contrario.
    const primero = anthropic({ fallarCreacion: 1 });
    const e0 = (await primero.layer.batches.submit(lote(2)).catch((x: unknown) => x)) as BatchSubmitError;
    expect(e0).toBeInstanceOf(BatchSubmitError);
    expect(e0.job.batchIds).toEqual([]);
    expect(e0.notSubmitted).toEqual(["row-0", "row-1"]);
    expect(e0.message).toMatch(/before any provider batch was created/);
  });
});

describe("Anthropic · results", () => {
  const RESULTADOS = [
    // Tier leído del `usage`: se valora.
    { custom_id: "row-0", result: { type: "succeeded", message: mensaje(USO_BATCH) } },
    // Sin `service_tier`: no se sabe a qué tarifa se cobró → nada.
    { custom_id: "row-1", result: { type: "succeeded", message: mensaje({ ...USO_BATCH, service_tier: undefined }) } },
    // «standard»: tarifa estándar → nada.
    { custom_id: "row-2", result: { type: "succeeded", message: mensaje({ ...USO_BATCH, service_tier: "standard" }) } },
    { custom_id: "row-3", result: { type: "errored", error: { type: "error", error: { type: "invalid_request_error", message: "bad" } } } },
    { custom_id: "row-4", result: { type: "canceled" } },
    { custom_id: "row-5", result: { type: "expired" } },
    // row-6 sin línea: «missing».
  ];

  it("cada resultado con su desenlace, y el de lote valorado `measured` a las dos tarifas publicadas", async () => {
    const { layer, llamadas } = anthropic({ lineas: RESULTADOS });
    const job = await layer.batches.submit(lote(7));
    const res = await layer.batches.results(job);

    expect(res.ended).toBe(true);
    const por = Object.fromEntries(res.items.map((i) => [i.customId, i]));
    expect(por["row-0"]!.outcome).toBe("succeeded");
    expect(por["row-0"]!.text).toBe("billing");
    expect(por["row-0"]!.servedTier).toBe("batch");
    expect(por["row-0"]!.usage).toMatchObject({ inputTokens: 5000, cachedInputTokens: 4000, cacheWriteInputTokens: 0, outputTokens: 200 });
    // Haiku 4.5, catálogo: 1 / 0,10 (lectura) / 5 por 1M; lote (página de precios,
    // 2026-09-27): 0,50 / 0,05 / 2,50. Estándar 0,0024 · lote 0,0012.
    const t = por["row-0"]!.tierSaving!;
    expect(t.basis).toBe("measured");
    expect(t.standardCost).toBeCloseTo(0.0024, 10);
    expect(t.appliedCost).toBeCloseTo(0.0012, 10);
    expect(t.amount).toBeLessThanOrEqual(0.0012);
    expect(t.amount).toBeGreaterThan(0.0012 - 2e-10);
    expect(t.pricesCheckedOn).toBe("2026-09-27");
    expect(t.basisReason).toMatch(/platform\.claude\.com/);

    expect(por["row-1"]!.tierSaving).toBeUndefined();
    expect(por["row-1"]!.reason).toMatch(/no service tier/);
    expect(por["row-2"]!.tierSaving).toBeUndefined();
    expect(por["row-2"]!.reason).toMatch(/not billed below the standard rate/);
    expect(por["row-3"]).toMatchObject({ outcome: "errored", error: { type: "invalid_request_error", message: "bad" } });
    expect(por["row-4"]!.outcome).toBe("canceled");
    expect(por["row-5"]!.outcome).toBe("expired");
    expect(por["row-6"]!.outcome).toBe("missing");

    expect(res.summary).toMatchObject({
      requestCount: 7,
      succeeded: 3,
      errored: 1,
      canceled: 1,
      expired: 1,
      missing: 1,
      pending: 0,
      credited: 1,
      basis: "measured",
      creditedLedger: "none",
      pricesCheckedOn: "2026-09-27",
    });
    expect(res.summary.tierSaving).toBe(t.amount);
    expect(res.summary.reason).toMatch(/never billed/);

    // Los resultados se piden a la BASE del adaptador, nunca al `results_url` ajeno.
    expect(llamadas.some((l) => l.url.includes("evil.example"))).toBe(false);
    expect(llamadas.some((l) => l.url === `${ANTHROPIC}/messages/batches/msgbatch_1/results`)).toBe(true);
  });

  it("el contrato: la herramienta del adaptador se sirve como texto y `data` sale validado", async () => {
    const esquema: JsonSchema = { type: "object", properties: { label: { type: "string" } }, required: ["label"], additionalProperties: false };
    const lineas = [
      { custom_id: "ok", result: { type: "succeeded", message: mensaje(USO_BATCH, [{ type: "tool_use", id: "t1", name: "bvsala_contract", input: { label: "billing" } }]) } },
      { custom_id: "mal", result: { type: "succeeded", message: mensaje(USO_BATCH, [{ type: "tool_use", id: "t2", name: "bvsala_contract", input: { other: 1 } }]) } },
    ];
    const { layer } = anthropic({ lineas });
    const contrato = { contractId: "label:v1", schema: esquema };
    const job = await layer.batches.submit([
      { customId: "ok", request: peticion("x", { response: contrato }) },
      { customId: "mal", request: peticion("y", { response: contrato }) },
    ]);
    const res = await layer.batches.results<{ label: string }>(job);
    const ok = res.items.find((i) => i.customId === "ok")!;
    expect(ok.contract).toBe("met");
    expect(ok.data).toEqual({ label: "billing" });
    const mal = res.items.find((i) => i.customId === "mal")!;
    expect(mal.contract).toBe("missed");
    expect(mal.data).toBeUndefined();
  });

  it("detrás de un proxy (host no oficial) el ahorro es `estimated`, y con `costModels` también", async () => {
    const proxy = anthropic({ lineas: [RESULTADOS[0]], baseUrl: "https://gateway.example/v1" });
    const job = await proxy.layer.batches.submit(lote(1));
    expect(job.endpoint).toBe("https://gateway.example/v1");
    const r1 = await proxy.layer.batches.results(job);
    expect(r1.items[0]!.tierSaving!.basis).toBe("estimated");
    expect(r1.items[0]!.tierSaving!.basisReason).toMatch(/not the provider's own API/);
    expect(r1.summary.basis).toBe("estimated");

    const srv = anthropic({ lineas: [RESULTADOS[0]] });
    const conPrecio = createSavingsLayer({
      provider: srv.provider,
      costModels: { "claude-haiku-4-5": { inputPer1k: 0.0008, outputPer1k: 0.004, cachedInputPer1k: 0.00008 } },
    });
    const job2 = await conPrecio.batches.submit(lote(1));
    const r2 = await conPrecio.batches.results(job2);
    expect(r2.items[0]!.tierSaving!.basis).toBe("estimated");
    expect(r2.items[0]!.tierSaving!.basisReason).toMatch(/costModels/);
    // Nunca por encima de la diferencia publicada.
    expect(r2.items[0]!.tierSaving!.amount).toBeLessThanOrEqual(0.0012);
  });

  it("mientras el lote corre no hay resultados ni cifras: `ended: false` y todo pendiente", async () => {
    const { layer, llamadas } = anthropic({ estado: "in_progress", lineas: RESULTADOS });
    const job = await layer.batches.submit(lote(3));
    const res = await layer.batches.results(job);
    expect(res.ended).toBe(false);
    expect(res.items).toEqual([]);
    expect(res.summary).toMatchObject({ pending: 3, credited: 0, tierSaving: 0, basis: "none" });
    expect(llamadas.some((l) => l.url.endsWith("/results"))).toBe(false);
  });

  it("status y cancel hablan con la API de lotes y resumen lo que dice el proveedor", async () => {
    const { layer, llamadas } = anthropic({ estado: "in_progress" });
    const job = await layer.batches.submit(lote(2));
    const st = await layer.batches.status(job);
    expect(st).toMatchObject({ state: "in_progress", requestCount: 2, batches: [{ id: "msgbatch_1", status: "in_progress" }] });
    await layer.batches.cancel(job);
    expect(llamadas.some((l) => l.method === "POST" && l.url === `${ANTHROPIC}/messages/batches/msgbatch_1/cancel`)).toBe(true);
  });

  it("un trabajo de otro proveedor o de otra base se rechaza en claro", async () => {
    const { layer } = anthropic();
    const job = await layer.batches.submit(lote(1));
    const otro = anthropic({ baseUrl: "https://gateway.example/v1" });
    await expect(otro.layer.batches.results(job)).rejects.toThrow(/submitted to anthropic at https:\/\/api\.anthropic\.com\/v1/);
    await expect(layer.batches.status({ ...job, kind: "otro" } as unknown as BatchJob)).rejects.toThrow(/not a batch job/);
    await expect(layer.batches.status({ ...job, requests: [{ customId: "x", model: "m", batch: 3 }] })).rejects.toThrow(
      /not a batch job/,
    );
  });
});

// ── OpenAI: Files + Batches ───────────────────────────────────────────────────

const OPENAI = "https://api.openai.com/v1";

function chat(uso: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    model: "gpt-4o-mini-2024-07-18",
    choices: [{ index: 0, message: { role: "assistant", content: "billing" }, finish_reason: "stop" }],
    usage: uso,
    ...extra,
  };
}

function openai(opciones: { salida?: unknown[]; errores?: unknown[]; estado?: string; baseUrl?: string; fallos?: unknown } = {}) {
  let ficheros = 0;
  let lotes = 0;
  const subidas: string[] = [];
  const base = opciones.baseUrl ?? OPENAI;
  const srv = servidor(async (ll) => {
    const ruta = ll.url.replace(base, "");
    if (ll.method === "POST" && ruta === "/files") {
      ficheros += 1;
      subidas.push(await (ll.form!.get("file") as Blob).text());
      return { json: { id: `file-in-${ficheros}`, purpose: "batch" } };
    }
    if (ll.method === "POST" && ruta === "/batches") {
      lotes += 1;
      return { json: { id: `batch_${lotes}`, status: "validating" } };
    }
    if (ll.method === "GET" && /^\/batches\/[^/]+$/.test(ruta)) {
      const estado = opciones.estado ?? "completed";
      return {
        json: {
          id: ruta.split("/").pop(),
          status: estado,
          request_counts: { total: 4, completed: 2, failed: 1 },
          output_file_id: opciones.salida ? "file-out" : null,
          error_file_id: opciones.errores ? "file-err" : null,
          ...(opciones.fallos ? { errors: opciones.fallos } : {}),
        },
      };
    }
    if (ll.method === "GET" && ruta === "/files/file-out/content") return { texto: jsonl(opciones.salida ?? []) };
    if (ll.method === "GET" && ruta === "/files/file-err/content") return { texto: jsonl(opciones.errores ?? []) };
    if (ll.method === "POST" && /\/cancel$/.test(ruta)) return { json: { status: "cancelling" } };
    return { estado: 404, json: {} };
  });
  const provider = new OpenAICompatibleProvider({ baseUrl: base, apiKey: "test-key", fetchImpl: srv.fetchImpl });
  return { ...srv, subidas, provider, layer: createSavingsLayer({ provider }) };
}

const pOpenAI = (contenido: string, model = "openai/gpt-4o-mini"): SavingsRequest => ({
  model,
  messages: [{ role: "user", content: contenido }],
});

describe("OpenAI · submit", () => {
  it("sube un JSONL con el cuerpo de generate() en cada línea y crea el lote sobre Chat Completions", async () => {
    const { llamadas, subidas, layer } = openai();
    const job = await layer.batches.submit([
      { customId: "a", request: pOpenAI("hola a") },
      { customId: "b", request: { ...pOpenAI("hola b"), temperature: 0, seed: 7 } },
    ]);
    expect(llamadas.map((l) => `${l.method} ${l.url}`)).toEqual([`POST ${OPENAI}/files`, `POST ${OPENAI}/batches`]);
    expect(llamadas[0]!.headers["authorization"]).toBe("Bearer test-key");
    // FormData: sin content-type puesto a mano (lo pone fetch con su frontera).
    expect(llamadas[0]!.headers["content-type"]).toBeUndefined();
    expect(llamadas[0]!.form!.get("purpose")).toBe("batch");
    expect(llamadas[1]!.json).toEqual({ input_file_id: "file-in-1", endpoint: "/v1/chat/completions", completion_window: "24h" });

    const lineas = subidas[0]!.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lineas.map((l) => [l["custom_id"], l["method"], l["url"]])).toEqual([
      ["a", "POST", "/v1/chat/completions"],
      ["b", "POST", "/v1/chat/completions"],
    ]);
    // Paridad con generate(): el mismo cuerpo, con el id desnudo y sin `stream` ni `service_tier`.
    const capturados: Record<string, unknown>[] = [];
    const espia = (async (_u: string, init: RequestInit) => {
      capturados.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(chat({ prompt_tokens: 1, completion_tokens: 1 })));
    }) as unknown as typeof fetch;
    const directo = new OpenAICompatibleProvider({ baseUrl: OPENAI, fetchImpl: espia });
    await directo.generate({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "hola a" }] });
    await directo.generate({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "hola b" }], temperature: 0, seed: 7 });
    expect(lineas.map((l) => l["body"])).toEqual(capturados);
    expect((lineas[0]!["body"] as Record<string, unknown>)["model"]).toBe("gpt-4o-mini");
    expect(JSON.stringify(lineas)).not.toContain("service_tier");

    expect(job).toMatchObject({ provider: "openai", endpoint: OPENAI, batchIds: ["batch_1"] });
  });

  it("un fichero por modelo, como exige la Batch API", async () => {
    const { subidas, layer } = openai();
    const job = await layer.batches.submit([
      { customId: "a", request: pOpenAI("1") },
      { customId: "b", request: pOpenAI("2", "openai/gpt-5-mini") },
      { customId: "c", request: pOpenAI("3") },
    ]);
    expect(subidas).toHaveLength(2);
    expect(job.batchIds).toEqual(["batch_1", "batch_2"]);
    expect(job.requests.map((r) => [r.customId, r.batch])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 0],
    ]);
  });

  it("Gemini por el endpoint compatible: se niega ANTES de enviar nada", async () => {
    const { llamadas, layer } = openai({ baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" });
    await expect(layer.batches.submit([{ customId: "a", request: pOpenAI("x", "google/gemini-2.5-flash") }])).rejects.toThrow(
      /Gemini's batch mode is not supported/,
    );
    expect(llamadas).toHaveLength(0);
  });
});

describe("OpenAI · results", () => {
  const SALIDA = [
    {
      id: "batch_req_1",
      custom_id: "a",
      response: { status_code: 200, request_id: "req_1", body: chat({ prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 0 } }) },
      error: null,
    },
    {
      id: "batch_req_2",
      custom_id: "b",
      response: { status_code: 400, request_id: "req_2", body: { error: { type: "invalid_request_error", message: "nope" } } },
      error: null,
    },
    // Con lectura cacheada: la tabla Batch de gpt-4o-mini NO la publica → esos
    // tokens no aportan y la cifra baja a `estimated`.
    {
      id: "batch_req_3",
      custom_id: "c",
      response: { status_code: 200, request_id: "req_3", body: chat({ prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 600 } }) },
      error: null,
    },
  ];
  const ERRORES = [
    { id: "batch_req_4", custom_id: "d", response: null, error: { code: "batch_expired", message: "This request could not be executed before the completion window expired." } },
  ];

  it("salida y errores: el tier es el del canal (registro de lote) y vale `measured` en el API oficial", async () => {
    const { layer } = openai({ salida: SALIDA, errores: ERRORES, estado: "expired" });
    const job = await layer.batches.submit(["a", "b", "c", "d", "e"].map((id) => ({ customId: id, request: pOpenAI(id) })));
    const res = await layer.batches.results(job);
    const por = Object.fromEntries(res.items.map((i) => [i.customId, i]));

    // gpt-4o-mini: estándar 0,15 / 0,60 por 1M; lote 0,075 / 0,30.
    // 1000 de entrada y 200 de salida: estándar 0,00027 · lote 0,000135.
    const a = por["a"]!;
    expect(a.outcome).toBe("succeeded");
    expect(a.servedTier).toBe("batch");
    expect(a.tierSaving!.basis).toBe("measured");
    expect(a.tierSaving!.basisReason).toMatch(/batch record/);
    expect(a.tierSaving!.amount).toBeLessThanOrEqual(0.000135);
    expect(a.tierSaving!.amount).toBeGreaterThan(0.000135 - 2e-10);

    expect(por["b"]).toMatchObject({ outcome: "errored", error: { type: "invalid_request_error", message: "nope" } });

    const c = por["c"]!;
    expect(c.tierSaving!.basis).toBe("estimated");
    expect(c.tierSaving!.basisReason).toMatch(/no cached input price/);
    // Solo entrada ordinaria (400) y salida: 400·0,075/1M + 200·0,30/1M.
    expect(c.tierSaving!.amount).toBeLessThanOrEqual(0.00009);
    expect(c.tierSaving!.amount).toBeGreaterThan(0.00009 - 2e-10);

    expect(por["d"]!.outcome).toBe("expired");
    // Sin línea en un lote que caducó: caducada, no «missing».
    expect(por["e"]!.outcome).toBe("expired");

    expect(res.summary).toMatchObject({ succeeded: 2, errored: 1, expired: 2, missing: 0, credited: 2, basis: "estimated" });
    expect(res.summary.tierSaving).toBeCloseTo(a.tierSaving!.amount + c.tierSaving!.amount, 12);
  });

  it("un host compatible que no es OpenAI: como mucho `estimated`", async () => {
    const { layer } = openai({ salida: [SALIDA[0]], baseUrl: "https://llm.example/v1" });
    const job = await layer.batches.submit([{ customId: "a", request: pOpenAI("a") }]);
    const res = await layer.batches.results(job);
    expect(res.items[0]!.tierSaving!.basis).toBe("estimated");
  });

  it("un lote rechazado entero (`failed`): cada petición errada con el motivo del proveedor", async () => {
    const { layer } = openai({ estado: "failed", fallos: { data: [{ code: "invalid_json_line", message: "line 1 is not JSON" }] } });
    const job = await layer.batches.submit([{ customId: "a", request: pOpenAI("a") }]);
    const st = await layer.batches.status(job);
    expect(st.state).toBe("ended");
    expect(st.counts.errored).toBe(4);
    const res = await layer.batches.results(job);
    expect(res.items[0]).toMatchObject({ outcome: "errored", error: { type: "batch_failed", message: "line 1 is not JSON" } });
  });

  it("mientras valida o corre, `status` cuenta lo que queda como en proceso", async () => {
    const { layer } = openai({ estado: "in_progress" });
    const job = await layer.batches.submit([{ customId: "a", request: pOpenAI("a") }]);
    const st = await layer.batches.status(job);
    expect(st).toMatchObject({ state: "in_progress", counts: { processing: 1, succeeded: 2, errored: 1 } });
  });
});

// ── El motivo de parada de cada resultado, cerrado como en `SavingsResult` ──
//
// Desde la 0.5 `BatchItemResult.finishReason` es uno de los cinco valores y el
// literal del proveedor va en `finishReasonDetail`, con la misma regla que
// `generate()` (src/providers/motivo-de-parada.ts). Por proveedor con Batch API.

describe("Anthropic · results · finishReason cerrado", () => {
  const CASOS: Array<[string, unknown, string, string | undefined]> = [
    ["end_turn", undefined, "stop", undefined],
    ["stop_sequence", undefined, "stop", "stop_sequence"],
    ["max_tokens", undefined, "length", undefined],
    ["model_context_window_exceeded", undefined, "length", "model_context_window_exceeded"],
    ["tool_use", undefined, "tool_calls", undefined],
    ["refusal", { type: "refusal", category: "cyber" }, "content_filter", "cyber"],
    ["pause_turn", undefined, "other", "pause_turn"],
  ];

  it.each(CASOS)("stop_reason %s → %s", async (parada, detalles, motivo, detalle) => {
    const contenido =
      parada === "tool_use"
        ? [{ type: "tool_use", id: "toolu_1", name: "label", input: { label: "billing" } }]
        : parada === "refusal"
          ? []
          : [{ type: "text", text: "billing" }];
    const msg = {
      ...mensaje(USO_BATCH, contenido),
      stop_reason: parada,
      ...(detalles !== undefined ? { stop_details: detalles } : {}),
    };
    const { layer } = anthropic({ lineas: [{ custom_id: "row-0", result: { type: "succeeded", message: msg } }] });
    const job = await layer.batches.submit(lote(1));
    const item = (await layer.batches.results(job)).items.find((i) => i.customId === "row-0")!;
    expect(item.outcome).toBe("succeeded");
    expect(item.finishReason).toBe(motivo);
    expect(item.finishReasonDetail).toBe(detalle);
  });
});

describe("OpenAI · results · finishReason cerrado", () => {
  const CASOS: Array<[string, string, string | undefined]> = [
    ["stop", "stop", undefined],
    ["length", "length", undefined],
    ["tool_calls", "tool_calls", undefined],
    ["function_call", "tool_calls", "function_call"],
    ["content_filter", "content_filter", undefined],
    ["content_filter: OTHER", "content_filter", "OTHER"],
    ["eos", "stop", "eos"],
    ["algo_nuevo", "other", "algo_nuevo"],
  ];

  it.each(CASOS)("finish_reason %s → %s", async (parada, motivo, detalle) => {
    const cuerpo = chat({ prompt_tokens: 1000, completion_tokens: 200 });
    cuerpo.choices[0]!.finish_reason = parada;
    const { layer } = openai({
      salida: [{ id: "batch_req_1", custom_id: "a", response: { status_code: 200, request_id: "req_1", body: cuerpo }, error: null }],
    });
    const job = await layer.batches.submit([{ customId: "a", request: pOpenAI("a") }]);
    const item = (await layer.batches.results(job)).items.find((i) => i.customId === "a")!;
    expect(item.outcome).toBe("succeeded");
    expect(item.finishReason).toBe(motivo);
    expect(item.finishReasonDetail).toBe(detalle);
  });
});

// ── La licencia, el proveedor y el cable ─────────────────────────────────────

describe("layer.batches · puertas", () => {
  let devOpen: string | undefined;
  beforeEach(() => {
    devOpen = process.env.BVSALA_DEV_OPEN;
  });
  afterEach(() => {
    if (devOpen !== undefined) process.env.BVSALA_DEV_OPEN = devOpen;
    else delete process.env.BVSALA_DEV_OPEN;
  });

  it("sin licencia, ninguna de las cuatro operaciones llega al proveedor", async () => {
    const { layer, llamadas } = anthropic();
    const job = await layer.batches.submit(lote(1));
    const antes = llamadas.length;
    delete process.env.BVSALA_DEV_OPEN;
    await expect(layer.batches.submit(lote(1))).rejects.toBeInstanceOf(LicenseError);
    await expect(layer.batches.status(job)).rejects.toBeInstanceOf(LicenseError);
    await expect(layer.batches.results(job)).rejects.toBeInstanceOf(LicenseError);
    await expect(layer.batches.cancel(job)).rejects.toBeInstanceOf(LicenseError);
    expect(llamadas.length).toBe(antes);
  });

  it("un proveedor de terceros (o el de demo) no tiene lotes: error claro", async () => {
    const propio: Provider = { id: "mine", generate: async () => ({ text: "", usage: { inputTokens: 0, outputTokens: 0 } }) };
    for (const provider of [propio, new MockProvider()]) {
      const layer = createSavingsLayer({ provider });
      await expect(layer.batches.submit(lote(1))).rejects.toThrow(/built-in providers/);
    }
  });

  it("el lote no emite uso: nada llega al medidor, ni al enviar ni al recoger", async () => {
    const medidor: string[] = [];
    const meteringFetch = (async (url: string) => {
      medidor.push(String(url));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const srv = anthropic({ lineas: [{ custom_id: "row-0", result: { type: "succeeded", message: mensaje(USO_BATCH) } }] });
    const layer = createSavingsLayer({
      provider: srv.provider,
      serviceAccountKey: "bvk_test",
      meteringUrl: "https://cp.example/api/metering/usage",
      meteringFetch,
      metering: { seatId: "seat-1", flushIntervalMs: 60_000 },
    });
    const job = await layer.batches.submit(lote(1));
    const res = await layer.batches.results(job);
    expect(res.summary.credited).toBe(1);
    layer.close();
    await new Promise((r) => setTimeout(r, 0));
    expect(medidor).toEqual([]);
  });
});
