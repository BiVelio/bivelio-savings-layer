import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { arrancarGateway } from "../gateway/servidor.js";
import { cajaLimpia, exigirBinCompilado, lanzar, type Caja } from "./helpers/bvsala-proceso.js";

/**
 * A2-11 y A2-15 · LAS SEÑALES.
 *
 * A2-11 · En Aider y Goose, Ctrl-C corta la respuesta en curso y la sesión
 * sigue. Ctrl-C llega a todo el grupo en primer plano, también a `bvsala`, que
 * apagaba el gateway y salía con 0: el agente seguía abierto y todas sus
 * peticiones siguientes fallaban con ECONNREFUSED. En modo envoltorio el
 * gateway vive lo que viva el hijo; SIGTERM se reenvía al hijo.
 *
 * A2-15 · `bvsala gateway` con un stream atascado: Ctrl-C dejaba de escuchar
 * pero el proceso no salía, y un segundo Ctrl-C tampoco. Ahora cerrar() corta
 * las conexiones que no terminan en unos segundos, y la segunda señal sale ya.
 */

/** Un upstream de Anthropic que responde un JSON con usage, o que se atasca en mitad del stream. */
function upstreamFalso(atascado: boolean): Promise<{ server: Server; puerto: number }> {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (atascado) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`);
        return; // nunca termina
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_falso",
          type: "message",
          role: "assistant",
          model: "claude-haiku-4-5",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 1 },
        }),
      );
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, puerto: (server.address() as { port: number }).port })),
  );
}

function cerrarServidor(s: Server): Promise<void> {
  s.closeAllConnections();
  return new Promise((r) => s.close(() => r()));
}

const CUERPO = JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 5, stream: true, messages: [{ role: "user", content: "hola" }] });

/** Un tope para que una espera que no termina falle en vez de colgar la suite. */
function conTope<T>(p: Promise<T>, ms: number): Promise<T | "VENCIDO"> {
  return Promise.race([p, new Promise<"VENCIDO">((r) => setTimeout(() => r("VENCIDO"), ms))]);
}

describe("A2-15 · cerrar() no espera para siempre a un stream atascado", () => {
  it("con una respuesta que nunca termina, cerrar() resuelve dentro del tope y corta la conexión", async () => {
    const up = await upstreamFalso(true);
    const gw = await arrancarGateway({
      puerto: 0,
      upstream: `http://127.0.0.1:${up.puerto}`,
      log: () => {},
      warn: () => {},
      topeConexionesAlCerrarMs: 300,
    });
    const ac = new AbortController();
    try {
      const r = await fetch(`http://127.0.0.1:${gw.puerto}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "clave-falsa" },
        body: CUERPO,
        signal: ac.signal,
      });
      expect(r.status).toBe(200);
      const t0 = Date.now();
      const fin = await conTope(gw.cerrar(), 4_000);
      expect(fin, "cerrar() se quedó esperando al stream atascado").not.toBe("VENCIDO");
      expect(Date.now() - t0).toBeLessThan(3_000);
      // El cliente ve la conexión cortada: su lectura termina (con error), no se cuelga.
      const lectura = await conTope(r.text().then(() => "fin", () => "cortada"), 2_000);
      expect(lectura).not.toBe("VENCIDO");
    } finally {
      ac.abort();
      await cerrarServidor(up.server);
    }
  });
});

describe.skipIf(process.platform === "win32")("A2-11 y A2-15 · señales del CLI, en un proceso de verdad", () => {
  let caja: Caja;
  let normal: { server: Server; puerto: number };
  let atascado: { server: Server; puerto: number };

  beforeAll(async () => {
    exigirBinCompilado();
    normal = await upstreamFalso(false);
    atascado = await upstreamFalso(true);
  });
  afterAll(async () => {
    await cerrarServidor(normal.server);
    await cerrarServidor(atascado.server);
  });
  afterEach(() => caja?.limpiar());

  it("A2-11 · Ctrl-C en `bvsala aider`: el gateway sigue vivo mientras el agente viva y sale con su código", async () => {
    caja = cajaLimpia();
    // Un aider falso que, como el de verdad, captura Ctrl-C y sigue trabajando.
    caja.terminal(
      "aider",
      [
        "const base = process.env.ANTHROPIC_API_BASE;",
        "const pedir = async (n) => {",
        "  try {",
        "    const r = await fetch(base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'clave-falsa' },",
        "      body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 5, messages: [{ role: 'user', content: 'hola' }] }) });",
        "    await r.text();",
        "    console.error('[aider falso] turno ' + n + ': HTTP ' + r.status);",
        "  } catch (e) {",
        "    console.error('[aider falso] turno ' + n + ': FALLO ' + ((e.cause && e.cause.code) || e.message));",
        "  }",
        "};",
        "process.on('SIGINT', async () => {",
        "  console.error('[aider falso] Ctrl-C: corta la respuesta y sigue');",
        "  await new Promise((r) => setTimeout(r, 400));",
        "  await pedir(2);",
        "  process.exit(7);",
        "});",
        "(async () => { await pedir(1); console.error('[aider falso] listo'); setInterval(() => {}, 1000); })();",
      ].join("\n"),
    );
    const p = lanzar(["aider"], caja.env({ BVSALA_GATEWAY_UPSTREAM: `http://127.0.0.1:${normal.puerto}` }));
    try {
      await p.esperar(/\[aider falso\] listo/);
      expect(p.stderr()).toContain("turno 1: HTTP 200");
      // Lo que hace la terminal con Ctrl-C: SIGINT a todo el grupo en primer plano.
      process.kill(-p.hijo.pid!, "SIGINT");
      const fin = await conTope(p.salida, 10_000);
      expect(fin, p.stderr()).not.toBe("VENCIDO");
      expect(p.stderr()).toContain("turno 2: HTTP 200");
      expect(p.stderr()).not.toContain("FALLO");
      // Sale cuando sale el hijo, con SU código.
      expect((fin as { code: number | null }).code).toBe(7);
      // Y el resumen de medición cuenta las dos peticiones.
      expect(p.stderr()).toMatch(/2 request\(s\) metered with the provider's usage/);
    } finally {
      p.matar();
    }
  });

  it("A2-11 · SIGTERM a `bvsala claude` se reenvía al terminal y el envoltorio sale con su código", async () => {
    caja = cajaLimpia();
    caja.terminal(
      "claude",
      [
        "process.on('SIGTERM', () => { console.error('[claude falso] SIGTERM recibido'); process.exit(3); });",
        "console.error('[claude falso] listo');",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    const p = lanzar(["claude"], caja.env());
    try {
      await p.esperar(/\[claude falso\] listo/);
      // Solo al envoltorio (un kill, un supervisor): no viene de la terminal.
      process.kill(p.hijo.pid!, "SIGTERM");
      const fin = await conTope(p.salida, 10_000);
      expect(fin, p.stderr()).not.toBe("VENCIDO");
      expect(p.stderr()).toContain("[claude falso] SIGTERM recibido");
      expect((fin as { code: number | null }).code).toBe(3);
    } finally {
      p.matar();
    }
  });

  it("A2-15 · `bvsala gateway` con un stream atascado: la segunda Ctrl-C sale enseguida", async () => {
    caja = cajaLimpia();
    const p = lanzar(["gateway", "--port", "0", "--upstream", `http://127.0.0.1:${atascado.puerto}`], caja.env());
    const ac = new AbortController();
    try {
      const m = await p.esperar(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      const r = await fetch(`http://127.0.0.1:${m[1]}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "clave-falsa" },
        body: CUERPO,
        signal: ac.signal,
      });
      expect(r.status).toBe(200);
      process.kill(p.hijo.pid!, "SIGINT");
      await new Promise((res) => setTimeout(res, 300));
      process.kill(p.hijo.pid!, "SIGINT");
      const fin = await conTope(p.salida, 2_500);
      expect(fin, "dos Ctrl-C y el gateway seguía vivo").not.toBe("VENCIDO");
      expect((fin as { code: number | null }).code).toBe(130);
    } finally {
      ac.abort();
      p.matar();
    }
  });
});
