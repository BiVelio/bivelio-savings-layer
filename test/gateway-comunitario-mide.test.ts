import { createServer, type Server } from "node:http";
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { arrancarGateway, type GatewayArrancado } from "../gateway/servidor.js";
import { costeMedido } from "../gateway/medidor.js";
import { resumenDeMedicion } from "../gateway/recuento.js";
import { CABECERA_ID_DE_PETICION, CABECERA_PIDE_INFORME } from "../gateway/informes-locales.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";

/**
 * SIN CLAVE (MODO COMUNITARIO, el de por defecto) EL GATEWAY MIDE.
 *
 * Hasta aquí `medir()` salía en seco si no había emisor: sin BIVELIO_SERVICE_KEY
 * todos los informes eran `not_metered`, el resumen de salida decía «no
 * inference request went through the gateway» después de servirlas, y el banner
 * prometía medición local. Lo que se fija:
 *
 *   · el informe local se calcula IGUAL que con clave (JSON, SSE y Chat
 *     Completions), a precio de lista, con el contador del proveedor;
 *   · el recuento y el resumen de salida dicen cuántas pasaron y cuántas se
 *     midieron;
 *   · el ENVÍO es lo único opcional: en comunidad no sale NADA de red que no sea
 *     hacia el upstream. Se comprueba en dos niveles: cada `fetch` y cada
 *     conexión TCP que abre el proceso.
 *
 * Todo en 127.0.0.1, con datos inventados.
 */

let recursos: (Server | GatewayArrancado)[] = [];
let avisos: string[] = [];
let espias: MockInstance[] = [];
/** Cada URL pedida por fetch y cada destino TCP abierto durante el test. */
let urlsDeFetch: string[] = [];
let destinosTcp: string[] = [];

beforeEach(() => {
  reiniciarAvisos();
  avisos = [];
  urlsDeFetch = [];
  destinosTcp = [];
  espias.push(vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void avisos.push(a.join(" "))));
  const fetchReal = globalThis.fetch;
  espias.push(
    vi.spyOn(globalThis, "fetch").mockImplementation(((input: string | URL | Request, init?: RequestInit) => {
      urlsDeFetch.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return fetchReal(input, init);
    }) as typeof fetch),
  );
  const conectarReal = net.Socket.prototype.connect;
  espias.push(
    vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function (this: net.Socket, ...args: unknown[]) {
      const a = args[0];
      const o = (Array.isArray(a) ? a[0] : a) as { host?: string; port?: number | string; path?: string } | number | string;
      if (typeof o === "object" && o !== null) destinosTcp.push(o.path ?? `${o.host ?? "localhost"}:${o.port}`);
      else destinosTcp.push(`${typeof args[1] === "string" ? args[1] : "localhost"}:${String(o)}`);
      return (conectarReal as (...x: unknown[]) => net.Socket).apply(this, args);
    } as never),
  );
});
afterEach(async () => {
  for (const e of espias) e.mockRestore();
  espias = [];
  for (const r of recursos) {
    if ("cerrar" in r) await r.cerrar();
    else await new Promise((res) => r.close(res));
  }
  recursos = [];
});

const USO_ANTHROPIC = { input_tokens: 1000, output_tokens: 50 };
const MODELO = "claude-sonnet-4-6";

const sseAnthropic = [
  `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_inventado_1", model: MODELO, usage: { input_tokens: 1000, output_tokens: 1 } } })}\n\n`,
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hola"}}\n\n',
  `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: USO_ANTHROPIC })}\n\n`,
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join("");

function arrancarUpstream(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const cuerpo = Buffer.concat(chunks).toString("utf8");
      if (req.url === "/v1/messages" && cuerpo.includes('"stream":true')) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sseAnthropic);
      } else if (req.url === "/v1/messages") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "msg_inventado_2", type: "message", model: MODELO, usage: USO_ANTHROPIC }));
      } else if (req.url === "/v1/chat/completions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ id: "chatcmpl-inventado", model: "gpt-4o-mini", choices: [], usage: { prompt_tokens: 800, completion_tokens: 40, total_tokens: 840 } }),
        );
      } else {
        res.writeHead(500, { "content-type": "application/json" });
        res.end('{"error":"boom"}');
      }
    });
    recursos.push(s);
    s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
  });
}

