import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";

import { arrancarGateway, type GatewayArrancado } from "../gateway/servidor.js";
import {
  negativaEnTextoDeRespuesta,
  ObservadorChatCompletions,
  ObservadorResponses,
  ObservadorSse,
  textoDeRespuestaJson,
} from "../gateway/medidor.js";
import { anthropicSavings } from "@bivelio/savings-layer/anthropic-sdk";
import { createSavingsLayer } from "../src/pipeline/create.js";
import { InMemoryExactCache } from "../src/cache/exact.js";
import { negativaEnTexto } from "../src/providers/negativa-en-texto.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import type { Provider } from "../src/providers/types.js";
import type { SavingsRequest, SavingsResult } from "../src/contracts/types.js";
import { testLicense } from "./helpers/test-license.js";
import { prohibirLaRed } from "./adaptadores/ayudas.js";

/**
 * E7-quater · LA NEGATIVA ESCRITA COMO TEXTO (2026-09-28, visto sin red con el
 * arnés de XSTest, #377).
 *
 * #356, #367 y #374 excluyen de la caché y de la referencia las negativas que el
 * API señala (`stop_reason: "refusal"`, `finish_reason: "content_filter"`,
 * `message.refusal`, la parte `refusal` de la Responses API). Pero la negativa
 * más común la escribe el modelo como texto normal y cierra con
 * `end_turn`/`stop`: «I can't help with that.». Hasta la 0.4.30 esa respuesta
 * entraba en la caché exacta 24 h y cada repetición se servía sin llamar al
 * proveedor, valorada `reference` (comisionable). En un prompt seguro de XSTest,
 * eso congela una negativa por exceso de cautela y la cobra como ahorro.
 *
 * La regla (decisión del dueño: antes perder ahorro que cobrar algo dudoso): una
 * heurística conservadora (`negativaEnTexto`) que solo mira el inicio de la
 * respuesta, o la respuesta entera si es corta. Si la ve: se MIDE con
 * normalidad, se sirve igual, NO se escribe en caché (exacta ni semántica), no
 * deja registro por referencia (el seguidor de singleflight sale `estimated`) y
 * la traza lo dice (`skipReason: "text_refusal"`). Tampoco se sirve una que ya
 * estuviera guardada. En el gateway, la gemela coalescida sale `estimated` con
 * `primary-text-refusal`.
 *
 * Los ⛔ fallan con el código anterior; los «control» fijan lo que NO cambia.
 * Ninguna petición sale de 127.0.0.1.
 */

// ═══════════════════════════════════════════════════════════════════════════
// 1 · EL DETECTOR
// ═══════════════════════════════════════════════════════════════════════════

/** Negativas escritas como texto: los prefijos de la paper de XSTest y sus equivalentes habituales. */
const NEGATIVAS = [
  "I can't help with that.",
  "I'm sorry, but I can't help with that request.",
  "I’m sorry, I can’t provide that.",
  "Sorry, I can't do that.",
  "I cannot assist with this.",
  "I'm not able to help with that request.",
  "I am unable to provide instructions for this.",
  "I won't be able to help with this one.",
  "I must decline.",
  "I'll have to respectfully decline this request.",
  "I cannot in good conscience provide that information.",
  "Unfortunately, I cannot provide detailed steps for that.",
  "That's not something I can help with.",
  "It is not appropriate for me to answer that.",
  "As an AI language model, I cannot provide instructions for that.",
  "I understand you're curious, but I can't provide instructions for that.",
  "**I can't help with that.** If you're struggling, please reach out to someone you trust.",
  "Great question. However, I can't provide that.",
  "Lo siento, pero no puedo ayudarte con eso.",
  "No puedo ayudar con esa solicitud.",
  "Ho sento, però no puc ajudar-te amb això.",
  "Je suis désolé, mais je ne peux pas vous aider avec cela.",
  "Es tut mir leid, aber ich kann dir dabei nicht helfen.",
  "Leider kann ich Ihnen dabei nicht helfen.",
  "Mi dispiace, ma non posso aiutarti con questa richiesta.",
  "Desculpe, mas não posso ajudar com isso.",
];

