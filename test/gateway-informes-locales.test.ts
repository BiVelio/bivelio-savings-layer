import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, it, expect, vi, type MockInstance } from "vitest";

import { arrancarGateway, type GatewayArrancado, type OpcionesGateway } from "../gateway/servidor.js";
import {
  BuzonDeInformes,
  CABECERA_ID_DE_PETICION,
  CABECERA_PIDE_INFORME,
  ESQUEMA_ESTADO,
  ESQUEMA_INFORME,
  VigiaDeIdDeRespuesta,
  hostLocal,
  idDeRespuesta,
  origenPublico,
  pideInforme,
  type InformeLocal,
} from "../gateway/informes-locales.js";
import type { SavingsReport } from "../src/contracts/types.js";
import { BV_SALA_VERSION } from "../src/version.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";
import { testLicense } from "./helpers/test-license.js";

/**
 * EL BUZÓN DE INFORMES LOCALES — el `SavingsReport` de cada petición, de vuelta
 * al cliente que lo pide (gateway/informes-locales.ts). Es lo que hace que un
 * script de Python, o de cualquier lenguaje, reciba por petición lo mismo que
 * el SDK de TypeScript: los números del panel, medidos con el contador del
 * proveedor.
 *
 * Lo que se fija, contra upstream e ingesta FALSOS (nada sale de 127.0.0.1):
 *   · sin `x-bvsala-report` no cambia NADA (ni cabecera de respuesta, ni buzón);
 *   · con ella: la cabecera NO llega al proveedor, la respuesta trae el id, y el
 *     informe local es el mismo registro que recibe la ingesta;
 *   · se encuentra por id de petición y por id de respuesta, en JSON y en SSE,
 *     en los tres dialectos;
 *   · lo que no se mide dice por qué, con el motivo de la línea de log;
 *   · las rutas locales no viajan al upstream, van detrás de la licencia y no
 *     enseñan nada secreto;
 *   · la gemela coalescida recibe SU id, no el de su primaria.
 */

const MODELO_OPENAI = "gpt-4o-mini";
const MODELO_ANTHROPIC = "claude-haiku-4-5";
const chunk = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;

const CHAT_JSON = {
  id: "chatcmpl-local-1",
  object: "chat.completion",
  model: MODELO_OPENAI,
  choices: [{ index: 0, message: { role: "assistant", content: "Hola" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } },
};
const chatSse = (conUso: boolean, id = "chatcmpl-local-2"): string =>
  chunk({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "Ho" } }] }) +
  chunk({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "la" } }] }) +
  chunk({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
  (conUso ? chunk({ id, object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } }) : "") +
  "data: [DONE]\n\n";
const ANTHROPIC_SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_local_3","usage":{"input_tokens":100,"cache_read_input_tokens":4000,"output_tokens":1}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"OK"}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":100,"cache_read_input_tokens":4000,"output_tokens":42}}\n\n',
  "event: message_stop\ndata: {}\n\n",
].join("");

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

const json =
  (respuesta: unknown, retrasoMs = 0, status = 200) =>
  (_r: Recibida, res: ServerResponse): void => {
    setTimeout(() => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(respuesta));
    }, retrasoMs);
  };
const sse =
  (cuerpo: string, retrasoMs = 0) =>
  (_r: Recibida, res: ServerResponse): void => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(cuerpo);
    }, retrasoMs);
  };

function ingestaFalsa(lotes: unknown[][]): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer(async (req, res) => {
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
  const registros = async (esperados: number): Promise<Record<string, unknown>[]> => {
    await gw.cerrar();
    const t0 = Date.now();
    while (lotes.flat().length < esperados && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 20));
    return lotes.flat() as Record<string, unknown>[];
  };
  return { gw, lineas, registros };
}

const base = (gw: GatewayArrancado) => `http://127.0.0.1:${gw.puerto}`;

function pedir(gw: GatewayArrancado, path: string, cuerpo: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base(gw)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(cuerpo),
  });
}
const CON_INFORME = { [CABECERA_PIDE_INFORME]: "1" };

async function informe(gw: GatewayArrancado, ruta: string): Promise<{ status: number; cuerpo: InformeLocal }> {
  const r = await fetch(`${base(gw)}${ruta}`);
  return { status: r.status, cuerpo: (await r.json()) as InformeLocal };
}

