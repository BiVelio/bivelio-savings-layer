import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { arrancarGateway, type GatewayArrancado } from "../gateway/servidor.js";
import { parseUsageRecords } from "../packages/protocol/src/index.js";
import { oficialHaciaElMock } from "./helpers/gateway-oficial.js";
import { testLicense } from "./helpers/test-license.js";

/**
 * LA LICENCIA MEDIR EN LA PASARELA (`bvsala`), de punta a punta y sin red.
 *
 * Con TODO armado —el canal concede todas las features, el operador puso las
 * banderas del modelo hermano, del esfuerzo y de la coalescencia— una licencia
 * `measure` deja el cuerpo byte a byte como lo mandó el cliente, no coalesce dos
 * peticiones idénticas en vuelo (dos llamadas al upstream) y lo que el modelo
 * hermano habría ahorrado viaja a la ingesta como registro `shadow`.
 */

const PETICION = {
  model: "claude-fable-5",
  max_tokens: 64,
  system: [{ type: "text", text: "sé breve", cache_control: { type: "ephemeral", ttl: "1h" } }],
  messages: [{ role: "user", content: "hola" }],
};
const CUERPO = JSON.stringify(PETICION);

const N_LECTURA = 150_000;
const SSE = [
  `event: message_start\ndata: {"type":"message_start","message":{"model":"claude-fable-5","usage":{"input_tokens":100,"cache_read_input_tokens":${N_LECTURA},"output_tokens":1}}}\n\n`,
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"OK"}}\n\n',
  `event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":100,"cache_read_input_tokens":${N_LECTURA},"output_tokens":42}}\n\n`,
  "event: message_stop\ndata: {}\n\n",
].join("");

const TODAS = ["context_elision", "cache_ttl_tuning", "sibling_model_routing", "per_turn_effort"];

let recursos: (Server | GatewayArrancado)[] = [];
afterEach(async () => {
  for (const r of recursos) {
    if ("cerrar" in r) await r.cerrar();
    else await new Promise((res) => r.close(res));
  }
  recursos = [];
});

function escuchar(s: Server): Promise<number> {
  recursos.push(s);
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port)));
}

function upstreamFalso(recibidos: string[], retrasoMs = 0, sse = SSE): Promise<number> {
  return escuchar(
    createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      recibidos.push(Buffer.concat(chunks).toString("utf8"));
      if (retrasoMs) await new Promise((r) => setTimeout(r, retrasoMs));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse);
    }),
  );
}

function plataformaFalsa(lotes: unknown[][]): Promise<number> {
  return escuchar(
    createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      if (req.url === "/api/org/entitlements") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ features: TODAS, refreshAfterSeconds: 300 }));
        return;
      }
      if (chunks.length > 0) lotes.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown[]);
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ ingested: 1 }));
    }),
  );
}

async function gatewayMedir(
  upstream: number,
  plataforma: number,
  plan = "measure",
  modeloHermano = true,
): Promise<GatewayArrancado> {
  const g = await arrancarGateway({
    license: testLicense({ plan, features: plan === "measure" ? [] : TODAS }),
    puerto: 0,
    ...oficialHaciaElMock(upstream),
    serviceAccountKey: "bvk_test",
    meteringUrl: `http://127.0.0.1:${plataforma}/api/metering/usage`,
    elision: true,
    modeloHermano,
    esfuerzo: "low",
    coalescer: true,
    log: () => {},
  });
  recursos.push(g);
  await new Promise((r) => setTimeout(r, 150)); // el canal asienta
  return g;
}

const pedir = (puerto: number, cuerpo = CUERPO) =>
  fetch(`http://127.0.0.1:${puerto}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-beta": "prompt-caching-2024-07-31" },
    body: cuerpo,
  });

/** Un turno que el proveedor factura como ESCRITURA de caché de 1h (la marca del cliente). */
const N_ESCRITA_1H = 100_000;
const SSE_ESCRITURA_1H = [
  `event: message_start\ndata: {"type":"message_start","message":{"model":"claude-fable-5","usage":{"input_tokens":100,"cache_creation_input_tokens":${N_ESCRITA_1H},"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":${N_ESCRITA_1H}},"cache_read_input_tokens":0,"output_tokens":1}}}\n\n`,
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"OK"}}\n\n',
  `event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":100,"cache_creation_input_tokens":${N_ESCRITA_1H},"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":${N_ESCRITA_1H}},"cache_read_input_tokens":0,"output_tokens":42}}\n\n`,
  "event: message_stop\ndata: {}\n\n",
].join("");

async function registrosDe(g: GatewayArrancado, lotes: unknown[][], n: number): Promise<Record<string, unknown>[]> {
  await g.cerrar();
  recursos = recursos.filter((r) => r !== g);
  await esperar(() => lotes.flat().length >= n);
  return lotes.flat() as Record<string, unknown>[];
}

