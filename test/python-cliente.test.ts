import { execFile, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";

import { arrancarGateway, type GatewayArrancado } from "../gateway/servidor.js";
import { CABECERA_ID_DE_PETICION, CABECERA_PIDE_INFORME, ESQUEMA_ESTADO, ESQUEMA_INFORME } from "../gateway/informes-locales.js";
import { BV_SALA_VERSION } from "../src/version.js";
import { testLicense } from "./helpers/test-license.js";

/**
 * EL CLIENTE DE PYTHON CONTRA EL GATEWAY DE VERDAD (packages/python).
 *
 * Dos cosas:
 *
 *   1. VERJAS que atan el paquete de Python al de npm sin ejecutar Python: la
 *      LICENSE es la misma byte a byte; las cabeceras y los esquemas del
 *      cliente son los del gateway; el paquete no tiene dependencias en
 *      ejecución; y la CI corre pytest.
 *   2. EXTREMO A EXTREMO: este proceso arranca dos gateways reales (OpenAI y
 *      Anthropic) con licencia de prueba, delante de upstreams e ingesta
 *      falsos en 127.0.0.1, y lanza packages/python/tests/e2e/escenario.py.
 *      Cada informe que recibe Python tiene que ser el registro que recibe la
 *      ingesta (el panel): mismo id, mismo coste, mismos tokens, misma base.
 *
 * Python sale de $BVSALA_PYTHON o de `python3`. Sin Python ≥ 3.10 el extremo a
 * extremo se salta en local; en CI es obligatorio, y con los dos SDK oficiales.
 */

const RAIZ = fileURLToPath(new URL("..", import.meta.url));
const leer = (ruta: string) => readFileSync(`${RAIZ}${ruta}`, "utf8");
const EN_CI = process.env.CI === "true";
const PY = process.env.BVSALA_PYTHON ?? "python3";
const versionPy = spawnSync(PY, ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"], { encoding: "utf8" });
const [mayor, menor] = (versionPy.stdout ?? "").trim().split(".").map(Number);
const hayPython = versionPy.status === 0 && (mayor! > 3 || (mayor === 3 && menor! >= 10));

describe("verjas: el paquete de Python dice lo mismo que el de npm", () => {
  it("la LICENSE de Python es la del paquete de npm, byte a byte", () => {
    expect(leer("packages/python/LICENSE")).toBe(leer("LICENSE"));
    const pyproject = leer("packages/python/pyproject.toml");
    expect(pyproject).toMatch(/^license-files = \["LICENSE"\]$/m);
  });

  it("las cabeceras y los esquemas del cliente son los del gateway", () => {
    const gateway = leer("packages/python/src/bvsala/_gateway.py");
    const claves = leer("packages/python/src/bvsala/_keys.py");
    const informe = leer("packages/python/src/bvsala/_report.py");
    expect(gateway).toContain(`REPORT_HEADER = "${CABECERA_PIDE_INFORME}"`);
    expect(claves).toContain(`REQUEST_ID_HEADER = "${CABECERA_ID_DE_PETICION}"`);
    expect(informe).toContain(`REPORT_SCHEMA = "${ESQUEMA_INFORME}"`);
    expect(informe).toContain(`STATUS_SCHEMA = "${ESQUEMA_ESTADO}"`);
  });

  it("⛔ sin dependencias en ejecución: solo la biblioteca estándar", () => {
    const pyproject = leer("packages/python/pyproject.toml");
    expect(pyproject).toMatch(/^dependencies = \[\]$/m);
    for (const f of ["_gateway.py", "_keys.py", "_report.py", "_errors.py", "__init__.py", "__main__.py", "_json_estricto.py", "_uso.py"]) {
      const src = leer(`packages/python/src/bvsala/${f}`);
      const importados = [...src.matchAll(/^(?:from|import) ([A-Za-z_][\w]*)/gm)].map((m) => m[1]);
      const ajenos = importados.filter(
        (m) => !["__future__", "asyncio", "json", "os", "re", "threading", "urllib", "collections", "typing", "dataclasses", "argparse", "sys", "math"].includes(m!),
      );
      expect(ajenos, f).toEqual([]);
    }
  });

  it("⛔ el cliente jamás habla con BiVelio ni con el proveedor: solo con el gateway", () => {
    for (const f of ["_gateway.py", "_keys.py", "_report.py", "__init__.py", "__main__.py", "_json_estricto.py", "_uso.py"]) {
      const src = leer(`packages/python/src/bvsala/${f}`);
      // Las únicas URL del código son la del gateway local y las de la documentación.
      const urls = [...src.matchAll(/https?:\/\/[^\s"'`)<>]+/g)].map((m) => m[0]);
      for (const u of urls) expect(u, `${f}: ${u}`).toMatch(/^http:\/\/127\.0\.0\.1:(8402|8403)$/);
    }
  });

  it("la CI corre pytest con dependencias de prueba fijadas por hash", () => {
    const ci = leer(".github/workflows/ci.yml");
    expect(ci).toContain("actions/setup-python@");
    expect(ci).toMatch(/pip install --require-hashes[^\n]*-r packages\/python\/requirements-ci\.txt/);
    expect(ci).toMatch(/python -m pytest packages\/python/);
    const req = leer("packages/python/requirements-ci.txt");
    for (const paquete of ["pytest", "openai", "anthropic"]) expect(req).toMatch(new RegExp(`^${paquete}==[\\d.]+ \\\\$`, "m"));
    expect(req).toContain("--hash=sha256:");
  });
});

// ── Extremo a extremo ────────────────────────────────────────────────────────

const chunk = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

/** Las cabeceras que recibió cada upstream falso: la del informe no debe estar nunca. */
const cabecerasRecibidas: string[][] = [];

function upstreamOpenAI(): Promise<{ server: Server; puerto: number }> {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      cabecerasRecibidas.push(Object.keys(req.headers));
      const partes: Buffer[] = [];
      for await (const c of req) partes.push(c as Buffer);
      const cuerpo = JSON.parse(Buffer.concat(partes).toString("utf8") || "{}") as { stream?: boolean; stream_options?: { include_usage?: boolean } };
      const id = `chatcmpl-e2e-${Math.random().toString(36).slice(2, 10)}`;
      const base = { id, object: "chat.completion.chunk", created: 0, model: "gpt-4o-mini" };
      if (cuerpo.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Hi" }, finish_reason: null }] }) +
            chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
            (cuerpo.stream_options?.include_usage
              ? chunk({ ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 } } })
              : "") +
            "data: [DONE]\n\n",
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id,
          object: "chat.completion",
          created: 0,
          model: "gpt-4o-mini",
          choices: [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 } },
        }),
      );
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, puerto: (server.address() as { port: number }).port }));
  });
}

