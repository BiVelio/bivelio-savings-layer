import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, it, expect, vi, type MockInstance } from "vitest";

import { arrancarGateway, type GatewayArrancado, type OpcionesGateway } from "../gateway/servidor.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";
import { testLicense } from "./helpers/test-license.js";

/**
 * EL DIALECTO DE CHAT COMPLETIONS EN EL GATEWAY — lo que hace falta para medir
 * un SDK oficial de OpenAI (Python, Node, cualquier lenguaje) apuntado a
 * `bvsala gateway --upstream openai`.
 *
 * Contra un upstream FALSO local y una ingesta falsa, como gateway-servidor:
 * ninguna petición sale de 127.0.0.1. Lo que se fija:
 *   · un stream con `include_usage` se mide con el contador del proveedor;
 *   · uno sin él se reenvía SIN medir y el log dice por qué (antes, silencio);
 *   · el JSON de chat/completions y de /v1/responses se mide;
 *   · una ruta sin dialecto se dice, count_tokens no;
 *   · el usage que cuenta es el FINAL, también en /v1/messages;
 *   · la inyección opt-in de include_usage es textual, respeta al cliente y se
 *     retira sola si el upstream la rechaza (400 o 422).
 */

const MODELO = "gpt-4o-mini";
const chunk = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
const texto = (t: string) => chunk({ object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: t } }] });
const FIN = chunk({ object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
const USO = chunk({
  object: "chat.completion.chunk",
  choices: [],
  usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } },
});
const DONE = "data: [DONE]\n\n";
const SSE_CON_USO = texto("Hola ") + texto("mundo") + FIN + USO + DONE;
const SSE_SIN_USO = texto("Hola ") + texto("mundo") + FIN + DONE;

interface Recibida {
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

let recursos: (Server | GatewayArrancado)[] = [];
let warn: MockInstance<(...args: unknown[]) => void>;
beforeEach(() => {
  reiniciarAvisos();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  warn.mockRestore();
  for (const r of recursos) {
    if ("cerrar" in r) await r.cerrar();
    else await new Promise((res) => r.close(res));
  }
  recursos = [];
});

function upstreamFalso(manejar: (r: Recibida, res: ServerResponse) => void): Promise<{ puerto: number; recibidas: Recibida[] }> {
  const recibidas: Recibida[] = [];
  return new Promise((resolve) => {
    const s = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const r = { path: req.url ?? "", headers: { ...req.headers }, body: Buffer.concat(chunks) };
      recibidas.push(r);
      manejar(r, res);
    });
    recursos.push(s);
    s.listen(0, "127.0.0.1", () => resolve({ puerto: (s.address() as { port: number }).port, recibidas }));
  });
}

/** Responde SSE; con `siPideUso`, el chunk de uso solo va si la petición lo pidió (como OpenAI). */
function sse(cuerpo: string | ((r: Recibida) => string)) {
  return (r: Recibida, res: ServerResponse): void => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(typeof cuerpo === "string" ? cuerpo : cuerpo(r));
  };
}
const comoOpenAI = (r: Recibida): string =>
  r.body.toString("utf8").includes('"include_usage":true') ? SSE_CON_USO : SSE_SIN_USO;

function json(respuesta: unknown, retrasoMs = 0) {
  return (_r: Recibida, res: ServerResponse): void => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(respuesta));
    }, retrasoMs);
  };
}

/**
 * Parte G · la referencia solo se concede contra el origen OFICIAL. Con
 * `upstream: "https://api.openai.com"` y este `fetchImpl`, ese origen va al mock
 * local y lo demás (la ingesta) por el fetch de siempre: nada sale a Internet.
 */
function comoOficial(puerto: number): Partial<OpcionesGateway> {
  const OFICIAL = "https://api.openai.com";
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (u.origin === OFICIAL) return fetch(`http://127.0.0.1:${puerto}${u.pathname}${u.search}`, init);
    return fetch(input, init);
  }) as typeof fetch;
  return { upstream: OFICIAL, fetchImpl };
}

