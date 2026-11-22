import { readFileSync } from "node:fs";
import { createServer, request as peticionHttp, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { CABECERA_ID_DE_PETICION, CABECERA_PIDE_INFORME, type InformeLocal } from "../gateway/informes-locales.js";
import { MOTIVO_CORTE_DEL_PROVEEDOR, arrancarGateway, type GatewayArrancado } from "../gateway/servidor.js";
import { costeMedido } from "../gateway/medidor.js";
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
    // e2e del 22-11: la línea es la de la tabla de docs/terminales/README.md, no «error while serving».
    expect(lineas.join("\n")).toContain(`→ 200 (stream) · not metered: ${MOTIVO_CORTE_DEL_PROVEEDOR}`);
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

/**
 * E2E DEL 22-11 · EL CORTE DICE LO QUE PROMETE LA GUÍA. Un upstream que manda
 * `message_start` y unos cuantos deltas y destruye el socket: el log decía
 * «→ error while serving: TypeError: terminated · cause: SocketError: other side
 * closed» y el informe local «no usage was read from the provider's answer
 * (HTTP 200)», mientras docs/terminales/README.md promete la línea
 * «· not metered: the provider cut the answer before its final usage» y el MISMO
 * motivo en el informe. La causa de undici sigue en la línea, como campo aparte.
 */
describe("e2e 22-11 · un corte a mitad de stream deja la línea y el motivo documentados", () => {
  const DELTA = (texto: string) =>
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: texto } })}\n\n`;

  /** message_start, tres deltas, y el socket destruido sin message_delta ni message_stop. */
  function upstreamQueCortaTrasDeltas(): Promise<number> {
    return new Promise((resolve) => {
      const s = createServer((req, res) => {
        req.resume();
        req.on("end", () => {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(INICIO_SSE);
          let n = 0;
          const t = setInterval(() => {
            n += 1;
            res.write(DELTA(`trozo ${n} `));
            if (n === 3) {
              clearInterval(t);
              setTimeout(() => res.destroy(), 20);
            }
          }, 10);
        });
      });
      recursos.push(s);
      s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
    });
  }

  it("⛔ log «→ 200 (stream) · not metered: <motivo> · detail: <causa>», informe con el mismo motivo y el resumen igual", async () => {
    const upstream = await upstreamQueCortaTrasDeltas();
    const lineas: string[] = [];
    const gw = await arrancarGateway({ puerto: 0, upstream: `http://127.0.0.1:${upstream}`, log: (l) => lineas.push(l) });
    recursos.push(gw);
    const r = await fetch(`http://127.0.0.1:${gw.puerto}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", [CABECERA_PIDE_INFORME]: "1" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 50, stream: true, messages: [] }),
    });
    expect(r.status).toBe(200);
    const id = r.headers.get(CABECERA_ID_DE_PETICION);
    expect(id).not.toBeNull();
    // El cliente ve el corte (no un 200 completo): como sin gateway.
    await expect(r.text()).rejects.toThrow();

    const linea = lineas.find((l) => l.includes("not metered"));
    expect(linea, lineas.join("\n")).toBeDefined();
    expect(linea!.startsWith(`[gateway] POST /v1/messages → 200 (stream) · not metered: ${MOTIVO_CORTE_DEL_PROVEEDOR} · detail: `)).toBe(true);
    // La causa de undici, como campo extra (no dentro del motivo).
    expect(linea).toMatch(/· detail: .*terminated|· detail: .*closed|· detail: .*socket/i);
    expect(lineas.join("\n")).not.toContain("error while serving");

    const informe = (await (
      await fetch(`http://127.0.0.1:${gw.puerto}/_bvsala/v1/reports/${id}?wait_ms=2000`)
    ).json()) as InformeLocal;
    expect(informe.status).toBe("not_metered");
    expect(informe.reason).toBe(MOTIVO_CORTE_DEL_PROVEEDOR);
    expect(informe.reason).not.toMatch(/no usage was read/);

    const e = gw.medicion();
    expect(e.noMedidas).toEqual({ [MOTIVO_CORTE_DEL_PROVEEDOR]: 1 });
    expect(resumenDeMedicion(e, "gateway")).toContain(`1 × ${MOTIVO_CORTE_DEL_PROVEEDOR}`);
  });

  it("JSON (stream:false) cortado a medias: la misma línea, sin «(stream)»", async () => {
    const { gw, lineas } = await montar();
    await pedirCrudo(gw.puerto, "json");
    const linea = lineas.find((l) => l.includes("not metered"));
    expect(linea, lineas.join("\n")).toBeDefined();
    expect(linea!.startsWith(`[gateway] POST /v1/messages → 200 · not metered: ${MOTIVO_CORTE_DEL_PROVEEDOR} · detail: `)).toBe(true);
  });

  it("el motivo es, letra por letra, la primera fila de la tabla de docs/terminales/README.md", () => {
    const guia = readFileSync(fileURLToPath(new URL("../docs/terminales/README.md", import.meta.url)), "utf8");
    expect(guia).toContain(`| \`${MOTIVO_CORTE_DEL_PROVEEDOR}\` |`);
  });
});

