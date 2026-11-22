import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { arrancarGateway, type GatewayArrancado } from "../gateway/servidor.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";

/**
 * e2e 1.2.4 · el resumen de salida acreditaba un ahorro «measured» de la
 * palanca de TTL con `--upstream deepseek`, pero solo porque el upstream FALSO
 * declaraba escrituras de caché. La guía de DeepSeek no decía nada.
 *
 * Lo que es verdad hoy (y lo que dice docs/terminales/deepseek.md): el
 * endpoint Anthropic de DeepSeek ignora `cache_control` y declara
 * `cache_creation_input_tokens: 0` (api-docs.deepseek.com/guides/anthropic_api,
 * consultada el 2026-11-22). Con ese usage no hay escritura que abaratar: el
 * gateway mide la petición y no acredita ningún ahorro. Sus lecturas de caché
 * (automáticas) se miden al precio de lectura del catálogo, $0.003/1M.
 *
 * Este test solo fija el lado del usage REAL de DeepSeek; qué hace la palanca
 * con un upstream que sí declarara escrituras es otra decisión (notas).
 */

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

/** El usage que documenta DeepSeek en su endpoint Anthropic: escrituras siempre a 0. */
const USO_DEEPSEEK = { input_tokens: 1000, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 256 };

function upstreamDeepSeekFalso(): Promise<{ puerto: number; rutas: string[] }> {
  const rutas: string[] = [];
  return new Promise((resolve) => {
    const s = createServer(async (req, res) => {
      for await (const _ of req) void _;
      rutas.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_ds",
          type: "message",
          role: "assistant",
          model: "deepseek-flash",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: USO_DEEPSEEK,
        }),
      );
    });
    recursos.push(s);
    s.listen(0, "127.0.0.1", () => resolve({ puerto: (s.address() as { port: number }).port, rutas }));
  });
}

describe("Claude Code con --upstream deepseek: la palanca de TTL no acredita nada con el usage de DeepSeek", () => {
  it("una petición con cache_control de 1h se mide (lecturas a $0.003/1M) y el ahorro acreditado es 0", async () => {
    const up = await upstreamDeepSeekFalso();
    const OFICIAL = "https://api.deepseek.com";
    const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (u.origin === OFICIAL) return fetch(`http://127.0.0.1:${up.puerto}${u.pathname}${u.search}`, init);
      return fetch(input, init);
    }) as typeof fetch;
    const lineas: string[] = [];
    // Modo comunitario: la palanca de TTL va armada por defecto.
    const gw = await arrancarGateway({ puerto: 0, upstream: OFICIAL, fetchImpl, log: (l) => lineas.push(l), warn: () => {} });
    recursos.push(gw);
    // Un primer turno de Claude Code: prompt nuevo y largo, marcado a 1h.
    const cuerpo = {
      model: "deepseek-flash",
      max_tokens: 10,
      system: [{ type: "text", text: "Eres un asistente. ".repeat(400), cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "hola", cache_control: { type: "ephemeral", ttl: "1h" } }] }],
    };
    const res = await fetch(`http://127.0.0.1:${gw.puerto}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer clave-falsa", "anthropic-version": "2023-06-01" },
      body: JSON.stringify(cuerpo),
    });
    expect(res.status).toBe(200);
    await res.text();
    expect(up.rutas).toEqual(["/anthropic/v1/messages"]);
    const t0 = Date.now();
    while (gw.medicion().medidas < 1 && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 20));
    const m = gw.medicion();
    expect(m.medidas).toBe(1);
    // 1000 de entrada a $0.30/1M + 256 leídos a $0.003/1M + 10 de salida a $1.20/1M (fila al precio peak).
    expect(m.dinero.gastoUsd).toBeCloseTo(0.0003 + 0.000000768 + 0.000012, 9);
    expect(m.dinero.ahorroMedidoUsd).toBe(0);
    const linea = lineas.find((l) => l.startsWith("[gateway] POST /v1/messages"));
    expect(linea).toContain("cache↓256");
    expect(linea).toContain("cache↑0");
  });

  it("docs/terminales/deepseek.md dice lo mismo: DeepSeek ignora cache_control, escrituras a 0, nada acreditado", () => {
    const md = readFileSync(new URL("../docs/terminales/deepseek.md", import.meta.url), "utf8").replace(/\s+/g, " ");
    expect(md).toContain("ignores `cache_control`");
    expect(md).toContain("`cache_creation_input_tokens` as 0");
    expect(md).toContain("no saving is credited on this traffic");
    expect(md).toContain("$0.003/1M");
  });
});