function ingestaFalsa(lotes: unknown[][]): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      // El canal de entitlements (armado por defecto con clave) pregunta aquí:
      // fail-closed, sin features.
      if (req.method === "GET" && (req.url ?? "").startsWith("/api/org/entitlements")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"features":[]}');
        return;
      }
      lotes.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown[]);
      res.writeHead(202, { "content-type": "application/json" });
      res.end('{"ingested":1}');
    });
    recursos.push(s);
    s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
  });
}

async function gateway(puertoUpstream: number, extra: Partial<OpcionesGateway> = {}) {
  const lotes: unknown[][] = [];
  const ingesta = await ingestaFalsa(lotes);
  const lineas: string[] = [];
  const gw = await arrancarGateway({
    // Desde la verja de licencia (LICENSE §2) no hay gateway sin licencia verificada.
    license: testLicense(),
    puerto: 0,
    upstream: `http://127.0.0.1:${puertoUpstream}`,
    serviceAccountKey: "bvk_test",
    meteringUrl: `http://127.0.0.1:${ingesta}`,
    seatId: "t",
    log: (l) => lineas.push(l),
    ...extra,
  });
  recursos.push(gw);
  /** Cierra (drena el emisor) y devuelve los registros que llegaron a la ingesta. */
  const registros = async (esperados = 0): Promise<Record<string, unknown>[]> => {
    await gw.cerrar();
    if (esperados > 0) await esperar(() => lotes.flat().length >= esperados);
    return lotes.flat() as Record<string, unknown>[];
  };
  return { gw, lineas, registros };
}

async function esperar(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout esperando la condición");
    await new Promise((r) => setTimeout(r, 20));
  }
}

function pedir(puerto: number, path: string, cuerpo: string | Buffer, headers: Record<string, string> = {}) {
  return fetch(`http://127.0.0.1:${puerto}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: cuerpo,
  });
}

const avisos = (): string => warn.mock.calls.map((c) => String(c[0])).join("\n");

describe("gateway · /v1/chat/completions en stream", () => {
  it("(a) con stream_options.include_usage → 1 registro measured con el contador del proveedor, y los bytes intactos", async () => {
    const up = await upstreamFalso(sse(SSE_CON_USO));
    const { gw, registros } = await gateway(up.puerto);
    const cuerpo = JSON.stringify({ model: MODELO, messages: [], stream: true, stream_options: { include_usage: true } });

    const r = await pedir(gw.puerto, "/v1/chat/completions", cuerpo);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(SSE_CON_USO);
    expect(up.recibidas[0]!.body.toString("utf8")).toBe(cuerpo);

    const regs = await registros(1);
    expect(regs).toHaveLength(1);
    const reg = regs[0]!;
    expect(reg["basis"]).toBe("measured");
    expect(reg["model"]).toBe(MODELO);
    expect(reg["actualInputTokens"]).toBe(100);
    expect(reg["actualOutputTokens"]).toBe(20);
    expect(reg["providerCachedInputTokens"]).toBe(40);
    // 60 a 0.00015 + 40 a 0.000075 + 20 a 0.0006, por 1K
    expect(reg["actualCost"] as number).toBeCloseTo(0.000024, 10);
    expect(reg["baselineCost"]).toBe(reg["actualCost"]);
    expect(reg["netSavings"]).toBe(0);
  });

  it("(b) sin stream_options → 0 registros, la línea dice que no pidió el usage y el aviso dice cómo pedirlo", async () => {
    const up = await upstreamFalso(sse(comoOpenAI));
    const { gw, lineas, registros } = await gateway(up.puerto);

    const r = await pedir(gw.puerto, "/v1/chat/completions", JSON.stringify({ model: MODELO, messages: [], stream: true }));
    expect(await r.text()).toBe(SSE_SIN_USO);

    expect(await registros()).toEqual([]);
    expect(lineas.join("\n")).toContain(
      "POST /v1/chat/completions → 200 (stream) · not metered: the request did not ask for usage (stream_options.include_usage)",
    );
    expect(avisos()).toContain('stream_options={"include_usage": True}');
    expect(avisos()).toContain("BVSALA_GATEWAY_USAGE_INJECT=1");
  });

  it("(c) pide el usage pero el upstream no manda el chunk final → 0 registros y la línea lo dice", async () => {
    const up = await upstreamFalso(sse(SSE_SIN_USO));
    const { gw, lineas, registros } = await gateway(up.puerto);

    const cuerpo = JSON.stringify({ model: MODELO, messages: [], stream: true, stream_options: { include_usage: true } });
    await (await pedir(gw.puerto, "/v1/chat/completions", cuerpo)).text();

    expect(await registros()).toEqual([]);
    expect(lineas.join("\n")).toContain("not metered: the stream ended without the provider's final usage event");
    expect(avisos()).toContain("POST /v1/chat/completions answered without the provider's final usage");
  });

  it("(d) usage en cada chunk (vLLM) y el cliente corta antes de [DONE] → 0 registros: un parcial no es medida", async () => {
    const parcial = (n: number) =>
      chunk({ choices: [{ index: 0, delta: { content: "x" } }], usage: { prompt_tokens: 10, completion_tokens: n } });
    const up = await upstreamFalso((_r, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(parcial(1));
      res.write(parcial(2));
      const t = setTimeout(() => res.end(FIN + DONE), 3000);
      res.on("close", () => clearTimeout(t));
    });
    const { gw, registros } = await gateway(up.puerto);

    const ac = new AbortController();
    const r = await fetch(`http://127.0.0.1:${gw.puerto}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: MODELO, messages: [], stream: true }),
      signal: ac.signal,
    });
    const lector = r.body!.getReader();
    let recibido = "";
    while (!recibido.includes('"completion_tokens":2')) recibido += new TextDecoder().decode((await lector.read()).value);
    ac.abort();

    await new Promise((res) => setTimeout(res, 300));
    expect(await registros()).toEqual([]);
  });

  it("(o) por defecto (sin usageInject) el upstream recibe los bytes idénticos", async () => {
    const up = await upstreamFalso(sse(comoOpenAI));
    const { gw } = await gateway(up.puerto);
    const cuerpo = ' {"model":"gpt-4o-mini","stream":true,"temperature":0.30000000000000004,"messages":[]}';
    await (await pedir(gw.puerto, "/v1/chat/completions", cuerpo)).text();
    expect(up.recibidas[0]!.body.toString("utf8")).toBe(cuerpo);
  });
});

