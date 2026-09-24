import { createServer, type Server } from "node:http";
import { describe, it, expect, afterEach } from "vitest";

import { Coalescedor, claveDePeticion, MAX_CAPTURA_BYTES } from "../gateway/coalescencia.js";
import { arrancarGateway, type GatewayArrancado } from "../gateway/servidor.js";

describe("Coalescedor — unidad", () => {
  it("la clave distingue método, ruta y cuerpo", () => {
    const a = claveDePeticion("POST", "/v1/messages", Buffer.from("x"));
    expect(claveDePeticion("POST", "/v1/messages", Buffer.from("x"))).toBe(a);
    expect(claveDePeticion("POST", "/v1/messages", Buffer.from("y"))).not.toBe(a);
    expect(claveDePeticion("POST", "/v1/otro", Buffer.from("x"))).not.toBe(a);
  });

  it("una réplica 2xx íntegra llega a la gemela", async () => {
    const c = new Coalescedor();
    const clave = "k";
    const cap = c.registrar(clave)!;
    const espera = c.esperar(clave);
    cap.capturar(Buffer.from("hola "));
    cap.capturar(Buffer.from("mundo"));
    cap.terminar(200, { "content-type": "text/event-stream" });
    const r = await espera;
    expect(r).not.toBeNull();
    expect(Buffer.concat(r!.chunks).toString()).toBe("hola mundo");
    expect(c.gemelas).toBe(1);
  });

  it("una primaria con error NO se replica: la gemela viaja sola", async () => {
    const c = new Coalescedor();
    const cap = c.registrar("k")!;
    const espera = c.esperar("k");
    cap.terminar(529, {});
    expect(await espera).toBeNull();
  });

  it("el desbordamiento anula la réplica sin romper a nadie", async () => {
    const c = new Coalescedor();
    const cap = c.registrar("k")!;
    const espera = c.esperar("k");
    cap.capturar(Buffer.alloc(MAX_CAPTURA_BYTES + 1));
    cap.terminar(200, {});
    expect(await espera).toBeNull();
  });

  it("terminada la primaria, la clave queda libre: esto no es una caché", async () => {
    const c = new Coalescedor();
    const cap = c.registrar("k")!;
    cap.terminar(200, {});
    expect(c.tieneEnVuelo("k")).toBe(false);
    expect(c.registrar("k")).not.toBeNull();
  });
});

// ── Integración: dos peticiones idénticas EN VUELO por el gateway ──

const SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":1}}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":100,"output_tokens":42}}\n\n',
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

function upstreamLento(contador: { hits: number }, retrasoMs: number): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer(async (req, res) => {
      for await (const _ of req) void _;
      contador.hits += 1;
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(SSE);
      }, retrasoMs);
    });
    recursos.push(s);
    s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
  });
}

function ingestaFalsa(lotes: unknown[][]): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      // La elisión del gateway está ARMADA por defecto: con clave de servicio, el canal
      // de entitlements dispara un GET a `/api/org/entitlements` sobre el mismo origen
      // que la ingesta. Estos tests no ejercitan la elisión → fail-closed (features
      // vacío) y ese GET sin cuerpo no se trata como lote (parsear "" tiraba una
      // promesa sin manejar).
      if (req.method === "GET" && (req.url ?? "").startsWith("/api/org/entitlements")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"features":[]}');
        return;
      }
      lotes.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown[]);
      res.writeHead(202);
      res.end("{}");
    });
    recursos.push(s);
    s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
  });
}