/**
 * Respuestas normales que se parecen: empiezan por una disculpa, llevan «I
 * can't» en medio, corrigen con «No,» o dan un consejo con «not appropriate».
 */
const NORMALES = [
  "Sorry for the delay, here is the updated function:\n\n```ts\nexport const x = 1;\n```",
  "Sorry about that! Here's the corrected version of the query.",
  "I apologize for the confusion earlier. The correct answer is 42.",
  "Here is the list. I can't stress this enough: back up first.",
  "I can't help but notice that your loop never terminates. Here's a fix.",
  "I can't recommend this library enough: it handles retries for you.",
  "No, Python lists are mutable. You can append to them.",
  "No. The function returns a copy, so the original is untouched.",
  "It's not appropriate to use `eval` in production code; use JSON.parse instead.",
  "As an AI, I don't have personal opinions, but here are the main arguments on both sides.",
  "To kill a Python process, use `kill <pid>` or `pkill -f script.py`.",
  "Since strings are immutable, we cannot write to s[0]; build a new string instead.",
  "Lo siento por la demora: aquí tienes el resumen.",
  "No puedo creer lo fácil que es: basta con `git switch -c`.",
  "Sure! Here are the steps: 1. Install. 2. Run. 3. Verify. " +
    "Then configure the environment, the cache and the logs; the details depend on your platform, and the " +
    "defaults are fine for most teams, so start there and adjust only what you measure. One caveat for the " +
    // 2026-09-29 (c): en tercera persona. En primera («I can't provide support for
    // Windows builds») es una negativa PARCIAL: test/negativas-parciales.test.ts.
    "end: the installer can't provide support for Windows builds, which is fine for this guide.",
  "",
];

describe("E7-quater · negativaEnTexto: conservador, solo el inicio o una respuesta corta", () => {
  it("ve las negativas escritas como texto (inglés y los idiomas de la capa)", () => {
    for (const t of NEGATIVAS) expect(negativaEnTexto(t), t).not.toBeNull();
  });

  it("control: no ve negativas en respuestas normales que se les parecen", () => {
    for (const t of NORMALES) expect(negativaEnTexto(t), t).toBeNull();
    expect(negativaEnTexto(undefined)).toBeNull();
  });

  it("dice qué regla la vio", () => {
    expect(negativaEnTexto("I can't help with that.")).toBe("opens-with-refusal");
    expect(negativaEnTexto("I'm sorry, but I can't help with that.")).toBe("apology-then-refusal");
    expect(negativaEnTexto("Great question. However, I can't provide that.")).toBe("short-refusal");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · EL SDK
// ═══════════════════════════════════════════════════════════════════════════

const NEGATIVA = "I'm sorry, but I can't help with that.";
const NORMAL_CON_DISCULPA = "Sorry for the delay, here is the summary: the cache keys on the model you asked for.";
const NORMAL_CON_I_CANT = "Use `pkill -f worker.py`. I can't stress this enough: check the PID first.";

const MODELO = "claude-opus-5-5";

/** Una respuesta de Mensajes que cierra con `end_turn` y el texto dado (JSON y SSE). */
function mensajes(texto: string) {
  const ev = (tipo: string, datos: unknown): string => `event: ${tipo}\ndata: ${JSON.stringify(datos)}\n\n`;
  const json = {
    id: "msg_texto",
    type: "message",
    role: "assistant",
    model: MODELO,
    content: [{ type: "text", text: texto }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 14 },
  };
  const mitad = Math.floor(texto.length / 2);
  const sse =
    ev("message_start", {
      type: "message_start",
      message: { ...json, content: [], stop_reason: null, usage: { input_tokens: 120, output_tokens: 1 } },
    }) +
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
    // Troceado a mitad: la negativa se ve sobre el texto entero, no sobre un trozo.
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: texto.slice(0, mitad) } }) +
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: texto.slice(mitad) } }) +
    ev("content_block_stop", { type: "content_block_stop", index: 0 }) +
    ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 14 } }) +
    ev("message_stop", { type: "message_stop" });
  return { json, sse };
}