describe("gateway · respuestas JSON por dialecto", () => {
  it("(e) chat/completions con stream:false y usage → 1 registro measured", async () => {
    const up = await upstreamFalso(
      json({ object: "chat.completion", choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } } }),
    );
    const { gw, registros } = await gateway(up.puerto);
    await (await pedir(gw.puerto, "/v1/chat/completions", JSON.stringify({ model: MODELO, messages: [] }))).text();

    const regs = await registros(1);
    expect(regs).toHaveLength(1);
    expect(regs[0]!["basis"]).toBe("measured");
    expect(regs[0]!["actualInputTokens"]).toBe(100);
    expect(regs[0]!["providerCachedInputTokens"]).toBe(40);
    expect(regs[0]!["actualOutputTokens"]).toBe(20);
  });

  it("(f) chat/completions JSON sin usage → 0 registros y la línea lo dice", async () => {
    const up = await upstreamFalso(json({ object: "chat.completion", choices: [] }));
    const { gw, lineas, registros } = await gateway(up.puerto);
    await (await pedir(gw.puerto, "/v1/chat/completions", JSON.stringify({ model: MODELO, messages: [] }))).text();

    expect(await registros()).toEqual([]);
    expect(lineas.join("\n")).toContain("POST /v1/chat/completions → 200 · not metered: the response carried no usage");
  });

  it("(g) POST /v1/responses en JSON (antes no se medía) → 1 registro con su desglose", async () => {
    const up = await upstreamFalso(
      json({ object: "response", usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 40 } } }),
    );
    const { gw, registros } = await gateway(up.puerto);
    await (await pedir(gw.puerto, "/v1/responses", JSON.stringify({ model: MODELO, input: "hola" }))).text();

    const regs = await registros(1);
    expect(regs).toHaveLength(1);
    expect(regs[0]!["basis"]).toBe("measured");
    expect(regs[0]!["actualInputTokens"]).toBe(100);
    expect(regs[0]!["providerCachedInputTokens"]).toBe(40);
  });

  it("(h) una ruta sin dialecto (/v1/embeddings) se dice; count_tokens no factura y no se avisa", async () => {
    const up = await upstreamFalso(json({ usage: { prompt_tokens: 8, total_tokens: 8 }, input_tokens: 8 }));
    const { gw, lineas, registros } = await gateway(up.puerto);

    await (await pedir(gw.puerto, "/v1/messages/count_tokens", JSON.stringify({ model: "claude-haiku-4-5", messages: [] }))).text();
    expect(avisos()).not.toContain("NOT metered");
    expect(lineas.join("\n")).not.toContain("not metered");

    await (await pedir(gw.puerto, "/v1/embeddings", JSON.stringify({ model: "text-embedding-3-small", input: "hola" }))).text();
    expect(await registros()).toEqual([]);
    expect(lineas.join("\n")).toContain("POST /v1/embeddings → 200 · not metered: no usage dialect for this route");
    expect(avisos()).toContain("POST /v1/embeddings is forwarded but NOT metered");
  });

  it("(i) /v1/messages en SSE con message_start y un error SIN message_delta → 0 registros (antes, un parcial «medido»)", async () => {
    const up = await upstreamFalso(
      sse(
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":1}}}\n\n' +
          'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
      ),
    );
    const { gw, lineas, registros } = await gateway(up.puerto);
    await (await pedir(gw.puerto, "/v1/messages", JSON.stringify({ model: "claude-haiku-4-5", stream: true }))).text();

    expect(await registros()).toEqual([]);
    expect(lineas.join("\n")).toContain(
      "POST /v1/messages → 200 (stream) · not metered: the stream ended without the provider's final usage event",
    );
  });

  it("(j) coalescencia: dos chat/completions JSON idénticas → la primaria measured y la gemela por referencia (singleflight)", async () => {
    const up = await upstreamFalso(json({ object: "chat.completion", choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } }, 150));
    const { gw, registros } = await gateway(up.puerto, { coalescer: true, ...comoOficial(up.puerto) });
    const cuerpo = JSON.stringify({ model: MODELO, messages: [{ role: "user", content: "hola" }] });
    const p1 = pedir(gw.puerto, "/v1/chat/completions", cuerpo).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 40));
    const p2 = pedir(gw.puerto, "/v1/chat/completions", cuerpo).then((r) => r.text());
    await Promise.all([p1, p2]);
    expect(up.recibidas).toHaveLength(1);

    const regs = await registros(2);
    expect(regs).toHaveLength(2);
    const medida = regs.find((r) => r["basis"] === "measured")!;
    const gemela = regs.find((r) => r["cacheResult"] === "singleflight")!;
    expect(medida["actualInputTokens"]).toBe(100);
    // Parte G · primaria intacta y gpt-4o-mini con lectura documentada: suelo
    // por referencia (toda la entrada a 0,000075/1K, sin salida: no hay
    // temperature 0 en el cuerpo).
    expect(gemela["basis"]).toBe("reference");
    expect(gemela["baselineCost"]).toBeCloseTo((100 / 1000) * 0.000075, 12);
    expect(gemela["referenceRequestId"]).toBe(medida["requestId"]);
    expect(gemela["avoidedLlm"]).toBe(1);
  });

  it("(j2) ⛔ coalescencia con la inyección de include_usage: la primaria NO viajó intacta → la gemela sigue estimated", async () => {
    // La inyección cambia el cuerpo que viaja (`stream_options`): el contador de
    // la primaria ya no es el de la petición del cliente byte a byte.
    const up = await upstreamFalso((r, res) => setTimeout(() => sse(comoOpenAI)(r, res), 150));
    const { gw, lineas, registros } = await gateway(up.puerto, { coalescer: true, usageInject: true, ...comoOficial(up.puerto) });
    const cuerpo = JSON.stringify({ model: MODELO, stream: true, messages: [{ role: "user", content: "hola" }] });
    const p1 = pedir(gw.puerto, "/v1/chat/completions", cuerpo).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 40));
    const p2 = pedir(gw.puerto, "/v1/chat/completions", cuerpo).then((r) => r.text());
    await Promise.all([p1, p2]);
    expect(up.recibidas).toHaveLength(1);

    const regs = await registros(2);
    const gemela = regs.find((r) => r["cacheResult"] === "singleflight")!;
    expect(gemela["basis"]).toBe("estimated");
    expect(gemela["referenceRequestId"]).toBeUndefined();
    expect(lineas.join("\n")).toContain("estimated, not by reference: layer-changed-request");
  });
});