/**
 * REVISIÓN DEL PR #617 · UN CORTE DESPUÉS DEL USAGE FINAL SE MIDE. Un proxy
 * HTTP/1.1 defectuoso entrega el SSE ENTERO (message_delta con su usage y
 * message_stop) y cierra el socket sin el trozo final del chunked: undici lanza
 * «terminated». El proveedor facturó la respuesta entera, pero la rama del corte
 * no la medía y decía en log, informe y resumen «cut the answer before its final
 * usage», que es falso. Ahora se mide como la rama del cliente que cierra tras el
 * usage final (las mismas llamadas, sin rebaja), y el motivo del corte queda
 * solo para cuando no se leyó ningún usage final (el bloque de arriba).
 */
describe("revisión #617 · el proveedor corta DESPUÉS del usage final: se mide con su usage", () => {
  const ev = (tipo: string, datos: unknown) => `event: ${tipo}\ndata: ${JSON.stringify(datos)}\n\n`;
  const USO = { input_tokens: 12, output_tokens: 7 };
  const SSE_COMPLETO =
    INICIO_SSE +
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hola" } }) +
    ev("content_block_stop", { type: "content_block_stop", index: 0 }) +
    ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: USO }) +
    ev("message_stop", { type: "message_stop" });

  /** Todo el SSE, usage final incluido, y el socket destruido sin el trozo final del chunked. */
  function upstreamCompletoYReset(): Promise<number> {
    return new Promise((resolve) => {
      const s = createServer((req, res) => {
        req.resume();
        req.on("end", () => {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(SSE_COMPLETO);
          setTimeout(() => res.destroy(), 30);
        });
      });
      recursos.push(s);
      s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
    });
  }

  it("⛔ se mide con el usage del proveedor; ni «not metered» ni el motivo del corte en log, informe o resumen", async () => {
    const upstream = await upstreamCompletoYReset();
    const lineas: string[] = [];
    const gw = await arrancarGateway({ puerto: 0, upstream: `http://127.0.0.1:${upstream}`, log: (l) => lineas.push(l) });
    recursos.push(gw);
    const r = await fetch(`http://127.0.0.1:${gw.puerto}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", [CABECERA_PIDE_INFORME]: "1" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 50, stream: true, messages: [] }),
    });
    expect(r.status).toBe(200);
    const id = r.headers.get(CABECERA_ID_DE_PETICION);
    expect(id).not.toBeNull();
    // El cliente sigue viendo el corte de transporte, como lo vería sin gateway.
    await expect(r.text()).rejects.toThrow();

    const informe = (await (
      await fetch(`http://127.0.0.1:${gw.puerto}/_bvsala/v1/reports/${id}?wait_ms=2000`)
    ).json()) as InformeLocal;
    expect(informe.status, JSON.stringify(informe)).toBe("metered");
    expect(informe.reason).toBeNull();
    const esperado = costeMedido("claude-sonnet-4-6", USO)!.costeUsd;
    expect(esperado).toBeGreaterThan(0);
    expect(informe.report!.cost.actual).toBeCloseTo(esperado, 12);

    const e = gw.medicion();
    expect(e.medidas).toBe(1);
    expect(e.noMedidas).toEqual({});
    expect(e.dinero.gastoUsd).toBeCloseTo(esperado, 12);
    const todo = lineas.join("\n");
    expect(todo).not.toContain("not metered");
    expect(todo).not.toContain(MOTIVO_CORTE_DEL_PROVEEDOR);
    expect(todo).toContain("→ 200 (stream) · the provider closed the connection after the final usage; metered anyway · detail: ");
    expect(todo).toMatch(/\[gateway\] POST \/v1\/messages +· claude-sonnet-4-6 · \$[\d.]+ \(in 12, .*out 7\)/);
    expect(resumenDeMedicion(e, "gateway")).not.toContain(MOTIVO_CORTE_DEL_PROVEEDOR);
  });
});
