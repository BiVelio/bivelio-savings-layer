import { createServer, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { arrancarGateway, type GatewayArrancado, type OpcionesGateway } from "../gateway/servidor.js";
import { dialectoGemini, modeloDeRutaGemini, ObservadorGemini, usoDeGemini } from "../gateway/gemini.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";
import { testLicense } from "./helpers/test-license.js";

/**
 * EL DIALECTO GEMINI EN EL GATEWAY — lo que hace falta para medir la CLI de
 * Gemini (y cualquier cliente del protocolo generativelanguage) apuntado a
 * `bvsala gateway --upstream gemini` o lanzado con `bvsala gemini`.
 *
 * Lo que se fija:
 *   · `:generateContent` (JSON) se mide con `usageMetadata`, modelo leído de la
 *     RUTA (el cuerpo de Gemini no lleva `model`);
 *   · `:streamGenerateContent?alt=sse` se observa SSE y se mide con el último
 *     `usageMetadata`;
 *   · `:streamGenerateContent` sin `alt=sse` (JSON por líneas) se observa igual;
 *   · la caché implícita se descuenta de la entrada y los pensamientos suman a
 *     la salida; una candidata SAFETY es una negativa;
 *   · el alias `--upstream deepseek` reescribe /v1/messages a /anthropic.
 */

const MODELO = "gemini-2.5-flash";

describe("usoDeGemini — usageMetadata → UsoSse", () => {
  it("resta la caché implícita de la entrada y suma los pensamientos a la salida", () => {
    expect(
      usoDeGemini({ promptTokenCount: 100, candidatesTokenCount: 20, cachedContentTokenCount: 40, thoughtsTokenCount: 5 }),
    ).toEqual({ input_tokens: 60, output_tokens: 25, cache_read_input_tokens: 40 });
  });

  it("sin los dos contadores obligatorios no hay uso", () => {
    expect(usoDeGemini({ promptTokenCount: 100 })).toBeNull();
    expect(usoDeGemini(undefined)).toBeNull();
    expect(usoDeGemini(null)).toBeNull();
  });
});

describe("ObservadorGemini — SSE y JSON por líneas", () => {
  const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

  it("SSE con alt=sse: el último usageMetadata manda, el texto se ve, SAFETY es negativa", () => {
    const o = new ObservadorGemini();
    const cand = (t: string) => ({ candidates: [{ content: { parts: [{ text: t }] }, finishReason: "STOP" }] });
    o.observar(sse(cand("Hola")));
    o.observar(sse({ candidates: [{ content: { parts: [{ text: " mundo" }] } }] }));
    o.observar(sse({ usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 } }));
    expect(o.usageFinal()).toEqual({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0 });
    expect(o.textoInicial()).toBe("Hola");
    expect(o.negativa()).toBe(false);

    const n = new ObservadorGemini();
    n.observar(sse({ candidates: [{ finishReason: "SAFETY" }] }));
    expect(n.negativa()).toBe(true);
  });

  it("JSON por líneas (sin alt=sse): fragmentos a medias se unen y el array se cierra sin [ ni ]", () => {
    const o = new ObservadorGemini();
    o.observar('[{ "candidates": [');
    o.observar('{ "content": { "parts": [{ "text": "x" }] } } ] },\n');
    o.observar('{"usageMetadata": {"promptTokenCount": 50, "candidatesTokenCount": 3}}\n]');
    expect(o.usageFinal()).toEqual({ input_tokens: 50, output_tokens: 3, cache_read_input_tokens: 0 });
    expect(o.textoInicial()).toBe("x");
  });
});

describe("modeloDeRutaGemini y dialectoGemini", () => {
  it("saca el modelo de la ruta, nunca de la query", () => {
    expect(modeloDeRutaGemini("/v1beta/models/gemini-2.5-flash:generateContent")).toBe("gemini-2.5-flash");
    expect(modeloDeRutaGemini("/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse")).toBe("gemini-2.5-flash");
    expect(modeloDeRutaGemini("/v1/chat/completions")).toBeNull();
    expect(dialectoGemini("/v1beta/models/gemini-2.5-flash:streamGenerateContent")).toBe("stream");
    expect(dialectoGemini("/v1beta/models/gemini-2.5-flash:generateContent")).toBe("generate");
    expect(dialectoGemini("/v1/messages")).toBeNull();
  });
});

interface Recibida {
  path: string;
  headers: Record<string, string | string[] | undefined>;
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
      const r: Recibida = { path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) };
      recibidas.push(r);
      manejar(r, res);
    });
    recursos.push(s);
    s.listen(0, "127.0.0.1", () => resolve({ puerto: (s.address() as { port: number }).port, recibidas }));
  });
}

