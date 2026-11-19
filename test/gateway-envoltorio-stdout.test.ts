import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { BIN, cajaLimpia, exigirBinCompilado, lanzar, type Caja } from "./helpers/bvsala-proceso.js";

/**
 * A2-10 · EN MODO ENVOLTORIO, EL STDOUT ES DEL TERMINAL.
 *
 * Quien cambia `claude` por `bvsala claude` en un script, en CI o en una tubería
 * (`bvsala claude -p … --output-format json | jq`) recibía seis líneas
 * «[bvsala gateway] …» mezcladas con la salida del agente: el JSON dejaba de ser
 * JSON y nada avisaba. Ahora toda línea propia del envoltorio (arranque, licencia,
 * medición, palancas, la nota del terminal y el log por petición) va a stderr; el
 * stdout es exactamente lo que imprime el hijo. `bvsala gateway` a secas sigue
 * igual: ahí el log es el producto.
 */
describe.skipIf(process.platform === "win32")("A2-10 · bvsala <terminal>: nada de bvsala en stdout", () => {
  let caja: Caja;
  let upstream: Server;
  let puertoUpstream = 0;

  beforeAll(async () => {
    exigirBinCompilado();
    upstream = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "msg_falso",
            type: "message",
            role: "assistant",
            model: "claude-haiku-4-5",
            content: [{ type: "text", text: "4" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 1 },
          }),
        );
      });
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    puertoUpstream = (upstream.address() as { port: number }).port;
  });
  afterAll(async () => {
    await new Promise((r) => upstream.close(r));
  });
  afterEach(() => caja?.limpiar());

  it("bvsala claude -p … : el stdout es exactamente la línea del hijo y el cartel va a stderr", () => {
    caja = cajaLimpia();
    caja.terminal("claude", 'process.stdout.write(JSON.stringify({ ok: true }) + "\\n");');
    const r = spawnSync(process.execPath, [BIN, "claude", "-p", "2+2", "--output-format", "json"], {
      env: caja.env(),
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('{"ok":true}\n');
    expect(JSON.parse(r.stdout)).toEqual({ ok: true });
    expect(r.stderr).toMatch(/\[bvsala gateway\] v\S+ listening on http:\/\/127\.0\.0\.1:\d+/);
    expect(r.stderr).toContain("[bvsala gateway] metering:");
  });

  it("bvsala gemini: la nota del terminal también va a stderr", () => {
    caja = cajaLimpia();
    caja.terminal("gemini", 'process.stdout.write("salida del agente\\n");');
    const r = spawnSync(process.execPath, [BIN, "gemini", "-p", "hola"], { env: caja.env(), encoding: "utf8", timeout: 20_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("salida del agente\n");
    expect(r.stderr).toContain("[bvsala gemini] Gemini CLI through the gateway");
  });

  it("con BVSALA_GATEWAY_LOG=1 el log por petición también va a stderr", async () => {
    caja = cajaLimpia();
    caja.terminal(
      "claude",
      [
        "(async () => {",
        "  const r = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', {",
        "    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'clave-falsa' },",
        "    body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 5, messages: [{ role: 'user', content: '2+2' }] }),",
        "  });",
        "  await r.text();",
        "  process.stdout.write(JSON.stringify({ status: r.status }) + '\\n');",
        "})();",
      ].join("\n"),
    );
    const p = lanzar(
      ["claude", "-p", "2+2"],
      caja.env({ BVSALA_GATEWAY_LOG: "1", BVSALA_GATEWAY_UPSTREAM: `http://127.0.0.1:${puertoUpstream}` }),
    );
    try {
      const fin = await p.salida;
      expect(fin.code, p.stderr()).toBe(0);
      expect(p.stdout()).toBe('{"status":200}\n');
      expect(p.stderr()).toMatch(/\[gateway\] POST \/v1\/messages/);
    } finally {
      p.matar();
    }
  });
});
