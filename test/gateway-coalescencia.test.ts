import { createServer, type Server } from "node:http";
import { describe, it, expect, afterEach, vi } from "vitest";

import { parseUsageRecords } from "../apps/web/lib/metering/usage.js";
import { Coalescedor, claveDePeticion, esOperacionCoalescible, MAX_CAPTURA_BYTES } from "../gateway/coalescencia.js";
import { arrancarGateway, type GatewayArrancado } from "../gateway/servidor.js";
import { CATALOGO } from "../src/pricing/catalogo.js";
import { REFERENCE_OUTPUT_SHARE } from "../src/tokenizer/accounting.js";
import { testLicense } from "./helpers/test-license.js";

describe("Coalescedor — unidad", () => {
  it("la clave distingue método, ruta y cuerpo", () => {
    const a = claveDePeticion("POST", "/v1/messages", Buffer.from("x"));
    expect(claveDePeticion("POST", "/v1/messages", Buffer.from("x"))).toBe(a);
    expect(claveDePeticion("POST", "/v1/messages", Buffer.from("y"))).not.toBe(a);
    expect(claveDePeticion("POST", "/v1/otro", Buffer.from("x"))).not.toBe(a);
  });

  it("solo admite inferencia de lectura; escrituras y rutas desconocidas quedan fuera", () => {
    for (const path of ["/v1/messages", "/v1/chat/completions", "/v1/responses", "/v1/embeddings"]) {
      expect(esOperacionCoalescible("POST", path)).toBe(true);
    }
    expect(esOperacionCoalescible("POST", "/openai/deployments/gpt/chat/completions")).toBe(true);
    for (const path of ["/v1/batches", "/v1/files", "/v1/models/delete", "/admin", "/v1/messages/count_tokens"]) {
      expect(esOperacionCoalescible("POST", path)).toBe(false);
    }
    expect(esOperacionCoalescible("GET", "/v1/messages")).toBe(false);
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

  it("Parte G · la huella de la primaria viaja con la réplica (y solo con una réplica válida)", async () => {
    const c = new Coalescedor();
    const huella = {
      requestId: "req-primaria",
      at: 1_800_000_000_000,
      intacta: true,
      proveedorOficial: true,
      conContador: true,
      suscripcion: false,
      fallida: false,
    };
    const cap = c.registrar("k")!;
    const espera = c.esperar("k");
    cap.terminar(200, {}, huella);
    expect((await espera)?.primaria).toEqual(huella);

    const cap2 = c.registrar("k2")!;
    const espera2 = c.esperar("k2");
    cap2.terminar(500, {}, huella);
    expect(await espera2).toBeNull();
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
  ingeridos.length = 0;
  vi.restoreAllMocks();
});

/**
 * Un upstream que retiene su respuesta: `retrasoMs` fijos (solo donde el orden
 * no importa), o hasta que se cumpla `soltarCuando` — una CONDICIÓN, no un
 * reloj: con un plazo fijo, un proceso sin CPU un par de cientos de ms (la suite
 * entera en paralelo) dejaba terminar a la primaria antes de que la gemela
 * llegara, y la «gemela» viajaba sola.
 */
function upstreamLento(contador: { hits: number; cuerpos?: string[] }, retrasoMs: number | (() => boolean)): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer(async (req, res) => {
      const trozos: Buffer[] = [];
      for await (const c of req) trozos.push(c as Buffer);
      contador.cuerpos?.push(Buffer.concat(trozos).toString("utf8"));
      contador.hits += 1;
      if (typeof retrasoMs === "number") await new Promise((r) => setTimeout(r, retrasoMs));
      else await esperar(retrasoMs);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(SSE);
    });
    recursos.push(s);
    s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
  });
}

/**
 * Lo que la verja REAL del ingest de producción (apps/web/lib/metering/usage.ts,
 * la que corre antes de la RPC) deja de cada lote: si un registro «reference» no
 * le parece coherente, lo DEGRADA a estimated en silencio. Estos tests miran lo
 * que el gateway manda Y lo que el servidor se quedaría.
 */
const ingeridos: Record<string, unknown>[] = [];

function ingestaFalsa(lotes: unknown[][], features: string[] = []): Promise<number> {
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
        res.end(JSON.stringify({ features }));
        return;
      }
      const lote = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown[];
      lotes.push(lote);
      ingeridos.push(...(parseUsageRecords(structuredClone(lote), "org-test") as unknown as Record<string, unknown>[]));
      res.writeHead(202);
      res.end("{}");
    });
    recursos.push(s);
    s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
  });
}

