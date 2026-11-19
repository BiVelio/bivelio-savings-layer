import { request as peticionHttp, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { arrancarGateway, type GatewayArrancado } from "../gateway/servidor.js";
import { urlHaciaElUpstream } from "../gateway/upstream.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";

/**
 * EL HOST DEL UPSTREAM ES FIJO — la ruta del cliente nunca lo cambia.
 *
 * `new URL(req.url, upstreamBase)` trataba `//otro-host/ruta` como URL relativa
 * al esquema: la petición salía, con la x-api-key del cliente, hacia
 * `otro-host`. Y el caso cotidiano: un base URL acabado en barra
 * (`http://127.0.0.1:8402/`) en un cliente que concatena produce
 * `//v1/messages`, que acababa en un 502 «getaddrinfo ENOTFOUND v1».
 *
 * Los hosts de ejemplo son inventados (`*.ejemplo.invalid`); nada sale de
 * 127.0.0.1: el `fetchImpl` del gateway es un falso que apunta lo que le piden.
 */

describe("urlHaciaElUpstream — pura", () => {
  const base = "https://api.anthropic.com";
  it("una ruta normal se resuelve contra el upstream, con su query", () => {
    expect(urlHaciaElUpstream("/v1/messages?beta=true", base)!.href).toBe("https://api.anthropic.com/v1/messages?beta=true");
    expect(urlHaciaElUpstream(undefined, base)!.href).toBe("https://api.anthropic.com/");
  });

  it("⛔ `//host/ruta` NO cambia el host: las barras iniciales se colapsan", () => {
    expect(urlHaciaElUpstream("//otro-host.ejemplo.invalid/v1/messages", base)!.href).toBe(
      "https://api.anthropic.com/otro-host.ejemplo.invalid/v1/messages",
    );
    expect(urlHaciaElUpstream("///otro-host.ejemplo.invalid/x", base)!.host).toBe("api.anthropic.com");
  });

  it("⛔ un base URL acabado en barra en el cliente (`//v1/messages`) llega a /v1/messages", () => {
    expect(urlHaciaElUpstream("//v1/messages", base)!.href).toBe("https://api.anthropic.com/v1/messages");
    expect(urlHaciaElUpstream("//v1/chat/completions?x=1", "https://api.openai.com")!.href).toBe("https://api.openai.com/v1/chat/completions?x=1");
  });

  it("⛔ la contrabarra (que WHATWG trata como barra) tampoco cuela un host", () => {
    for (const ruta of ["/\\otro-host.ejemplo.invalid/x", "\\\\otro-host.ejemplo.invalid/x", "/\\/otro-host.ejemplo.invalid/x"]) {
      const u = urlHaciaElUpstream(ruta, base);
      expect(u === null || u.origin === "https://api.anthropic.com", ruta).toBe(true);
    }
  });

  it("⛔ la forma absoluta (autoridad embebida) se reduce a su ruta: la autoridad se ignora", () => {
    expect(urlHaciaElUpstream("http://otro-host.ejemplo.invalid/v1/messages?a=1", base)!.href).toBe("https://api.anthropic.com/v1/messages?a=1");
    expect(urlHaciaElUpstream("https://usuario:secreto@otro-host.ejemplo.invalid//v1/messages", base)!.href).toBe(
      "https://api.anthropic.com/v1/messages",
    );
  });

  it("lo que no es una ruta no se reenvía (null → 400)", () => {
    expect(urlHaciaElUpstream("*", base)).toBeNull();
    expect(urlHaciaElUpstream("otro-host.ejemplo.invalid:443", base)).toBeNull();
    expect(urlHaciaElUpstream("ftp://otro-host.ejemplo.invalid/x", base)).toBeNull();
  });

  it("un upstream escrito con barra final también vale", () => {
    expect(urlHaciaElUpstream("/v1/messages", "http://127.0.0.1:9000/")!.href).toBe("http://127.0.0.1:9000/v1/messages");
  });
});

// ── De punta a punta ───────────────────────────────────────────────────────

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

const UPSTREAM = "http://upstream.ejemplo.invalid:8080";

async function montar(upstream = UPSTREAM) {
  const llamadas: { url: string; apiKey: string | null }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    llamadas.push({ url, apiKey: new Headers(init?.headers).get("x-api-key") });
    return new Response(JSON.stringify({ id: "msg_inventado", type: "message", model: "claude-sonnet-4-6", usage: { input_tokens: 3, output_tokens: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const gw = await arrancarGateway({ puerto: 0, upstream, fetchImpl, log: () => {} });
  recursos.push(gw);
  return { gw, llamadas };
}

/** node:http manda la ruta TAL CUAL (fetch la normalizaría): es lo que hace `curl --path-as-is`. */
function pedirCrudo(puerto: number, ruta: string): Promise<{ status: number; cuerpo: string }> {
  return new Promise((resolve, reject) => {
    const req = peticionHttp(
      { host: "127.0.0.1", port: puerto, path: ruta, method: "POST", headers: { "content-type": "application/json", "x-api-key": "clave-inventada-de-prueba" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, cuerpo: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 5, messages: [] }));
  });
}

describe("el gateway nunca reenvía a un host que no sea su upstream", () => {
  it("⛔ `//otro-host/…`, `/\\otro-host/…` y la forma absoluta: ninguna llamada sale con otro origen, y la clave no viaja a otro host", async () => {
    const { gw, llamadas } = await montar();
    const rutas = [
      "//otro-host.ejemplo.invalid/v1/messages",
      "//otro-host.ejemplo.invalid:9916/robado",
      "/\\otro-host.ejemplo.invalid/v1/messages",
      "http://otro-host.ejemplo.invalid/v1/messages",
      "///otro-host.ejemplo.invalid/v1/messages",
    ];
    for (const ruta of rutas) {
      const r = await pedirCrudo(gw.puerto, ruta);
      expect([200, 400], ruta).toContain(r.status);
    }
    expect(llamadas.length).toBeGreaterThan(0);
    for (const l of llamadas) expect(new URL(l.url).origin, l.url).toBe(UPSTREAM);
  });

  it("⛔ `//v1/messages` (cliente con base URL acabado en barra) llega a <upstream>/v1/messages y responde 200 (antes: 502 ENOTFOUND v1)", async () => {
    const { gw, llamadas } = await montar();
    const r = await pedirCrudo(gw.puerto, "//v1/messages");
    expect(r.status).toBe(200);
    expect(llamadas).toEqual([{ url: `${UPSTREAM}/v1/messages`, apiKey: "clave-inventada-de-prueba" }]);
    // Y se mide como la ruta que es.
    expect(gw.medicion().medidas).toBe(1);
  });

  it("un upstream configurado con barra final funciona igual", async () => {
    const { gw, llamadas } = await montar(`${UPSTREAM}/`);
    const r = await pedirCrudo(gw.puerto, "/v1/messages");
    expect(r.status).toBe(200);
    expect(llamadas[0]!.url).toBe(`${UPSTREAM}/v1/messages`);
  });

  it("un destino que no es una ruta → 400 sin reenviar nada", async () => {
    const { gw, llamadas } = await montar();
    const r = await pedirCrudo(gw.puerto, "ftp://otro-host.ejemplo.invalid/v1/messages");
    expect(r.status).toBe(400);
    expect(r.cuerpo).toContain("not a path");
    expect(llamadas).toEqual([]);
  });
});