function upstreamAnthropic(): Promise<{ server: Server; puerto: number }> {
  return new Promise((resolve) => {
    const server = createServer(async (req, res: ServerResponse) => {
      cabecerasRecibidas.push(Object.keys(req.headers));
      const partes: Buffer[] = [];
      for await (const c of req) partes.push(c as Buffer);
      const cuerpo = JSON.parse(Buffer.concat(partes).toString("utf8") || "{}") as { stream?: boolean };
      const id = `msg_e2e_${Math.random().toString(36).slice(2, 10)}`;
      const mensaje = {
        id,
        type: "message",
        role: "assistant",
        model: "claude-haiku-4-5",
        content: [{ type: "text", text: "Hi" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 100, cache_read_input_tokens: 4000, output_tokens: 20 },
      };
      if (cuerpo.stream) {
        const ev = (e: string, d: unknown) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          ev("message_start", {
            type: "message_start",
            message: { ...mensaje, content: [], stop_reason: null, usage: { input_tokens: 100, cache_read_input_tokens: 4000, output_tokens: 1 } },
          }) +
            ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
            ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } }) +
            ev("content_block_stop", { type: "content_block_stop", index: 0 }) +
            ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } }) +
            ev("message_stop", { type: "message_stop" }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(mensaje));
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, puerto: (server.address() as { port: number }).port }));
  });
}

function ingestaFalsa(registros: Record<string, unknown>[]): Promise<{ server: Server; puerto: number }> {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const partes: Buffer[] = [];
      for await (const c of req) partes.push(c as Buffer);
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"features":[]}');
        return;
      }
      registros.push(...(JSON.parse(Buffer.concat(partes).toString("utf8")) as Record<string, unknown>[]));
      res.writeHead(202, { "content-type": "application/json" });
      res.end('{"ingested":1}');
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, puerto: (server.address() as { port: number }).port }));
  });
}

interface Paso {
  paso: string;
  ausente?: boolean;
  requestId?: string;
  status?: string;
  reason?: string | null;
  report?: Record<string, unknown> | null;
  [k: string]: unknown;
}

