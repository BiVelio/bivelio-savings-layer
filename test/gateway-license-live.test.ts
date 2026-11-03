import { createServer, type Server } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, it, expect } from "vitest";

import { arrancarGateway, type GatewayArrancado, type OpcionesGateway } from "../gateway/servidor.js";
import {
  TEST_KEYS,
  mutableClock,
  signLicense,
  signRevocationList,
  testLicense,
  testPayload,
} from "./helpers/test-license.js";

/**
 * LA LICENCIA DEL GATEWAY, EN VIVO (LICENSE §2), contra servidores node:http
 * reales en 127.0.0.1: una plataforma falsa (entitlements, licencia, lista de
 * revocaciones, ingesta) y upstreams SSE, uno rápido y uno lento que suelta el
 * resto de la respuesta cuando el test lo dice.
 *
 * La promesa que se fija aquí es la que no se negocia: una petición que pasó la
 * verja TERMINA aunque la licencia caduque mientras está en vuelo; solo las
 * NUEVAS reciben el 402. Y el corte llega por las tres vías — reloj, bloqueo del
 * control plane (por cualquier ruta, con las palancas apagadas o no) y
 * revocación por jti — y se cura solo en cuanto hay una licencia buena.
 */

const DIA = 86_400;

const PRIMER_CHUNK =
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":1}}}\n\n';
const RESTO = [
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"OK"}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":100,"output_tokens":42}}\n\n',
  "event: message_stop\ndata: {}\n\n",
].join("");
const SSE = PRIMER_CHUNK + RESTO;

let recursos: (Server | GatewayArrancado)[] = [];
afterEach(async () => {
  // Los gateways primero: cierran sus conexiones con los upstreams.
  for (const r of recursos.filter((x) => "cerrar" in x)) await (r as GatewayArrancado).cerrar();
  for (const r of recursos.filter((x) => !("cerrar" in x))) await new Promise((res) => (r as Server).close(res));
  recursos = [];
});

function escuchar(s: Server): Promise<number> {
  recursos.push(s);
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port)));
}

interface Recibida {
  path: string;
  headers: Record<string, unknown>;
  body: string;
}

/** Upstream SSE rápido; guarda lo que recibe. */
async function upstreamRapido(recibidas: Recibida[] = []): Promise<number> {
  return escuchar(
    createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      recibidas.push({ path: req.url ?? "", headers: { ...req.headers }, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(SSE);
    }),
  );
}

/** Upstream SSE lento: manda message_start y se queda esperando a `soltar()`. */
async function upstreamLento(): Promise<{ puerto: number; soltar: () => void; recibidas: () => number }> {
  let soltar: () => void = () => {};
  const barrera = new Promise<void>((r) => (soltar = r));
  let n = 0;
  const puerto = await escuchar(
    createServer(async (req, res) => {
      for await (const _ of req) void _;
      n += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(PRIMER_CHUNK);
      await barrera;
      res.end(RESTO);
    }),
  );
  return { puerto, soltar: () => soltar(), recibidas: () => n };
}

interface Plataforma {
  base: string;
  entitlements: { features: string[]; reason?: string; estado?: number };
  current: { estado: number; token?: string };
  revocados: string[];
  lotes: unknown[][];
  rutas: string[];
}

