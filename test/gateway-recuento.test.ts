import { createServer, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, it, expect, vi, type MockInstance } from "vitest";

import { arrancarGateway, type GatewayArrancado } from "../gateway/servidor.js";
import { RecuentoDeMedicion, resumenDeMedicion } from "../gateway/recuento.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";
import { testLicense } from "./helpers/test-license.js";

/**
 * EL RECUENTO DE LO MEDIDO — lo que el envoltorio imprime al salir, porque su
 * log por petición va callado (docs/investigacion/2026-09-27/agentes-de-codigo.md).
 *
 * Dos mitades: la línea (pura) y el recuento que lleva el gateway contra un
 * upstream FALSO en 127.0.0.1 (nada sale de la máquina). Lo que se fija:
 *   · lo medido se cuenta con el contador del proveedor, y nada se estima;
 *   · cada «not metered» de la API se cuenta con su motivo;
 *   · la telemetría y las sondas que un terminal manda por el base URL no
 *     cuentan como «no medido», y un error del proveedor tampoco (no factura).
 */

describe("resumenDeMedicion — la línea de salida", () => {
  it("nada pasó por el gateway: lo dice, y dice dónde mirar", () => {
    const l = resumenDeMedicion(new RecuentoDeMedicion().estado(), "copilot");
    expect(l).toContain("[bvsala copilot] metering in this run: no inference request went through the gateway");
    expect(l).toContain("docs/terminales/");
  });

  it("todo medido: solo la cuenta, sin cifra de dinero ni de ahorro", () => {
    const r = new RecuentoDeMedicion();
    r.medida();
    r.medida();
    const l = resumenDeMedicion(r.estado(), "claude");
    expect(l).toBe("[bvsala claude] metering in this run: 2 request(s) metered with the provider's usage.");
    expect(l).not.toMatch(/\$|sav/i);
  });

  it("parte sin medir: los motivos, de más a menos, y que nada se estima en su lugar", () => {
    const r = new RecuentoDeMedicion();
    r.medida();
    r.noMedida("the request did not ask for usage (stream_options.include_usage)");
    r.noMedida('model "x" has no list price in the catalog');
    r.noMedida("the request did not ask for usage (stream_options.include_usage)");
    const l = resumenDeMedicion(r.estado(), "aider");
    expect(l).toContain("1 request(s) metered");
    expect(l).toContain("3 forwarded but NOT metered (nothing is estimated in their place)");
    expect(l.indexOf("2 × the request did not ask for usage")).toBeLessThan(l.indexOf('1 × model "x"'));
  });

  it("las réplicas coalescidas van aparte: no se llaman «medidas»", () => {
    const r = new RecuentoDeMedicion();
    r.medida();
    r.replica();
    const l = resumenDeMedicion(r.estado(), "claude");
    expect(l).toContain("1 request(s) metered with the provider's usage · 1 duplicate(s) answered with a replica");
    const solo = new RecuentoDeMedicion();
    solo.replica();
    expect(resumenDeMedicion(solo.estado(), "claude")).not.toContain("no inference request");
  });

  it("los motivos distintos tienen tope: un id de modelo por petición no hace crecer la memoria sin fin", () => {
    const r = new RecuentoDeMedicion();
    for (let i = 0; i < 500; i++) r.noMedida(`model "m${i}" has no list price in the catalog`);
    const e = r.estado();
    expect(Object.keys(e.noMedidas).length).toBeLessThanOrEqual(51);
    expect(Object.values(e.noMedidas).reduce((s, n) => s + n, 0)).toBe(500);
    expect(e.noMedidas["other reasons"]).toBe(450);
  });
});

// ── El recuento dentro del gateway ─────────────────────────────────────────

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

function servidor(manejar: (path: string, cuerpo: string, res: ServerResponse) => void): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      manejar(req.url ?? "", Buffer.concat(chunks).toString("utf8"), res);
    });
    recursos.push(s);
    s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
  });
}

const sse = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;

async function montar() {
  const upstream = await servidor((path, cuerpo, res) => {
    if (path === "/v1/messages") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ id: "m", type: "message", model: "claude-sonnet-4-6", usage: { input_tokens: 10, output_tokens: 2 } }),
      );
      return;
    }
    if (path === "/v1/chat/completions") {
      // Como OpenAI: el chunk de uso solo si la petición lo pidió.
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse({ choices: [{ index: 0, delta: { content: "hola" } }] }));
      if (cuerpo.includes('"include_usage":true')) res.write(sse({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 1 } }));
      res.end("data: [DONE]\n\n");
      return;
    }
    if (path === "/v1/error") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end('{"error":"boom"}');
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const ingesta = await servidor((path, _cuerpo, res) => {
    res.writeHead(path.startsWith("/api/org/entitlements") ? 200 : 202, { "content-type": "application/json" });
    res.end(path.startsWith("/api/org/entitlements") ? '{"features":[]}' : '{"ingested":1}');
  });
  const gw = await arrancarGateway({
    license: testLicense(),
    puerto: 0,
    upstream: `http://127.0.0.1:${upstream}`,
    serviceAccountKey: "bvk_test",
    meteringUrl: `http://127.0.0.1:${ingesta}`,
    seatId: "t",
    log: () => {},
    avisosDeNoMedido: false,
  });
  recursos.push(gw);
  const pedir = (path: string, cuerpo: unknown) =>
    fetch(`http://127.0.0.1:${gw.puerto}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cuerpo),
    }).then((r) => r.text());
  return { gw, pedir };
}

describe("el gateway lleva el recuento de lo medido y lo que no", () => {
  it("cuenta lo medido y cada «not metered» de la API con su motivo", async () => {
    const { gw, pedir } = await montar();
    await pedir("/v1/messages", { model: "claude-sonnet-4-6", max_tokens: 5, messages: [] });
    await pedir("/v1/chat/completions", {
      model: "gpt-4o-mini",
      messages: [],
      stream: true,
      stream_options: { include_usage: true },
    });
    await pedir("/v1/chat/completions", { model: "gpt-4o-mini", messages: [], stream: true });
    await pedir("/v1/messages", { model: "modelo-sin-precio-xyz", max_tokens: 5, messages: [] });

    const e = gw.medicion();
    expect(e.medidas).toBe(2);
    expect(e.noMedidas).toEqual({
      "the request did not ask for usage (stream_options.include_usage)": 1,
      'model "modelo-sin-precio-xyz" has no list price in the catalog': 1,
    });
  });

  it("la telemetría fuera de /v1/ y los errores del proveedor no cuentan como «no medido»", async () => {
    const { gw, pedir } = await montar();
    await pedir("/api/event_logging/batch", { events: [] });
    await pedir("/v1/error", { model: "claude-sonnet-4-6" });
    expect(gw.medicion()).toEqual({ medidas: 0, replicas: 0, noMedidas: {} });
    expect(resumenDeMedicion(gw.medicion(), "claude")).toContain("no inference request went through the gateway");
  });

  it("una ruta de la API sin dialecto sí cuenta, con su motivo", async () => {
    const { gw, pedir } = await montar();
    await pedir("/v1/embeddings", { model: "text-embedding-3-small", input: "x" });
    expect(gw.medicion().noMedidas).toEqual({ "no usage dialect for this route": 1 });
  });
});