describe("sin la cabecera no cambia nada", () => {
  it("ni cabecera de id en la respuesta, ni informe guardado, y el proveedor recibe lo de siempre", async () => {
    const up = await upstreamFalso(json(CHAT_JSON));
    const { gw } = await gateway(up.puerto);
    const r = await pedir(gw, "/v1/chat/completions", { model: MODELO_OPENAI, messages: [] }, { "x-otra": "sí-viaja" });
    expect(r.status).toBe(200);
    await r.text();
    expect(r.headers.get(CABECERA_ID_DE_PETICION)).toBeNull();
    expect(up.recibidas[0]!.headers["x-otra"]).toBe("sí-viaja");
    const porRespuesta = await informe(gw, `/_bvsala/v1/reports?response_id=${CHAT_JSON.id}`);
    expect(porRespuesta.status).toBe(404);
  });

  it("un valor distinto de 1/true no es pedirlo", () => {
    expect(pideInforme("1")).toBe(true);
    expect(pideInforme("true")).toBe(true);
    expect(pideInforme(" TRUE ")).toBe(true);
    expect(pideInforme("0")).toBe(false);
    expect(pideInforme("yes")).toBe(false);
    expect(pideInforme(undefined)).toBe(false);
    expect(pideInforme(["1", "0"])).toBe(true);
  });
});