describe("gateway · Parte G: lo que la réplica dice de la primaria", () => {
  /** Dos idénticas concurrentes por un gateway «oficial» con coalescencia. */
  async function pareja(path: string, respuesta: unknown, cuerpo: Record<string, unknown>) {
    const up = await upstreamFalso(json(respuesta, 150));
    const { gw, lineas, registros } = await gateway(up.puerto, { coalescer: true, ...comoOficial(up.puerto) });
    const texto = JSON.stringify(cuerpo);
    const p1 = pedir(gw.puerto, path, texto).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 40));
    const p2 = pedir(gw.puerto, path, texto).then((r) => r.text());
    await Promise.all([p1, p2]);
    expect(up.recibidas).toHaveLength(1);
    const regs = await registros(2);
    return {
      medida: regs.find((r) => r["basis"] === "measured")!,
      gemela: regs.find((r) => r["cacheResult"] === "singleflight")!,
      lineas,
    };
  }

  it("(g1) ⛔ /v1/responses sin stream con `status: \"failed\"` y usage: la primaria se mide, la gemela NO por referencia", async () => {
    const { medida, gemela, lineas } = await pareja(
      "/v1/responses",
      { object: "response", status: "failed", usage: { input_tokens: 100, output_tokens: 0 } },
      { model: MODELO, input: "hola" },
    );
    expect(medida["actualInputTokens"]).toBe(100);
    expect(gemela["basis"]).toBe("estimated");
    expect(gemela["referenceRequestId"]).toBeUndefined();
    expect(lineas.join("\n")).toContain("estimated, not by reference: primary-failed");
  });

  it("(g2) la misma /v1/responses con `status: \"completed\"` sí da referencia (el control de g1)", async () => {
    const { gemela } = await pareja(
      "/v1/responses",
      { object: "response", status: "completed", service_tier: "default", usage: { input_tokens: 100, output_tokens: 5 } },
      { model: MODELO, input: "hola" },
    );
    expect(gemela["basis"]).toBe("reference");
  });

  it("(g3) ⛔ pedido `auto` y SERVIDO en `scale` (capacidad prepagada): la gemela NO por referencia", async () => {
    const { gemela, lineas } = await pareja(
      "/v1/chat/completions",
      { object: "chat.completion", service_tier: "scale", choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } },
      { model: MODELO, service_tier: "auto", messages: [{ role: "user", content: "hola" }] },
    );
    expect(gemela["basis"]).toBe("estimated");
    expect(lineas.join("\n")).toContain("estimated, not by reference: service-tier");
  });

  it("(g4) servido en `flex` sin pedirlo: el suelo baja a la mitad", async () => {
    const { gemela } = await pareja(
      "/v1/chat/completions",
      { object: "chat.completion", service_tier: "flex", choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } },
      { model: MODELO, messages: [{ role: "user", content: "hola" }] },
    );
    expect(gemela["basis"]).toBe("reference");
    expect(gemela["baselineCost"]).toBeCloseTo(0.5 * (100 / 1000) * 0.000075, 12);
  });
});