/** La plataforma falsa: entitlements, licencia actual, revocaciones e ingesta. */
async function plataformaFalsa(): Promise<Plataforma> {
  const p: Plataforma = {
    base: "",
    entitlements: { features: [] },
    current: { estado: 404 },
    revocados: [],
    lotes: [],
    rutas: [],
  };
  const puerto = await escuchar(
    createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const ruta = (req.url ?? "").split("?")[0]!;
      p.rutas.push(`${req.method} ${ruta}`);
      const json = (status: number, cuerpo: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(cuerpo));
      };
      if (req.method === "GET" && ruta === "/api/org/entitlements") {
        const e = p.entitlements;
        if (e.estado !== undefined && e.estado !== 200) return json(e.estado, { error: "boom" });
        return json(200, { features: e.features, refreshAfterSeconds: 300, ...(e.reason ? { reason: e.reason } : {}) });
      }
      if (req.method === "GET" && ruta === "/api/license/current") {
        if (req.headers.authorization !== "Bearer bvk_test") return json(401, { error: "unknown key" });
        if (p.current.estado !== 200) return json(p.current.estado, { error: "x" });
        return json(200, { token: p.current.token });
      }
      if (req.method === "GET" && ruta === "/licenses/revocations") {
        const lista = signRevocationList({
          seq: p.revocados.length + 1,
          asOf: Math.floor(Date.now() / 1000),
          revoked: [...p.revocados],
        });
        return json(200, { list: lista });
      }
      if (req.method === "POST" && ruta === "/api/metering/usage") {
        if (chunks.length > 0) p.lotes.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown[]);
        return json(202, { ingested: 0 });
      }
      return json(404, { error: "no such route" });
    }),
  );
  p.base = `http://127.0.0.1:${puerto}`;
  return p;
}

async function gateway(opts: OpcionesGateway): Promise<GatewayArrancado> {
  const g = await arrancarGateway({ puerto: 0, log: () => {}, warn: () => {}, ...opts });
  recursos.push(g);
  return g;
}

function pedir(puerto: number, ruta = "/v1/messages", init: RequestInit = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${puerto}${ruta}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku-4-5", stream: true, messages: [{ role: "user", content: "hola" }] }),
    ...init,
  });
}