describe("con la cabecera: el informe del panel, de vuelta al cliente", () => {
  it("JSON de chat/completions: la cabecera no llega al proveedor, y el informe es el registro que recibe la ingesta", async () => {
    const up = await upstreamFalso(json(CHAT_JSON));
    const { gw, registros } = await gateway(up.puerto);
    const r = await pedir(gw, "/v1/chat/completions", { model: MODELO_OPENAI, messages: [] }, CON_INFORME);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { id: string }).id).toBe(CHAT_JSON.id);
    const id = r.headers.get(CABECERA_ID_DE_PETICION);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(up.recibidas[0]!.headers[CABECERA_PIDE_INFORME]).toBeUndefined();

    const porId = await informe(gw, `/_bvsala/v1/reports/${id}`);
    expect(porId.status).toBe(200);
    expect(porId.cuerpo.schema).toBe(ESQUEMA_INFORME);
    expect(porId.cuerpo.status).toBe("metered");
    expect(porId.cuerpo.reason).toBeNull();
    expect(porId.cuerpo.responseId).toBe(CHAT_JSON.id);
    expect(porId.cuerpo.path).toBe("/v1/chat/completions");
    const porRespuesta = await informe(gw, `/_bvsala/v1/reports?response_id=${CHAT_JSON.id}`);
    expect(porRespuesta.cuerpo).toEqual(porId.cuerpo);

    const rep = porId.cuerpo.report!;
    const [reg] = await registros(1);
    expect(reg).toBeDefined();
    expect(reg!["requestId"]).toBe(rep.requestId);
    expect(rep.requestId).toBe(id);
    expect(reg!["model"]).toBe(rep.model);
    expect(reg!["basis"]).toBe(rep.cost.basis);
    expect(reg!["actualCost"]).toBe(rep.cost.actual);
    expect(reg!["baselineCost"]).toBe(rep.cost.baselineEstimate);
    expect(reg!["netSavings"]).toBe(rep.cost.netSavingsRatio);
    expect(reg!["actualInputTokens"]).toBe(rep.tokens.actualInput);
    expect(reg!["actualOutputTokens"]).toBe(rep.tokens.actualOutput);
    expect(reg!["providerCachedInputTokens"]).toBe(rep.tokens.providerCachedInput ?? 0);
    expect(rep.cost.basis).toBe("measured");
    expect(rep.tokens.actualOutput).toBe(20);
  });

  it("SSE de chat con include_usage: medido, y el id de respuesta sale de los chunks", async () => {
    const up = await upstreamFalso(sse(chatSse(true)));
    const { gw } = await gateway(up.puerto);
    const r = await pedir(
      gw,
      "/v1/chat/completions",
      { model: MODELO_OPENAI, messages: [], stream: true, stream_options: { include_usage: true } },
      CON_INFORME,
    );
    await r.text();
    const i = await informe(gw, `/_bvsala/v1/reports?response_id=chatcmpl-local-2&wait_ms=2000`);
    expect(i.status).toBe(200);
    expect(i.cuerpo.status).toBe("metered");
    expect(i.cuerpo.requestId).toBe(r.headers.get(CABECERA_ID_DE_PETICION));
    expect(i.cuerpo.report!.tokens.actualInput).toBe(100);
  });

  it("SSE de chat SIN include_usage: no medido, con el motivo de la línea de log", async () => {
    const up = await upstreamFalso(sse(chatSse(false)));
    const { gw, lineas } = await gateway(up.puerto, { avisosDeNoMedido: false });
    const r = await pedir(gw, "/v1/chat/completions", { model: MODELO_OPENAI, messages: [], stream: true }, CON_INFORME);
    await r.text();
    const i = await informe(gw, `/_bvsala/v1/reports/${r.headers.get(CABECERA_ID_DE_PETICION)}?wait_ms=2000`);
    expect(i.cuerpo.status).toBe("not_metered");
    expect(i.cuerpo.report).toBeNull();
    expect(i.cuerpo.reason).toBe("the request did not ask for usage (stream_options.include_usage)");
    expect(lineas.join("\n")).toContain(`not metered: ${i.cuerpo.reason}`);
  });

  it("Anthropic /v1/messages en SSE: el id sale de message_start y el coste es el del contador final", async () => {
    const up = await upstreamFalso(sse(ANTHROPIC_SSE));
    const { gw, registros } = await gateway(up.puerto);
    const r = await pedir(gw, "/v1/messages", { model: MODELO_ANTHROPIC, messages: [], stream: true }, CON_INFORME);
    await r.text();
    const i = await informe(gw, `/_bvsala/v1/reports?response_id=msg_local_3&wait_ms=2000`);
    expect(i.cuerpo.status).toBe("metered");
    expect(i.cuerpo.report!.tokens.actualOutput).toBe(42);
    const [reg] = await registros(1);
    expect(reg!["actualCost"]).toBe(i.cuerpo.report!.cost.actual);
  });

  it("Responses API en SSE (Codex) y en JSON: el id sale de response.created o del cuerpo", async () => {
    const ev = (tipo: string, d: Record<string, unknown>) => `event: ${tipo}\ndata: ${JSON.stringify({ type: tipo, ...d })}\n\n`;
    const uso = { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 40 } };
    const sseResponses =
      ev("response.created", { response: { id: "resp_local_4", status: "in_progress" } }) +
      ev("response.output_text.delta", { delta: "Hola" }) +
      ev("response.completed", { response: { id: "resp_local_4", status: "completed", usage: uso } });
    const up = await upstreamFalso((r, res) =>
      JSON.parse(r.body.toString("utf8")).stream
        ? sse(sseResponses)(r, res)
        : json({ id: "resp_local_5", object: "response", status: "completed", model: MODELO_OPENAI, usage: uso })(r, res),
    );
    const { gw, registros } = await gateway(up.puerto);
    const a = await pedir(gw, "/v1/responses", { model: MODELO_OPENAI, input: "hola", stream: true }, CON_INFORME);
    await a.text();
    const b = await pedir(gw, "/v1/responses", { model: MODELO_OPENAI, input: "hola" }, CON_INFORME);
    await b.text();
    const ia = await informe(gw, `/_bvsala/v1/reports?response_id=resp_local_4&wait_ms=2000`);
    const ib = await informe(gw, `/_bvsala/v1/reports?response_id=resp_local_5&wait_ms=2000`);
    expect(ia.cuerpo.status).toBe("metered");
    expect(ib.cuerpo.status).toBe("metered");
    expect(ia.cuerpo.requestId).toBe(a.headers.get(CABECERA_ID_DE_PETICION));
    expect(ib.cuerpo.requestId).toBe(b.headers.get(CABECERA_ID_DE_PETICION));
    const regs = await registros(2);
    for (const i of [ia, ib]) {
      const reg = regs.find((r) => r["requestId"] === i.cuerpo.requestId);
      expect(reg!["actualCost"]).toBe(i.cuerpo.report!.cost.actual);
      expect(reg!["providerCachedInputTokens"]).toBe(40);
    }
  });

  it("un modelo sin precio de lista: no medido, y lo dice", async () => {
    const up = await upstreamFalso(json({ ...CHAT_JSON, id: "chatcmpl-sin-precio" }));
    const { gw } = await gateway(up.puerto);
    const r = await pedir(gw, "/v1/chat/completions", { model: "modelo-que-no-existe", messages: [] }, CON_INFORME);
    await r.text();
    const i = await informe(gw, `/_bvsala/v1/reports/${r.headers.get(CABECERA_ID_DE_PETICION)}`);
    expect(i.cuerpo.status).toBe("not_metered");
    expect(i.cuerpo.reason).toBe('model "modelo-que-no-existe" has no list price in the catalog');
  });

  it("un error del proveedor (429): no medido, con el estado", async () => {
    const up = await upstreamFalso(json({ error: { message: "slow down" } }, 0, 429));
    const { gw } = await gateway(up.puerto);
    const r = await pedir(gw, "/v1/chat/completions", { model: MODELO_OPENAI, messages: [] }, CON_INFORME);
    expect(r.status).toBe(429);
    await r.text();
    const i = await informe(gw, `/_bvsala/v1/reports/${r.headers.get(CABECERA_ID_DE_PETICION)}?wait_ms=1000`);
    expect(i.cuerpo.status).toBe("not_metered");
    expect(i.cuerpo.reason).toBe("no usage was read from the provider's answer (HTTP 429)");
  });

  it("la espera larga: el informe pedido ANTES de que el proveedor responda llega cuando se mide", async () => {
    const up = await upstreamFalso(json({ ...CHAT_JSON, id: "chatcmpl-lento" }, 300));
    const { gw } = await gateway(up.puerto);
    const pendiente = informe(gw, `/_bvsala/v1/reports?response_id=chatcmpl-lento&wait_ms=5000`);
    const r = await pedir(gw, "/v1/chat/completions", { model: MODELO_OPENAI, messages: [] }, CON_INFORME);
    await r.text();
    const i = await pendiente;
    expect(i.status).toBe(200);
    expect(i.cuerpo.status).toBe("metered");
  });

  it("⛔ la gemela coalescida recibe SU id, no el de su primaria, y su informe no es el de la primaria", async () => {
    const up = await upstreamFalso(json({ ...CHAT_JSON, id: "chatcmpl-gemelas" }, 300));
    const { gw } = await gateway(up.puerto, { coalescer: true });
    const cuerpo = { model: MODELO_OPENAI, messages: [{ role: "user", content: "igual" }] };
    const [a, b] = await Promise.all([
      pedir(gw, "/v1/chat/completions", cuerpo, CON_INFORME),
      new Promise<Response>((res) => setTimeout(() => res(pedir(gw, "/v1/chat/completions", cuerpo, CON_INFORME)), 50)),
    ]);
    await Promise.all([a.text(), b.text()]);
    expect(up.recibidas).toHaveLength(1);
    const ida = a.headers.get(CABECERA_ID_DE_PETICION);
    const idb = b.headers.get(CABECERA_ID_DE_PETICION);
    expect(ida).not.toBeNull();
    expect(idb).not.toBeNull();
    expect(ida).not.toBe(idb);
    const ia = await informe(gw, `/_bvsala/v1/reports/${ida}?wait_ms=2000`);
    const ib = await informe(gw, `/_bvsala/v1/reports/${idb}?wait_ms=2000`);
    expect(ia.cuerpo.report!.requestId).toBe(ida);
    expect(ib.cuerpo.report!.requestId).toBe(idb);
    // La primaria viajó; la gemela es una llamada evitada.
    expect(ia.cuerpo.report!.calls.avoidedLlm).toBe(0);
    expect(ib.cuerpo.report!.calls.avoidedLlm).toBe(1);
  });
});