async function esperar(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout esperando la condición");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("pasarela con licencia Medir", () => {
  it("con todo armado, el cuerpo llega al upstream byte a byte y el hermano solo se informa como sombra", async () => {
    const recibidos: string[] = [];
    const lotes: unknown[][] = [];
    const g = await gatewayMedir(await upstreamFalso(recibidos), await plataformaFalsa(lotes));
    const res = await pedir(g.puerto);
    expect(res.status).toBe(200);
    await res.text();
    expect(recibidos).toEqual([CUERPO]);

    await g.cerrar();
    recursos = recursos.filter((r) => r !== g);
    await esperar(() => lotes.flat().length >= 2);
    const registros = lotes.flat() as Record<string, unknown>[];
    const sombra = registros.filter((r) => r["basis"] === "shadow");
    const medidos = registros.filter((r) => r["basis"] !== "shadow");
    expect(medidos).toHaveLength(1);
    expect(medidos[0]!["baselineCost"]).toBe(medidos[0]!["actualCost"]);
    expect(sombra).toHaveLength(1);
    expect(String(sombra[0]!["requestId"])).toMatch(/:shadow$/);
    expect(Number(sombra[0]!["actualCost"])).toBeLessThan(Number(sombra[0]!["baselineCost"]));
    expect(() => parseUsageRecords(registros, "org")).not.toThrow();
  });

  it("REBAJA DE TTL EN SOMBRA: el cuerpo sale con su ttl 1h y el «habrías ahorrado» es la aritmética exacta sobre el usage", async () => {
    const recibidos: string[] = [];
    const lotes: unknown[][] = [];
    // Sin el hermano, para aislar la palanca de TTL.
    const g = await gatewayMedir(await upstreamFalso(recibidos, 0, SSE_ESCRITURA_1H), await plataformaFalsa(lotes), "measure", false);
    const res = await pedir(g.puerto);
    await res.text();
    // Nunca aplicada: el upstream recibe la marca de 1h del cliente, byte a byte.
    expect(recibidos).toEqual([CUERPO]);
    expect(recibidos[0]).toContain('"ttl":"1h"');

    const registros = await registrosDe(g, lotes, 2);
    const medidos = registros.filter((r) => r["basis"] !== "shadow");
    const sombra = registros.filter((r) => r["basis"] === "shadow");
    // Lo medido: el coste real (con la prima de 1h), sin ahorro alguno.
    expect(medidos).toHaveLength(1);
    expect(medidos[0]!["baselineCost"]).toBe(medidos[0]!["actualCost"]);
    // La sombra: 100 000 tokens escritos a 1h (2×) que la capa habría escrito a
    // 5 min (1,25×), a la entrada de lista de claude-fable-5 (0,01 $/1k) →
    // 100 × 0,01 $ × 0,75 = 0,75 $. Ni un céntimo más.
    expect(sombra).toHaveLength(1);
    expect(sombra[0]!["baselineCost"]).toBeCloseTo(Number(medidos[0]!["actualCost"]), 10);
    expect(Number(sombra[0]!["baselineCost"]) - Number(sombra[0]!["actualCost"])).toBeCloseTo(0.75, 10);
    // Hipotético: no evita ni ejecuta nada, y la ingesta lo acepta como sombra.
    expect(sombra[0]!["avoidedLlm"] ?? 0).toBe(0);
    expect(() => parseUsageRecords(registros, "org")).not.toThrow();
  });

  it("REBAJA DE TTL EN SOMBRA: con marcas de 5m del propio cliente no se inventa nada (atribución sucia)", async () => {
    const recibidos: string[] = [];
    const lotes: unknown[][] = [];
    const mixto = JSON.stringify({
      ...PETICION,
      messages: [
        { role: "user", content: [{ type: "text", text: "hola", cache_control: { type: "ephemeral", ttl: "5m" } }] },
      ],
    });
    const g = await gatewayMedir(await upstreamFalso(recibidos, 0, SSE_ESCRITURA_1H), await plataformaFalsa(lotes), "measure", false);
    await (await pedir(g.puerto, mixto)).text();
    expect(recibidos).toEqual([mixto]);
    const registros = await registrosDe(g, lotes, 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(registros.filter((r) => r["basis"] === "shadow")).toHaveLength(0);
  });

  it("dos peticiones idénticas en vuelo NO se coalescen: dos llamadas al upstream", async () => {
    const recibidos: string[] = [];
    const g = await gatewayMedir(await upstreamFalso(recibidos, 80), await plataformaFalsa([]));
    const [a, b] = await Promise.all([pedir(g.puerto), pedir(g.puerto)]);
    await Promise.all([a.text(), b.text()]);
    expect(recibidos).toEqual([CUERPO, CUERPO]);
  });

  it("CONTRASTE: con la licencia de pago, las mismas banderas SÍ reescriben el cuerpo", async () => {
    const recibidos: string[] = [];
    const g = await gatewayMedir(await upstreamFalso(recibidos), await plataformaFalsa([]), "pro");
    await (await pedir(g.puerto)).text();
    expect(recibidos).toHaveLength(1);
    expect(recibidos[0]).not.toBe(CUERPO);
  });
});
