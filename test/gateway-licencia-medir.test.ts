import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { arrancarGateway, type GatewayArrancado } from "../gateway/servidor.js";
import { parseUsageRecords } from "../packages/protocol/src/index.js";
import { oficialHaciaElMock } from "./helpers/gateway-oficial.js";
import { testLicense } from "./helpers/test-license.js";

/**
 * LA LICENCIA MEDIR Y EL MODO SOLO-OBSERVAR EN LA PASARELA (`bvsala`), de punta a
 * punta y sin red.
 *
 * POR QUÉ CAMBIÓ ESTE FICHERO (1.2.4). Hasta la 1.2.3 fijaba, a propósito, que
 * una licencia `measure` dejaba el cuerpo byte a byte, no coalescía y solo
 * informaba el «habrías ahorrado» como sombra. Era el diseño del modelo cerrado
 * anterior a la 1.0.0 (#417). Con el open core (#523) el modo comunitario —sin
 * ninguna clave— ya aplicaba todas las palancas, así que la clave gratuita de la
 * nube dejaba la pasarela PEOR que sin clave. Decisión del dueño (21-11-2026):
 * Medir ahorra igual que el modo comunitario, y el paso limpio es una opción
 * explícita (`BVSALA_GATEWAY_OBSERVE_ONLY=1` → `soloObservar`), en cualquier plan.
 *
 * Lo que fija ahora:
 *   1. MEDIR = COMUNITARIO: con las mismas banderas del operador, el upstream
 *      recibe exactamente los mismos bytes y las mismas llamadas que sin claves,
 *      aunque la nube sirva `features: []` para la organización;
 *   2. el modo solo-observar conserva, intacto, lo que antes hacía Medir: cuerpo
 *      byte a byte, sin coalescencia, y el hipotético como registro `shadow`;
 *   3. una licencia de PAGO sigue mandada por las features de su organización:
 *      Medir no ha abierto nada que no estuviera ya abierto sin clave.
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

function plataformaFalsa(lotes: unknown[][], features: string[] = TODAS, reason?: string): Promise<number> {
  return escuchar(
    createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      if (req.url === "/api/org/entitlements") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ features, refreshAfterSeconds: 300, ...(reason ? { reason } : {}) }));
        return;
      }
      if (chunks.length > 0) lotes.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown[]);
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ ingested: 1 }));
    }),
  );
}

/** Las banderas del operador, las mismas en todos los montajes de este fichero. */
const banderas = (modeloHermano: boolean) => ({ elision: true, modeloHermano, esfuerzo: "low", coalescer: true, log: () => {} });

/** Una pasarela con licencia (y clave de servicio). `soloObservar` es BVSALA_GATEWAY_OBSERVE_ONLY=1. */
async function gatewayConLicencia(
  upstream: number,
  plataforma: number,
  plan = "measure",
  modeloHermano = true,
  soloObservar = false,
): Promise<GatewayArrancado> {
  const g = await arrancarGateway({
    license: testLicense({ plan, features: plan === "measure" ? [] : TODAS }),
    puerto: 0,
    ...oficialHaciaElMock(upstream),
    serviceAccountKey: "bvk_test",
    meteringUrl: `http://127.0.0.1:${plataforma}/api/metering/usage`,
    ...banderas(modeloHermano),
    ...(soloObservar ? { soloObservar: true } : {}),
  });
  recursos.push(g);
  await new Promise((r) => setTimeout(r, 150)); // el canal asienta
  return g;
}

/** Lo que hasta la 1.2.3 hacía la licencia Medir sola: ahora, Medir + solo-observar. */
const gatewayMedir = (upstream: number, plataforma: number, plan = "measure", modeloHermano = true) =>
  gatewayConLicencia(upstream, plataforma, plan, modeloHermano, plan === "measure");