async function montar() {
  const upstream = await arrancarUpstream();
  const lineas: string[] = [];
  // SIN license y SIN serviceAccountKey: el modo comunitario, tal cual arranca `bvsala claude` sin claves.
  const gw = await arrancarGateway({ puerto: 0, upstream: `http://127.0.0.1:${upstream}`, log: (l) => lineas.push(l) });
  recursos.push(gw);
  const base = `http://127.0.0.1:${gw.puerto}`;
  const pedir = async (ruta: string, cuerpo: unknown) => {
    const r = await fetch(`${base}${ruta}`, {
      method: "POST",
      headers: { "content-type": "application/json", [CABECERA_PIDE_INFORME]: "1", "x-api-key": "clave-inventada-de-prueba" },
      body: JSON.stringify(cuerpo),
    });
    await r.text();
    const id = r.headers.get(CABECERA_ID_DE_PETICION);
    const informe = (await (await fetch(`${base}/_bvsala/v1/reports/${id}?wait_ms=2000`)).json()) as {
      status: string;
      reason: string | null;
      report: { cost: { actual: number; basis: string } } | null;
    };
    return { status: r.status, informe };
  };
  return { gw, upstream, lineas, pedir, base };
}

describe("modo comunitario (sin clave): el gateway mide en local y no manda nada a BiVelio", () => {
  it("⛔ /v1/messages sin stream: el informe es `metered` a precio de lista (antes: not_metered)", async () => {
    const { gw, pedir, lineas } = await montar();
    const { status, informe } = await pedir("/v1/messages", { model: MODELO, max_tokens: 50, messages: [{ role: "user", content: "hola" }] });
    expect(status).toBe(200);
    expect(informe.status).toBe("metered");
    expect(informe.reason).toBeNull();
    const esperado = costeMedido(MODELO, USO_ANTHROPIC)!.costeUsd;
    expect(esperado).toBeGreaterThan(0);
    expect(informe.report!.cost.actual).toBeCloseTo(esperado, 12);
    expect(informe.report!.cost.basis).toBe("measured");
    expect(gw.medicion().medidas).toBe(1);
    // La línea de log por petición, como con clave: con su coste, sin «not metered».
    const linea = lineas.find((l) => l.startsWith("[gateway] POST /v1/messages"));
    expect(linea).toContain(MODELO);
    expect(linea).not.toContain("not metered");
  });

  it("⛔ /v1/messages en streaming (lo que mandan Claude Code y los demás terminales): `metered`", async () => {
    const { gw, pedir, lineas } = await montar();
    const { informe } = await pedir("/v1/messages", { model: MODELO, max_tokens: 50, stream: true, messages: [{ role: "user", content: "hola" }] });
    expect(informe.status).toBe("metered");
    expect(informe.report!.cost.actual).toBeCloseTo(costeMedido(MODELO, USO_ANTHROPIC)!.costeUsd, 12);
    expect(gw.medicion().medidas).toBe(1);
    expect(lineas.join("\n")).not.toContain("no BIVELIO_SERVICE_KEY");
    // Una línea por petición, ni cero ni dos.
    expect(lineas.filter((l) => l.startsWith("[gateway] POST /v1/messages"))).toHaveLength(1);
  });

  it("⛔ /v1/chat/completions: `metered` con el usage de OpenAI", async () => {
    const { pedir } = await montar();
    const { informe } = await pedir("/v1/chat/completions", { model: "gpt-4o-mini", messages: [{ role: "user", content: "hola" }] });
    expect(informe.status).toBe("metered");
    expect(informe.report!.cost.actual).toBeGreaterThan(0);
  });

  it("⛔ el resumen de salida dice la verdad: cuántas pasaron y cuántas se midieron (antes: «no inference request went through»)", async () => {
    const { gw, pedir } = await montar();
    await pedir("/v1/messages", { model: MODELO, max_tokens: 50, messages: [] });
    await pedir("/v1/messages", { model: MODELO, max_tokens: 50, stream: true, messages: [] });
    await pedir("/v1/chat/completions", { model: "gpt-4o-mini", messages: [] });
    const e = gw.medicion();
    expect(e.recibidas).toBe(3);
    expect(e.medidas).toBe(3);
    expect(e.noMedidas).toEqual({});
    const l = resumenDeMedicion(e, "claude");
    expect(l).not.toContain("no inference request went through");
    expect(l).toContain("3 inference request(s) went through the gateway");
    expect(l).toContain("3 request(s) metered with the provider's usage");
    // Y el resumen local (lo que lee `bvsala mcp`) ya no sale vacío.
    const resumen = (await (await fetch(`http://127.0.0.1:${gw.puerto}/_bvsala/v1/summary`)).json()) as Record<string, unknown>;
    expect(JSON.stringify(resumen)).toContain('"metered":3');
  });

  it("el estado local dice que la medición está encendida, y el banner cuadra con lo que hace", async () => {
    const { base } = await montar();
    const estado = (await (await fetch(`${base}/_bvsala/v1/status`)).json()) as { metering: boolean; license: { plan: string } };
    expect(estado.license.plan).toBe("community");
    expect(estado.metering).toBe(true);
    const banner = avisos.find((a) => a.includes("COMMUNITY MODE"));
    expect(banner).toBeDefined();
    expect(banner).toContain("every request is metered on this machine");
    expect(banner).toContain("Nothing is sent to BiVelio");
    expect(banner).not.toContain("metered only in the local report routes");
  });

  it("⛔ en comunidad no sale NINGUNA petición a un host que no sea el upstream: ni un fetch ni una conexión TCP", async () => {
    const { gw, upstream, pedir } = await montar();
    await pedir("/v1/messages", { model: MODELO, max_tokens: 50, messages: [] });
    await pedir("/v1/messages", { model: MODELO, max_tokens: 50, stream: true, messages: [] });
    await pedir("/v1/chat/completions", { model: "gpt-4o-mini", messages: [] });
    await pedir("/v1/otra-cosa", { model: MODELO });
    // El emisor (si existiera) vacía al cerrar: se cierra ANTES de mirar.
    await gw.cerrar();
    recursos = recursos.filter((r) => r !== gw);

    const permitidos = new Set([`http://127.0.0.1:${gw.puerto}`, `http://127.0.0.1:${upstream}`]);
    expect(urlsDeFetch.length).toBeGreaterThan(0);
    const fueraPorFetch = urlsDeFetch.filter((u) => !permitidos.has(new URL(u).origin));
    expect(fueraPorFetch).toEqual([]);
    // Al upstream sí se llegó: el espía ve de verdad lo que sale.
    expect(urlsDeFetch.some((u) => new URL(u).origin === `http://127.0.0.1:${upstream}`)).toBe(true);

    const tcpPermitidos = new Set([`127.0.0.1:${gw.puerto}`, `127.0.0.1:${upstream}`, `localhost:${gw.puerto}`, `localhost:${upstream}`]);
    expect(destinosTcp.length).toBeGreaterThan(0);
    expect(destinosTcp.filter((d) => !tcpPermitidos.has(d))).toEqual([]);
    expect(`${urlsDeFetch.join(" ")} ${destinosTcp.join(" ")}`).not.toContain("bivelio");
  });

  it("CONTROL: con clave de servicio el mismo espía SÍ ve salir el envío (la prueba de arriba no pasa en vacío)", async () => {
    const upstream = await arrancarUpstream();
    const ingesta = await new Promise<number>((resolve) => {
      const s = createServer((req, res) => {
        req.resume();
        res.writeHead(req.url?.startsWith("/api/org/entitlements") ? 200 : 202, { "content-type": "application/json" });
        res.end(req.url?.startsWith("/api/org/entitlements") ? '{"features":[]}' : '{"ingested":1}');
      });
      recursos.push(s);
      s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
    });
    const gw = await arrancarGateway({
      puerto: 0,
      upstream: `http://127.0.0.1:${upstream}`,
      serviceAccountKey: "bvk_test",
      meteringUrl: `http://127.0.0.1:${ingesta}/api/metering/usage`,
      seatId: "asiento-inventado",
      log: () => {},
    });
    await (
      await fetch(`http://127.0.0.1:${gw.puerto}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: MODELO, max_tokens: 5, messages: [] }),
      })
    ).text();
    await gw.cerrar();
    expect(urlsDeFetch.some((u) => new URL(u).origin === `http://127.0.0.1:${ingesta}`)).toBe(true);
  });
});