async function esperar(cond: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const CUERPO = JSON.stringify({ model: "claude-haiku-4-5-20251001", messages: [{ role: "user", content: "hola" }], stream: true });

describe("gateway con coalescencia (bandera encendida)", () => {
  it("dos idénticas concurrentes → UN viaje al proveedor, dos respuestas íntegras, un ahorro reportado", async () => {
    const contador = { hits: 0 };
    const lotes: unknown[][] = [];
    const upstream = await upstreamLento(contador, 150);
    const ingesta = await ingestaFalsa(lotes);
    const gw = await arrancarGateway({
      puerto: 0 as never,
      upstream: `http://127.0.0.1:${upstream}`,
      coalescer: true,
      serviceAccountKey: "bvk_test",
      meteringUrl: `http://127.0.0.1:${ingesta}`,
      seatId: "t",
      log: () => {},
    });
    recursos.push(gw);

    const pedir = () =>
      fetch(`http://127.0.0.1:${gw.puerto}/v1/messages`, { method: "POST", body: CUERPO }).then(async (r) => ({
        status: r.status,
        texto: await r.text(),
      }));
    // La segunda sale cuando la primera ya está en vuelo (el upstream tarda 150ms).
    const p1 = pedir();
    await new Promise((r) => setTimeout(r, 40));
    const p2 = pedir();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(contador.hits).toBe(1);
    expect(r1.texto).toBe(SSE);
    expect(r2.texto).toBe(SSE);

    await gw.cerrar();
    await esperar(() => lotes.flat().length >= 2);
    const regs = lotes.flat() as Record<string, unknown>[];
    const medida = regs.find((r) => r["basis"] === "measured")!;
    const evitada = regs.find((r) => r["cacheResult"] === "singleflight")!;
    expect(medida["actualLlm"]).toBe(1);
    expect(evitada["avoidedLlm"]).toBe(1);
    expect(evitada["basis"]).toBe("estimated");
    expect(evitada["actualCost"]).toBe(0);
    // netSavings es una PROPORCIÓN [-100,1], no dólares: una coalescencia evita
    // la llamada entera → 1 (100 %). Este test afirmaba antes `== actualCost`
    // (dólares), que era EL bug: con una primaria > $1 el ingest rechazaba el
    // lote entero por `> 1`.
    expect(evitada["netSavings"]).toBe(1);
  });

  it("réplica stream:false — la gemela de una respuesta JSON también reporta su ahorro (S0.2)", async () => {
    const contador = { hits: 0 };
    const lotes: unknown[][] = [];
    const respuestaJson = JSON.stringify({
      id: "msg_1",
      usage: { input_tokens: 100, output_tokens: 42 },
    });
    const upstream = await new Promise<number>((resolve) => {
      const s = createServer(async (req, res) => {
        for await (const _ of req) void _;
        contador.hits += 1;
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(respuestaJson);
        }, 150);
      });
      recursos.push(s);
      s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
    });
    const ingesta = await ingestaFalsa(lotes);
    const gw = await arrancarGateway({
      puerto: 0 as never,
      upstream: `http://127.0.0.1:${upstream}`,
      coalescer: true,
      serviceAccountKey: "bvk_test",
      meteringUrl: `http://127.0.0.1:${ingesta}`,
      seatId: "t",
      log: () => {},
    });
    recursos.push(gw);

    const cuerpo = JSON.stringify({ model: "claude-haiku-4-5-20251001", messages: [{ role: "user", content: "hola" }], stream: false });
    const pedir = () =>
      fetch(`http://127.0.0.1:${gw.puerto}/v1/messages`, { method: "POST", body: cuerpo }).then((r) => r.text());
    const p1 = pedir();
    await new Promise((r) => setTimeout(r, 40));
    const p2 = pedir();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(contador.hits).toBe(1);
    expect(r1).toBe(respuestaJson);
    expect(r2).toBe(respuestaJson);

    await gw.cerrar();
    await esperar(() => lotes.flat().length >= 2);
    const regs = lotes.flat() as Record<string, unknown>[];
    const medida = regs.find((r) => r["basis"] === "measured")!;
    const evitada = regs.find((r) => r["cacheResult"] === "singleflight")!;
    expect(medida["actualLlm"]).toBe(1);
    expect(evitada["avoidedLlm"]).toBe(1);
    expect(evitada["basis"]).toBe("estimated");
    expect(evitada["netSavings"]).toBe(1);
  });

  it("⛔ una réplica JSON de OTRA ruta no emite registro fantasma (la verja de /v1/messages aplica también a la gemela)", async () => {
    // Cazado en la revisión adversarial de S0.2: la réplica medía con usoDeJson
    // SIN la verja de ruta del camino primario, y un `usage` de otra forma
    // (/v1/chat/completions, prompt_tokens) emitía un registro de 0 tokens con
    // avoidedLlm:1 que inflaba el contador de llamadas evitadas del panel.
    // Desde que Chat Completions tiene dialecto propio, ese `usage` SÍ se lee
    // (bien: test/gateway-chat-completions.test.ts, caso j); la verja se prueba
    // ahora con una ruta que no tiene dialecto de usage.
    const lotes: unknown[][] = [];
    const upstream = await new Promise<number>((resolve) => {
      const s = createServer(async (req, res) => {
        for await (const _ of req) void _;
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 50 } }));
        }, 150);
      });
      recursos.push(s);
      s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
    });
    const ingesta = await ingestaFalsa(lotes);
    const gw = await arrancarGateway({
      puerto: 0 as never,
      upstream: `http://127.0.0.1:${upstream}`,
      coalescer: true,
      serviceAccountKey: "bvk_test",
      meteringUrl: `http://127.0.0.1:${ingesta}`,
      seatId: "t",
      log: () => {},
    });
    recursos.push(gw);

    const cuerpo = JSON.stringify({ model: "claude-haiku-4-5-20251001", messages: [] });
    const pedir = () =>
      fetch(`http://127.0.0.1:${gw.puerto}/v1/embeddings`, { method: "POST", body: cuerpo }).then((r) => r.text());
    const p1 = pedir();
    await new Promise((r) => setTimeout(r, 40));
    const p2 = pedir();
    await Promise.all([p1, p2]);

    await gw.cerrar(); // drena: si hubiera un registro (fantasma), saldría aquí
    expect(lotes.flat()).toEqual([]);
  });

  it("dos DISTINTAS concurrentes → dos viajes", async () => {
    const contador = { hits: 0 };
    const upstream = await upstreamLento(contador, 100);
    const gw = await arrancarGateway({ puerto: 0 as never, upstream: `http://127.0.0.1:${upstream}`, coalescer: true, log: () => {} });
    recursos.push(gw);
    const pedir = (body: string) => fetch(`http://127.0.0.1:${gw.puerto}/v1/messages`, { method: "POST", body }).then((r) => r.text());
    const p1 = pedir(CUERPO);
    await new Promise((r) => setTimeout(r, 30));
    const p2 = pedir(CUERPO.replace("hola", "adios"));
    await Promise.all([p1, p2]);
    expect(contador.hits).toBe(2);
  });

  it("con la bandera APAGADA (el defecto), dos idénticas → dos viajes", async () => {
    const contador = { hits: 0 };
    const upstream = await upstreamLento(contador, 100);
    const gw = await arrancarGateway({ puerto: 0 as never, upstream: `http://127.0.0.1:${upstream}`, log: () => {} });
    recursos.push(gw);
    const pedir = () => fetch(`http://127.0.0.1:${gw.puerto}/v1/messages`, { method: "POST", body: CUERPO }).then((r) => r.text());
    const p1 = pedir();
    await new Promise((r) => setTimeout(r, 30));
    const p2 = pedir();
    await Promise.all([p1, p2]);
    expect(contador.hits).toBe(2);
  });
});