/**
 * Parte G · la referencia solo se concede contra el origen OFICIAL del
 * proveedor. Estos tests arrancan el gateway con `upstream:
 * "https://api.anthropic.com"` y este `fetchImpl` lleva ESE origen al mock
 * local; todo lo demás (la ingesta, el canal de entitlements) sale por el fetch
 * de siempre. Nada sale a Internet.
 */
function haciaElMock(puerto: number): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (u.origin === OFICIAL) return fetch(`http://127.0.0.1:${puerto}${u.pathname}${u.search}`, init);
    return fetch(input, init);
  }) as typeof fetch;
}
const OFICIAL = "https://api.anthropic.com";

/**
 * Cuántas gemelas esperan ya en el coalescedor del gateway (espía sobre
 * `Coalescedor.prototype.esperar`, que sigue haciendo lo suyo). Es la condición
 * que ordena los casos de coalescencia: la primaria no se suelta hasta que la
 * gemela ya la espera.
 */
function gemelasEnEspera(): () => number {
  const espia = vi.spyOn(Coalescedor.prototype, "esperar");
  return () => espia.mock.calls.length;
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
    const gemelas = gemelasEnEspera();
    const upstream = await upstreamLento(contador, () => gemelas() === 1);
    const ingesta = await ingestaFalsa(lotes);
    const gw = await arrancarGateway({
      license: testLicense(),
      puerto: 0 as never,
      upstream: OFICIAL,
      fetchImpl: haciaElMock(upstream),
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
    // La segunda sale cuando la primera ya está en vuelo (el upstream la ha
    // visto, así que ya está registrada), y el upstream no contesta hasta que
    // la segunda ya espera como gemela.
    const p1 = pedir();
    await esperar(() => contador.hits === 1);
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
    // Parte G · la primaria viajó intacta (sin palancas: la licencia de prueba
    // no trae features) y claude-haiku-4-5 tiene precio de lectura en SU fila:
    // la gemela se valora con el contador de la primaria, al SUELO. Toda la
    // entrada (100) a lectura de caché, y la salida (42) a 0 porque el cuerpo
    // no fija temperature 0.
    expect(evitada["basis"]).toBe("reference");
    expect(evitada["baselineInputTokens"]).toBe(100);
    expect(evitada["baselineOutputTokens"]).toBe(0);
    expect(evitada["baselineCost"]).toBeCloseTo((100 / 1000) * CATALOGO["claude-haiku-4-5"]!.cachedInputPer1k!, 12);
    // Menos de lo que costó la primaria: el suelo, nunca la cifra halagüeña.
    expect(evitada["baselineCost"] as number).toBeLessThan(medida["actualCost"] as number);
    expect(evitada["referenceRequestId"]).toBe(medida["requestId"]);
    expect(typeof evitada["referenceAt"]).toBe("number");
    expect(evitada["actualCost"]).toBe(0);
    // netSavings es una PROPORCIÓN [-100,1], no dólares: una coalescencia evita
    // la llamada entera → 1 (100 %). Este test afirmaba antes `== actualCost`
    // (dólares), que era EL bug: con una primaria > $1 el ingest rechazaba el
    // lote entero por `> 1`.
    expect(evitada["netSavings"]).toBe(1);
    // Y la verja REAL del ingest la acepta como referencia coherente (no la
    // degrada), con su puntero a la primaria.
    const ingerida = ingeridos.find((r) => r["requestId"] === evitada["requestId"])!;
    expect(ingerida["basis"]).toBe("reference");
    expect(ingerida["referenceRequestId"]).toBe(medida["requestId"]);
  });

  it("réplica stream:false — la gemela de una respuesta JSON también reporta su ahorro (S0.2)", async () => {
    const contador = { hits: 0 };
    const lotes: unknown[][] = [];
    const respuestaJson = JSON.stringify({
      id: "msg_1",
      usage: { input_tokens: 100, output_tokens: 42 },
    });
    const gemelas = gemelasEnEspera();
    const upstream = await new Promise<number>((resolve) => {
      const s = createServer(async (req, res) => {
        for await (const _ of req) void _;
        contador.hits += 1;
        // La primaria no termina hasta que su gemela ya la espera.
        await esperar(() => gemelas() === 1);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(respuestaJson);
      });
      recursos.push(s);
      s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
    });
    const ingesta = await ingestaFalsa(lotes);
    const gw = await arrancarGateway({
      license: testLicense(),
      puerto: 0 as never,
      upstream: OFICIAL,
      fetchImpl: haciaElMock(upstream),
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
    await esperar(() => contador.hits === 1);
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
    expect(evitada["basis"]).toBe("reference");
    expect(evitada["baselineCost"]).toBeCloseTo((100 / 1000) * CATALOGO["claude-haiku-4-5"]!.cachedInputPer1k!, 12);
    expect(evitada["netSavings"]).toBe(1);
    expect(ingeridos.find((r) => r["requestId"] === evitada["requestId"])!["basis"]).toBe("reference");
  });

  /** Dos idénticas concurrentes por un gateway con coalescencia: los registros y las líneas de log. */
  async function pareja(
    cuerpo: string,
    headers: Record<string, string> = {},
    palancas: { features?: string[]; opciones?: Partial<Parameters<typeof arrancarGateway>[0]>; oficial?: boolean } = {},
  ) {
    const contador = { hits: 0, cuerpos: [] as string[] };
    const lotes: unknown[][] = [];
    const lineas: string[] = [];
    const gemelas = gemelasEnEspera();
    const upstream = await upstreamLento(contador, () => gemelas() === 1);
    const ingesta = await ingestaFalsa(lotes, palancas.features ?? []);
    const gw = await arrancarGateway({
      license: testLicense(),
      puerto: 0 as never,
      // El origen oficial por defecto, para que cada ⛔ pruebe SU motivo; con
      // `oficial: false`, el mock local tal cual.
      ...(palancas.oficial === false
        ? { upstream: `http://127.0.0.1:${upstream}` }
        : { upstream: OFICIAL, fetchImpl: haciaElMock(upstream) }),
      coalescer: true,
      serviceAccountKey: "bvk_test",
      meteringUrl: `http://127.0.0.1:${ingesta}`,
      seatId: "t",
      log: (l) => lineas.push(l),
      ...palancas.opciones,
    });
    recursos.push(gw);
    // El canal de entitlements refresca al arrancar: con features, que asiente.
    if (palancas.features) await new Promise((r) => setTimeout(r, 150));
    const pedir = () =>
      fetch(`http://127.0.0.1:${gw.puerto}/v1/messages`, { method: "POST", body: cuerpo, headers }).then((r) => r.text());
    const p1 = pedir();
    await esperar(() => contador.hits === 1);
    const p2 = pedir();
    await Promise.all([p1, p2]);
    expect(contador.hits).toBe(1);
    await gw.cerrar();
    await esperar(() => lotes.flat().length >= 2);
    const regs = lotes.flat() as Record<string, unknown>[];
    return {
      medida: regs.find((r) => r["basis"] === "measured")!,
      evitada: regs.find((r) => r["cacheResult"] === "singleflight")!,
      lineas,
      enviado: contador.cuerpos[0]!,
    };
  }

  it("Parte G · con temperature 0 en el cuerpo la salida también cuenta, al 95 % y redondeada hacia abajo", async () => {
    const cuerpo = JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      temperature: 0,
      messages: [{ role: "user", content: "hola" }],
      stream: true,
    });
    const { evitada, lineas } = await pareja(cuerpo);
    const precio = CATALOGO["claude-haiku-4-5"]!;
    const salida = Math.floor(REFERENCE_OUTPUT_SHARE * 42);
    expect(salida).toBe(39);
    expect(evitada["basis"]).toBe("reference");
    expect(evitada["baselineOutputTokens"]).toBe(salida);
    expect(evitada["baselineCost"]).toBeCloseTo((100 / 1000) * precio.cachedInputPer1k! + (salida / 1000) * precio.outputPer1k, 12);
    expect(ingeridos.find((r) => r["requestId"] === evitada["requestId"])!["basis"]).toBe("reference");
    expect(lineas.join("\n")).toMatch(/COALESCED \(call avoided\).*by reference: floor \$[0-9.]+ \(cache read price, 39 output tok at temperature 0\)/);
  });

  it("⛔ Parte G · con la rebaja de TTL la primaria NO viajó intacta: la gemela sigue estimated", async () => {
    // Lo publicado al cliente (parametrosReferencia, 12 idiomas) dice que la
    // petición que corrió es «byte-identical, untouched by the layer». La
    // rebaja reescribe `cache_control.ttl`: cambia bytes aunque no cambie
    // tokens, así que no hay excepción que valga.
    const cuerpo = JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: [{ role: "user", content: "hola" }],
      stream: true,
    });
    const { evitada, enviado, lineas } = await pareja(cuerpo, {}, { features: ["cache_ttl_tuning"] });
    // La palanca actuó de verdad sobre la primaria…
    expect((JSON.parse(enviado) as { system: { cache_control: { ttl: string } }[] }).system[0]!.cache_control.ttl).toBe("5m");
    // …y por eso la gemela NO se valora por referencia.
    expect(evitada["basis"]).toBe("estimated");
    expect(evitada["referenceRequestId"]).toBeUndefined();
    expect(lineas.join("\n")).toContain("estimated, not by reference: layer-changed-request");
  });

  it("⛔ Parte G · contra un upstream que NO es el origen oficial (un mock, un proxy) la gemela sigue estimated", async () => {
    // Antes de la Parte G esta gemela era estimated y quedaba fuera de la
    // comisión; con un contador que no está en ninguna factura a precio de
    // lista, así sigue.
    const { evitada, lineas } = await pareja(CUERPO, {}, { oficial: false });
    expect(evitada["basis"]).toBe("estimated");
    expect(evitada["referenceRequestId"]).toBeUndefined();
    expect(lineas.join("\n")).toContain("estimated, not by reference: unofficial-upstream");
    expect(ingeridos.find((r) => r["requestId"] === evitada["requestId"])!["basis"]).toBe("estimated");
  });

  it("⛔ Parte G · una gemela cuyo cliente se fue antes de la réplica NO se valora por referencia; la que la recibe, sí", async () => {
    // El caso del watchdog: el cliente abandona la espera y reintenta con el
    // MISMO cuerpo. Sin esta guarda, una sola llamada del proveedor se
    // acreditaba una vez por cada gemela abandonada.
    const contador = { hits: 0 };
    const lotes: unknown[][] = [];
    const lineas: string[] = [];
    const upstream = await upstreamLento(contador, 600);
    const ingesta = await ingestaFalsa(lotes);
    const gw = await arrancarGateway({
      license: testLicense(),
      puerto: 0 as never,
      upstream: OFICIAL,
      fetchImpl: haciaElMock(upstream),
      coalescer: true,
      serviceAccountKey: "bvk_test",
      meteringUrl: `http://127.0.0.1:${ingesta}`,
      seatId: "t",
      log: (l) => lineas.push(l),
    });
    recursos.push(gw);
    const pedir = (abortarTrasMs?: number) => {
      const ac = new AbortController();
      if (abortarTrasMs !== undefined) setTimeout(() => ac.abort(), abortarTrasMs);
      return fetch(`http://127.0.0.1:${gw.puerto}/v1/messages`, { method: "POST", body: CUERPO, signal: ac.signal }).then(
        (r) => r.text().then(() => "ok"),
        () => "se-fue",
      );
    };
    const primaria = pedir();
    await new Promise((r) => setTimeout(r, 50));
    const abandonada = pedir(150); // su cliente se va mientras espera a la primaria
    await new Promise((r) => setTimeout(r, 50));
    const recibida = pedir();
    expect(await Promise.all([primaria, abandonada, recibida])).toEqual(["ok", "se-fue", "ok"]);
    expect(contador.hits).toBe(1);

    await gw.cerrar();
    await esperar(() => lotes.flat().length >= 3);
    const regs = lotes.flat() as Record<string, unknown>[];
    const medida = regs.find((r) => r["basis"] === "measured")!;
    const gemelas = regs.filter((r) => r["cacheResult"] === "singleflight");
    expect(gemelas).toHaveLength(2);
    // Una sola gemela por referencia: la que su cliente recibió.
    const porReferencia = gemelas.filter((r) => r["basis"] === "reference");
    expect(porReferencia).toHaveLength(1);
    expect(porReferencia[0]!["referenceRequestId"]).toBe(medida["requestId"]);
    const abandonadaReg = gemelas.find((r) => r["basis"] !== "reference")!;
    expect(abandonadaReg["basis"]).toBe("estimated");
    expect(abandonadaReg["referenceRequestId"]).toBeUndefined();
    expect(lineas.join("\n")).toContain("estimated, not by reference: client-disconnected");
    // Y tras la verja REAL del ingest, una sola referencia.
    expect(ingeridos.filter((r) => r["basis"] === "reference")).toHaveLength(1);
    // El plazo: con una conexión abortada, `cerrar()` espera unos 4 s a que el
    // servidor HTTP suelte sus sockets (ya pasaba antes de la Parte G). Sin
    // margen, el tope de 5 s de vitest volvería el test intermitente.
  }, 15_000);

  it("⛔ Parte G · con los diales de elisión la primaria NO viajó intacta: la gemela sigue estimated", async () => {
    const cuerpo = JSON.stringify({ model: "claude-haiku-4-5-20251001", messages: [{ role: "user", content: "hola" }], stream: true });
    const { evitada, enviado, lineas } = await pareja(cuerpo, {}, { features: ["context_elision"], opciones: { dialesElision: true } });
    expect(enviado).toContain("context_management");
    expect(evitada["basis"]).toBe("estimated");
    expect(lineas.join("\n")).toContain("estimated, not by reference: layer-changed-request");
  });

  it("⛔ Parte G · el tráfico de SUSCRIPCIÓN jamás se valora por referencia: sin factura por token no hay contador", async () => {
    const { medida, evitada, lineas } = await pareja(CUERPO, { "anthropic-beta": "oauth-2025-04-20" });
    expect(medida["basis"]).toBe("measured");
    expect(evitada["basis"]).toBe("estimated");
    expect(evitada["referenceRequestId"]).toBeUndefined();
    expect(lineas.join("\n")).toContain("estimated, not by reference: subscription");
  });

  it("⛔ Parte G · un modelo sin precio de lectura en SU fila (gpt-4 no lo publica) sigue estimated", async () => {
    const cuerpo = JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "hola" }], stream: true });
    const { evitada, lineas } = await pareja(cuerpo);
    expect(evitada["basis"]).toBe("estimated");
    expect(lineas.join("\n")).toContain("estimated, not by reference: no-cached-price");
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
      license: testLicense(),
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
    const gw = await arrancarGateway({ license: testLicense(), puerto: 0 as never, upstream: `http://127.0.0.1:${upstream}`, coalescer: true, log: () => {} });
    recursos.push(gw);
    const pedir = (body: string) => fetch(`http://127.0.0.1:${gw.puerto}/v1/messages`, { method: "POST", body }).then((r) => r.text());
    const p1 = pedir(CUERPO);
    await new Promise((r) => setTimeout(r, 30));
    const p2 = pedir(CUERPO.replace("hola", "adios"));
    await Promise.all([p1, p2]);
    expect(contador.hits).toBe(2);
  });

  it("dos creaciones idénticas fuera de inferencia ejecutan dos operaciones", async () => {
    const contador = { hits: 0 };
    const upstream = await upstreamLento(contador, 100);
    const gw = await arrancarGateway({ license: testLicense(), puerto: 0 as never, upstream: `http://127.0.0.1:${upstream}`, coalescer: true, log: () => {} });
    recursos.push(gw);
    const pedir = () => fetch(`http://127.0.0.1:${gw.puerto}/v1/batches`, { method: "POST", body: CUERPO }).then((r) => r.text());
    const p1 = pedir();
    await new Promise((r) => setTimeout(r, 30));
    const p2 = pedir();
    await Promise.all([p1, p2]);
    expect(contador.hits).toBe(2);
  });

  it("con la bandera APAGADA (el defecto), dos idénticas → dos viajes", async () => {
    const contador = { hits: 0 };
    const upstream = await upstreamLento(contador, 100);
    const gw = await arrancarGateway({ license: testLicense(), puerto: 0 as never, upstream: `http://127.0.0.1:${upstream}`, log: () => {} });
    recursos.push(gw);
    const pedir = () => fetch(`http://127.0.0.1:${gw.puerto}/v1/messages`, { method: "POST", body: CUERPO }).then((r) => r.text());
    const p1 = pedir();
    await new Promise((r) => setTimeout(r, 30));
    const p2 = pedir();
    await Promise.all([p1, p2]);
    expect(contador.hits).toBe(2);
  });
});
