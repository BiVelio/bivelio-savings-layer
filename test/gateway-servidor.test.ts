import { createServer, type Server } from "node:http";
import { brotliCompressSync } from "node:zlib";
import { afterEach, describe, it, expect } from "vitest";

import { arrancarGateway, type GatewayArrancado } from "../gateway/servidor.js";

/**
 * El gateway contra un upstream FALSO local: passthrough byte a byte, retirada
 * de cabeceras de transporte, medición desde el usage del SSE y metering hacia
 * una ingesta falsa. Ninguna petición sale de 127.0.0.1.
 */

const SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":4000,"output_tokens":1}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"OK"}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":100,"cache_read_input_tokens":4000,"output_tokens":42}}\n\n',
  "event: message_stop\ndata: {}\n\n",
].join("");

let recursos: (Server | GatewayArrancado)[] = [];
afterEach(async () => {
  for (const r of recursos) {
    if ("cerrar" in r) await r.cerrar();
    else await new Promise((res) => r.close(res));
  }
  recursos = [];
});

function arrancarUpstreamFalso(recibidas: { path: string; headers: Record<string, unknown>; body: string }[]): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      recibidas.push({ path: req.url ?? "", headers: { ...req.headers }, body: Buffer.concat(chunks).toString("utf8") });
      if (req.url?.startsWith("/api/hello")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      // Respuesta COMPRIMIDA de verdad, como la del upstream real: el fetch del
      // gateway la descomprime en silencio, y si el gateway reenviara el
      // `content-encoding` original el cliente final moriría intentando
      // descomprimir texto plano (hallazgo F0 nº1, BrotliDecompressionError).
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "anthropic-ratelimit-requests-remaining": "999",
        "content-encoding": "br",
      });
      res.end(brotliCompressSync(SSE));
    });
    recursos.push(s);
    s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
  });
}

function arrancarUpstreamJson(respuesta: unknown): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer(async (req, res) => {
      for await (const _ of req) void _;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(respuesta));
    });
    recursos.push(s);
    s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
  });
}

function arrancarIngestaFalsa(lotes: unknown[][]): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      lotes.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown[]);
      res.writeHead(202, { "content-type": "application/json" });
      res.end('{"ingested":1}');
    });
    recursos.push(s);
    s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
  });
}