describe.skipIf(!hayPython && !EN_CI)("extremo a extremo: Python → gateway real → upstream falso", () => {
  const servidores: Server[] = [];
  const gateways: GatewayArrancado[] = [];
  const registros: Record<string, unknown>[] = [];
  let pasos: Paso[] = [];
  let upOpenAI = 0;

  beforeAll(async () => {
    if (!hayPython) throw new Error(`CI needs Python >= 3.10 at ${PY} for the Python client test`);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const ingesta = await ingestaFalsa(registros);
    const oa = await upstreamOpenAI();
    const an = await upstreamAnthropic();
    servidores.push(ingesta.server, oa.server, an.server);
    upOpenAI = oa.puerto;
    const comun = {
      license: testLicense(),
      puerto: 0,
      serviceAccountKey: "bvk_test",
      meteringUrl: `http://127.0.0.1:${ingesta.puerto}`,
      seatId: "e2e",
      log: () => {},
      avisosDeNoMedido: false,
    };
    const gOa = await arrancarGateway({ ...comun, upstream: `http://127.0.0.1:${oa.puerto}` });
    const gAn = await arrancarGateway({ ...comun, license: testLicense(), upstream: `http://127.0.0.1:${an.puerto}` });
    gateways.push(gOa, gAn);
    const cfg = {
      openai: `http://127.0.0.1:${gOa.puerto}`,
      openaiUpstream: `http://127.0.0.1:${oa.puerto}`,
      anthropic: `http://127.0.0.1:${gAn.puerto}`,
      anthropicUpstream: `http://127.0.0.1:${an.puerto}`,
    };
    // ASÍNCRONO a propósito: los gateways viven en ESTE proceso, y un spawnSync
    // bloquearía el bucle de eventos que tiene que contestarle a Python.
    const { stdout } = await promisify(execFile)(PY, [`${RAIZ}packages/python/tests/e2e/escenario.py`, JSON.stringify(cfg)], {
      timeout: 60_000,
      env: { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", PYTHONDONTWRITEBYTECODE: "1" },
    });
    pasos = stdout
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Paso);
    // Cerrar DRENA el emisor: después, la ingesta tiene todos los registros.
    for (const g of gateways) await g.cerrar();
  }, 90_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    for (const s of servidores) await new Promise((r) => s.close(r));
  });

  const paso = (nombre: string): Paso => {
    const p = pasos.find((x) => x.paso === nombre);
    if (!p) throw new Error(`the Python scenario printed no step '${nombre}'`);
    return p;
  };

  /** Lo que Python recibió es el registro que recibió la ingesta: mismo id, dinero, tokens y base. */
  const esElDelPanel = (p: Paso): void => {
    expect(p.status).toBe("metered");
    const rep = p.report as { requestId: string; model: string; cost: Record<string, unknown>; tokens: Record<string, unknown> };
    expect(rep.requestId).toBe(p.requestId);
    const reg = registros.find((r) => r["requestId"] === p.requestId);
    expect(reg, `ingest record for ${p.paso}`).toBeDefined();
    expect(reg!["model"]).toBe(rep.model);
    expect(reg!["basis"]).toBe(rep.cost["basis"]);
    expect(reg!["actualCost"]).toBe(rep.cost["actual"]);
    expect(reg!["baselineCost"]).toBe(rep.cost["baselineEstimate"]);
    expect(reg!["netSavings"]).toBe(rep.cost["netSavingsRatio"]);
    expect(reg!["actualInputTokens"]).toBe(rep.tokens["actualInput"]);
    expect(reg!["actualOutputTokens"]).toBe(rep.tokens["actualOutput"]);
    expect(reg!["providerCachedInputTokens"]).toBe(rep.tokens["providerCachedInput"] ?? 0);
  };

  it("status: la versión, el upstream y la licencia del gateway", () => {
    const s = paso("status");
    expect(s["version"]).toBe(BV_SALA_VERSION);
    expect(s["upstream"]).toBe(`http://127.0.0.1:${upOpenAI}`);
    expect(s["license"]).toBe("active");
    expect(s["metering"]).toBe(true);
  });

  it("biblioteca estándar: la cabecera y el id de respuesta llevan al mismo informe, que es el del panel", () => {
    const p = paso("stdlib");
    expect(p["cabecera"]).toBe(p.requestId);
    expect(p["mismo"]).toBe(true);
    esElDelPanel(p);
  });

  it("SDK de OpenAI envuelto: JSON y stream con include_usage medidos; sin include_usage, dicho", () => {
    const p = paso("openai");
    if (p.ausente) {
      expect(EN_CI, "CI must install the openai SDK (requirements-ci.txt)").toBe(false);
      return;
    }
    esElDelPanel(p);
    esElDelPanel(paso("openai-stream"));
    const sinUso = paso("openai-stream-sin-uso");
    expect(sinUso.status).toBe("not_metered");
    expect(sinUso.reason).toBe("the request did not ask for usage (stream_options.include_usage)");
    expect(registros.find((r) => r["requestId"] === sinUso.requestId)).toBeUndefined();
    const m = paso("mismatch");
    expect(m["lanzo"]).toBe(true);
  });

  it("SDK de Anthropic envuelto: mensaje y stream medidos, y los totales no mezclan bases", () => {
    const p = paso("anthropic");
    if (p.ausente) {
      expect(EN_CI, "CI must install the anthropic SDK (requirements-ci.txt)").toBe(false);
      return;
    }
    esElDelPanel(p);
    esElDelPanel(paso("anthropic-stream"));
    const t = paso("totales");
    expect(t["requests"]).toBe(2);
    expect(t["metered"]).toBe(2);
    const sumaPanel = registros
      .filter((r) => r["requestId"] === p.requestId || r["requestId"] === paso("anthropic-stream").requestId)
      .reduce((s, r) => s + (r["actualCost"] as number), 0);
    expect(t["actual"] as number).toBeCloseTo(sumaPanel, 12);
  });

  it("⛔ la cabecera del informe nunca llegó a un upstream, y ninguna petición se quedó sin cerrar", () => {
    expect(cabecerasRecibidas.length).toBeGreaterThan(0);
    for (const nombres of cabecerasRecibidas) expect(nombres).not.toContain(CABECERA_PIDE_INFORME);
    for (const p of pasos.filter((x) => x.requestId !== undefined)) {
      expect(["metered", "not_metered"]).toContain(p.status);
    }
  });
});
