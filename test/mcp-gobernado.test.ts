import { spawn } from "node:child_process";
import { createServer, request, type Server } from "node:http";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";

import {
  ERROR_METODO,
  ERROR_PARAMETROS,
  ERROR_PARSEO,
  ERROR_PETICION,
  HERRAMIENTAS,
  MAX_BYTES_POR_MENSAJE,
  crearServidorMcp,
  servirPorStdio,
  urlDelGateway,
} from "../gateway/mcp.js";
import { BuzonDeInformes, CABECERA_PIDE_INFORME, ESQUEMA_RESUMEN, atenderRutaLocal, resumenLocal, rutaLocal } from "../gateway/informes-locales.js";
import { arrancarGateway, type GatewayArrancado } from "../gateway/servidor.js";
import type { SavingsReport } from "../src/contracts/types.js";
import { testLicense } from "./helpers/test-license.js";

/**
 * D12 · MCP GOBERNADO: `bvsala mcp`, un servidor MCP de solo lectura por stdio.
 *
 * Lo que se prueba, y contra qué:
 *   · EL MARCO: JSON-RPC 2.0, una línea por mensaje, troceado como llegue; las
 *     notificaciones no se contestan; los errores con los códigos de la spec.
 *   · SOLO LECTURA: ninguna herramienta muta, y lo único que sale hacia el
 *     gateway son GET a dos rutas locales.
 *   · SIN FUGAS DE CONTENIDO: se siembran canarios en todo lo que un informe
 *     puede llevar de identificable (ids de petición, de respuesta, de tool
 *     call, la ruta) y ninguno sale; las sumas se comprueban a mano.
 *   · DE PUNTA A PUNTA: un gateway de verdad delante de un Anthropic falso, una
 *     petición con `x-bvsala-report: 1`, y el binario `bvsala mcp` leyéndolo.
 */

const informe = (over: Partial<SavingsReport> & Record<string, unknown>): SavingsReport =>
  ({
    requestId: "req-CANARIO-1",
    model: "claude-haiku-4-5",
    cost: { baselineEstimate: 0.01, actual: 0.004, netSavingsRatio: 0.6, netSavingsUsd: 0.006, basis: "measured" },
    ...over,
  }) as unknown as SavingsReport;

function buzonSembrado(): BuzonDeInformes {
  const b = new BuzonDeInformes();
  b.abrir("req-CANARIO-1", "/v1/messages?secreto=CANARIO");
  b.anotarRespuesta("req-CANARIO-1", "msg_CANARIO_1");
  b.medido(
    "req-CANARIO-1",
    informe({
      attribution: { sessionId: "sess-A" },
      toolOutputCompaction: {
        profile: "lossless-data",
        tokenBasis: "estimated",
        estimator: { id: "heuristic", exact: false },
        decisions: [
          { toolCallId: "toolu_CANARIO_a", status: "applied", reason: "applied", transformId: "json-lossless", version: "1", tokensBefore: 700, tokensAfter: 430 },
          { toolCallId: "toolu_CANARIO_b", status: "bypassed", reason: "duplicate_keys", transformId: "json-lossless", version: "1", tokensBefore: 640, tokensAfter: 640 },
        ],
      },
      // Lo que un informe puede llevar de texto libre: nada de esto puede salir.
      trace: [{ stage: "x", note: "texto del prompt CANARIO" }],
    } as never),
  );
  b.abrir("req-CANARIO-2", "/v1/messages");
  b.medido(
    "req-CANARIO-2",
    informe({
      requestId: "req-CANARIO-2",
      attribution: { sessionId: "sess-A" },
      cost: { baselineEstimate: 0.002, actual: 0.002, netSavingsRatio: 0, netSavingsUsd: 0, basis: "estimated" },
    } as never),
  );
  b.abrir("req-CANARIO-3", "/v1/messages");
  b.noMedido("req-CANARIO-3", "the provider reported no usage");
  b.abrir("req-CANARIO-4", "/v1/messages");
  return b;
}

