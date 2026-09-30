import { createServer, request, ServerResponse, type IncomingHttpHeaders, type Server } from "node:http";
import { describe, it, expect, afterEach, vi } from "vitest";

import { Coalescedor } from "../gateway/coalescencia.js";
import { arrancarGateway, type GatewayArrancado } from "../gateway/servidor.js";
import { UsageEmitter } from "../src/metering/emitter.js";
import { testLicense } from "./helpers/test-license.js";

/**
 * Dos hallazgos del gateway que salieron al estabilizar la coalescencia:
 *   1. `cerrar()` vaciaba el emisor SIN esperar la medición de una gemela que ya
 *      había hecho `res.end()` y esperaba su `finish`: si el `finish` llegaba
 *      tras el vaciado, ese registro se perdía.
 *   2. Las cabeceras hop-by-hop del upstream (`connection: keep-alive`…) se
 *      reenvían al cliente, en la primaria y en la réplica.
 * Ningún reloj real decide nada aquí: todo espera a CONDICIONES.
 */

const SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":1}}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":100,"output_tokens":42}}\n\n',
  "event: message_stop\ndata: {}\n\n",
].join("");

const CUERPO = JSON.stringify({ model: "claude-haiku-4-5-20251001", messages: [{ role: "user", content: "hola" }], stream: true });
const OFICIAL = "https://api.anthropic.com";
/** Marca la petición GEMELA del test (no es de identidad: no cambia la clave de coalescencia). */
const MARCA_GEMELA = "x-prueba-gemela";

let recursos: (Server | GatewayArrancado)[] = [];
let restaurarFinish: (() => void) | null = null;
afterEach(async () => {
  restaurarFinish?.();
  restaurarFinish = null;
  for (const r of recursos) {
    if ("cerrar" in r) await r.cerrar();
    else await new Promise((res) => r.close(res));
  }
  recursos = [];
  vi.restoreAllMocks();
});

async function esperar(cond: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Cuántas gemelas esperan ya en el coalescedor (espía que no cambia nada). */
function gemelasEnEspera(): () => number {
  const espia = vi.spyOn(Coalescedor.prototype, "esperar");
  return () => espia.mock.calls.length;
}

/** El upstream: no contesta hasta que `soltar()` se cumple (una condición, no un reloj). */
function upstream(
  contador: { hits: number },
  soltar: () => boolean,
  cabeceras: Record<string, string> = { "content-type": "text/event-stream" },
): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer(async (req, res) => {
      for await (const _ of req) void _;
      contador.hits += 1;
      await esperar(soltar);
      res.writeHead(200, cabeceras);
      res.end(SSE);
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
      if (req.method === "GET" && (req.url ?? "").startsWith("/api/org/entitlements")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ features: [] }));
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

function haciaElMock(puerto: number): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (u.origin === OFICIAL) return fetch(`http://127.0.0.1:${puerto}${u.pathname}${u.search}`, init);
    return fetch(input, init);
  }) as typeof fetch;
}

/**
 * RETIENE el `finish` (y el `close`) de la respuesta del gateway a la gemela
 * marcada hasta que el test la suelte: es el cliente lento cuyo último byte aún
 * no se ha entregado. `writableFinished` dice false mientras tanto, como diría
 * con un socket aún ocupado. Devuelve cuántos eventos hay retenidos y cómo
 * soltarlos (se re-emiten en su orden).
 */
function retenerFinishDeLaGemela(): { retenidos: () => number; soltar: () => void } {
  const proto = ServerResponse.prototype as unknown as {
    emit: (this: ServerResponse, ev: string | symbol, ...args: unknown[]) => boolean;
  };
  const emitOriginal = proto.emit;
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ServerResponse.prototype), "writableFinished")!;
  const cola: { res: ServerResponse; ev: string; args: unknown[] }[] = [];
  let reteniendo = true;
  const esGemela = (res: ServerResponse): boolean => res.req?.headers[MARCA_GEMELA] !== undefined;

  proto.emit = function (this: ServerResponse, ev: string | symbol, ...args: unknown[]): boolean {
    if (reteniendo && (ev === "finish" || ev === "close") && esGemela(this)) {
      cola.push({ res: this, ev, args });
      return true;
    }
    return emitOriginal.call(this, ev, ...args);
  };
  Object.defineProperty(ServerResponse.prototype, "writableFinished", {
    configurable: true,
    get(this: ServerResponse) {
      if (reteniendo && esGemela(this)) return false;
      return descriptor.get!.call(this);
    },
  });

  const restaurar = (): void => {
    proto.emit = emitOriginal;
    delete (ServerResponse.prototype as unknown as Record<string, unknown>)["writableFinished"];
  };
  const soltar = (): void => {
    if (!reteniendo) return;
    reteniendo = false;
    restaurar();
    for (const { res, ev, args } of cola.splice(0)) res.emit(ev, ...args);
  };
  restaurarFinish = soltar;
  return { retenidos: () => cola.length, soltar };
}