async function esperar(cond: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error("timeout esperando la condición");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Un token caducado más allá de la gracia, pero con firma buena. */
function licenciaCaducada(over: Record<string, unknown> = {}) {
  const ahora = Math.floor(Date.now() / 1000);
  return testLicense({ expires_at: ahora - 40 * DIA, grace_days: 14, ...over });
}

describe("L1 · sin licencia hay gateway: modo comunitario (open core)", () => {
  it("sin `license` arranca en modo comunitario; con un token de otra clave, rechaza", async () => {
    const comunitario = await arrancarGateway({ puerto: 0, log: () => {} } as unknown as OpcionesGateway);
    expect(comunitario.puerto).toBeGreaterThan(0);
    await comunitario.cerrar();
    const otra = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    await expect(
      arrancarGateway({
        puerto: 0,
        log: () => {},
        license: { token: signLicense(testPayload(), otra.privateKey), publicKey: TEST_KEYS.publicKey },
      }),
    ).rejects.toThrow("does not verify");
  });
});

describe("la verja por petición", () => {
  it("L2 · caducada desde el inicio: 402 JSON en TODAS las rutas y el upstream no recibe nada", async () => {
    const recibidas: Recibida[] = [];
    const upstream = await upstreamRapido(recibidas);
    const g = await gateway({ upstream: `http://127.0.0.1:${upstream}`, license: licenciaCaducada() });

    const r = await pedir(g.puerto);
    expect(r.status).toBe(402);
    expect(r.headers.get("content-type")).toBe("application/json");
    expect(r.headers.get("x-bvsala-license-status")).toBe("expired");
    expect(r.headers.get("cache-control")).toBe("no-store");
    const json = (await r.json()) as { type: string; error: { type: string; status: string; message: string } };
    expect(json.type).toBe("error");
    expect(json.error.type).toBe("license_error");
    expect(json.error.status).toBe("expired");
    expect(json.error.message).toContain("/dashboard/account");

    const head = await fetch(`http://127.0.0.1:${g.puerto}/api/hello`, { method: "HEAD" });
    expect(head.status).toBe(402);
    expect(await head.text()).toBe("");
    const modelos = await fetch(`http://127.0.0.1:${g.puerto}/v1/models`);
    expect(modelos.status).toBe(402);
    await modelos.text();
    expect(g.licenseStatus()).toBe("expired");
    expect(recibidas).toHaveLength(0);
  });

  it("L3 · ⛔ una petición EN CURSO no se corta aunque la licencia caduque a mitad; la siguiente recibe el 402", async () => {
    const t0 = Date.now();
    const reloj = mutableClock(t0);
    const avisos: string[] = [];
    const lento = await upstreamLento();
    const g = await gateway({
      upstream: `http://127.0.0.1:${lento.puerto}`,
      license: { ...testLicense({ expires_at: Math.floor(t0 / 1000) + 60, grace_days: 0 }, t0), now: reloj.now },
      warn: (l) => avisos.push(l),
    });

    const r = await pedir(g.puerto);
    expect(r.status).toBe(200);
    const lector = r.body!.getReader();
    const decodificador = new TextDecoder();
    let texto = "";
    while (!texto.includes("message_start")) {
      const { value, done } = await lector.read();
      if (done) break;
      texto += decodificador.decode(value, { stream: true });
    }
    expect(texto).toContain("message_start");

    // La licencia caduca (sin gracia) CON la petición en vuelo…
    reloj.advance(120_000);
    lento.soltar();
    for (;;) {
      const { value, done } = await lector.read();
      if (done) break;
      texto += decodificador.decode(value, { stream: true });
    }
    // …y la respuesta llega ÍNTEGRA.
    expect(texto).toBe(SSE);

    const siguiente = await pedir(g.puerto);
    expect(siguiente.status).toBe(402);
    expect(((await siguiente.json()) as { error: { status: string } }).error.status).toBe("expired");
    expect(lento.recibidas()).toBe(1);
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toContain("license expired");
    expect(avisos[0]).toContain("requests in flight are not touched");
  });

  it("L4 · tres peticiones cortadas seguidas: UNA línea de aviso", async () => {
    const avisos: string[] = [];
    const upstream = await upstreamRapido();
    const g = await gateway({
      upstream: `http://127.0.0.1:${upstream}`,
      license: licenciaCaducada(),
      warn: (l) => avisos.push(l),
    });
    for (let i = 0; i < 3; i++) expect((await pedir(g.puerto)).status).toBe(402);
    expect(avisos).toHaveLength(1);
  });

  it("L5 · de activa a gracia por el reloj: se sirve, y UNA línea «in grace»", async () => {
    const t0 = Date.now();
    const reloj = mutableClock(t0);
    const avisos: string[] = [];
    const upstream = await upstreamRapido();
    const g = await gateway({
      upstream: `http://127.0.0.1:${upstream}`,
      license: { ...testLicense({ expires_at: Math.floor(t0 / 1000) + 60, grace_days: 14 }, t0), now: reloj.now },
      warn: (l) => avisos.push(l),
    });
    expect((await pedir(g.puerto)).status).toBe(200);
    expect(avisos).toHaveLength(0);
    reloj.advance(120_000);
    const r = await pedir(g.puerto);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(SSE);
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toContain("in grace");
    expect((await pedir(g.puerto)).status).toBe(200);
    expect(avisos).toHaveLength(1);
    expect(g.licenseStatus()).toBe("grace");
  });
});

describe("la renovación y la revocación", () => {
  it("L6 · la renovación CURA: caducada al arrancar, el 402 fuerza la recogida y la siguiente se sirve", async () => {
    const plataforma = await plataformaFalsa();
    plataforma.current = { estado: 200, token: signLicense(testPayload()) };
    const avisos: string[] = [];
    const upstream = await upstreamRapido();
    const g = await gateway({
      upstream: `http://127.0.0.1:${upstream}`,
      serviceAccountKey: "bvk_test",
      meteringUrl: `${plataforma.base}/api/metering/usage`,
      license: { ...licenciaCaducada(), licenseServerUrl: plataforma.base },
      warn: (l) => avisos.push(l),
    });
    expect((await pedir(g.puerto)).status).toBe(402);
    await esperar(() => g.licenseStatus() === "active");
    const r = await pedir(g.puerto);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(SSE);
    expect(avisos.some((l) => l.includes("license active again"))).toBe(true);
    expect(plataforma.rutas).toContain("GET /api/license/current");
  });

  it("L10 · revocación por jti: tras el sondeo, 402 revoked y la línea lo dice", async () => {
    const plataforma = await plataformaFalsa();
    const licencia = testLicense();
    const jti = (JSON.parse(Buffer.from(licencia.token.split(".")[1]!, "base64url").toString("utf8")) as { jti: string }).jti;
    plataforma.revocados = [jti];
    plataforma.current = { estado: 404 };
    const avisos: string[] = [];
    const upstream = await upstreamRapido();
    const g = await gateway({
      upstream: `http://127.0.0.1:${upstream}`,
      serviceAccountKey: "bvk_test",
      meteringUrl: `${plataforma.base}/api/metering/usage`,
      license: {
        ...licencia,
        licenseServerUrl: plataforma.base,
        revocations: { floorSeconds: 0.05, pollIntervalSeconds: 0.05, jitterRatio: 0 },
      },
      warn: (l) => avisos.push(l),
    });
    await esperar(() => plataforma.rutas.includes("GET /licenses/revocations") && g.licenseStatus() === "revoked");
    const r = await pedir(g.puerto);
    expect(r.status).toBe(402);
    expect(r.headers.get("x-bvsala-license-status")).toBe("revoked");
    await r.text();
    expect(avisos.some((l) => l.includes("license revoked"))).toBe(true);
    // La recogida forzada no encuentra licencia (404): se avisa, una vez.
    await esperar(() => avisos.some((l) => l.includes("no active license")));
  });

  it("L10b · revocada, pero la plataforma sirve una reemitida de la misma org: se cura sola", async () => {
    const plataforma = await plataformaFalsa();
    const licencia = testLicense();
    const jti = (JSON.parse(Buffer.from(licencia.token.split(".")[1]!, "base64url").toString("utf8")) as { jti: string }).jti;
    plataforma.revocados = [jti];
    plataforma.current = { estado: 200, token: signLicense(testPayload()) };
    const upstream = await upstreamRapido();
    const g = await gateway({
      upstream: `http://127.0.0.1:${upstream}`,
      serviceAccountKey: "bvk_test",
      meteringUrl: `${plataforma.base}/api/metering/usage`,
      license: {
        ...licencia,
        licenseServerUrl: plataforma.base,
        revocations: { floorSeconds: 0.05, pollIntervalSeconds: 0.05, jitterRatio: 0 },
      },
    });
    await esperar(async () => {
      const r = await pedir(g.puerto);
      await r.text();
      return r.status === 402;
    });
    await esperar(async () => {
      const r = await pedir(g.puerto);
      await r.text();
      return r.status === 200;
    });
    expect(g.licenseStatus()).toBe("active");
  });

  it("L11 · sin licenseServerUrl: CERO llamadas de licencia (ni recogida ni revocaciones)", async () => {
    const plataforma = await plataformaFalsa();
    const urls: string[] = [];
    const espia = (async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(String(input instanceof Request ? input.url : input));
      return fetch(input, init);
    }) as typeof fetch;
    const upstream = await upstreamRapido();
    const g = await gateway({
      upstream: `http://127.0.0.1:${upstream}`,
      serviceAccountKey: "bvk_test",
      meteringUrl: `${plataforma.base}/api/metering/usage`,
      license: testLicense(),
      fetchImpl: espia,
    });
    expect((await pedir(g.puerto)).status).toBe(200);
    await dormir(100);
    expect(urls.some((u) => u.includes("/api/license/current"))).toBe(false);
    expect(urls.some((u) => u.includes("/licenses/revocations"))).toBe(false);
    // El canal SÍ existe (hay clave): se consulta sobre el origen de la ingesta.
    expect(urls.some((u) => u.includes("/api/org/entitlements"))).toBe(true);
  });
});