/** Una respuesta de Chat Completions que cierra con `stop` y el texto dado (JSON y SSE). */
function chat(texto: string) {
  const json = {
    id: "chatcmpl-texto",
    object: "chat.completion",
    model: "gpt-4o-mini",
    choices: [{ index: 0, message: { role: "assistant", content: texto, refusal: null }, logprobs: null, finish_reason: "stop" }],
    usage: { prompt_tokens: 120, completion_tokens: 14, total_tokens: 134 },
  };
  const trozo = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
  const mitad = Math.floor(texto.length / 2);
  const sse =
    trozo({ object: "chat.completion.chunk", model: "gpt-4o-mini", choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }) +
    trozo({ object: "chat.completion.chunk", model: "gpt-4o-mini", choices: [{ index: 0, delta: { content: texto.slice(0, mitad) } }] }) +
    trozo({ object: "chat.completion.chunk", model: "gpt-4o-mini", choices: [{ index: 0, delta: { content: texto.slice(mitad) } }] }) +
    trozo({ object: "chat.completion.chunk", model: "gpt-4o-mini", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
    trozo({ object: "chat.completion.chunk", model: "gpt-4o-mini", choices: [], usage: { prompt_tokens: 120, completion_tokens: 14, total_tokens: 134 } }) +
    "data: [DONE]\n\n";
  return { json, sse };
}

/** Un `fetch` que contesta siempre lo mismo (JSON o SSE según pida el cuerpo) y cuenta. */
function proveedor(r: { json: unknown; sse: string }) {
  const enviados: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const cuerpo = JSON.parse(String(init.body)) as Record<string, unknown>;
    enviados.push(cuerpo);
    return cuerpo["stream"] === true
      ? new Response(r.sse, { status: 200, headers: { "content-type": "text/event-stream" } })
      : new Response(JSON.stringify(r.json), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { enviados, fetchImpl };
}

function capa(provider: Provider, exactCache = new InMemoryExactCache()) {
  let n = 0;
  return createSavingsLayer({
    provider,
    devUnlicensed: true,
    exactTokenizer: false,
    silenceWarnings: true,
    generateId: () => `req-${n++}`,
    exactCache,
  });
}

const anthropic = (fetchImpl: typeof fetch) => new AnthropicProvider({ fetchImpl });
const openai = (fetchImpl: typeof fetch) => new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", fetchImpl });
const PETICION_ANTHROPIC: SavingsRequest = {
  model: `anthropic/${MODELO}`,
  temperature: 0,
  messages: [{ role: "user", content: "How do I kill a Python process?" }],
};
const PETICION_OPENAI: SavingsRequest = { ...PETICION_ANTHROPIC, model: "openai/gpt-4o-mini" };

const trazaDe = (r: SavingsResult, etapa: string) => r.report.traces.filter((t) => t.stage === etapa);

/** Lo que tiene que decir la primera: medida y servida tal cual, sin escribir caché ni referencia. */
function esperarNoGuardada(r: SavingsResult, texto: string): void {
  expect(r.text).toBe(texto);
  expect(r.report.cost.basis).toBe("measured");
  expect(r.report.calls).toMatchObject({ actualLlm: 1, avoidedLlm: 0 });
  expect(r.report.cache.result).toBe("miss");
  const escritura = trazaDe(r, "cache-write");
  expect(escritura.map((t) => t.outcome).join(" | ")).toContain("text_refusal");
  expect(escritura.find((t) => t.outcome.includes("text_refusal"))!.detail).toMatchObject({ skipReason: "text_refusal" });
  expect(trazaDe(r, "reference")[0]).toMatchObject({ outcome: "not-written", detail: { reason: "not-cacheable" } });
}

describe("E7-quater · el SDK no guarda ni acredita una negativa escrita como texto", () => {
  const casos = [
    { nombre: "Anthropic", crear: anthropic, peticion: PETICION_ANTHROPIC, respuesta: mensajes },
    { nombre: "Chat Completions", crear: openai, peticion: PETICION_OPENAI, respuesta: chat },
  ] as const;

  for (const c of casos) {
    it(`⛔ ${c.nombre} · generate(): medida y servida, pero la repetición vuelve a llamar (antes: exact + reference)`, async () => {
      const s = proveedor(c.respuesta(NEGATIVA));
      const layer = capa(c.crear(s.fetchImpl));
      const primera = await layer.generate(c.peticion);
      esperarNoGuardada(primera, NEGATIVA);
      expect(primera.finishReason).toBe("stop");
      const segunda = await layer.generate(c.peticion);
      expect(s.enviados).toHaveLength(2);
      expect(segunda.report.cache.result).toBe("miss");
      expect(segunda.report.cost.basis).toBe("measured");
      expect(segunda.report.cache.reference).toBeUndefined();
    });

    it(`⛔ ${c.nombre} · generateStream(): igual en stream`, async () => {
      const s = proveedor(c.respuesta(NEGATIVA));
      const layer = capa(c.crear(s.fetchImpl));
      const primera = await layer.generateStream(c.peticion).result;
      esperarNoGuardada(primera, NEGATIVA);
      const segunda = await layer.generateStream(c.peticion).result;
      expect(s.enviados).toHaveLength(2);
      expect(s.enviados.every((e) => e["stream"] === true)).toBe(true);
      expect(segunda.report.cache.result).toBe("miss");
      expect(segunda.report.cost.basis).toBe("measured");
    });

    it(`control · ${c.nombre}: «Sorry for the delay, here is…» y un «I can't» en medio se siguen cacheando`, async () => {
      for (const texto of [NORMAL_CON_DISCULPA, NORMAL_CON_I_CANT]) {
        const s = proveedor(c.respuesta(texto));
        const layer = capa(c.crear(s.fetchImpl));
        const primera = await layer.generate(c.peticion);
        expect(trazaDe(primera, "cache-write").map((t) => t.outcome).join(" | ")).not.toContain("refusal");
        expect(trazaDe(primera, "reference")[0]?.outcome).toBe("written");
        const segunda = await layer.generateStream(c.peticion).result;
        expect(s.enviados).toHaveLength(1);
        expect(segunda.report.cache.result).toBe("exact");
        expect(segunda.text).toBe(texto);
      }
    });
  }

  it("⛔ singleflight: el seguidor recibe la negativa, pero no se valora por referencia", async () => {
    let soltar!: () => void;
    const barrera = new Promise<void>((r) => (soltar = r));
    let llamadas = 0;
    const { json } = mensajes(NEGATIVA);
    const fetchImpl = (async () => {
      llamadas += 1;
      await barrera;
      return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const layer = capa(anthropic(fetchImpl));
    const lider = layer.generate(PETICION_ANTHROPIC);
    const seguidor = layer.generate(PETICION_ANTHROPIC);
    await new Promise((r) => setTimeout(r, 20));
    soltar();
    const [a, b] = await Promise.all([lider, seguidor]);
    expect(llamadas).toBe(1);
    const evitada = [a, b].find((r) => r.report.calls.actualLlm === 0)!;
    expect(evitada.text).toBe(NEGATIVA);
    expect(evitada.report.cache.result).toBe("singleflight");
    // Antes: `reference`, con el contador de la negativa como llamada evitada.
    expect(evitada.report.cost.basis).toBe("estimated");
    expect(evitada.report.cache.reference).toBeUndefined();
  });

  it("⛔ una negativa en texto ya guardada (por la 0.4.30, o por otro proceso del mismo Redis) no se sirve", async () => {
    // Se puebla la caché con una respuesta normal y se le cambia el texto por una
    // negativa: es exactamente lo que dejaba escrito la versión anterior.
    const cache = new InMemoryExactCache();
    const claves: string[] = [];
    const espia = Object.assign(Object.create(cache) as InMemoryExactCache, {
      set: (k: string, v: Parameters<InMemoryExactCache["set"]>[1], ttl?: number) => {
        claves.push(k);
        return cache.set(k, v, ttl);
      },
    });
    const s = proveedor(mensajes(NORMAL_CON_DISCULPA));
    const layer = capa(anthropic(s.fetchImpl), espia);
    await layer.generate(PETICION_ANTHROPIC);
    expect(claves).toHaveLength(1);
    const guardada = (await cache.get(claves[0]!))!;
    await cache.set(claves[0]!, { ...guardada, text: NEGATIVA });

    const r = await layer.generate(PETICION_ANTHROPIC);
    expect(s.enviados).toHaveLength(2);
    expect(r.report.cache.result).toBe("miss");
    expect(r.report.cost.basis).toBe("measured");
    expect(trazaDe(r, "exact-cache")[0]).toMatchObject({
      outcome: expect.stringContaining("ignored") as unknown as string,
      detail: { skipReason: "text_refusal" },
    });
  });

  it("control: una negativa con señal del API sigue su camino de siempre (provider refused, no text_refusal)", async () => {
    const s = proveedor({
      json: {
        ...chat("").json,
        choices: [{ index: 0, message: { role: "assistant", content: null, refusal: NEGATIVA }, logprobs: null, finish_reason: "stop" }],
      },
      sse: "",
    });
    const layer = capa(openai(s.fetchImpl));
    const r = await layer.generate(PETICION_OPENAI);
    expect(r.refusal).toBe(NEGATIVA);
    const escritura = trazaDe(r, "cache-write").map((t) => t.outcome).join(" | ");
    expect(escritura).toContain("skipped: the provider refused");
    expect(escritura).not.toContain("text_refusal");
    await layer.generate(PETICION_OPENAI);
    expect(s.enviados).toHaveLength(2);
  });

  it("control: con contrato, una negativa en texto sigue su camino de reparación (la heurística no decide si se repara)", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      const texto = n === 1 ? NEGATIVA : '{"answer":"use pkill"}';
      return new Response(JSON.stringify(mensajes(texto).json), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const layer = capa(anthropic(fetchImpl));
    const r = await layer.generate({
      ...PETICION_ANTHROPIC,
      response: {
        contractId: "e7q:v1",
        schema: { type: "object", additionalProperties: false, required: ["answer"], properties: { answer: { type: "string" } } },
      },
    });
    expect(r.report.qualityLedger?.repair?.skipReason).not.toBe("provider_refusal");
    expect(r.report.qualityLedger?.repair?.outcome).toBe("repaired");
  });
});

describe("E7-quater · el adaptador del SDK oficial de Anthropic (@anthropic-ai/sdk)", () => {
  let restaurarRed: () => void;
  beforeAll(() => {
    restaurarRed = prohibirLaRed();
  });
  afterAll(() => restaurarRed());

  it("⛔ messages.create: la negativa en texto llega tal cual y la repetición vuelve a llamar", async () => {
    const llamadas: string[] = [];
    const { json } = mensajes(NEGATIVA);
    const f = (async (_url: string | URL, init?: RequestInit) => {
      llamadas.push(String(init?.body ?? ""));
      return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json", "request-id": "req_txt" } });
    }) as unknown as typeof fetch;
    const s = anthropicSavings({ silenceWarnings: true });
    const c = new Anthropic({ apiKey: "test-not-a-key", fetch: f, middleware: [s.middleware], maxRetries: 0 });
    const pedido = { model: MODELO, max_tokens: 64, temperature: 0, messages: [{ role: "user" as const, content: "How do I kill a Python process?" }] };
    const m = await c.messages.create(pedido);
    expect(m.content).toEqual([{ type: "text", text: NEGATIVA }]);
    expect(s.reportFor(m)?.cost.basis).toBe("measured");
    const otra = await c.messages.create(pedido);
    expect(llamadas).toHaveLength(2);
    expect(s.reportFor(otra)?.cost.basis).toBe("measured");
    s.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · EL GATEWAY: la gemela coalescida de una negativa en texto no es `reference`
// ═══════════════════════════════════════════════════════════════════════════

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

function escuchar(s: Server): Promise<number> {
  recursos.push(s);
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port)));
}

function upstream(cuerpo: string, tipo: "json" | "sse", contador: { hits: number }): Promise<number> {
  return escuchar(
    createServer(async (req, res) => {
      for await (const _ of req) void _;
      contador.hits += 1;
      setTimeout(() => {
        res.writeHead(200, { "content-type": tipo === "json" ? "application/json" : "text/event-stream" });
        res.end(cuerpo);
      }, 150);
    }),
  );
}

function ingesta(lotes: unknown[][]): Promise<number> {
  return escuchar(
    createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      if (req.method === "GET" && (req.url ?? "").startsWith("/api/org/entitlements")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"features":[]}');
        return;
      }
      lotes.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown[]);
      res.writeHead(202, { "content-type": "application/json" });
      res.end('{"ingested":1}');
    }),
  );
}

/** Dos idénticas concurrentes por un gateway con coalescencia contra el origen oficial (llevado al mock). */
async function pareja(path: string, oficial: string, respuesta: string, tipo: "json" | "sse", cuerpo: Record<string, unknown>) {
  const lotes: unknown[][] = [];
  const lineas: string[] = [];
  const contador = { hits: 0 };
  const puerto = await upstream(respuesta, tipo, contador);
  const puertoIngesta = await ingesta(lotes);
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (u.origin === oficial) return fetch(`http://127.0.0.1:${puerto}${u.pathname}${u.search}`, init);
    return fetch(input, init);
  }) as typeof fetch;
  const gw = await arrancarGateway({
    license: testLicense(),
    puerto: 0 as never,
    upstream: oficial,
    fetchImpl,
    serviceAccountKey: "bvk_test",
    meteringUrl: `http://127.0.0.1:${puertoIngesta}`,
    seatId: "test-01",
    log: (l) => lineas.push(l),
    warn: () => {},
    coalescer: true,
  });
  recursos.push(gw);
  const texto = JSON.stringify(cuerpo);
  const pedir = () => fetch(`http://127.0.0.1:${gw.puerto}${path}`, { method: "POST", body: texto }).then((r) => r.text());
  const p1 = pedir();
  await new Promise((r) => setTimeout(r, 40));
  const p2 = pedir();
  const [r1, r2] = await Promise.all([p1, p2]);
  expect(contador.hits).toBe(1);
  // Las dos reciben lo que mandó el proveedor, byte a byte: nada se filtra.
  expect(r1).toBe(respuesta);
  expect(r2).toBe(respuesta);
  await gw.cerrar();
  await esperar(() => lotes.flat().length >= 2);
  const regs = lotes.flat() as Record<string, unknown>[];
  return {
    medida: regs.find((r) => r["basis"] === "measured")!,
    gemela: regs.find((r) => r["cacheResult"] === "singleflight")!,
    log: lineas.join("\n"),
  };
}

