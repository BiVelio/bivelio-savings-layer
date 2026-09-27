import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";

import { parseUsageRecords } from "../apps/web/lib/metering/usage.js";
import { arrancarGateway, type GatewayArrancado } from "../gateway/servidor.js";
import {
  negativaEnJson,
  ObservadorChatCompletions,
  ObservadorSse,
  valorarGemelaPorReferencia,
  type RegistroMedido,
} from "../gateway/medidor.js";
import { anthropicSavings } from "@bivelio/savings-layer/anthropic-sdk";
import { createSavingsLayer } from "../src/pipeline/create.js";
import { InMemoryExactCache } from "../src/cache/exact.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { CATALOGO } from "../src/pricing/catalogo.js";
import type { Provider } from "../src/providers/types.js";
import type { SavingsRequest, SavingsResult } from "../src/contracts/types.js";
import { testLicense } from "./helpers/test-license.js";
import { medicion, prohibirLaRed, vaciar } from "./adaptadores/ayudas.js";

/**
 * E7 · LAS NEGATIVAS FACTURADAS (informe de inteligencia competitiva del
 * 2026-09-27, §10).
 *
 * Desde el 24-sep-2026 Anthropic vuelve a cobrar las negativas que llegan ANTES
 * de cualquier salida cuando `stop_details.category` es `bio`, `frontier_llm` o
 * `reasoning_extraction`, «like any other request, at the rates of the model
 * that ran it»; las de mitad de stream ya se cobraban. Documentación oficial,
 * consultada el 2026-09-27:
 *
 *   · https://platform.claude.com/docs/en/release-notes/api (24-sep-2026)
 *   · https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback
 *     («What a refusal looks like» y «How refusals are billed»)
 *   · https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons
 *     (la forma en stream: `message_start` con su `usage`, ningún bloque, y
 *     `message_delta` con `delta.stop_reason: "refusal"` y `delta.stop_details`)
 *
 * La forma: un HTTP 200 normal, `content: []`, `stop_reason: "refusal"`,
 * `stop_details: { type: "refusal", category, explanation }` y los tokens en
 * `usage` («Either way, `content` is empty and token counts appear in `usage`»).
 *
 * Lo que se ata aquí, para que ningún filtro futuro de «respuesta vacía» las
 * pierda:
 *
 *   1. SE MIDEN como cualquier petición: `measured`, con su coste al precio del
 *      modelo, en el gateway (JSON y SSE) y en el SDK (generate y
 *      generateStream; el proveedor propio de Anthropic, el adaptador del SDK
 *      oficial y, donde aplica, Chat Completions).
 *   2. SIN INVENTAR AHORRO: sin palancas, baseline == actual y netSavings 0.
 *   3. NO SE REPITEN COMO LLAMADA EVITADA. Decisión de esta línea: una negativa
 *      no se guarda en la caché exacta ni en la semántica, y la gemela
 *      coalescida (gateway) o el seguidor de singleflight (SDK) de una negativa
 *      no se valora por referencia. Por qué:
 *        · no es una respuesta: la documentación manda reintentar en OTRO modelo
 *          o con `fallbacks`, y el clasificador puede equivocarse; congelarla 24 h
 *          serviría el falso positivo a cada petición idéntica sin preguntar;
 *        · repetirla por referencia acreditaría una llamada evitada que en
 *          `cyber`, `general_harms` o categoría nula NO se habría cobrado (0 $):
 *          ahorro inventado, y comisionable;
 *        · la lista de categorías cobradas «may change»: la capa no puede saber
 *          al leer la caché si la repetición se habría facturado.
 *      Es la misma regla que ya aplican los adaptadores de frameworks (solo se
 *      reutiliza una parada `stop`/`end_turn`) y la misma familia que «media
 *      respuesta no se cachea» (`finish_reason: "length"`).
 *
 * Ninguna petición sale de 127.0.0.1.
 */