describe("el bloqueo del control plane (canal de entitlements)", () => {
  async function conCanal(extra: Partial<OpcionesGateway> = {}) {
    const plataforma = await plataformaFalsa();
    const recibidas: Recibida[] = [];
    const upstream = await upstreamRapido(recibidas);
    const lineas: string[] = [];
    const g = await gateway({
      upstream: `http://127.0.0.1:${upstream}`,
      serviceAccountKey: "bvk_test",
      meteringUrl: `${plataforma.base}/api/metering/usage`,
      entitlementsTtlMs: 50,
      license: testLicense(),
      log: (l) => lineas.push(l),
      ...extra,
    });
    // El refresco del arranque tiene que ASENTAR sin bloqueo antes de que el test
    // lo ponga: si no, ese primer refresco lo recogería solo y el test no probaría
    // que las peticiones (de cualquier ruta) disparan el refresco por TTL.
    await esperar(() => plataforma.rutas.includes("GET /api/org/entitlements"));
    await dormir(30);
    return { plataforma, g, recibidas, lineas };
  }
  const estadoDe = async (r: Promise<Response>) => {
    const res = await r;
    await res.text();
    return res.status;
  };

  it("L7 · el `reason` es PEGAJOSO: corta, sigue cortando con la plataforma caída y solo lo quita otro 200", async () => {
    const { plataforma, g } = await conCanal();
    plataforma.entitlements = { features: [], reason: "license-revoked" };
    await esperar(async () => (await estadoDe(pedir(g.puerto))) === 402);
    expect(g.licenseStatus()).toBe("revoked");
    plataforma.entitlements = { features: [], estado: 500 };
    for (let i = 0; i < 4; i++) {
      await dormir(60);
      expect(await estadoDe(pedir(g.puerto))).toBe(402);
    }
    plataforma.entitlements = { features: [] };
    await esperar(async () => (await estadoDe(pedir(g.puerto))) === 200);
  });

  it("L8 · ⛔ el corte llega por CUALQUIER ruta: solo /v1/responses, ninguna a /v1/messages", async () => {
    const { plataforma, g, recibidas } = await conCanal();
    plataforma.entitlements = { features: [], reason: "license-revoked" };
    await esperar(async () => (await estadoDe(pedir(g.puerto, "/v1/responses"))) === 402);
    expect(recibidas.some((r) => r.path.startsWith("/v1/messages"))).toBe(false);
  });

  it("L9 · ⛔ BVSALA_GATEWAY_ELISION=0 desarma las palancas, NO el canal: el bloqueo sigue cortando", async () => {
    const { plataforma, g, recibidas } = await conCanal({ elision: false });
    plataforma.entitlements = { features: ["cache_ttl_tuning"], reason: "license-expired" };
    await esperar(async () => (await estadoDe(pedir(g.puerto))) === 402);
    expect(g.licenseStatus()).toBe("expired");
    // Sin bloqueo y con el feature: el cuerpo con 1h viaja INTACTO (palancas desarmadas).
    plataforma.entitlements = { features: ["cache_ttl_tuning"] };
    const cuerpo = JSON.stringify({
      model: "claude-fable-5-1",
      messages: [{ role: "user", content: "hola" }],
      system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral", ttl: "1h" } }],
    });
    await esperar(async () => (await estadoDe(pedir(g.puerto, "/v1/messages", { body: cuerpo }))) === 200);
    expect(recibidas.at(-1)!.body).toBe(cuerpo);
  });

  it("L12 · canal con 401 (clave borrada con el proceso vivo): una línea con el arreglo y se sigue sirviendo", async () => {
    const { plataforma, g, lineas } = await conCanal();
    plataforma.entitlements = { features: [], estado: 401 };
    for (let i = 0; i < 4; i++) {
      await dormir(60);
      expect(await estadoDe(pedir(g.puerto))).toBe(200);
    }
    expect(lineas.filter((l) => l.includes("no longer recognised"))).toHaveLength(1);
    expect(g.licenseStatus()).toBe("active");
  });

  it("L13 · reason no-license → 402 no-license, con el texto que manda a suscribirse", async () => {
    const { plataforma, g } = await conCanal();
    plataforma.entitlements = { features: [], reason: "no-license" };
    let cuerpo: { error: { status: string; message: string } } | null = null;
    await esperar(async () => {
      const r = await pedir(g.puerto);
      if (r.status !== 402) {
        await r.text();
        return false;
      }
      cuerpo = (await r.json()) as { error: { status: string; message: string } };
      return true;
    });
    expect(cuerpo!.error.status).toBe("no-license");
    expect(cuerpo!.error.message).toContain("no active BiVelio license");
    expect(cuerpo!.error.message).toContain("/dashboard/account");
  });
});