async function esperar(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout esperando la condición");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("arrancarGateway — passthrough que mide", () => {
  it("reenvía el cuerpo intacto, retira las cabeceras de transporte y conserva las demás", async () => {
    const recibidas: { path: string; headers: Record<string, unknown>; body: string }[] = [];
    const upstream = await arrancarUpstreamFalso(recibidas);
    const gw = await arrancarGateway({ puerto: 0 as never, upstream: `http://127.0.0.1:${upstream}`, log: () => {} });
    recursos.push(gw);

    const cuerpo = JSON.stringify({ model: "claude-haiku-4-5-20251001", messages: [{ role: "user", content: "hola" }], stream: true });
    const r = await fetch(`http://127.0.0.1:${gw.puerto}/v1/messages?beta=true`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-beta": "oauth-2025-04-20,claude-code-20250219", authorization: "Bearer sk-test" },
      body: cuerpo,
    });

    expect(r.status).toBe(200);
    // Transporte retirado; el resto conservado:
    expect(r.headers.get("content-encoding")).toBeNull();
    expect(r.headers.get("anthropic-ratelimit-requests-remaining")).toBe("999");
    // El stream llega entero y sin tocar:
    expect(await r.text()).toBe(SSE);
    // Y el upstream recibió el cuerpo byte a byte con sus cabeceras:
    expect(recibidas[0]!.path).toBe("/v1/messages?beta=true");
    expect(recibidas[0]!.body).toBe(cuerpo);
    expect(recibidas[0]!.headers["anthropic-beta"]).toBe("oauth-2025-04-20,claude-code-20250219");
    expect(recibidas[0]!.headers["authorization"]).toBe("Bearer sk-test");
  });

  it("con clave de servicio, emite un registro medido a la ingesta", async () => {
    const recibidas: { path: string; headers: Record<string, unknown>; body: string }[] = [];
    const lotes: unknown[][] = [];
    const upstream = await arrancarUpstreamFalso(recibidas);
    const ingesta = await arrancarIngestaFalsa(lotes);
    const gw = await arrancarGateway({
      puerto: 0 as never,
      upstream: `http://127.0.0.1:${upstream}`,
      serviceAccountKey: "bvk_test",
      meteringUrl: `http://127.0.0.1:${ingesta}`,
      seatId: "test-01",
      log: () => {},
    });
    recursos.push(gw);

    await fetch(`http://127.0.0.1:${gw.puerto}/v1/messages?beta=true`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", stream: true }),
    }).then((r) => r.text());

    // El emisor agrupa; el lote sale al llegar al tamaño o al flush del cierre.
    await gw.cerrar();
    await esperar(() => lotes.length > 0);

    const reg = (lotes[0]![0] ?? {}) as Record<string, unknown>;
    expect(reg["model"]).toBe("claude-haiku-4-5-20251001");
    expect(reg["basis"]).toBe("measured");
    expect(reg["actualLlm"]).toBe(1);
    expect(reg["providerCachedInputTokens"]).toBe(4000);
    expect(reg["actualInputTokens"]).toBe(4100);
    expect(reg["actualOutputTokens"]).toBe(42);
    expect(reg["netSavings"]).toBe(0);
    expect(reg["seatId"]).toBe("test-01");
    // v1: el baseline ES el actual — nada estimado.
    expect(reg["baselineCost"]).toBe(reg["actualCost"]);
  });

  it("sin clave de servicio: mismo passthrough, cero metering (avisar, nunca romper)", async () => {
    const recibidas: { path: string; headers: Record<string, unknown>; body: string }[] = [];
    const upstream = await arrancarUpstreamFalso(recibidas);
    const gw = await arrancarGateway({ puerto: 0 as never, upstream: `http://127.0.0.1:${upstream}`, log: () => {} });
    recursos.push(gw);
    const r = await fetch(`http://127.0.0.1:${gw.puerto}/v1/messages`, {
      method: "POST",
      body: JSON.stringify({ model: "claude-haiku-4-5", stream: true }),
    });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(SSE);
  });

  it("upstream caído → 502 con detalle, nunca cuelga", async () => {
    const gw = await arrancarGateway({ puerto: 0 as never, upstream: "http://127.0.0.1:1", log: () => {} });
    recursos.push(gw);
    const r = await fetch(`http://127.0.0.1:${gw.puerto}/v1/messages`, { method: "POST", body: "{}" });
    expect(r.status).toBe(502);
    expect(((await r.json()) as { error: string }).error).toContain("upstream unreachable");
  });

  it("stream:false — la respuesta JSON con usage también se mide (S0.2: antes se reenviaba sin registrarse)", async () => {
    const lotes: unknown[][] = [];
    const ingesta = await arrancarIngestaFalsa(lotes);
    const upstream = await arrancarUpstreamJson({
      id: "msg_1",
      usage: {
        input_tokens: 100,
        output_tokens: 42,
        cache_read_input_tokens: 4000,
        cache_creation_input_tokens: 1000,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 },
      },
    });
    const gw = await arrancarGateway({
      puerto: 0 as never,
      upstream: `http://127.0.0.1:${upstream}`,
      serviceAccountKey: "bvk_test",
      meteringUrl: `http://127.0.0.1:${ingesta}`,
      seatId: "test-01",
      log: () => {},
    });
    recursos.push(gw);

    await fetch(`http://127.0.0.1:${gw.puerto}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", stream: false }),
    }).then((r) => r.text());

    await gw.cerrar();
    await esperar(() => lotes.length > 0);

    const reg = (lotes[0]![0] ?? {}) as Record<string, unknown>;
    expect(reg["basis"]).toBe("measured");
    expect(reg["actualLlm"]).toBe(1);
    expect(reg["actualInputTokens"]).toBe(100 + 4000 + 1000);
    expect(reg["actualOutputTokens"]).toBe(42);
    // haiku-4-5: 0.1k in + 4k cache↓ (0.0001/1k) + 1k escritura 1h a 2× + 42 out
    expect(reg["actualCost"]).toBeCloseTo(0.0001 + 0.0004 + 0.002 + 0.00021, 10);
  });

  it("count_tokens responde JSON pero NO factura: cero registros", async () => {
    const lotes: unknown[][] = [];
    const ingesta = await arrancarIngestaFalsa(lotes);
    const upstream = await arrancarUpstreamJson({ input_tokens: 2095 });
    const gw = await arrancarGateway({
      puerto: 0 as never,
      upstream: `http://127.0.0.1:${upstream}`,
      serviceAccountKey: "bvk_test",
      meteringUrl: `http://127.0.0.1:${ingesta}`,
      seatId: "test-01",
      log: () => {},
    });
    recursos.push(gw);

    const r = await fetch(`http://127.0.0.1:${gw.puerto}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", messages: [] }),
    });
    expect(((await r.json()) as { input_tokens: number }).input_tokens).toBe(2095);

    await gw.cerrar(); // drena: si hubiera algo que emitir, saldría aquí
    expect(lotes.length).toBe(0);
  });

  it("HEAD /api/hello (la comprobación de vida de Claude Code) pasa limpia", async () => {
    const recibidas: { path: string; headers: Record<string, unknown>; body: string }[] = [];
    const upstream = await arrancarUpstreamFalso(recibidas);
    const gw = await arrancarGateway({ puerto: 0 as never, upstream: `http://127.0.0.1:${upstream}`, log: () => {} });
    recursos.push(gw);
    const r = await fetch(`http://127.0.0.1:${gw.puerto}/api/hello`, { method: "HEAD" });
    expect(r.status).toBe(200);
  });
});