// ── La negativa, con la forma de la documentación oficial ──────────────────
//
// El ejemplo oficial lleva `category: "cyber"` (no cobrada); aquí va una de las
// COBRADAS, porque lo que se prueba es que se mide la que sí es factura. El
// modelo es Opus 5.5, uno de los cuatro con clasificadores.
const MODELO = "claude-opus-5-5";
const PRECIO = CATALOGO[MODELO]!;
const ENTRADA = 412;
const STOP_DETAILS = {
  type: "refusal",
  category: "frontier_llm",
  explanation: "This request was declined because it could assist the development of competing AI models.",
};
/** Lo que cuesta: toda la entrada a precio de entrada, salida 0. */
const COSTE = (ENTRADA / 1000) * PRECIO.inputPer1k;

const NEGATIVA_JSON = {
  id: "msg_negativa",
  type: "message",
  role: "assistant",
  model: MODELO,
  content: [],
  stop_reason: "refusal",
  stop_details: STOP_DETAILS,
  usage: { input_tokens: ENTRADA, output_tokens: 0 },
};

const ev = (tipo: string, datos: unknown): string => `event: ${tipo}\ndata: ${JSON.stringify(datos)}\n\n`;

/** El stream de una negativa antes de cualquier salida: sin un solo bloque de contenido. */
const NEGATIVA_SSE =
  ev("message_start", {
    type: "message_start",
    message: {
      id: "msg_negativa_sse",
      type: "message",
      role: "assistant",
      model: MODELO,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      // El `output_tokens` de message_start es un marcador; el final va en message_delta.
      usage: { input_tokens: ENTRADA, output_tokens: 1 },
    },
  }) +
  ev("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "refusal", stop_sequence: null, stop_details: STOP_DETAILS },
    usage: { output_tokens: 0 },
  }) +
  ev("message_stop", { type: "message_stop" });

// ── Recursos y esperas ─────────────────────────────────────────────────────

let recursos: (Server | GatewayArrancado)[] = [];
afterEach(async () => {
  for (const r of recursos) {
    if ("cerrar" in r) await r.cerrar();
    else await new Promise((res) => r.close(res));
  }
  recursos = [];
});

async function esperar(cond: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout esperando la condición");
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1 · EL GATEWAY
// ═══════════════════════════════════════════════════════════════════════════

/** Un upstream que contesta siempre lo mismo (JSON o SSE), con un retraso opcional. */
function upstreamQueNiega(cuerpo: string, tipo: "json" | "sse", contador: { hits: number }, retrasoMs = 0): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer(async (req, res) => {
      for await (const _ of req) void _;
      contador.hits += 1;
      setTimeout(() => {
        res.writeHead(200, { "content-type": tipo === "json" ? "application/json" : "text/event-stream" });
        res.end(cuerpo);
      }, retrasoMs);
    });
    recursos.push(s);
    s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
  });
}

/** La ingesta falsa, más lo que la verja REAL del ingest se quedaría de cada lote. */
function ingestaFalsa(lotes: unknown[][], ingeridos: Record<string, unknown>[]): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      // Con clave de servicio el canal de entitlements pide sus features al mismo
      // origen: fail-closed, sin palancas.
      if (req.method === "GET" && (req.url ?? "").startsWith("/api/org/entitlements")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"features":[]}');
        return;
      }
      const lote = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown[];
      lotes.push(lote);
      ingeridos.push(...(parseUsageRecords(structuredClone(lote), "org-test") as unknown as Record<string, unknown>[]));
      res.writeHead(202, { "content-type": "application/json" });
      res.end('{"ingested":1}');
    });
    recursos.push(s);
    s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
  });
}

/**
 * El origen OFICIAL llevado al mock local: la referencia de una gemela solo se
 * concede contra `api.anthropic.com`, así que para probar SU motivo el gateway
 * tiene que creerse que habla con él. Nada sale a Internet.
 */
const OFICIAL = "https://api.anthropic.com";
function haciaElMock(puerto: number): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (u.origin === OFICIAL) return fetch(`http://127.0.0.1:${puerto}${u.pathname}${u.search}`, init);
    return fetch(input, init);
  }) as typeof fetch;
}

async function gatewayMedido(upstream: number, ingesta: number, lineas: string[], extra: Partial<Parameters<typeof arrancarGateway>[0]> = {}) {
  const gw = await arrancarGateway({
    license: testLicense(),
    puerto: 0 as never,
    upstream: OFICIAL,
    fetchImpl: haciaElMock(upstream),
    serviceAccountKey: "bvk_test",
    meteringUrl: `http://127.0.0.1:${ingesta}`,
    seatId: "test-01",
    log: (l) => lineas.push(l),
    warn: () => {},
    ...extra,
  });
  recursos.push(gw);
  return gw;
}

