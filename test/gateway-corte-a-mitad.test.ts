import { createServer, request as peticionHttp, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { arrancarGateway, type GatewayArrancado } from "../gateway/servidor.js";
import { resumenDeMedicion } from "../gateway/recuento.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";

/**
 * EL PROVEEDOR CORTA LA RESPUESTA A MEDIAS → EL CLIENTE VE UN CORTE.
 *
 * Con las cabeceras ya enviadas, el gateway cerraba con `res.end()`: el cuerpo
 * «chunked» terminaba LIMPIO y una respuesta truncada (un SSE sin su final, o
 * medio JSON sobre un 200 válido) llegaba como completa. Directo al proveedor
 * el cliente vería un error de transporte y reintentaría; a través del gateway
 * tiene que ver lo mismo.
 */

let recursos: (Server | GatewayArrancado)[] = [];
let warn: MockInstance;
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

const INICIO_SSE = `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_inventado", model: "claude-sonnet-4-6", usage: { input_tokens: 12, output_tokens: 1 } } })}\n\n`;

/** Un upstream que manda las cabeceras y el principio del cuerpo, y destruye el socket. */
function upstreamQueCorta(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        if (req.url === "/sana") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end('{"ok":true}');
          return;
        }
        const stream = req.headers["x-prueba"] === "sse";
        res.writeHead(200, { "content-type": stream ? "text/event-stream" : "application/json" });
        res.write(stream ? INICIO_SSE : '{"id":"msg_inventado","type":"message","content":[{"type":"text","text":"medio cuer');
        setTimeout(() => res.destroy(), 30);
      });
    });
    recursos.push(s);
    s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
  });
}

async function montar() {
  const upstream = await upstreamQueCorta();
  const lineas: string[] = [];
  const gw = await arrancarGateway({ puerto: 0, upstream: `http://127.0.0.1:${upstream}`, log: (l) => lineas.push(l) });
  recursos.push(gw);
  return { gw, lineas };
}

/** Con node:http, sin fetch: se ve si la respuesta acabó entera (`complete`) o la conexión se rompió. */
function pedirCrudo(puerto: number, tipo: "sse" | "json"): Promise<{ status: number; cuerpo: string; completa: boolean; error: string | null }> {
  return new Promise((resolve) => {
    const req = peticionHttp(
      { host: "127.0.0.1", port: puerto, path: "/v1/messages", method: "POST", headers: { "content-type": "application/json", "x-prueba": tipo } },
      (res) => {
        const chunks: Buffer[] = [];
        let error: string | null = null;
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("error", (e) => (error = String(e)));
        res.on("close", () =>
          resolve({ status: res.statusCode ?? 0, cuerpo: Buffer.concat(chunks).toString("utf8"), completa: res.complete, error }),
        );
      },
    );
    req.on("error", (e) => resolve({ status: 0, cuerpo: "", completa: false, error: String(e) }));
    req.end(JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 5, stream: tipo === "sse", messages: [] }));
  });
}

describe("un corte del proveedor a mitad de respuesta llega al cliente como corte", () => {
  it("⛔ SSE cortado tras message_start: leer el cuerpo con fetch RECHAZA (antes resolvía con el stream truncado)", async () => {
    const { gw, lineas } = await montar();
    const r = await fetch(`http://127.0.0.1:${gw.puerto}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-prueba": "sse" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 5, stream: true, messages: [] }),
    });
    expect(r.status).toBe(200);
    await expect(r.text()).rejects.toThrow();
    expect(lineas.join("\n")).toContain("error while serving");
  });

  it("⛔ JSON sin stream cortado a medias: tampoco llega como un 200 completo", async () => {
    const { gw } = await montar();
    const r = await fetch(`http://127.0.0.1:${gw.puerto}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-prueba": "json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 5, messages: [] }),
    });
    await expect(r.text()).rejects.toThrow();
  });

  it("⛔ a nivel HTTP: la respuesta NO se marca completa (sin el trozo final del chunked)", async () => {
    const { gw } = await montar();
    const r = await pedirCrudo(gw.puerto, "sse");
    expect(r.status).toBe(200);
    expect(r.cuerpo).toContain("message_start");
    expect(r.completa).toBe(false);
  });

  it("el gateway sigue vivo, y el resumen cuenta la cortada como no medida con su motivo", async () => {
    const { gw } = await montar();
    await pedirCrudo(gw.puerto, "sse");
    const otra = await fetch(`http://127.0.0.1:${gw.puerto}/sana`, { method: "POST", body: "{}" });
    expect(otra.status).toBe(200);
    expect(await otra.text()).toBe('{"ok":true}');
    const e = gw.medicion();
    expect(e.recibidas).toBe(1);
    expect(e.medidas).toBe(0);
    expect(e.noMedidas).toEqual({ "the provider cut the answer before its final usage": 1 });
    expect(resumenDeMedicion(e, "claude")).not.toContain("no inference request went through");
  });
});