/** Sin ninguna clave: el modo comunitario, con las mismas banderas. */
async function gatewayComunitario(upstream: number, modeloHermano = true, soloObservar = false): Promise<GatewayArrancado> {
  const g = await arrancarGateway({
    puerto: 0,
    ...oficialHaciaElMock(upstream),
    ...banderas(modeloHermano),
    ...(soloObservar ? { soloObservar: true } : {}),
  });
  recursos.push(g);
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

describe("pasarela en modo solo-observar (lo que hasta la 1.2.3 forzaba la licencia Medir)", () => {
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

describe("pasarela con licencia Medir · ahorra igual que el modo comunitario", () => {
  /** Una petición y dos idénticas a la vez; devuelve lo que vio el upstream. */
  async function carga(g: GatewayArrancado, recibidos: string[]) {
    await (await pedir(g.puerto)).text();
    const trasUna = recibidos.length;
    const otra = JSON.stringify({ ...PETICION, messages: [{ role: "user", content: "adiós" }] });
    const [a, b] = await Promise.all([pedir(g.puerto, otra), pedir(g.puerto, otra)]);
    await Promise.all([a.text(), b.text()]);
    return { cuerpos: [...recibidos], enLasDosALaVez: recibidos.length - trasUna };
  }

  it("mismos bytes y mismas llamadas al upstream que SIN CLAVES, aunque la nube sirva features: []", async () => {
    const vistoComunidad: string[] = [];
    const comunidad = await carga(await gatewayComunitario(await upstreamFalso(vistoComunidad, 80, SSE_ESCRITURA_1H)), vistoComunidad);

    const vistoMedir: string[] = [];
    // La nube REAL sirve `features: []` a una org que solo tiene Medir.
    const medir = await carga(
      await gatewayConLicencia(await upstreamFalso(vistoMedir, 80, SSE_ESCRITURA_1H), await plataformaFalsa([], [])),
      vistoMedir,
    );

    // El contador independiente es el upstream falso. Antes de la 1.2.4: con
    // Medir 3 llamadas y el cuerpo intacto; sin claves, 2 y el cuerpo reescrito.
    expect(comunidad.cuerpos).toHaveLength(2);
    expect(comunidad.enLasDosALaVez).toBe(1);
    expect(medir.cuerpos).toEqual(comunidad.cuerpos);
    expect(medir.enLasDosALaVez).toBe(1);
    // Y las palancas actuaron de verdad: la marca de 1h salió a 5 min.
    expect(medir.cuerpos[0]).not.toBe(CUERPO);
    expect(medir.cuerpos[0]).not.toContain('"ttl":"1h"');
  });

  it("con SOLO la licencia Medir pegada a mano (sin clave de servicio) también: igual que sin claves", async () => {
    const vistoComunidad: string[] = [];
    await (await pedir((await gatewayComunitario(await upstreamFalso(vistoComunidad, 0, SSE_ESCRITURA_1H))).puerto)).text();
    const vistoMedir: string[] = [];
    const g = await arrancarGateway({
      license: testLicense({ plan: "measure", features: [] }),
      puerto: 0,
      ...oficialHaciaElMock(await upstreamFalso(vistoMedir, 0, SSE_ESCRITURA_1H)),
      ...banderas(true),
    });
    recursos.push(g);
    await (await pedir(g.puerto)).text();
    expect(vistoMedir).toEqual(vistoComunidad);
    expect(vistoMedir[0]).not.toBe(CUERPO);
  });

  it("el ahorro REAL viaja a la ingesta como medido (baseline > actual) y no hay ningún registro sombra", async () => {
    const recibidos: string[] = [];
    const lotes: unknown[][] = [];
    // El proveedor factura lo que de verdad llegó: una escritura a 5 min (la capa rebajó la marca de 1h).
    const sse5m = SSE_ESCRITURA_1H.replaceAll(
      `"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":${N_ESCRITA_1H}`,
      `"ephemeral_5m_input_tokens":${N_ESCRITA_1H},"ephemeral_1h_input_tokens":0`,
    );
    const g = await gatewayConLicencia(await upstreamFalso(recibidos, 0, sse5m), await plataformaFalsa(lotes, []), "measure", false);
    await (await pedir(g.puerto)).text();
    expect(recibidos[0]).not.toContain('"ttl":"1h"');
    const registros = await registrosDe(g, lotes, 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(registros.filter((r) => r["basis"] === "shadow")).toHaveLength(0);
    expect(registros).toHaveLength(1);
    // La rebaja de TTL aplicada acredita su ahorro, como en cualquier otro plan.
    expect(Number(registros[0]!["baselineCost"])).toBeGreaterThan(Number(registros[0]!["actualCost"]));
    expect(() => parseUsageRecords(registros, "org")).not.toThrow();
  });

  it("el cartel de arranque dice lo que pasa ahora (palancas encendidas), no «SHADOW mode»", async () => {
    const { AVISO_GATEWAY_MEDIR, AVISO_GATEWAY_SOLO_OBSERVAR } = await import("../gateway/servidor.js");
    expect(AVISO_GATEWAY_MEDIR).toContain("the same levers as with no BiVelio keys apply");
    // No todas las palancas van encendidas por defecto: el cartel no puede decirlo (revisión de #612).
    expect(AVISO_GATEWAY_MEDIR).not.toMatch(/every (local )?(saving )?lever/i);
    expect(AVISO_GATEWAY_MEDIR).toContain("BVSALA_GATEWAY_OBSERVE_ONLY=1");
    expect(AVISO_GATEWAY_MEDIR).not.toMatch(/SHADOW|byte for byte|upgrade/);
    expect(AVISO_GATEWAY_SOLO_OBSERVAR).toContain("OBSERVE-ONLY");
    expect(AVISO_GATEWAY_SOLO_OBSERVAR).toContain("byte for byte");
  });

  it("el JSDoc publicado de createSavingsLayer (viaja en dist/index.d.ts) no dice «every local saving lever on»", async () => {
    // Revisión de #612: no todas las palancas van encendidas por defecto, así que
    // ningún texto que viaja al cliente puede afirmarlo.
    const { readFileSync } = await import("node:fs");
    const fuente = readFileSync(new URL("../src/pipeline/create.ts", import.meta.url), "utf8");
    expect(fuente).toContain("COMMUNITY gate — free, zero telemetry, zero network.");
    expect(fuente).not.toMatch(/every local saving lever on/);
  });

  it("una org Medir BLOQUEADA por el control plane se sigue cortando con 402 (el canal de org no se ha soltado)", async () => {
    const recibidos: string[] = [];
    const g = await gatewayConLicencia(await upstreamFalso(recibidos), await plataformaFalsa([], [], "license-revoked"));
    const res = await pedir(g.puerto);
    expect(res.status).toBe(402);
    await res.text();
    expect(recibidos).toHaveLength(0);
  });
});

describe("pasarela · lo que NO cambia", () => {
  it("opt-out del operador (BVSALA_GATEWAY_ELISION=0) con licencia de PAGO: nada se reescribe", async () => {
    const recibidos: string[] = [];
    const g = await arrancarGateway({
      license: testLicense({ plan: "pro", features: TODAS }),
      puerto: 0,
      ...oficialHaciaElMock(await upstreamFalso(recibidos, 0, SSE_ESCRITURA_1H)),
      ...banderas(true),
      elision: false,
      coalescer: false,
    });
    recursos.push(g);
    await (await pedir(g.puerto)).text();
    expect(recibidos).toEqual([CUERPO]);
  });
});

describe("pasarela · una licencia de PAGO lleva las mismas palancas que sin claves (1.2.4)", () => {
  // Hasta la 1.2.3 estos dos casos decían «nada se reescribe»: una organización
  // de pago con la fila sin literales, o sin clave de servicio, tenía MENOS
  // palancas que quien no ponía ninguna clave.
  it("licencia de PAGO sin las features en su organización: lo mismo que el modo comunitario", async () => {
    const comunidad: string[] = [];
    const gc = await gatewayComunitario(await upstreamFalso(comunidad, 0, SSE_ESCRITURA_1H), true, false);
    await (await pedir(gc.puerto)).text();
    const recibidos: string[] = [];
    const g = await gatewayConLicencia(await upstreamFalso(recibidos, 0, SSE_ESCRITURA_1H), await plataformaFalsa([], []), "pro");
    await (await pedir(g.puerto)).text();
    expect(recibidos).toEqual(comunidad);
    expect(recibidos).not.toEqual([CUERPO]);
  });

  it("licencia de PAGO sin clave de servicio: lo mismo que el modo comunitario", async () => {
    const comunidad: string[] = [];
    const gc = await gatewayComunitario(await upstreamFalso(comunidad, 0, SSE_ESCRITURA_1H), true, false);
    await (await pedir(gc.puerto)).text();
    const recibidos: string[] = [];
    const g = await arrancarGateway({
      license: testLicense({ plan: "pro", features: TODAS }),
      puerto: 0,
      ...oficialHaciaElMock(await upstreamFalso(recibidos, 0, SSE_ESCRITURA_1H)),
      ...banderas(true),
      coalescer: false,
    });
    recursos.push(g);
    await (await pedir(g.puerto)).text();
    expect(recibidos).toEqual(comunidad);
    expect(recibidos).not.toEqual([CUERPO]);
  });

  it.each([
    ["sin claves", "comunidad"],
    ["con licencia de pago", "pro"],
  ])("el modo solo-observar vale en cualquier plan (%s): byte a byte y sin coalescer", async (_n, plan) => {
    const recibidos: string[] = [];
    const up = await upstreamFalso(recibidos, 80, SSE_ESCRITURA_1H);
    const g = plan === "comunidad" ? await gatewayComunitario(up, true, true) : await gatewayConLicencia(up, await plataformaFalsa([]), plan, true, true);
    const [a, b] = await Promise.all([pedir(g.puerto), pedir(g.puerto)]);
    await Promise.all([a.text(), b.text()]);
    expect(recibidos).toEqual([CUERPO, CUERPO]);
  });
});
