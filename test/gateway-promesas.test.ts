import { createServer, type Server } from "node:http";
import { describe, it, expect, afterEach } from "vitest";

import { claveDePeticion, materialDeCabeceras, CABECERAS_DE_IDENTIDAD } from "../gateway/coalescencia.js";
import { arrancarGateway, type GatewayArrancado } from "../gateway/servidor.js";
import { testLicense } from "./helpers/test-license.js";

/**
 * TANDA 2 — las promesas del gateway, cazadas el 27-08:
 *  A) un corte de stream a media respuesta NO debe tumbar el proceso.
 *  B) el abort del cliente (Esc en Claude Code) DEBE cancelar el upstream.
 *  C) la clave de coalescencia DEBE separar credenciales/versión/betas.
 */

let recursos: (Server | GatewayArrancado)[] = [];
afterEach(async () => {
  for (const r of recursos) {
    if ("cerrar" in r) await r.cerrar();
    else await new Promise((res) => r.close(res));
  }
  recursos = [];
});

// ── C: la clave de coalescencia y las cabeceras de identidad ──────────────
describe("claveDePeticion — separa por cabeceras de identidad", () => {
  const cuerpo = Buffer.from("x");
  const mat = (h: Record<string, string>) => materialDeCabeceras((n) => h[n]);

  it("misma credencial → misma clave", () => {
    const a = claveDePeticion("POST", "/v1/messages", cuerpo, mat({ authorization: "Bearer AAA" }));
    const b = claveDePeticion("POST", "/v1/messages", cuerpo, mat({ authorization: "Bearer AAA" }));
    expect(a).toBe(b);
  });

  it("⛔ distinta credencial → CLAVE DISTINTA (nunca servir la respuesta de otra)", () => {
    const a = claveDePeticion("POST", "/v1/messages", cuerpo, mat({ authorization: "Bearer AAA" }));
    const b = claveDePeticion("POST", "/v1/messages", cuerpo, mat({ authorization: "Bearer BBB" }));
    expect(a).not.toBe(b);
  });

  it("⛔ distinta x-api-key / anthropic-version / anthropic-beta / api-key (Azure) / openai-organization / openai-project → claves distintas", () => {
    expect(CABECERAS_DE_IDENTIDAD).toEqual(expect.arrayContaining(["api-key", "openai-organization", "openai-project"]));
    const base = claveDePeticion("POST", "/v1/messages", cuerpo, mat({}));
    for (const h of CABECERAS_DE_IDENTIDAD) {
      expect(claveDePeticion("POST", "/v1/messages", cuerpo, mat({ [h]: "otra" }))).not.toBe(base);
    }
  });
});

// ── A: un corte de stream no tumba el proceso ─────────────────────────────
describe("resiliencia del gateway", () => {
  /** Un upstream que manda cabeceras + un trozo y luego CORTA el socket a lo bruto. */
  function upstreamQueCorta(): Promise<number> {
    return new Promise((resolve) => {
      const s = createServer((req, res) => {
        void (async () => {
          for await (const _ of req) void _;
        })();
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("event: message_start\ndata: {}\n\n");
        // Cortar la conexión a mitad del stream (reset), sin end().
        setTimeout(() => res.socket?.destroy(), 30);
      });
      recursos.push(s);
      s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
    });
  }

  it("⛔ un reset del upstream a media respuesta NO tumba el gateway: sigue sirviendo", async () => {
    const up = await upstreamQueCorta();
    const gw = await arrancarGateway({
      license: testLicense(),
      puerto: 0 as never,
      upstream: `http://127.0.0.1:${up}`,
      coalescer: true, // con coalescencia, un cuelgue de clave sería el agravante
      log: () => {},
    });
    recursos.push(gw);
    const body = JSON.stringify({ model: "claude-haiku-4-5-20251001", messages: [], stream: true });

    // La primera revienta a mitad; el proceso debe seguir vivo.
    await fetch(`http://127.0.0.1:${gw.puerto}/v1/messages`, { method: "POST", body }).then(
      (r) => r.text().catch(() => ""),
      () => "",
    );

    // Si el gateway hubiera muerto, esta segunda ni conectaría. Debe responder.
    const segunda = await fetch(`http://127.0.0.1:${gw.puerto}/v1/messages`, { method: "POST", body }).then(
      (r) => r.status,
      () => 0,
    );
    expect(segunda).toBeGreaterThan(0); // el gateway sigue en pie
  });

  // ── B: el abort del cliente cancela el upstream ─────────────────────────
  it("⛔ si el cliente aborta, el upstream se cancela (no se sigue generando y facturando)", async () => {
    let upstreamAbortado = false;
    let upstreamArrancado = false;
    const up = await new Promise<number>((resolve) => {
      const s = createServer(async (req, res) => {
        upstreamArrancado = true;
        req.on("aborted", () => (upstreamAbortado = true));
        res.on("close", () => {
          if (!res.writableEnded) upstreamAbortado = true;
        });
        for await (const _ of req) void _;
        // Responde MUY lento: da tiempo a que el cliente aborte antes.
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("event: message_start\ndata: {}\n\n");
        setTimeout(() => res.end("event: message_stop\ndata: {}\n\n"), 2000);
      });
      recursos.push(s);
      s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
    });
    const gw = await arrancarGateway({ license: testLicense(), puerto: 0 as never, upstream: `http://127.0.0.1:${up}`, log: () => {} });
    recursos.push(gw);

    const ac = new AbortController();
    const body = JSON.stringify({ model: "claude-haiku-4-5-20251001", messages: [], stream: true });
    const pet = fetch(`http://127.0.0.1:${gw.puerto}/v1/messages`, { method: "POST", body, signal: ac.signal }).catch(
      () => undefined,
    );
    // Esperar a que el upstream esté generando, y entonces abortar como el cliente.
    await new Promise((r) => setTimeout(r, 200));
    ac.abort();
    await pet;
    // El upstream debe haberse enterado de que la conexión del gateway se cayó.
    await new Promise((r) => setTimeout(r, 200));
    expect(upstreamArrancado).toBe(true);
    expect(upstreamAbortado).toBe(true);
  });
});