describe("E7 · el gateway mide una negativa como cualquier petición", () => {
  for (const tipo of ["json", "sse"] as const) {
    it(`${tipo === "json" ? "stream:false (JSON)" : "stream:true (SSE)"}: bytes intactos, un registro measured con su coste y sin ahorro`, async () => {
      const lotes: unknown[][] = [];
      const ingeridos: Record<string, unknown>[] = [];
      const lineas: string[] = [];
      const cuerpoDelProveedor = tipo === "json" ? JSON.stringify(NEGATIVA_JSON) : NEGATIVA_SSE;
      const upstream = await upstreamQueNiega(cuerpoDelProveedor, tipo, { hits: 0 });
      const ingesta = await ingestaFalsa(lotes, ingeridos);
      const gw = await gatewayMedido(upstream, ingesta, lineas);

      const r = await fetch(`http://127.0.0.1:${gw.puerto}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: MODELO, max_tokens: 64, messages: [{ role: "user", content: "hola" }], stream: tipo === "sse" }),
      });
      expect(r.status).toBe(200);
      // El cliente recibe la negativa tal cual: ni un filtro, ni un reintento.
      expect(await r.text()).toBe(cuerpoDelProveedor);

      await gw.cerrar();
      await esperar(() => lotes.flat().length > 0);
      const regs = lotes.flat() as Record<string, unknown>[];
      expect(regs).toHaveLength(1);
      const reg = regs[0]!;
      expect(reg["model"]).toBe(MODELO);
      expect(reg["basis"]).toBe("measured");
      expect(reg["actualLlm"]).toBe(1);
      expect(reg["avoidedLlm"]).toBe(0);
      expect(reg["actualInputTokens"]).toBe(ENTRADA);
      expect(reg["actualOutputTokens"]).toBe(0);
      expect(reg["actualCost"]).toBeCloseTo(COSTE, 12);
      // Sin palancas no hay ahorro que enseñar: el baseline ES el coste real.
      expect(reg["baselineCost"]).toBe(reg["actualCost"]);
      expect(reg["netSavings"]).toBe(0);
      // Y la verja REAL del ingest se lo queda tal cual: measured, con su coste.
      expect(ingeridos).toHaveLength(1);
      expect(ingeridos[0]!["basis"]).toBe("measured");
      expect(ingeridos[0]!["actualCost"]).toBeCloseTo(COSTE, 12);
      // La línea de log que lee quien mira su terminal dice lo que se pagó.
      expect(lineas.join("\n")).toContain(`$${COSTE.toFixed(6)} (in ${ENTRADA}`);
    });
  }

  it("⛔ coalescencia: la gemela de una negativa es una llamada evitada, pero NO se valora por referencia", async () => {
    const lotes: unknown[][] = [];
    const ingeridos: Record<string, unknown>[] = [];
    const lineas: string[] = [];
    const contador = { hits: 0 };
    const upstream = await upstreamQueNiega(NEGATIVA_SSE, "sse", contador, 150);
    const ingesta = await ingestaFalsa(lotes, ingeridos);
    const gw = await gatewayMedido(upstream, ingesta, lineas, { coalescer: true });

    // temperature 0: sin la guarda, la gemela se valoraría por referencia (el
    // caso de control está en test/gateway-coalescencia.test.ts).
    const cuerpo = JSON.stringify({ model: MODELO, max_tokens: 64, temperature: 0, messages: [{ role: "user", content: "hola" }], stream: true });
    const pedir = () => fetch(`http://127.0.0.1:${gw.puerto}/v1/messages`, { method: "POST", body: cuerpo }).then((r) => r.text());
    const p1 = pedir();
    await new Promise((r) => setTimeout(r, 40));
    const p2 = pedir();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(contador.hits).toBe(1);
    // Las dos reciben la negativa: la gemela no se inventa otra respuesta.
    expect(r1).toBe(NEGATIVA_SSE);
    expect(r2).toBe(NEGATIVA_SSE);

    await gw.cerrar();
    await esperar(() => lotes.flat().length >= 2);
    const regs = lotes.flat() as Record<string, unknown>[];
    const medida = regs.find((r) => r["basis"] === "measured")!;
    const evitada = regs.find((r) => r["cacheResult"] === "singleflight")!;
    expect(medida["actualCost"]).toBeCloseTo(COSTE, 12);
    expect(evitada["avoidedLlm"]).toBe(1);
    // Estimated, que NUNCA entra en la base de la comisión, y sin puntero.
    expect(evitada["basis"]).toBe("estimated");
    expect(evitada["referenceRequestId"]).toBeUndefined();
    expect(ingeridos.find((r) => r["requestId"] === evitada["requestId"])!["basis"]).toBe("estimated");
    expect(lineas.join("\n")).toContain("estimated, not by reference: primary-refused");
  });

  it("detectar la negativa sin tocar el passthrough: JSON de Mensajes y de Chat Completions, y los dos observadores SSE", () => {
    expect(negativaEnJson("/v1/messages", JSON.stringify(NEGATIVA_JSON))).toBe(true);
    expect(negativaEnJson("/v1/messages", JSON.stringify({ ...NEGATIVA_JSON, stop_reason: "end_turn" }))).toBe(false);
    // La ruta manda: el mismo cuerpo en una ruta sin dialecto no es una negativa.
    expect(negativaEnJson("/v1/embeddings", JSON.stringify(NEGATIVA_JSON))).toBe(false);
    expect(negativaEnJson("/v1/messages", "{no es json")).toBe(false);
    const chat = (fin: string) => JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: null }, finish_reason: fin }] });
    expect(negativaEnJson("/v1/chat/completions", chat("content_filter"))).toBe(true);
    expect(negativaEnJson("/v1/chat/completions", chat("stop"))).toBe(false);

    const sse = new ObservadorSse();
    // Troceado en cualquier byte, como llega por la red.
    for (let i = 0; i < NEGATIVA_SSE.length; i += 37) sse.observar(NEGATIVA_SSE.slice(i, i + 37));
    expect(sse.negativa()).toBe(true);
    expect(sse.usageFinal()).toMatchObject({ input_tokens: ENTRADA, output_tokens: 0 });
    const normal = new ObservadorSse();
    normal.observar(NEGATIVA_SSE.replace('"stop_reason":"refusal"', '"stop_reason":"end_turn"'));
    expect(normal.negativa()).toBe(false);

    const cc = new ObservadorChatCompletions();
    cc.observar(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }] })}\n\n`);
    cc.observar(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 300, completion_tokens: 0 } })}\n\ndata: [DONE]\n\n`);
    expect(cc.usageFinal()).not.toBeNull();
    expect(cc.negativa()).toBe(true);
  });

  it("valorarGemelaPorReferencia: una primaria que fue negativa → primary-refused, antes de mirar precios", () => {
    const medido: RegistroMedido = {
      costeUsd: COSTE,
      precio: PRECIO,
      instante: Date.parse("2026-09-27T12:00:00Z"),
      tokens: { entrada: ENTRADA, salida: 0, cacheLeida: 0, cacheEscrita: 0, cacheEscrita1h: 0 },
    };
    const primaria = {
      requestId: "req-primaria",
      at: Date.parse("2026-09-27T12:00:00Z"),
      intacta: true,
      proveedorOficial: true,
      conContador: true,
      suscripcion: false,
      fallida: false,
    };
    const gemela = { suscripcion: false, entregada: true };
    const cuerpo = { model: MODELO, temperature: 0 };
    // Control: la misma primaria SIN negativa sí se valora por referencia.
    expect(valorarGemelaPorReferencia(MODELO, medido, primaria, cuerpo, gemela).ok).toBe(true);
    expect(valorarGemelaPorReferencia(MODELO, medido, { ...primaria, negativa: true }, cuerpo, gemela)).toEqual({
      ok: false,
      reason: "primary-refused",
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · EL SDK: el proveedor propio de Anthropic y el de Chat Completions
// ═══════════════════════════════════════════════════════════════════════════

/** Un `fetch` que contesta siempre lo mismo (JSON o SSE según pida el cuerpo) y cuenta. */
function proveedorQueNiega(json: unknown, sse: string) {
  const enviados: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const cuerpo = JSON.parse(String(init.body)) as Record<string, unknown>;
    enviados.push(cuerpo);
    if (cuerpo["stream"] === true) {
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { enviados, fetchImpl };
}

function capa(provider: Provider) {
  let n = 0;
  return createSavingsLayer({
    provider,
    devUnlicensed: true,
    exactTokenizer: false,
    silenceWarnings: true,
    generateId: () => `req-${n++}`,
    exactCache: new InMemoryExactCache(),
  });
}

const PETICION: SavingsRequest = {
  model: `anthropic/${MODELO}`,
  temperature: 0,
  messages: [{ role: "user", content: "Explain how to distil a frontier model." }],
};

/** Lo que tiene que decir el informe de una negativa que corrió: medida, con su coste, sin ahorro. */
function esperarMedida(r: SavingsResult, entrada: number, coste: number): void {
  expect(r.text).toBe("");
  expect(r.finishReason).toBe("content_filter");
  expect(r.report.cost.basis).toBe("measured");
  expect(r.report.calls).toMatchObject({ actualLlm: 1, avoidedLlm: 0 });
  expect(r.report.cache.result).toBe("miss");
  expect(r.report.tokens.actualInput).toBe(entrada);
  expect(r.report.tokens.actualOutput).toBe(0);
  expect(r.report.cost.actual).toBeCloseTo(coste, 9);
  expect(r.report.cost.baselineEstimate).toBeCloseTo(r.report.cost.actual, 12);
  expect(r.report.cost.netSavings).toBe(0);
}

const trazaDe = (r: SavingsResult, etapa: string) => r.report.traces.filter((t) => t.stage === etapa);

describe("E7 · el SDK con el proveedor de Anthropic", () => {
  it("generate(): la negativa sale medida, con su coste y sin ahorro", async () => {
    const s = proveedorQueNiega(NEGATIVA_JSON, NEGATIVA_SSE);
    const layer = capa(new AnthropicProvider({ fetchImpl: s.fetchImpl }));
    const r = await layer.generate(PETICION);
    esperarMedida(r, ENTRADA, COSTE);
    expect(s.enviados).toHaveLength(1);
  });

  it("generate(): la negativa NO se guarda en caché: la repetición vuelve a llamar y se mide otra vez", async () => {
    const s = proveedorQueNiega(NEGATIVA_JSON, NEGATIVA_SSE);
    const layer = capa(new AnthropicProvider({ fetchImpl: s.fetchImpl }));
    const primera = await layer.generate(PETICION);
    expect(trazaDe(primera, "cache-write").map((t) => t.outcome).join(" | ")).toContain("skipped: the provider refused");
    // Sin registro por referencia: ni la caché ni un seguidor de singleflight
    // pueden valorar una repetición con este contador.
    expect(trazaDe(primera, "reference")[0]).toMatchObject({ outcome: "not-written", detail: { reason: "not-cacheable" } });
    const segunda = await layer.generate(PETICION);
    expect(s.enviados).toHaveLength(2);
    esperarMedida(segunda, ENTRADA, COSTE);
  });

  it("generateStream(): la negativa en SSE sale medida, con su coste, y tampoco se cachea", async () => {
    const s = proveedorQueNiega(NEGATIVA_JSON, NEGATIVA_SSE);
    const layer = capa(new AnthropicProvider({ fetchImpl: s.fetchImpl }));
    const flujo = layer.generateStream(PETICION);
    const eventos: string[] = [];
    for await (const e of flujo) eventos.push(e.type);
    // Ningún delta de texto: solo el cierre.
    expect(eventos).toEqual(["done"]);
    const r = await flujo.result;
    esperarMedida(r, ENTRADA, COSTE);
    expect(r.report.streaming?.delivery).toBe("live");
    const otra = await layer.generateStream(PETICION).result;
    expect(s.enviados).toHaveLength(2);
    expect(s.enviados.every((c) => c["stream"] === true)).toBe(true);
    esperarMedida(otra, ENTRADA, COSTE);
  });

  it("con contrato de salida: la negativa NO se repara (sería la misma negativa, pagada otra vez) y se mide una sola llamada", async () => {
    const s = proveedorQueNiega(NEGATIVA_JSON, NEGATIVA_SSE);
    const layer = capa(new AnthropicProvider({ fetchImpl: s.fetchImpl }));
    const r = await layer.generate({
      ...PETICION,
      response: {
        contractId: "e7:v1",
        schema: { type: "object", additionalProperties: false, required: ["answer"], properties: { answer: { type: "string" } } },
      },
    });
    // Una sola llamada: antes, la capa mandaba una reparación al MISMO modelo con
    // la salida vacía pegada (dos llamadas pagadas y netSavings -1).
    expect(s.enviados).toHaveLength(1);
    expect(r.report.calls).toMatchObject({ actualLlm: 1, retries: 0 });
    expect(trazaDe(r, "validation").map((t) => t.outcome)).toContain("repair-skipped");
    expect(r.report.qualityLedger?.repair).toEqual({ outcome: "skipped", skipReason: "provider_refusal" });
    expect(r.report.constraints.structurallyValid).toBe(false);
    expect(r.report.cost.basis).toBe("measured");
    expect(r.report.cost.actual).toBeGreaterThan(0);
    expect(r.report.cost.netSavings).toBe(0);
  });

  it("singleflight: el seguidor de una negativa en vuelo se sirve, pero no se valora por referencia", async () => {
    let soltar!: () => void;
    const barrera = new Promise<void>((r) => (soltar = r));
    let llamadas = 0;
    const fetchImpl = (async () => {
      llamadas += 1;
      await barrera;
      return new Response(JSON.stringify(NEGATIVA_JSON), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const layer = capa(new AnthropicProvider({ fetchImpl }));
    const lider = layer.generate(PETICION);
    const seguidor = layer.generate(PETICION);
    await new Promise((r) => setTimeout(r, 20));
    soltar();
    const [a, b] = await Promise.all([lider, seguidor]);
    expect(llamadas).toBe(1);
    const medida = [a, b].find((r) => r.report.calls.actualLlm === 1)!;
    const evitada = [a, b].find((r) => r.report.calls.actualLlm === 0)!;
    esperarMedida(medida, ENTRADA, COSTE);
    expect(evitada.report.cache.result).toBe("singleflight");
    expect(evitada.report.cost.basis).toBe("estimated");
    expect(evitada.report.cache.reference).toBeUndefined();
  });
});

describe("E7 · el SDK con el proveedor de Chat Completions (donde aplica)", () => {
  const openai = (fetchImpl: typeof fetch) => new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", fetchImpl });
  const MINI = CATALOGO["gpt-4o-mini"]!;
  const USO = { prompt_tokens: 300, completion_tokens: 0, total_tokens: 300 };
  const COSTE_MINI = (300 / 1000) * MINI.inputPer1k;
  const PETICION_OPENAI: SavingsRequest = { model: "openai/gpt-4o-mini", temperature: 0, messages: [{ role: "user", content: "hola" }] };

  it("finish_reason content_filter sin texto y con usage: medida con su coste, sin ahorro, y no se cachea", async () => {
    const cuerpo = {
      id: "chatcmpl-filtro",
      object: "chat.completion",
      model: "gpt-4o-mini",
      choices: [{ index: 0, message: { role: "assistant", content: null, refusal: null }, finish_reason: "content_filter" }],
      usage: USO,
    };
    const s = proveedorQueNiega(cuerpo, "");
    const layer = capa(openai(s.fetchImpl));
    const r = await layer.generate(PETICION_OPENAI);
    esperarMedida(r, 300, COSTE_MINI);
    await layer.generate(PETICION_OPENAI);
    expect(s.enviados).toHaveLength(2);
  });

  it("una negativa de salidas estructuradas (content null + refusal) sale medida con los tokens de la negativa", async () => {
    // OpenAI la cobra como cualquier salida: la negativa ES texto del modelo,
    // solo que en `refusal`. Con esquema, la respuesta no cumple el contrato y
    // la capa ya no la cacheaba (`structurallyValid: false`).
    const cuerpo = {
      id: "chatcmpl-negativa",
      object: "chat.completion",
      model: "gpt-4o-mini",
      choices: [{ index: 0, message: { role: "assistant", content: null, refusal: "I'm sorry, I cannot assist with that request." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 300, completion_tokens: 11, total_tokens: 311 },
    };
    const s = proveedorQueNiega(cuerpo, "");
    const layer = capa(openai(s.fetchImpl));
    const r = await layer.generate({
      ...PETICION_OPENAI,
      response: {
        contractId: "e7:v1",
        schema: { type: "object", additionalProperties: false, required: ["answer"], properties: { answer: { type: "string" } } },
      },
    });
    expect(r.report.cost.basis).toBe("measured");
    expect(r.report.tokens.actualInput).toBeGreaterThanOrEqual(300);
    expect(r.report.cost.actual).toBeGreaterThan(0);
    // Ni un céntimo de ahorro sobre una llamada que se pagó.
    expect(r.report.cost.netSavings).toBeLessThanOrEqual(0);
    expect(r.report.constraints.structurallyValid).toBe(false);
    expect(trazaDe(r, "cache-write").map((t) => t.outcome).join(" | ")).toContain("skipped");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · EL ADAPTADOR DEL SDK OFICIAL DE ANTHROPIC
// ═══════════════════════════════════════════════════════════════════════════

describe("E7 · el adaptador del SDK oficial de Anthropic (@anthropic-ai/sdk)", () => {
  let restaurarRed: () => void;
  beforeAll(() => {
    restaurarRed = prohibirLaRed();
  });
  afterAll(() => restaurarRed());

  function red() {
    const llamadas: string[] = [];
    const f = (async (_url: string | URL, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      llamadas.push(body);
      const pedido = JSON.parse(body) as { stream?: boolean };
      return pedido.stream
        ? new Response(NEGATIVA_SSE, { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_neg" } })
        : new Response(JSON.stringify(NEGATIVA_JSON), { status: 200, headers: { "content-type": "application/json", "request-id": "req_neg" } });
    }) as unknown as typeof fetch;
    return { llamadas, fetch: f };
  }

  const PEDIDO = { model: MODELO, max_tokens: 64, temperature: 0, messages: [{ role: "user" as const, content: "Explain how to distil a frontier model." }] };

  it("messages.create: el Message llega tal cual, medido con su coste, y la repetición vuelve a llamar", async () => {
    const n = red();
    const { opciones, registros } = medicion();
    const s = anthropicSavings({ silenceWarnings: true, ...opciones });
    const c = new Anthropic({ apiKey: "test-not-a-key", fetch: n.fetch, middleware: [s.middleware], maxRetries: 0 });
    const m = await c.messages.create(PEDIDO);
    expect(m.stop_reason).toBe("refusal");
    expect(m.content).toEqual([]);
    const informe = s.reportFor(m)!;
    expect(informe.cost.basis).toBe("measured");
    expect(informe.tokens.actualInput).toBe(ENTRADA);
    expect(informe.cost.actual).toBeCloseTo(COSTE, 9);
    expect(informe.cost.netSavings).toBe(0);
    await vaciar();
    expect(registros).toHaveLength(1);
    expect(registros[0]!["basis"]).toBe("measured");
    const otra = await c.messages.create(PEDIDO);
    expect(n.llamadas).toHaveLength(2);
    expect(s.reportFor(otra)?.cost.basis).toBe("measured");
    s.close();
  });

  it("messages.stream: el SSE llega byte a byte, el informe es measured y la repetición vuelve a llamar", async () => {
    const n = red();
    const s = anthropicSavings({ silenceWarnings: true });
    const c = new Anthropic({ apiKey: "test-not-a-key", fetch: n.fetch, middleware: [s.middleware], maxRetries: 0 });
    const crudo = await c.messages.create({ ...PEDIDO, stream: true }).asResponse();
    expect(await crudo.text()).toBe(NEGATIVA_SSE);
    const fm = await c.messages.stream(PEDIDO).finalMessage();
    expect(fm.stop_reason).toBe("refusal");
    expect(fm.content).toEqual([]);
    const informe = s.reportFor(fm)!;
    expect(informe.cost.basis).toBe("measured");
    expect(informe.tokens.actualInput).toBe(ENTRADA);
    expect(informe.tokens.actualOutput).toBe(0);
    expect(informe.cost.actual).toBeCloseTo(COSTE, 9);
    expect(informe.cost.netSavings).toBe(0);
    await c.messages.stream(PEDIDO).finalMessage();
    expect(n.llamadas).toHaveLength(3);
    s.close();
  });
});