describe("gateway · inyección opt-in de include_usage (BVSALA_GATEWAY_USAGE_INJECT=1)", () => {
  it("(k) un stream sin stream_options sale con include_usage insertado TEXTUALMENTE, y se mide", async () => {
    const up = await upstreamFalso(sse(comoOpenAI));
    const { gw, registros } = await gateway(up.puerto, { usageInject: true });
    const original = '{"model":"gpt-4o-mini", "temperature":0.30000000000000004,"stream":true,"messages":[]}';

    const r = await pedir(gw.puerto, "/v1/chat/completions", original);
    expect(await r.text()).toBe(SSE_CON_USO);

    const enviado = up.recibidas[0]!.body.toString("utf8");
    expect((JSON.parse(enviado) as { stream_options: unknown }).stream_options).toEqual({ include_usage: true });
    expect(enviado).toBe('{"stream_options":{"include_usage":true},' + original.slice(1));

    const regs = await registros(1);
    expect(regs).toHaveLength(1);
    expect(regs[0]!["basis"]).toBe("measured");
  });

  it("(l) el cliente que manda include_usage: false decide él: cuerpo intacto, 0 registros, «did not ask»", async () => {
    const up = await upstreamFalso(sse(comoOpenAI));
    const { gw, lineas, registros } = await gateway(up.puerto, { usageInject: true });
    const original = JSON.stringify({ model: MODELO, stream: true, stream_options: { include_usage: false }, messages: [] });

    await (await pedir(gw.puerto, "/v1/chat/completions", original)).text();
    expect(up.recibidas[0]!.body.toString("utf8")).toBe(original);
    expect(await registros()).toEqual([]);
    expect(lineas.join("\n")).toContain("not metered: the request did not ask for usage");
  });

  it("(m) un cuerpo comprimido (gzip) pasa byte a byte: no se descomprime para inyectar", async () => {
    const up = await upstreamFalso(sse(comoOpenAI));
    const { gw } = await gateway(up.puerto, { usageInject: true });
    const comprimido = gzipSync(Buffer.from(JSON.stringify({ model: MODELO, stream: true, messages: [] })));

    await (await pedir(gw.puerto, "/v1/chat/completions", comprimido, { "content-encoding": "gzip" })).text();
    expect(up.recibidas[0]!.body.equals(comprimido)).toBe(true);
  });

  for (const status of [400, 422]) {
    it(`(n) el upstream rechaza stream_options con ${status} → reintento intacto, 200 al cliente, y la inyección se apaga`, async () => {
      const up = await upstreamFalso((r, res) => {
        if (r.body.toString("utf8").includes("stream_options")) {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Unrecognized request argument supplied: stream_options" } }));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(SSE_SIN_USO);
      });
      const { gw, lineas } = await gateway(up.puerto, { usageInject: true });
      const original = JSON.stringify({ model: MODELO, stream: true, messages: [] });

      const r = await pedir(gw.puerto, "/v1/chat/completions", original);
      expect(r.status).toBe(200);
      expect(await r.text()).toBe(SSE_SIN_USO);
      expect(up.recibidas).toHaveLength(2);
      expect(up.recibidas[1]!.body.toString("utf8")).toBe(original);
      expect(lineas.join("\n")).toContain(
        `the upstream rejected (${status}) the request with stream_options.include_usage added; forwarding it unchanged`,
      );
      expect(avisos()).toContain("rejects stream_options");

      // La siguiente ya no lo intenta: un solo viaje, sin inyectar.
      await (await pedir(gw.puerto, "/v1/chat/completions", original)).text();
      expect(up.recibidas).toHaveLength(3);
      expect(up.recibidas[2]!.body.toString("utf8")).toBe(original);
    });
  }
});

describe("gateway · lo que no se mide se dice, petición a petición", () => {
  const JSON_CON_USO = { object: "chat.completion", choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } };

  it("un modelo sin precio de lista: 0 registros y UNA línea por petición (el aviso, una vez)", async () => {
    const up = await upstreamFalso(sse(SSE_CON_USO));
    const { gw, lineas, registros } = await gateway(up.puerto);
    const cuerpo = JSON.stringify({ model: "modelo-sin-precio-x", messages: [], stream: true, stream_options: { include_usage: true } });

    await (await pedir(gw.puerto, "/v1/chat/completions", cuerpo)).text();
    await (await pedir(gw.puerto, "/v1/chat/completions", cuerpo)).text();

    expect(await registros()).toEqual([]);
    const sinPrecio = lineas.filter((l) =>
      l.includes('POST /v1/chat/completions · not metered: model "modelo-sin-precio-x" has no list price'),
    );
    expect(sinPrecio).toHaveLength(2);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("is not in the price catalog"))).toHaveLength(1);
  });

  it("un cuerpo del que no se lee el modelo (Azure lo lleva en la ruta): una línea por petición", async () => {
    const up = await upstreamFalso(json(JSON_CON_USO));
    const { gw, lineas, registros } = await gateway(up.puerto);
    const ruta = "/openai/deployments/mi-despliegue/chat/completions";

    await (await pedir(gw.puerto, ruta, JSON.stringify({ messages: [] }))).text();
    await (await pedir(gw.puerto, ruta, JSON.stringify({ messages: [] }))).text();

    expect(await registros()).toEqual([]);
    expect(lineas.filter((l) => l.includes(`POST ${ruta} · not metered: could not read the model from the request body`))).toHaveLength(2);
  });

  it("un cuerpo comprimido que no se puede leer dice su content-encoding", async () => {
    const up = await upstreamFalso(json(JSON_CON_USO));
    const { gw, lineas, registros } = await gateway(up.puerto);

    await (await pedir(gw.puerto, "/v1/chat/completions", Buffer.from("no es brotli"), { "content-encoding": "br" })).text();

    expect(await registros()).toEqual([]);
    expect(lineas.join("\n")).toContain("not metered: could not read the model from the request body (content-encoding: br)");
  });

  it("una respuesta JSON por encima del tope de captura: se sirve entera, no se mide y la línea lo dice", async () => {
    const relleno = "x".repeat(6 * 1024 * 1024);
    const up = await upstreamFalso(json({ ...JSON_CON_USO, relleno }));
    const { gw, lineas, registros } = await gateway(up.puerto);

    const r = await pedir(gw.puerto, "/v1/chat/completions", JSON.stringify({ model: MODELO, messages: [] }));
    expect((await r.text()).length).toBeGreaterThan(6 * 1024 * 1024);

    expect(await registros()).toEqual([]);
    expect(lineas.join("\n")).toContain("POST /v1/chat/completions → 200 · not metered: the response was too large to read its usage");
  });

  it("una ruta con dialecto que no responde ni JSON ni SSE (sin content-type): la línea lo dice", async () => {
    const up = await upstreamFalso((_r, res) => {
      res.writeHead(200);
      res.end(JSON.stringify(JSON_CON_USO));
    });
    const { gw, lineas, registros } = await gateway(up.puerto);
    await (await pedir(gw.puerto, "/v1/chat/completions", JSON.stringify({ model: MODELO, messages: [] }))).text();

    expect(await registros()).toEqual([]);
    expect(lineas.join("\n")).toContain("not metered: the response is neither JSON nor an event stream (content-type: none)");
  });

  it("con la inyección puesta y un cuerpo comprimido, la línea y el aviso dicen por qué no aplicó (sin mandar a ponerla)", async () => {
    const up = await upstreamFalso(sse(SSE_SIN_USO));
    const { gw, lineas } = await gateway(up.puerto, { usageInject: true });
    const comprimido = gzipSync(Buffer.from(JSON.stringify({ model: MODELO, stream: true, messages: [] })));

    await (await pedir(gw.puerto, "/v1/chat/completions", comprimido, { "content-encoding": "gzip" })).text();

    expect(lineas.join("\n")).toContain(
      "not metered: the request did not ask for usage (stream_options.include_usage); usage injection skips compressed request bodies",
    );
    expect(avisos()).toContain("BVSALA_GATEWAY_USAGE_INJECT=1 is on");
    expect(avisos()).not.toContain("Or start the gateway with BVSALA_GATEWAY_USAGE_INJECT=1");
  });

  it("tras el rechazo de stream_options, un stream sin usage dice que el upstream lo rechaza y no repite el W1", async () => {
    const up = await upstreamFalso((r, res) => {
      if (r.body.toString("utf8").includes("stream_options")) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Unrecognized request argument supplied: stream_options" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(SSE_SIN_USO);
    });
    const { gw, lineas } = await gateway(up.puerto, { usageInject: true });
    const original = JSON.stringify({ model: MODELO, stream: true, messages: [] });

    await (await pedir(gw.puerto, "/v1/chat/completions", original)).text();
    await (await pedir(gw.puerto, "/v1/chat/completions", original)).text();

    const noMedidas = lineas.filter((l) => l.includes("not metered"));
    expect(noMedidas).toHaveLength(2);
    for (const l of noMedidas) expect(l).toContain("and the upstream rejects that option");
    expect(avisos()).toContain("rejects stream_options");
    expect(avisos()).not.toContain("carry no usage, so they are forwarded but NOT metered");
  });

  it("con avisosDeNoMedido:false (modo envoltorio) la línea se escribe pero nada va a la consola", async () => {
    const up = await upstreamFalso(sse(comoOpenAI));
    const { gw, lineas } = await gateway(up.puerto, { avisosDeNoMedido: false });

    await (await pedir(gw.puerto, "/v1/chat/completions", JSON.stringify({ model: MODELO, messages: [], stream: true }))).text();
    await (await pedir(gw.puerto, "/v1/embeddings", JSON.stringify({ model: "text-embedding-3-small", input: "hola" }))).text();

    expect(lineas.join("\n")).toContain("not metered: the request did not ask for usage");
    expect(lineas.join("\n")).toContain("POST /v1/embeddings → 200 (stream) · not metered: no usage dialect for this route");
    expect(avisos()).not.toContain("NOT metered");
  });

  it("la gemela coalescida de un stream que no pidió usage dice lo mismo que su primaria", async () => {
    const up = await upstreamFalso((_r, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(SSE_SIN_USO);
      }, 150);
    });
    const { gw, lineas } = await gateway(up.puerto, { coalescer: true });
    const cuerpo = JSON.stringify({ model: MODELO, messages: [{ role: "user", content: "hola" }], stream: true });
    const p1 = pedir(gw.puerto, "/v1/chat/completions", cuerpo).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 40));
    const p2 = pedir(gw.puerto, "/v1/chat/completions", cuerpo).then((r) => r.text());
    await Promise.all([p1, p2]);
    expect(up.recibidas).toHaveLength(1);

    const noMedidas = lineas.filter((l) => l.includes("not metered"));
    expect(noMedidas).toHaveLength(2);
    for (const l of noMedidas) expect(l).toContain("the request did not ask for usage (stream_options.include_usage)");
  });
});