function ingestaFalsa(lotes: unknown[][]): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      if (req.method === "GET" && (req.url ?? "").startsWith("/api/org/entitlements")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"features":["cache_ttl_tuning","context_elision","sibling_model_routing","per_turn_effort"]}');
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
  const gw = await arrancarGateway({
    license: testLicense(),
    puerto: 0,
    upstream: `http://127.0.0.1:${puertoUpstream}`,
    serviceAccountKey: "bvk_test",
    meteringUrl: `http://127.0.0.1:${ingesta}`,
    seatId: "t",
    log: () => {},
    ...extra,
  });
  recursos.push(gw);
  return {
    gw,
    registros: async (): Promise<Record<string, unknown>[]> => {
      await gw.cerrar();
      // El emisor drena asíncrono: esperar al lote, con tope, como los otros tests.
      const t0 = Date.now();
      while (lotes.flat().length === 0 && Date.now() - t0 < 3000) {
        await new Promise((r) => setTimeout(r, 20));
      }
      return lotes.flat() as Record<string, unknown>[];
    },
  };
}

function pedir(puerto: number, path: string, cuerpo: unknown, headers: Record<string, string> = {}) {
  return fetch(`http://127.0.0.1:${puerto}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(cuerpo),
  });
}

const USO_COMPLETO = {
  promptTokenCount: 100,
  candidatesTokenCount: 20,
  cachedContentTokenCount: 40,
  thoughtsTokenCount: 5,
};

describe("gateway · protocolo Gemini", () => {
  it(":generateContent (JSON) se mide con el modelo de la ruta y el usageMetadata", async () => {
    const up = await upstreamFalso((_r, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: "hola" }] } }], usageMetadata: USO_COMPLETO }));
    });
    const { gw, registros } = await gateway(up.puerto);
    const res = await pedir(gw.puerto, `/v1beta/models/${MODELO}:generateContent`, {
      contents: [{ parts: [{ text: "cuenta" }] }],
    });
    expect(res.status).toBe(200);
    const regs = await registros();
    expect(regs).toHaveLength(1);
    expect(regs[0]!.model).toBe(MODELO);
    expect(regs[0]!.basis).toBe("measured");
    // Entrada total 100 (60 ordinaria + 40 de caché implícita), salida 25
    // (20 + 5 de pensamiento): el descuento de caché va en el coste, el conteo
    // del cable es el total que factura el proveedor.
    expect(regs[0]!.actualInputTokens).toBe(100);
    expect(regs[0]!.providerCachedInputTokens).toBe(40);
    expect(regs[0]!.actualOutputTokens).toBe(25);
  });

  it(":streamGenerateContent?alt=sse se observa y se mide con el último usageMetadata", async () => {
    const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
    const up = await upstreamFalso((_r, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        sse({ candidates: [{ content: { parts: [{ text: "ho" }] } }] }) +
          sse({ candidates: [{ content: { parts: [{ text: "la" }] } }] }) +
          sse({ usageMetadata: USO_COMPLETO }),
      );
    });
    const { gw, registros } = await gateway(up.puerto);
    const res = await pedir(gw.puerto, `/v1beta/models/${MODELO}:streamGenerateContent?alt=sse`, {
      contents: [{ parts: [{ text: "cuenta" }] }],
    });
    expect(res.status).toBe(200);
    const regs = await registros();
    expect(regs).toHaveLength(1);
    expect(regs[0]!.model).toBe(MODELO);
    expect(regs[0]!.basis).toBe("measured");
  });

  it(":streamGenerateContent sin alt=sse (JSON por líneas) se observa igual", async () => {
    const up = await upstreamFalso((_r, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        '[{"candidates":[{"content":{"parts":[{"text":"ho"}]}}]},\n' +
          `{"usageMetadata":${JSON.stringify(USO_COMPLETO)}}\n]`,
      );
    });
    const { gw, registros } = await gateway(up.puerto);
    const res = await pedir(gw.puerto, `/v1beta/models/${MODELO}:streamGenerateContent`, {
      contents: [{ parts: [{ text: "cuenta" }] }],
    });
    expect(res.status).toBe(200);
    const regs = await registros();
    expect(regs).toHaveLength(1);
    expect(regs[0]!.model).toBe(MODELO);
  });
});

describe("gateway · --upstream deepseek reescribe Anthropic a /anthropic", () => {
  it("POST /v1/messages viaja a /anthropic/v1/messages con las cabeceras del cliente", async () => {
    const up = await upstreamFalso((_r, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } })}\n\n` +
          `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
          `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n` +
          `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
          `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } })}\n\n` +
          `data: ${JSON.stringify({ type: "message_stop" })}\n\n`,
      );
    });
    // El alias oficial de DeepSeek, con el fetch redirigido al fake local.
    const OFICIAL = "https://api.deepseek.com";
    const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (u.origin === OFICIAL) return fetch(`http://127.0.0.1:${up.puerto}${u.pathname}${u.search}`, init);
      return fetch(input, init);
    }) as typeof fetch;
    const { gw } = await gateway(up.puerto, { upstream: OFICIAL, fetchImpl });
    const res = await pedir(
      gw.puerto,
      "/v1/messages",
      { model: "deepseek-chat", max_tokens: 10, messages: [{ role: "user", content: "hi" }] },
      { authorization: "Bearer ds-test-key" },
    );
    expect(res.status).toBe(200);
    expect(up.recibidas[0]!.path).toBe("/anthropic/v1/messages");
    expect(String(up.recibidas[0]!.headers["authorization"] ?? "")).toBe("Bearer ds-test-key");
  });
});
