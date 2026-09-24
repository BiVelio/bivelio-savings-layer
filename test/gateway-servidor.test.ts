import { createServer, request, type Server } from "node:http";
import { brotliCompressSync } from "node:zlib";
import { afterEach, describe, it, expect } from "vitest";

import { arrancarGateway, ErrorDeEscucha, type GatewayArrancado } from "../gateway/servidor.js";
import { testLicense } from "./helpers/test-license.js";
import { BV_SALA_VERSION } from "../src/version.js";

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

function arrancarIngestaFalsa(lotes: unknown[][], cabeceras: Record<string, unknown>[] = []): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      // La elisión del gateway está ARMADA por defecto (`elision !== false`), así que
      // con clave de servicio el canal de entitlements dispara un GET a
      // `/api/org/entitlements` sobre el MISMO origen que la ingesta. En la plataforma
      // real son dos rutas distintas; aquí la plataforma falsa las sirve las dos.
      // Estos tests NO ejercitan la elisión: se responde fail-closed (features vacío),
      // y ese GET sin cuerpo NO se trata como un lote de metering (parsear "" tiraba
      // una promesa sin manejar en el handler del mock).
      if (req.method === "GET" && (req.url ?? "").startsWith("/api/org/entitlements")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"features":[]}');
        return;
      }
      lotes.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown[]);
      cabeceras.push({ ...req.headers });
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
    const gw = await arrancarGateway({ license: testLicense(), puerto: 0 as never, upstream: `http://127.0.0.1:${upstream}`, log: () => {} });
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
      license: testLicense(),
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
      headers: {
        "content-type": "application/json",
        "x-claude-code-session-id": "sesion-abc-123",
        "x-claude-code-agent-id": "agente-7",
      },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", stream: true }),
    }).then((r) => r.text());

    // El emisor agrupa; el lote sale al llegar al tamaño o al flush del cierre.
    await gw.cerrar();
    await esperar(() => lotes.length > 0);

    const reg = (lotes[0]![0] ?? {}) as Record<string, unknown>;
    expect(reg["model"]).toBe("claude-haiku-4-5-20251001");
    // Atribución de sesión/subagente (0019): viaja tal cual en el wire.
    expect(reg["sessionId"]).toBe("sesion-abc-123");
    expect(reg["agentId"]).toBe("agente-7");
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

  it("el lote a la ingesta declara la versión del gateway en la cabecera x-bvsala-version, y solo ahí", async () => {
    const recibidas: { path: string; headers: Record<string, unknown>; body: string }[] = [];
    const lotes: unknown[][] = [];
    const cabeceras: Record<string, unknown>[] = [];
    const upstream = await arrancarUpstreamFalso(recibidas);
    const ingesta = await arrancarIngestaFalsa(lotes, cabeceras);
    const gw = await arrancarGateway({
      license: testLicense(),
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
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", stream: true }),
    }).then((r) => r.text());
    await gw.cerrar();
    await esperar(() => lotes.length > 0);

    // El gateway es la superficie con la palanca de tarifa: declara gateway/, no sdk/.
    expect(cabeceras[0]!["x-bvsala-version"]).toBe(`gateway/${BV_SALA_VERSION}`);
    // Conjunto EXACTO de cabeceras propias del emisor (las demás las pone Node:
    // host, connection, content-length, accept*, user-agent…). Ninguna otra
    // cabecera x-bvsala-* ni x-claude-code-* se cuela hacia la ingesta.
    const propias = Object.keys(cabeceras[0]!).filter((k) => k.startsWith("x-") || k === "authorization" || k === "content-type").sort();
    expect(propias).toEqual(["authorization", "content-type", "x-bvsala-version"]);
    // Y en el CUERPO no va ninguna versión: el canal cerrado sigue cerrado.
    const reg = (lotes[0]![0] ?? {}) as Record<string, unknown>;
    expect(reg["clientVersion"]).toBeUndefined();
    expect(reg["version"]).toBeUndefined();
  });

  it("atribución: sin cabeceras el campo NO viaja, y una cabecera con texto libre se descarta (no tira el lote)", async () => {
    const recibidas: { path: string; headers: Record<string, unknown>; body: string }[] = [];
    const lotes: unknown[][] = [];
    const upstream = await arrancarUpstreamFalso(recibidas);
    const ingesta = await arrancarIngestaFalsa(lotes);
    const gw = await arrancarGateway({
      license: testLicense(),
      puerto: 0 as never,
      upstream: `http://127.0.0.1:${upstream}`,
      serviceAccountKey: "bvk_test",
      meteringUrl: `http://127.0.0.1:${ingesta}`,
      seatId: "test-01",
      log: () => {},
    });
    recursos.push(gw);

    // 1 · sin cabeceras de atribución
    await fetch(`http://127.0.0.1:${gw.puerto}/v1/messages`, {
      method: "POST",
      body: JSON.stringify({ model: "claude-haiku-4-5", stream: true }),
    }).then((r) => r.text());
    // 2 · cabecera con espacios (texto libre): la verja del ingest la rechazaría
    //     con un 400 de LOTE entero — el gateway la descarta antes de emitir.
    await fetch(`http://127.0.0.1:${gw.puerto}/v1/messages`, {
      method: "POST",
      headers: { "x-claude-code-session-id": "esto no es un id" },
      body: JSON.stringify({ model: "claude-haiku-4-5", stream: true }),
    }).then((r) => r.text());

    await gw.cerrar();
    await esperar(() => lotes.flat().length >= 2);
    for (const reg of lotes.flat() as Record<string, unknown>[]) {
      expect("sessionId" in reg).toBe(false);
      expect("agentId" in reg).toBe(false);
    }
  });

  it("con licencia y SIN clave de servicio (solo en proceso): mismo passthrough, cero metering (la licencia verja; el metering es best-effort)", async () => {
    const recibidas: { path: string; headers: Record<string, unknown>; body: string }[] = [];
    const upstream = await arrancarUpstreamFalso(recibidas);
    const gw = await arrancarGateway({ license: testLicense(), puerto: 0 as never, upstream: `http://127.0.0.1:${upstream}`, log: () => {} });
    recursos.push(gw);
    const r = await fetch(`http://127.0.0.1:${gw.puerto}/v1/messages`, {
      method: "POST",
      body: JSON.stringify({ model: "claude-haiku-4-5", stream: true }),
    });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(SSE);
  });

  it("upstream caído → 502 con detalle, nunca cuelga", async () => {
    const gw = await arrancarGateway({ license: testLicense(), puerto: 0 as never, upstream: "http://127.0.0.1:1", log: () => {} });
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
      license: testLicense(),
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
      license: testLicense(),
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

  it("GET /v1/models (model discovery de Claude Code) pasa íntegro y NO factura", async () => {
    const lotes: unknown[][] = [];
    const ingesta = await arrancarIngestaFalsa(lotes);
    const modelos = { data: [{ id: "claude-sonnet-4-5", display_name: "Claude Sonnet 4.5" }], has_more: false };
    const upstream = await new Promise<number>((resolve) => {
      const s = createServer((req, res) => {
        res.writeHead(req.method === "GET" && req.url?.startsWith("/v1/models") ? 200 : 404, { "content-type": "application/json" });
        res.end(JSON.stringify(modelos));
      });
      recursos.push(s);
      s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
    });
    const gw = await arrancarGateway({
      license: testLicense(),
      puerto: 0 as never,
      upstream: `http://127.0.0.1:${upstream}`,
      serviceAccountKey: "bvk_test",
      meteringUrl: `http://127.0.0.1:${ingesta}`,
      seatId: "test-01",
      log: () => {},
    });
    recursos.push(gw);

    const r = await fetch(`http://127.0.0.1:${gw.puerto}/v1/models?limit=1000`, { headers: { "x-api-key": "sk-test", authorization: "Bearer sk-test" } });
    expect(r.status).toBe(200);
    expect(r.redirected).toBe(false); // cualquier redirect = fallo de discovery, por diseño del cliente
    expect(await r.json()).toEqual(modelos);

    await gw.cerrar();
    expect(lotes.length).toBe(0);
  });

  it("⛔ un handshake WebSocket (Codex CLI lo intenta en cada sesión) recibe 426, no 502", async () => {
    const recibidas: { path: string; headers: Record<string, unknown>; body: string }[] = [];
    const upstream = await arrancarUpstreamFalso(recibidas);
    const gw = await arrancarGateway({ license: testLicense(), puerto: 0 as never, upstream: `http://127.0.0.1:${upstream}`, log: () => {} });
    recursos.push(gw);

    const { createConnection } = await import("node:net");
    const respuesta = await new Promise<string>((resolve, reject) => {
      const s = createConnection({ host: "127.0.0.1", port: gw.puerto }, () => {
        s.write(
          "GET /v1/responses HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
        );
      });
      let datos = "";
      s.on("data", (d) => (datos += d.toString()));
      s.on("end", () => resolve(datos));
      s.on("error", reject);
      setTimeout(() => {
        s.destroy();
        resolve(datos);
      }, 2000);
    });
    expect(respuesta).toMatch(/^HTTP\/1\.1 426 /);
    expect(recibidas).toHaveLength(0); // el upstream ni se entera
  });

  it("⛔ un RST del cliente tras el 426 NO tumba el proceso (Node retira sus manejadores del socket en 'upgrade')", async () => {
    const recibidas: { path: string; headers: Record<string, unknown>; body: string }[] = [];
    const upstream = await arrancarUpstreamFalso(recibidas);
    const gw = await arrancarGateway({ license: testLicense(), puerto: 0 as never, upstream: `http://127.0.0.1:${upstream}`, log: () => {} });
    recursos.push(gw);

    const { createConnection } = await import("node:net");
    await new Promise<void>((resolve, reject) => {
      const s = createConnection({ host: "127.0.0.1", port: gw.puerto }, () => {
        s.write("GET /v1/responses HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
      });
      s.once("data", () => {
        s.resetAndDestroy(); // RST, no FIN: lo que hace tokio al soltar el TcpStream con bytes sin leer
        resolve();
      });
      s.on("error", reject);
    });
    await new Promise((r) => setTimeout(r, 100));
    // Si el proceso hubiera muerto no estaríamos aquí; y el gateway sigue sirviendo:
    const r = await fetch(`http://127.0.0.1:${gw.puerto}/v1/messages`, { method: "POST", body: JSON.stringify({ model: "claude-haiku-4-5", stream: true }) });
    expect(r.status).toBe(200);
  });

  it("⛔ un Esc de Claude Code a mitad de generación NO emite registro: el usage de message_start es provisional", async () => {
    const lotes: unknown[][] = [];
    const ingesta = await arrancarIngestaFalsa(lotes);
    const inicio = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":4000,"output_tokens":1}}}\n\n';
    const upstream = await new Promise<number>((resolve) => {
      const s = createServer(async (req, res) => {
        for await (const _ of req) void _;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(inicio);
        setTimeout(() => res.end('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":900}}\n\n'), 5000);
      });
      recursos.push(s);
      s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
    });
    const gw = await arrancarGateway({
      license: testLicense(),
      puerto: 0 as never,
      upstream: `http://127.0.0.1:${upstream}`,
      serviceAccountKey: "bvk_test",
      meteringUrl: `http://127.0.0.1:${ingesta}`,
      seatId: "test-01",
      log: () => {},
    });
    recursos.push(gw);

    const ac = new AbortController();
    const r = await fetch(`http://127.0.0.1:${gw.puerto}/v1/messages`, {
      method: "POST",
      body: JSON.stringify({ model: "claude-haiku-4-5", stream: true }),
      signal: ac.signal,
    });
    const lector = r.body!.getReader();
    let recibido = "";
    while (!recibido.includes("message_start")) recibido += new TextDecoder().decode((await lector.read()).value);
    ac.abort(); // Esc

    await new Promise((res) => setTimeout(res, 300));
    await gw.cerrar();
    expect(lotes.flat()).toEqual([]);
  });

  it("dialecto por ruta: un POST …/responses (Codex) se mide con el observador de la Responses API", async () => {
    const lotes: unknown[][] = [];
    const ingesta = await arrancarIngestaFalsa(lotes);
    const sse = [
      'event: response.created\ndata: {"type":"response.created"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1000,"input_tokens_details":{"cached_tokens":600,"cache_write_tokens":0},"output_tokens":50}}}\n\n',
    ].join("");
    const upstream = await new Promise<number>((resolve) => {
      const s = createServer(async (req, res) => {
        for await (const _ of req) void _;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sse);
      });
      recursos.push(s);
      s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
    });
    const gw = await arrancarGateway({
      license: testLicense(),
      puerto: 0 as never,
      upstream: `http://127.0.0.1:${upstream}`,
      serviceAccountKey: "bvk_test",
      meteringUrl: `http://127.0.0.1:${ingesta}`,
      seatId: "test-01",
      log: () => {},
    });
    recursos.push(gw);

    const r = await fetch(`http://127.0.0.1:${gw.puerto}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: "hola", stream: true }),
    });
    expect(await r.text()).toBe(sse); // byte a byte, como siempre

    await gw.cerrar();
    await esperar(() => lotes.length > 0);
    const reg = (lotes[0]![0] ?? {}) as Record<string, unknown>;
    expect(reg["model"]).toBe("gpt-5.6-sol");
    expect(reg["basis"]).toBe("measured");
    expect(reg["providerCachedInputTokens"]).toBe(600);
    expect(reg["actualInputTokens"]).toBe(1000);
    expect(reg["actualOutputTokens"]).toBe(50);
    // gpt-5.6-sol: 0.4k a 0.004 + 0.6k a 0.0004 + 0.05k a 0.02
    expect(reg["actualCost"]).toBeCloseTo(0.0016 + 0.00024 + 0.001, 10);
  });

  it("⛔ SSE SIN content-type en …/responses (el backend de ChatGPT lo sirve así) → se mide igual", async () => {
    // Validado en mano el 30-08 con el espía: chatgpt.com/backend-api/codex
    // responde el stream sin cabecera content-type y el gateway no creaba
    // observador — Codex imprimía «tokens used» y el panel no veía nada.
    const lotes: unknown[][] = [];
    const ingesta = await arrancarIngestaFalsa(lotes);
    const sse =
      'event: response.created\ndata: {"type":"response.created"}\n\n' +
      'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":200,"input_tokens_details":{"cached_tokens":50,"cache_write_tokens":0},"output_tokens":3}}}\n\n';
    const upstream = await new Promise<number>((resolve) => {
      const s = createServer(async (req, res) => {
        for await (const _ of req) void _;
        res.writeHead(200); // sin content-type, como el backend real
        res.end(sse);
      });
      recursos.push(s);
      s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
    });
    const gw = await arrancarGateway({
      license: testLicense(),
      puerto: 0 as never,
      upstream: `http://127.0.0.1:${upstream}`,
      serviceAccountKey: "bvk_test",
      meteringUrl: `http://127.0.0.1:${ingesta}`,
      seatId: "test-01",
      log: () => {},
    });
    recursos.push(gw);

    const r = await fetch(`http://127.0.0.1:${gw.puerto}/backend-api/codex/responses`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.5", stream: true }),
    });
    expect(await r.text()).toBe(sse);

    await gw.cerrar();
    await esperar(() => lotes.length > 0);
    const reg = (lotes[0]![0] ?? {}) as Record<string, unknown>;
    expect(reg["model"]).toBe("gpt-5.5");
    expect(reg["actualInputTokens"]).toBe(200);
    expect(reg["providerCachedInputTokens"]).toBe(50);
    expect(reg["actualOutputTokens"]).toBe(3);
  });

  it("⛔ cuerpo de petición comprimido (Codex manda zstd; aquí gzip) → los bytes pasan intactos y el modelo se lee igual", async () => {
    const recibidas: { path: string; headers: Record<string, unknown>; body: string }[] = [];
    const lotes: unknown[][] = [];
    const ingesta = await arrancarIngestaFalsa(lotes);
    const sse = 'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":2}}}\n\n';
    const upstream = await new Promise<number>((resolve) => {
      const s = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        recibidas.push({ path: req.url ?? "", headers: { ...req.headers }, body: Buffer.concat(chunks).toString("base64") });
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sse);
      });
      recursos.push(s);
      s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
    });
    const gw = await arrancarGateway({
      license: testLicense(),
      puerto: 0 as never,
      upstream: `http://127.0.0.1:${upstream}`,
      serviceAccountKey: "bvk_test",
      meteringUrl: `http://127.0.0.1:${ingesta}`,
      seatId: "test-01",
      log: () => {},
    });
    recursos.push(gw);

    const { gzipSync } = await import("node:zlib");
    const comprimido = gzipSync(Buffer.from(JSON.stringify({ model: "gpt-5.5", stream: true })));
    await fetch(`http://127.0.0.1:${gw.puerto}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body: comprimido,
    }).then((r) => r.text());

    expect(Buffer.from(recibidas[0]!.body, "base64").equals(comprimido)).toBe(true); // byte a byte
    expect(recibidas[0]!.headers["content-encoding"]).toBe("gzip");

    await gw.cerrar();
    await esperar(() => lotes.length > 0);
    expect(((lotes[0]![0] ?? {}) as Record<string, unknown>)["model"]).toBe("gpt-5.5");
  });

  it("⛔ el cliente cierra nada más recibir el usage (Codex CLI lo hace) → se mide igual", async () => {
    // Cazado en la validación en mano de `bvsala codex`: Codex corta la conexión
    // al ver response.completed; el upstream sigue abierto, el gateway lo
    // trataba como «cliente abortó» y la medición nunca corría.
    const lotes: unknown[][] = [];
    const ingesta = await arrancarIngestaFalsa(lotes);
    const completado =
      'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":100,"output_tokens":7}}}\n\n';
    const upstream = await new Promise<number>((resolve) => {
      const s = createServer(async (req, res) => {
        for await (const _ of req) void _;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(completado);
        // …y el upstream se queda abierto: el cliente no va a esperar.
        setTimeout(() => res.end(), 5000);
      });
      recursos.push(s);
      s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
    });
    const gw = await arrancarGateway({
      license: testLicense(),
      puerto: 0 as never,
      upstream: `http://127.0.0.1:${upstream}`,
      serviceAccountKey: "bvk_test",
      meteringUrl: `http://127.0.0.1:${ingesta}`,
      seatId: "test-01",
      log: () => {},
    });
    recursos.push(gw);

    const ac = new AbortController();
    const r = await fetch(`http://127.0.0.1:${gw.puerto}/v1/responses`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.6-sol", stream: true }),
      signal: ac.signal,
    });
    const lector = r.body!.getReader();
    let recibido = "";
    while (!recibido.includes("response.completed")) recibido += new TextDecoder().decode((await lector.read()).value);
    ac.abort(); // el cliente se va con el usage ya en la mano

    await esperar(() => lotes.length > 0, 4000).catch(() => {});
    await gw.cerrar();
    await esperar(() => lotes.length > 0);
    const reg = (lotes[0]![0] ?? {}) as Record<string, unknown>;
    expect(reg["model"]).toBe("gpt-5.6-sol");
    expect(reg["actualInputTokens"]).toBe(100);
    expect(reg["actualOutputTokens"]).toBe(7);
  });

  it("HEAD /api/hello (la comprobación de vida de Claude Code) pasa limpia", async () => {
    const recibidas: { path: string; headers: Record<string, unknown>; body: string }[] = [];
    const upstream = await arrancarUpstreamFalso(recibidas);
    const gw = await arrancarGateway({ license: testLicense(), puerto: 0 as never, upstream: `http://127.0.0.1:${upstream}`, log: () => {} });
    recursos.push(gw);
    const r = await fetch(`http://127.0.0.1:${gw.puerto}/api/hello`, { method: "HEAD" });
    expect(r.status).toBe(200);
  });
});