describe("gateway · /v1/responses en stream: los tres finales", () => {
  const ev = (tipo: string, response: unknown): string => `event: ${tipo}\ndata: ${JSON.stringify({ type: tipo, response })}\n\n`;
  const INICIO = ev("response.created", { id: "resp_1", status: "in_progress" });
  const TEXTO = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hola"}\n\n';

  it("(r1) ⛔ un stream que acaba en response.incomplete SE FACTURA: ahora se mide con el usage de ese evento", async () => {
    const up = await upstreamFalso(
      sse(
        INICIO +
          TEXTO +
          ev("response.incomplete", {
            id: "resp_1",
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 16 },
          }),
      ),
    );
    const { gw, lineas, registros } = await gateway(up.puerto);
    await (await pedir(gw.puerto, "/v1/responses", JSON.stringify({ model: MODELO, input: "hola", stream: true }))).text();

    const regs = await registros(1);
    expect(regs).toHaveLength(1);
    expect(regs[0]!["basis"]).toBe("measured");
    expect(regs[0]!["actualInputTokens"]).toBe(100);
    expect(regs[0]!["actualOutputTokens"]).toBe(16);
    expect(regs[0]!["providerCachedInputTokens"]).toBe(40);
    expect(lineas.join("\n")).not.toContain("not metered");
  });

  it("(r2) response.failed CON usage también se mide; SIN usage no se inventa nada y la línea lo dice", async () => {
    const conUso = await upstreamFalso(
      sse(INICIO + ev("response.failed", { id: "resp_1", status: "failed", usage: { input_tokens: 80, output_tokens: 0 } })),
    );
    const a = await gateway(conUso.puerto);
    await (await pedir(a.gw.puerto, "/v1/responses", JSON.stringify({ model: MODELO, input: "hola", stream: true }))).text();
    const regsA = await a.registros(1);
    expect(regsA).toHaveLength(1);
    expect(regsA[0]!["actualInputTokens"]).toBe(80);

    const sinUso = await upstreamFalso(
      sse(INICIO + ev("response.failed", { id: "resp_1", status: "failed", error: { code: "server_error" }, usage: null })),
    );
    const b = await gateway(sinUso.puerto, { avisosDeNoMedido: false });
    await (await pedir(b.gw.puerto, "/v1/responses", JSON.stringify({ model: MODELO, input: "hola", stream: true }))).text();
    expect(await b.registros()).toEqual([]);
    expect(b.lineas.join("\n")).toContain(
      "POST /v1/responses → 200 (stream) · not metered: the response ended as response.failed without usage",
    );
  });
});