/** Primaria + gemela coalescida por un gateway con emisor, con el `finish` de la gemela retenido. */
async function gemelaConFinishRetenido(opciones: Partial<Parameters<typeof arrancarGateway>[0]> = {}) {
  const contador = { hits: 0 };
  const lotes: unknown[][] = [];
  const lineas: string[] = [];
  const avisos: string[] = [];
  const gemelas = gemelasEnEspera();
  const up = await upstream(contador, () => gemelas() === 1);
  const ingesta = await ingestaFalsa(lotes);
  const gw = await arrancarGateway({
    license: testLicense(),
    puerto: 0 as never,
    upstream: OFICIAL,
    fetchImpl: haciaElMock(up),
    coalescer: true,
    serviceAccountKey: "bvk_test",
    meteringUrl: `http://127.0.0.1:${ingesta}`,
    seatId: "t",
    log: (l) => lineas.push(l),
    warn: (l) => avisos.push(l),
    ...opciones,
  });
  recursos.push(gw);
  const reten = retenerFinishDeLaGemela();

  const pedir = (h: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${gw.puerto}/v1/messages`, { method: "POST", body: CUERPO, headers: h }).then((r) => r.text());
  const p1 = pedir();
  await esperar(() => contador.hits === 1);
  const p2 = pedir({ [MARCA_GEMELA]: "1" });
  const [r1, r2] = await Promise.all([p1, p2]);
  expect(contador.hits).toBe(1);
  expect(r1).toBe(SSE);
  // El cliente de la gemela YA tiene la réplica entera; solo falta su `finish`.
  expect(r2).toBe(SSE);
  await esperar(() => reten.retenidos() >= 1);
  return { gw, lotes, lineas, avisos, reten };
}

describe("gw.cerrar() y las mediciones en vuelo", () => {
  it("espera la medición de una gemela cuyo `finish` llega DESPUÉS de empezar a cerrar", async () => {
    const drenado = { hecho: false };
    const original = UsageEmitter.prototype.stopAndDrain;
    vi.spyOn(UsageEmitter.prototype, "stopAndDrain").mockImplementation(async function (this: UsageEmitter, ...a) {
      await original.apply(this, a);
      drenado.hecho = true;
    });
    const { gw, lotes, lineas, reten } = await gemelaConFinishRetenido();

    const cierre = gw.cerrar();
    // El `finish` se suelta cuando el cierre ya está en marcha: o esperando a
    // las mediciones en vuelo (lo correcto) o con el emisor ya vaciado (el bug:
    // el registro de la gemela llega a un emisor parado y no sale nunca).
    await esperar(() => drenado.hecho || lineas.some((l) => l.includes("in-flight measurement")));
    reten.soltar();
    await cierre;
    recursos = recursos.filter((r) => r !== gw);

    const regs = lotes.flat() as Record<string, unknown>[];
    expect(regs.filter((r) => r["basis"] === "measured")).toHaveLength(1);
    // La gemela llegó a la ingesta: el informe cuadra con el uso.
    expect(regs.filter((r) => r["cacheResult"] === "singleflight")).toHaveLength(1);
  });

  it("con tope: si el `finish` no llega, el cierre avisa y termina (nunca se cuelga)", async () => {
    const { gw, avisos, reten } = await gemelaConFinishRetenido({ topeMedicionesAlCerrarMs: 10 });

    const cierre = gw.cerrar();
    await esperar(() => avisos.some((l) => l.includes("still in flight")));
    // `server.close()` espera a la conexión de la gemela, que Node solo libera
    // en su `finish`: se suelta ahora para que el cierre pueda terminar.
    reten.soltar();
    await cierre;
    recursos = recursos.filter((r) => r !== gw);
    expect(avisos.find((l) => l.includes("still in flight"))).toMatch(/1 measurement\(s\) still in flight after 10 ms/);
  });
});

/** Una petición con `Connection: close` y sus cabeceras de respuesta crudas. */
function pedirConClose(puerto: number, extra: Record<string, string> = {}): Promise<{ headers: IncomingHttpHeaders; texto: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: puerto, path: "/v1/messages", method: "POST", agent: false, headers: { connection: "close", ...extra } },
      (res) => {
        const trozos: Buffer[] = [];
        res.on("data", (c: Buffer) => trozos.push(c));
        res.on("end", () => resolve({ headers: res.headers, texto: Buffer.concat(trozos).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(CUERPO);
  });
}

describe("cabeceras hop-by-hop del upstream (RFC 9110 §7.6.1)", () => {
  it("no se reenvían al cliente ni en la primaria ni en la réplica de su gemela", async () => {
    const contador = { hits: 0 };
    const gemelas = gemelasEnEspera();
    const up = await upstream(contador, () => gemelas() === 1, {
      "content-type": "text/event-stream",
      connection: "keep-alive, x-salto-privado",
      "keep-alive": "timeout=5",
      "x-salto-privado": "1",
      "proxy-authenticate": "Basic",
      "x-de-extremo": "si",
    });
    const gw = await arrancarGateway({
      license: testLicense(),
      puerto: 0 as never,
      upstream: OFICIAL,
      fetchImpl: haciaElMock(up),
      coalescer: true,
      log: () => {},
    });
    recursos.push(gw);

    const p1 = pedirConClose(gw.puerto);
    await esperar(() => contador.hits === 1);
    const p2 = pedirConClose(gw.puerto);
    const [primaria, replica] = await Promise.all([p1, p2]);
    expect(contador.hits).toBe(1);

    for (const r of [primaria, replica]) {
      expect(r.texto).toBe(SSE);
      // El cliente pidió cerrar: la conexión se cierra, no la decide el upstream.
      expect(r.headers["connection"]).toBe("close");
      expect(r.headers["keep-alive"]).toBeUndefined();
      expect(r.headers["proxy-authenticate"]).toBeUndefined();
      // La que el upstream nombró en su `connection` es de su salto, tampoco viaja.
      expect(r.headers["x-salto-privado"]).toBeUndefined();
      // Las de extremo a extremo, sí.
      expect(r.headers["x-de-extremo"]).toBe("si");
      expect(r.headers["content-type"]).toBe("text/event-stream");
    }
  });
});