/** Un servidor HTTP con SOLO las rutas locales de verdad (atenderRutaLocal) sobre un buzón. */
function rutasLocales(buzon: BuzonDeInformes, vistas: string[]): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      vistas.push(`${req.method} ${req.url}`);
      const u = rutaLocal(req.url);
      if (!u) {
        res.writeHead(404).end();
        return;
      }
      await atenderRutaLocal(req, res, u, {
        buzon,
        estado: () => ({
          schema: "bvsala.gateway.status/1",
          gateway: "bvsala",
          version: "0.0.0",
          upstream: "https://api.anthropic.com",
          license: { state: "active", plan: "pro", expiresAt: null },
          metering: true,
          reports: { requestHeader: CABECERA_PIDE_INFORME, responseHeader: "x-bvsala-request-id", capacity: buzon.limite },
        }),
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` }));
  });
}

const rpc = (id: number | string | null, method: string, params?: unknown) =>
  JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, ...(params === undefined ? {} : { params }) });

describe("el marco: JSON-RPC 2.0 por líneas", () => {
  const s = crearServidorMcp({ gateway: "http://127.0.0.1:1", version: "0.0.0", fetch: (() => Promise.reject(new Error("sin red"))) as typeof fetch });
  const json = async (linea: string) => JSON.parse((await s.manejar(linea))!) as Record<string, any>;

  it("initialize negocia la versión: la pedida si se habla, si no la más nueva", async () => {
    const a = await json(rpc(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } }));
    expect(a).toMatchObject({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } } } });
    expect(a.result.serverInfo.name).toBe("bvsala");
    const b = await json(rpc(2, "initialize", { protocolVersion: "1999-01-01" }));
    expect(b.result.protocolVersion).toBe("2025-06-18");
  });

  it("una notificación (sin id) nunca tiene respuesta, ni de error", async () => {
    expect(await s.manejar(rpc(null, "notifications/initialized"))).toBeNull();
    expect(await s.manejar(rpc(null, "un/metodo/que/no/existe"))).toBeNull();
    expect(await s.manejar(rpc(null, "tools/call", { name: "gateway_status" }))).toBeNull();
  });

  it("método desconocido → -32601, con su id", async () => {
    expect(await json(rpc(7, "resources/list"))).toMatchObject({ id: 7, error: { code: ERROR_METODO } });
    expect(await json(rpc("x", "tools/execute"))).toMatchObject({ id: "x", error: { code: ERROR_METODO } });
  });

  it("JSON roto → -32700 con id null; no-objeto, lote o sin jsonrpc → -32600", async () => {
    expect(await json("{no es json")).toMatchObject({ id: null, error: { code: ERROR_PARSEO } });
    expect(await json("[]")).toMatchObject({ id: null, error: { code: ERROR_PETICION } });
    expect(await json(`[${rpc(1, "ping")}]`)).toMatchObject({ error: { code: ERROR_PETICION, message: "batches are not supported" } });
    expect(await json('"hola"')).toMatchObject({ error: { code: ERROR_PETICION } });
    expect(await json('{"id":1,"method":"ping"}')).toMatchObject({ id: 1, error: { code: ERROR_PETICION } });
    expect(await json('{"jsonrpc":"2.0","id":{"a":1},"method":"ping"}')).toMatchObject({ id: null, error: { code: ERROR_PETICION } });
    expect(await json('{"jsonrpc":"2.0","id":1,"method":"ping","params":[1]}')).toMatchObject({ id: 1, error: { code: ERROR_PARAMETROS } });
  });

  it("una respuesta del cliente (result sin method) no se contesta; una línea vacía tampoco", async () => {
    expect(await s.manejar('{"jsonrpc":"2.0","id":9,"result":{}}')).toBeNull();
    expect(await s.manejar("   ")).toBeNull();
  });

  it("ping → {}", async () => {
    expect(await json(rpc(3, "ping"))).toEqual({ jsonrpc: "2.0", id: 3, result: {} });
  });

  it("por stdio: troceado como llegue, CRLF, en orden, y una línea gigante no tumba el resto", async () => {
    const entrada = new PassThrough();
    const salida = new PassThrough();
    let escrito = "";
    salida.on("data", (b: Buffer) => (escrito += b.toString("utf8")));
    const fin = servirPorStdio(entrada, salida, { gateway: "http://127.0.0.1:1", version: "0.0.0" });
    const todo = `${rpc(1, "ping")}\r\n${rpc(null, "notifications/initialized")}\n\n${rpc(2, "tools/list")}\n`;
    // Partido a mitad de un mensaje, y de un carácter multibyte que no hay: a mitad de JSON.
    entrada.write(todo.slice(0, 10));
    entrada.write(todo.slice(10, 50));
    entrada.write(todo.slice(50));
    entrada.write(`${"x".repeat(MAX_BYTES_POR_MENSAJE + 10)}\n`);
    entrada.write(`${rpc(3, "ping")}\n`);
    entrada.end();
    await fin;
    const lineas = escrito.trimEnd().split("\n").map((l) => JSON.parse(l) as Record<string, any>);
    expect(lineas.map((l) => [l.id, l.error?.code ?? null])).toEqual([
      [1, null],
      [2, null],
      [null, ERROR_PETICION],
      [3, null],
    ]);
    // stdout es solo protocolo: cada línea es un mensaje JSON-RPC 2.0 entero.
    for (const l of lineas) expect(l.jsonrpc).toBe("2.0");
  });
});

describe("el catálogo: bajo demanda, mínimo y de solo lectura", () => {
  const s = crearServidorMcp({ gateway: "http://127.0.0.1:1", version: "0.0.0" });
  const json = async (linea: string) => JSON.parse((await s.manejar(linea))!) as Record<string, any>;

  it("tools/list pagina con nextCursor y junta, entre páginas, el catálogo entero", async () => {
    const p1 = await json(rpc(1, "tools/list"));
    expect(p1.result.tools).toHaveLength(2);
    expect(typeof p1.result.nextCursor).toBe("string");
    const p2 = await json(rpc(2, "tools/list", { cursor: p1.result.nextCursor }));
    expect(p2.result.nextCursor).toBeUndefined();
    const nombres = [...p1.result.tools, ...p2.result.tools].map((t: { name: string }) => t.name);
    expect(nombres).toEqual(["gateway_status", "session_costs", "compaction_opportunities"]);
    expect(await json(rpc(3, "tools/list", { cursor: "p999" }))).toMatchObject({ error: { code: ERROR_PARAMETROS } });
    expect(await json(rpc(4, "tools/list", { cursor: 1 }))).toMatchObject({ error: { code: ERROR_PARAMETROS } });
  });

  it("⛔ ninguna herramienta muta: todas readOnly, no destructivas, cerradas al mundo y sin argumentos", () => {
    for (const h of HERRAMIENTAS) {
      expect(h.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      expect(h.inputSchema).toEqual({ type: "object", properties: {}, additionalProperties: false });
      expect(h.name).not.toMatch(/set|enable|disable|start|stop|run|create|delete|update|write|propose|apply|experiment/i);
    }
  });

  it("herramienta desconocida o con argumentos → -32602", async () => {
    expect(await json(rpc(5, "tools/call", { name: "enable_lever" }))).toMatchObject({ error: { code: ERROR_PARAMETROS } });
    expect(await json(rpc(6, "tools/call", {}))).toMatchObject({ error: { code: ERROR_PARAMETROS } });
    expect(await json(rpc(7, "tools/call", { name: "gateway_status", arguments: { model: "x" } }))).toMatchObject({
      error: { code: ERROR_PARAMETROS, message: "gateway_status takes no arguments" },
    });
  });

  it("solo el gateway LOCAL: --gateway tiene que ser http de loopback y sin credenciales", () => {
    expect(urlDelGateway([])).toEqual({ ok: true, url: "http://127.0.0.1:8402" });
    expect(urlDelGateway(["--port", "9100"])).toEqual({ ok: true, url: "http://127.0.0.1:9100" });
    expect(urlDelGateway(["--gateway", "http://localhost:8403/algo"])).toEqual({ ok: true, url: "http://localhost:8403" });
    for (const mala of ["https://127.0.0.1:8402", "http://10.0.0.5:8402", "http://savings.bivelio.com", "http://u:p@127.0.0.1:8402", "http://127.0.0.1.nip.io:8402"]) {
      expect(urlDelGateway(["--gateway", mala]).ok, mala).toBe(false);
    }
    expect(urlDelGateway(["--port", "0"]).ok).toBe(false);
    expect(urlDelGateway(["--write"]).ok).toBe(false);
  });
});

describe("sobre las rutas locales de verdad: agregados, sin fugas, solo GET", () => {
  const vistas: string[] = [];
  let srv: { server: Server; url: string };
  let mcp: ReturnType<typeof crearServidorMcp>;
  beforeAll(async () => {
    srv = await rutasLocales(buzonSembrado(), vistas);
    mcp = crearServidorMcp({ gateway: srv.url, version: "0.0.0" });
  });
  afterAll(() => new Promise<void>((r) => srv.server.close(() => r())));

  const llamar = async (name: string) => {
    const r = JSON.parse((await mcp.manejar(rpc(1, "tools/call", { name, arguments: {} })))!) as Record<string, any>;
    return r.result as { content: Array<{ text: string }>; structuredContent: Record<string, any>; isError: boolean };
  };

  it("session_costs: por sesión y por base, sin sumar measured con estimated (cuentas a mano)", async () => {
    const r = await llamar("session_costs");
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.content[0]!.text)).toEqual(r.structuredContent);
    const sesiones = r.structuredContent.sessions as Array<Record<string, any>>;
    const a = sesiones.find((x) => x.sessionId === "sess-A")!;
    expect(a.requests).toEqual({ total: 2, metered: 2, notMetered: 0, pending: 0 });
    expect(a.costByBasis).toEqual({
      measured: { requests: 1, actualUsd: 0.004, baselineUsd: 0.01, netSavingsUsd: 0.006 },
      estimated: { requests: 1, actualUsd: 0.002, baselineUsd: 0.002, netSavingsUsd: 0 },
    });
    const sinSesion = sesiones.find((x) => x.sessionId === null)!;
    expect(sinSesion.requests).toEqual({ total: 2, metered: 0, notMetered: 1, pending: 1 });
    expect(sinSesion.notMeteredReasons).toEqual({ "the provider reported no usage": 1 });
    expect(r.structuredContent.window).toMatchObject({ reports: 4, maxAgeMinutes: 60 });
  });

  it("compaction_opportunities: códigos y cuentas, tokens marcados como estimados", async () => {
    const r = await llamar("compaction_opportunities");
    expect(r.structuredContent).toMatchObject({
      toolOutputs: 2,
      applied: 1,
      coverage: 0.5,
      estimatedTokens: { before: 700, after: 430, basis: "estimated" },
    });
    expect(r.structuredContent.opportunities.map((o: { reason: string; toolOutputs: number }) => [o.reason, o.toolOutputs]).sort()).toEqual([
      ["applied", 1],
      ["duplicate_keys", 1],
    ]);
  });

  it("gateway_status: el estado, con su alcance", async () => {
    const r = await llamar("gateway_status");
    expect(r.structuredContent.status.schema).toBe("bvsala.gateway.status/1");
    expect(r.structuredContent.scope).toMatchObject({ gateway: srv.url, readOnly: true });
  });

  it("⛔ ni un canario: ningún id de petición, de respuesta, de tool call, ni la ruta, ni texto libre", async () => {
    const todo = [await llamar("gateway_status"), await llamar("session_costs"), await llamar("compaction_opportunities")]
      .map((r) => JSON.stringify(r))
      .join("\n");
    expect(todo).not.toMatch(/CANARIO/);
    // Y la ruta de resumen, a pelo, tampoco.
    const crudo = await (await fetch(`${srv.url}/_bvsala/v1/summary`)).text();
    expect(crudo).not.toMatch(/CANARIO/);
    expect(JSON.parse(crudo).schema).toBe(ESQUEMA_RESUMEN);
  });

  it("⛔ solo lectura: lo único que salió hacia el gateway son GET a status y summary", () => {
    expect(vistas.length).toBeGreaterThan(0);
    for (const v of vistas) expect(v).toMatch(/^GET \/_bvsala\/v1\/(status|summary)$/);
  });

  it("⛔ la ruta de resumen no acepta otra cosa que GET ni un Host que no sea de loopback", async () => {
    const post = await fetch(`${srv.url}/_bvsala/v1/summary`, { method: "POST", body: "{}" });
    expect(post.status).toBe(405);
    const ajeno = await new Promise<number>((resolve) => {
      const req = request(`${srv.url}/_bvsala/v1/summary`, { headers: { host: "evil.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.end();
    });
    expect(ajeno).toBe(403);
  });

  it("resumenLocal es una función pura del buzón: lo mismo dos veces, y sin el informe ni sus ids", () => {
    const b = buzonSembrado();
    const r1 = resumenLocal(b.vigentes(), b.limite);
    const r2 = resumenLocal(b.vigentes(), b.limite);
    expect(r2).toEqual(r1);
    expect(JSON.stringify(r1)).not.toMatch(/CANARIO|requestId|responseId|toolCallId/);
  });

  it("el gateway que no responde: error de herramienta (isError), no un error de protocolo", async () => {
    const caido = crearServidorMcp({ gateway: "http://127.0.0.1:1", version: "0.0.0" });
    const r = JSON.parse((await caido.manejar(rpc(9, "tools/call", { name: "session_costs" })))!) as Record<string, any>;
    expect(r.error).toBeUndefined();
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(/is not answering/);
  });
});

describe("de punta a punta: gateway de verdad, petición con informe, y el binario `bvsala mcp`", () => {
  const RAIZ = new URL("..", import.meta.url).pathname;
  let upstream: Server;
  let ingesta: Server;
  let gateway: GatewayArrancado;
  let casa = "";

  const escuchar = (s: Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)));

  beforeAll(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    casa = mkdtempSync(join(tmpdir(), "bvsala-mcp-casa-"));
    upstream = createServer(async (req, res) => {
      for await (const _ of req) void _;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_CANARIO_e2e",
          type: "message",
          role: "assistant",
          model: "claude-haiku-4-5",
          content: [{ type: "text", text: "respuesta CANARIO del modelo" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 20 },
        }),
      );
    });
    ingesta = createServer(async (req, res) => {
      for await (const _ of req) void _;
      res.writeHead(req.method === "GET" ? 200 : 202, { "content-type": "application/json" });
      res.end(req.method === "GET" ? '{"features":[]}' : '{"ingested":1}');
    });
    const [pu, pi] = await Promise.all([escuchar(upstream), escuchar(ingesta)]);
    gateway = await arrancarGateway({
      license: testLicense(),
      puerto: 0,
      serviceAccountKey: "bvk_test",
      meteringUrl: `http://127.0.0.1:${pi}`,
      seatId: "e2e",
      log: () => {},
      avisosDeNoMedido: false,
      upstream: `http://127.0.0.1:${pu}`,
    });
    const r = await fetch(`http://127.0.0.1:${gateway.puerto}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "sk-ant-de-prueba",
        "anthropic-version": "2023-06-01",
        [CABECERA_PIDE_INFORME]: "1",
        "x-claude-code-session-id": "sess-e2e",
      },
      body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 64, messages: [{ role: "user", content: "pregunta CANARIO del usuario" }] }),
    });
    await r.text();
    expect(r.status).toBe(200);
  }, 60_000);

  afterAll(async () => {
    await gateway?.cerrar();
    await new Promise<void>((r) => upstream.close(() => r()));
    await new Promise<void>((r) => ingesta.close(() => r()));
    rmSync(casa, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("stdin → stdout: initialize, tools/list y las tres herramientas; nada más en stdout y ni un canario", async () => {
    const hijo = spawn(join(RAIZ, "node_modules/.bin/tsx"), [join(RAIZ, "gateway/bin.ts"), "mcp", "--port", String(gateway.puerto)], {
      cwd: RAIZ,
      env: { PATH: process.env.PATH ?? "", HOME: casa },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    hijo.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")));
    hijo.stderr.on("data", (b: Buffer) => (err += b.toString("utf8")));
    const fin = new Promise<number>((r) => hijo.on("close", (c) => r(c ?? -1)));
    hijo.stdin.write(
      [
        rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } }),
        rpc(null, "notifications/initialized"),
        rpc(2, "tools/list"),
        rpc(3, "tools/call", { name: "gateway_status", arguments: {} }),
        rpc(4, "tools/call", { name: "session_costs" }),
        rpc(5, "tools/call", { name: "compaction_opportunities" }),
        rpc(6, "no/existe"),
      ].join("\n") + "\n",
    );
    hijo.stdin.end();
    expect(await fin, err).toBe(0);
    const lineas = out.trimEnd().split("\n").map((l) => JSON.parse(l) as Record<string, any>);
    expect(lineas.map((l) => l.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(lineas[2]!.result.structuredContent.status.license.state).toBeTypeOf("string");
    const sesion = (lineas[3]!.result.structuredContent.sessions as Array<Record<string, any>>).find((s) => s.sessionId === "sess-e2e");
    expect(sesion, JSON.stringify(lineas[3])).toBeDefined();
    expect(sesion!.requests.metered).toBe(1);
    expect(Object.keys(sesion!.costByBasis)).toEqual(["measured"]);
    expect(sesion!.costByBasis.measured.actualUsd).toBeGreaterThan(0);
    expect(lineas[4]!.result.structuredContent.toolOutputs).toBe(0);
    expect(lineas[4]!.result.structuredContent.note).toMatch(/the gateway forwards bytes and does not compact tool outputs/);
    expect(lineas[5]!.error.code).toBe(ERROR_METODO);
    expect(out).not.toMatch(/CANARIO|sk-ant-de-prueba/);
  }, 90_000);
});