/**
 * Los tres defectos del gateway que la verificación de cinco agentes encontró
 * sobre la 0.4.20 (2026-09-13) y que el dueño quiso arreglados antes de
 * publicar nada más. Cada prueba FALLA contra el código de la 0.4.20.
 */

/** Una petición HTTP/1.1 cruda con cabeceras que undici (el cliente fetch) se
 *  negaría a mandar: por eso va con `node:http`, que las escribe tal cual. */
function pedirCrudo(
  puerto: number,
  headers: Record<string, string>,
  cuerpo: string,
): Promise<{ status: number; cuerpo: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: puerto, path: "/v1/messages", method: "POST", headers }, (res) => {
      let datos = "";
      res.setEncoding("utf8");
      res.on("data", (d: string) => (datos += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, cuerpo: datos }));
    });
    req.on("error", reject);
    req.end(cuerpo);
  });
}

describe("arrancarGateway — los defectos de la 0.4.20 (verificación del 2026-09-13)", () => {
  it("⛔ dos gateways en el mismo puerto: el segundo rechaza con ErrorDeEscucha (EADDRINUSE) y un mensaje del producto, no la traza de Node", async () => {
    const recibidas: { path: string; headers: Record<string, unknown>; body: string }[] = [];
    const upstream = await arrancarUpstreamFalso(recibidas);
    const primero = await arrancarGateway({ license: testLicense(), puerto: 0 as never, upstream: `http://127.0.0.1:${upstream}`, log: () => {} });
    recursos.push(primero);

    const err = (await arrancarGateway({ license: testLicense(), puerto: primero.puerto, upstream: `http://127.0.0.1:${upstream}`, log: () => {} }).then(
      (gw) => {
        recursos.push(gw);
        return null;
      },
      (e: unknown) => e,
    )) as (Error & { code?: string; puerto?: number }) | null;

    expect(err).toBeInstanceOf(ErrorDeEscucha);
    expect(err!.code).toBe("EADDRINUSE");
    expect(err!.puerto).toBe(primero.puerto);
    // Un mensaje del producto, en español, con el puerto; el error crudo de
    // Node («listen EADDRINUSE: address already in use 127.0.0.1:N») queda
    // como `cause` para quien depure, no como lo primero que lee el probador.
    expect(err!.message).toContain(`${primero.puerto}`);
    expect(err!.message).toMatch(/already in use/);
    expect(err!.message).not.toMatch(/^listen EADDRINUSE/);
    expect(String((err as { cause?: unknown }).cause)).toContain("EADDRINUSE");
    // Y el primero sigue sirviendo: el fallo del segundo no le tocó nada.
    const r = await fetch(`http://127.0.0.1:${primero.puerto}/v1/messages`, { method: "POST", body: JSON.stringify({ model: "claude-haiku-4-5", stream: true }) });
    expect(r.status).toBe(200);
  });

  it("⛔ con licencia y sin clave (en proceso), una petición en streaming que termina en 200 deja SU línea en el log (la que `bvsala doctor` manda buscar)", async () => {
    // Claude Code, Codex, Goose y Qwen van SIEMPRE en streaming. Hasta 0.4.20
    // la rama de streaming solo logueaba desde medir(), y medir() sin emisor
    // vuelve en silencio: un probador sin clave (o con la clave mal exportada)
    // no tenía forma de confirmar que su terminal pasaba por el gateway.
    const recibidas: { path: string; headers: Record<string, unknown>; body: string }[] = [];
    const upstream = await arrancarUpstreamFalso(recibidas);
    const lineas: string[] = [];
    const gw = await arrancarGateway({ license: testLicense(), puerto: 0 as never, upstream: `http://127.0.0.1:${upstream}`, log: (l) => lineas.push(l) });
    recursos.push(gw);

    const r = await fetch(`http://127.0.0.1:${gw.puerto}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", messages: [{ role: "user", content: "hola" }], stream: true }),
    });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(SSE);

    const linea = lineas.find((l) => l.startsWith("[gateway] POST /v1/messages"));
    expect(linea).toBeDefined();
    expect(linea).toContain("→ 200");
    expect(linea).toContain("(stream)");
    expect(linea).toContain("not metered: no BIVELIO_SERVICE_KEY");
    // Una línea por petición, ni cero ni dos.
    expect(lineas.filter((l) => l.startsWith("[gateway] POST /v1/messages"))).toHaveLength(1);
  });

  it("⛔ `Expect: 100-continue` (curl ≥ 8.7 lo añade a cuerpos > 1 MB) → 200, y el upstream NO recibe la cabecera", async () => {
    // undici rechaza `expect` («expect header not supported») y el gateway
    // respondía 502 «upstream unreachable · TypeError: fetch failed», el
    // MISMO texto que un upstream caído, sin que la petición saliera.
    const recibidas: { path: string; headers: Record<string, unknown>; body: string }[] = [];
    const upstream = await arrancarUpstreamFalso(recibidas);
    const gw = await arrancarGateway({ license: testLicense(), puerto: 0 as never, upstream: `http://127.0.0.1:${upstream}`, log: () => {} });
    recursos.push(gw);

    const cuerpo = JSON.stringify({ model: "claude-haiku-4-5", stream: true });
    const r = await pedirCrudo(gw.puerto, { "content-type": "application/json", expect: "100-continue", "anthropic-beta": "x" }, cuerpo);
    expect(r.status).toBe(200);
    expect(r.cuerpo).toBe(SSE);
    expect(recibidas).toHaveLength(1);
    expect(recibidas[0]!.body).toBe(cuerpo);
    expect(recibidas[0]!.headers["expect"]).toBeUndefined();
    expect(recibidas[0]!.headers["anthropic-beta"]).toBe("x"); // las de verdad siguen pasando
  });

  it("⛔ `Transfer-Encoding: chunked` en la petición → 200; el upstream recibe el cuerpo entero SIN esa cabecera", async () => {
    const recibidas: { path: string; headers: Record<string, unknown>; body: string }[] = [];
    const upstream = await arrancarUpstreamFalso(recibidas);
    const gw = await arrancarGateway({ license: testLicense(), puerto: 0 as never, upstream: `http://127.0.0.1:${upstream}`, log: () => {} });
    recursos.push(gw);

    const cuerpo = JSON.stringify({ model: "claude-haiku-4-5", stream: true });
    const r = await pedirCrudo(gw.puerto, { "content-type": "application/json", "transfer-encoding": "chunked" }, cuerpo);
    expect(r.status).toBe(200);
    expect(recibidas).toHaveLength(1);
    expect(recibidas[0]!.body).toBe(cuerpo);
    expect(recibidas[0]!.headers["transfer-encoding"]).toBeUndefined();
  });

  it("las hop-by-hop de RFC 7230 §6.1 y las que nombre `Connection` se quedan en este salto", async () => {
    const recibidas: { path: string; headers: Record<string, unknown>; body: string }[] = [];
    const upstream = await arrancarUpstreamFalso(recibidas);
    const gw = await arrancarGateway({ license: testLicense(), puerto: 0 as never, upstream: `http://127.0.0.1:${upstream}`, log: () => {} });
    recursos.push(gw);

    const r = await pedirCrudo(
      gw.puerto,
      {
        connection: "keep-alive, x-solo-este-salto",
        "x-solo-este-salto": "1",
        "keep-alive": "timeout=5",
        te: "trailers",
        trailer: "x-fin",
        "proxy-connection": "keep-alive",
        "x-api-key": "sk-test",
      },
      JSON.stringify({ model: "claude-haiku-4-5", stream: true }),
    );
    expect(r.status).toBe(200);
    expect(recibidas).toHaveLength(1);
    const h = recibidas[0]!.headers;
    for (const nombre of ["x-solo-este-salto", "keep-alive", "te", "trailer", "proxy-connection", "upgrade"]) {
      expect(h[nombre], nombre).toBeUndefined();
    }
    expect(h["x-api-key"]).toBe("sk-test");
  });

  it("⛔ upstream caído → el 502 dice la CAUSA (ECONNREFUSED), no solo «fetch failed»", async () => {
    // Un puerto que ESTUVO abierto y ya no: el 1 no vale, undici lo corta
    // antes de conectar («bad port», lista de puertos prohibidos del fetch).
    const cerrado = await new Promise<number>((resolve) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    const lineas: string[] = [];
    const gw = await arrancarGateway({ license: testLicense(), puerto: 0 as never, upstream: `http://127.0.0.1:${cerrado}`, log: (l) => lineas.push(l) });
    recursos.push(gw);
    const r = await fetch(`http://127.0.0.1:${gw.puerto}/v1/messages`, { method: "POST", body: "{}" });
    expect(r.status).toBe(502);
    const json = (await r.json()) as { error: string; detail: string };
    expect(json.error).toContain("upstream unreachable");
    expect(json.detail).toContain("ECONNREFUSED");
    // Y en el log, lo mismo: un probador con «fetch failed» a secas no sabe
    // si es la red, el upstream o una cabecera que undici rechazó.
    expect(lineas.find((l) => l.includes("upstream unreachable"))).toContain("ECONNREFUSED");
  });
});