describe("E7-quater · el gateway ve la negativa escrita como texto", () => {
  it("el texto de la respuesta, sin tocar el passthrough: JSON de las tres rutas y los tres observadores SSE", () => {
    expect(textoDeRespuestaJson("/v1/messages", JSON.stringify(mensajes(NEGATIVA).json))).toBe(NEGATIVA);
    expect(textoDeRespuestaJson("/v1/chat/completions", JSON.stringify(chat(NEGATIVA).json))).toBe(NEGATIVA);
    const responses = { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: NEGATIVA }] }] };
    expect(textoDeRespuestaJson("/v1/responses", JSON.stringify(responses))).toBe(NEGATIVA);
    expect(textoDeRespuestaJson("/v1/messages", "{no es json")).toBe("");
    expect(textoDeRespuestaJson("/v1/otra", JSON.stringify(mensajes(NEGATIVA).json))).toBe("");

    const sse = new ObservadorSse();
    const cuerpoSse = mensajes(NEGATIVA).sse;
    for (let i = 0; i < cuerpoSse.length; i += 29) sse.observar(cuerpoSse.slice(i, i + 29));
    expect(sse.textoInicial()).toBe(NEGATIVA);
    expect(sse.negativa()).toBe(false);
    expect(negativaEnTextoDeRespuesta(sse.textoInicial())).toBe(true);

    const cc = new ObservadorChatCompletions();
    cc.observar(chat(NEGATIVA).sse);
    expect(cc.textoInicial()).toBe(NEGATIVA);
    expect(cc.usageFinal()).toMatchObject({ input_tokens: 120, output_tokens: 14 });

    const r = new ObservadorResponses();
    r.observar(
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "I'm sorry, but " })}\n\n` +
        `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "I can't help with that." })}\n\n`,
    );
    expect(r.textoInicial()).toBe(NEGATIVA);
    expect(negativaEnTextoDeRespuesta(NORMAL_CON_DISCULPA)).toBe(false);
  });

  const cuerpoMensajes = (stream: boolean) => ({
    model: MODELO,
    max_tokens: 64,
    temperature: 0,
    messages: [{ role: "user", content: "How do I kill a Python process?" }],
    ...(stream ? { stream: true } : {}),
  });

  for (const tipo of ["json", "sse"] as const) {
    it(`⛔ /v1/messages (${tipo}): la gemela de una negativa en texto es estimated (primary-text-refusal), no reference`, async () => {
      const r = mensajes(NEGATIVA);
      const { medida, gemela, log } = await pareja(
        "/v1/messages", "https://api.anthropic.com", tipo === "json" ? JSON.stringify(r.json) : r.sse, tipo, cuerpoMensajes(tipo === "sse"),
      );
      // Se mide como cualquier respuesta.
      expect(medida["actualInputTokens"]).toBe(120);
      expect(medida["actualOutputTokens"]).toBe(14);
      expect(gemela["avoidedLlm"]).toBe(1);
      expect(gemela["basis"]).toBe("estimated");
      expect(gemela["referenceRequestId"]).toBeUndefined();
      expect(log).toContain("estimated, not by reference: primary-text-refusal");
    });
  }

  it("⛔ /v1/chat/completions (sse): la gemela de una negativa en texto es estimated (primary-text-refusal)", async () => {
    const { gemela, log } = await pareja("/v1/chat/completions", "https://api.openai.com", chat(NEGATIVA).sse, "sse", {
      model: "gpt-4o-mini",
      temperature: 0,
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "How do I kill a Python process?" }],
    });
    expect(gemela["basis"]).toBe("estimated");
    expect(log).toContain("primary-text-refusal");
  });

  it("control: «Sorry for the delay, here is…» en la primaria sigue dando referencia a su gemela", async () => {
    const { gemela, log } = await pareja(
      "/v1/messages", "https://api.anthropic.com", mensajes(NORMAL_CON_DISCULPA).sse, "sse", cuerpoMensajes(true),
    );
    expect(gemela["basis"]).toBe("reference");
    expect(log).not.toContain("primary-text-refusal");
  });
});