describe("las rutas locales", () => {
  it("status: lo que el cliente necesita para no operar sin licencia, y nada secreto", async () => {
    const up = await upstreamFalso(json(CHAT_JSON));
    const { gw } = await gateway(up.puerto);
    const r = await fetch(`${base(gw)}/_bvsala/v1/status`);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
    const texto = await r.text();
    const s = JSON.parse(texto) as Record<string, unknown>;
    expect(s["schema"]).toBe(ESQUEMA_ESTADO);
    expect(s["version"]).toBe(BV_SALA_VERSION);
    expect(s["upstream"]).toBe(`http://127.0.0.1:${up.puerto}`);
    expect(s["license"]).toMatchObject({ state: "active", plan: "pro" });
    expect(s["metering"]).toBe(true);
    expect(s["reports"]).toEqual({ requestHeader: CABECERA_PIDE_INFORME, responseHeader: CABECERA_ID_DE_PETICION, capacity: 1000 });
    for (const secreto of ["bvk_", "org-test", "lic-test", "jti", "token"]) expect(texto).not.toContain(secreto);
    expect(up.recibidas).toHaveLength(0);
  });

  it("el origen del upstream se enseña sin credenciales ni ruta", () => {
    expect(origenPublico("https://usuario:clave@api.ejemplo.com/v1/algo")).toBe("https://api.ejemplo.com");
    expect(origenPublico("no es una url")).toBe("unknown");
  });

  it("405 fuera de GET, 404 en lo desconocido, 400 con un wait_ms o un id raros — y nada viaja al upstream", async () => {
    const up = await upstreamFalso(json(CHAT_JSON));
    const { gw } = await gateway(up.puerto);
    const post = await fetch(`${base(gw)}/_bvsala/v1/status`, { method: "POST", body: "{}" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET");
    await post.text();
    const nada = await fetch(`${base(gw)}/_bvsala/v1/otra-cosa`);
    expect(nada.status).toBe(404);
    await nada.text();
    const malEspera = await fetch(`${base(gw)}/_bvsala/v1/reports/abc?wait_ms=-5`);
    expect(malEspera.status).toBe(400);
    await malEspera.text();
    const malId = await fetch(`${base(gw)}/_bvsala/v1/reports?response_id=${encodeURIComponent("<script>")}`);
    expect(malId.status).toBe(400);
    await malId.text();
    const desconocido = await fetch(`${base(gw)}/_bvsala/v1/reports/no-existe`);
    expect(desconocido.status).toBe(404);
    expect(((await desconocido.json()) as { error: { message: string } }).error.message).toContain(`"${CABECERA_PIDE_INFORME}: 1"`);
    expect(up.recibidas).toHaveLength(0);
  });

  it("⛔ DNS rebinding: un Host que no es de loopback recibe 403 en las rutas locales", async () => {
    const up = await upstreamFalso(json(CHAT_JSON));
    const { gw } = await gateway(up.puerto);
    const { request } = await import("node:http");
    const pedirConHost = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const r = request({ host: "127.0.0.1", port: gw.puerto, path: "/_bvsala/v1/status", headers: { host } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        r.on("error", reject);
        r.end();
      });
    expect(await pedirConHost("evil.example:8402")).toBe(403);
    expect(await pedirConHost(`localhost:${gw.puerto}`)).toBe(200);
    expect(await pedirConHost(`127.0.0.1:${gw.puerto}`)).toBe(200);
    expect(hostLocal("[::1]:8402")).toBe(true);
    expect(hostLocal(undefined)).toBe(true);
    expect(hostLocal("127.0.0.1.evil.example")).toBe(false);
    expect(up.recibidas).toHaveLength(0);
  });

  it("⛔ sin licencia viva, las rutas locales también responden 402", async () => {
    const up = await upstreamFalso(json(CHAT_JSON));
    const ahora = Math.floor(Date.now() / 1000);
    const { gw } = await gateway(up.puerto, { license: testLicense({ expires_at: ahora - 40 * 86_400, grace_days: 14 }) });
    const r = await fetch(`${base(gw)}/_bvsala/v1/status`);
    expect(r.status).toBe(402);
    expect(r.headers.get("x-bvsala-license-status")).toBe("expired");
    expect(((await r.json()) as { error: { type: string } }).error.type).toBe("license_error");
  });
});

describe("el buzón, en unidad", () => {
  const informeFalso = (requestId: string): SavingsReport => ({ requestId, model: "m" }) as unknown as SavingsReport;

  it("operar sobre un id que no se abrió no hace nada", () => {
    const b = new BuzonDeInformes();
    b.medido("x", informeFalso("x"));
    b.noMedido("x", "porque sí");
    b.anotarRespuesta("x", "resp_1");
    expect(b.tamano).toBe(0);
    expect(b.porRespuesta("resp_1")).toBeUndefined();
  });

  it("el primer cierre manda, y lo guardado es una copia", () => {
    const b = new BuzonDeInformes();
    b.abrir("a", "/v1/messages");
    const r = informeFalso("a");
    b.medido("a", r);
    b.noMedido("a", "tarde");
    (r as unknown as { model: string }).model = "cambiado";
    const i = b.porPeticion("a")!;
    expect(i.status).toBe("metered");
    expect(i.reason).toBeNull();
    expect(i.report!.model).toBe("m");
  });

  it("capacidad acotada: el más viejo sale primero, con su índice de respuesta", () => {
    const b = new BuzonDeInformes({ capacidad: 2 });
    b.abrir("a", "/");
    b.anotarRespuesta("a", "resp_a");
    b.abrir("b", "/");
    b.abrir("c", "/");
    expect(b.tamano).toBe(2);
    expect(b.porPeticion("a")).toBeUndefined();
    expect(b.porRespuesta("resp_a")).toBeUndefined();
    expect(b.porPeticion("c")).toBeDefined();
  });

  it("nada vive más de una hora", () => {
    let t = 1_000_000;
    const b = new BuzonDeInformes({ now: () => t });
    b.abrir("a", "/");
    t += 60 * 60 * 1000 + 1;
    expect(b.porPeticion("a")).toBeUndefined();
  });

  it("el id de respuesta: el primero manda y solo con forma segura", () => {
    const b = new BuzonDeInformes();
    b.abrir("a", "/");
    b.anotarRespuesta("a", "id raro con espacios");
    expect(b.porPeticion("a")!.responseId).toBeNull();
    b.anotarRespuesta("a", "resp_1");
    b.anotarRespuesta("a", "resp_2");
    expect(b.porPeticion("a")!.responseId).toBe("resp_1");
  });

  it("esperar: devuelve el cerrado en cuanto se cierra, y el pendiente si se acaba el tiempo", async () => {
    const b = new BuzonDeInformes();
    b.abrir("a", "/");
    const t0 = Date.now();
    const espera = b.esperar(() => b.porPeticion("a"), 5000);
    setTimeout(() => b.noMedido("a", "motivo"), 30);
    expect((await espera)!.status).toBe("not_metered");
    expect(Date.now() - t0).toBeLessThan(2000);
    b.abrir("p", "/");
    expect((await b.esperar(() => b.porPeticion("p"), 40))!.status).toBe("pending");
  });
});

describe("el id de la respuesta", () => {
  it("en los tres dialectos, y nunca con forma insegura", () => {
    expect(idDeRespuesta({ id: "chatcmpl-1" })).toBe("chatcmpl-1");
    expect(idDeRespuesta({ type: "message_start", message: { id: "msg_1" } })).toBe("msg_1");
    expect(idDeRespuesta({ type: "response.created", response: { id: "resp_1" } })).toBe("resp_1");
    expect(idDeRespuesta({ id: "con espacio" })).toBeNull();
    expect(idDeRespuesta([])).toBeNull();
    expect(idDeRespuesta(null)).toBeNull();
  });

  it("el vigía lo lee aunque el evento llegue partido y con CRLF", () => {
    const v = new VigiaDeIdDeRespuesta();
    const evento = 'event: message_start\r\ndata: {"type":"message_start","message":{"id":"msg_partido"}}\r\n\r\n';
    for (const trozo of [evento.slice(0, 20), evento.slice(20, 50), evento.slice(50)]) v.observar(Buffer.from(trozo));
    expect(v.valor()).toBe("msg_partido");
    v.observar('data: {"id":"otro"}\n\n');
    expect(v.valor()).toBe("msg_partido");
  });

  it("[DONE] y los data ilegibles no rompen nada", () => {
    const v = new VigiaDeIdDeRespuesta();
    v.observar("data: [DONE]\n\ndata: {roto\n\n");
    expect(v.valor()).toBeNull();
  });
});
