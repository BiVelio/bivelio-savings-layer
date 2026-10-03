import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { simular, type PeticionTtl } from "../benchmarks/ttl/nucleo.js";
import {
  cerrarTurno,
  costeDeFallo,
  fraccionCompartida,
  MemoriaDeTurnos,
  perdidosConRebajaAplicada,
  perdidosConRebajaEnSombra,
  TTL_1H_MS,
  TTL_5M_MS,
} from "../gateway/fallos-ttl.js";
import { costeMedido, informeMedido } from "../gateway/medidor.js";
import { arrancarGateway, type GatewayArrancado } from "../gateway/servidor.js";
import { huellaDe, PRIMA_1H, PRIMA_5M, type Huella } from "../gateway/tarifa.js";
import { parseUsageRecords } from "../packages/protocol/src/index.js";
import { precioDeLista } from "../src/pricing/catalogo.js";
import { oficialHaciaElMock } from "./helpers/gateway-oficial.js";
import { testLicense } from "./helpers/test-license.js";

/**
 * EL AHORRO NETO DE LA REBAJA DE TTL (2026-10-03).
 *
 * Hasta la 0.5.0 la pasarela acreditaba la prima de cada escritura rebajada y
 * no restaba el fallo de caché que la rebaja provoca en el turno siguiente: el
 * panel enseñaba el BRUTO. Aquí se prueba que el turno que sufre el fallo lo
 * resta — con la palanca aplicada (observado en el usage) y en sombra (el
 * contrafactual del banco de TTL, con su misma aritmética) — y que donde no hay
 * fallo no se resta nada.
 */

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 3, 10, 0, 0);

/** Una huella sintética: `n` mensajes de 1.000 bytes sobre 2.000 fijos. */
const huella = (n: number, system = "s"): Huella => ({
  system,
  tools: "t",
  mensajes: Array.from({ length: n }, (_, i) => `m${i}`),
  bytes: Array.from({ length: n }, () => 1_000),
  bytesFijos: 2_000,
});

const uso = (cacheLeida: number, escrita5m: number, escrita1h: number) => ({
  cacheLeida,
  cacheEscrita: escrita5m + escrita1h,
  cacheEscrita1h: escrita1h,
});

describe("fraccionCompartida: lo que este turno conserva del anterior", () => {
  it("un turno encadenado conserva TODO el cuerpo anterior", () => {
    expect(fraccionCompartida(huella(3), huella(5))).toBe(1);
  });
  it("si cambian system o tools no conserva nada", () => {
    expect(fraccionCompartida(huella(3, "a"), huella(5, "b"))).toBe(0);
  });
  it("una compactación conserva solo lo fijo y los mensajes que no cambió", () => {
    const antes = huella(8);
    const despues: Huella = { ...huella(2), mensajes: ["m0", "resumen"] };
    // 2.000 fijos + 1 mensaje de 1.000 sobre 10.000.
    expect(fraccionCompartida(antes, despues)).toBeCloseTo(0.3, 12);
  });
});

describe("la rebaja APLICADA: el fallo se observa en el usage del turno siguiente", () => {
  const dosTurnos = (huecoMs: number, opciones: { rebajado?: boolean; atribuible?: boolean } = {}) => {
    const m = new MemoriaDeTurnos();
    const t1 = m.abrir("hilo", huella(3), T0, opciones.rebajado ?? true);
    // Arranque en frío rebajado: 100.000 tokens escritos a 5 min.
    cerrarTurno(t1, uso(0, 100_000, 0), { sombra: false, atribuible: opciones.atribuible ?? true, perdidos: 0 });
    return m.abrir("hilo", huella(4), T0 + huecoMs, false);
  };

  it("pasados 5 min, lo que la entrada de 5 min cubría se reescribe: se pierde entero", () => {
    const t2 = dosTurnos(6 * MIN);
    // No leyó nada y reescribió el prefijo (100.000) más su cola (500), a 1h.
    expect(perdidosConRebajaAplicada(t2, uso(0, 0, 100_500))).toBe(100_000);
  });

  it("dentro de los 5 min la caché acierta: nada que restar", () => {
    const t2 = dosTurnos(4 * MIN);
    expect(perdidosConRebajaAplicada(t2, uso(100_000, 0, 500))).toBe(0);
  });

  it("pasados 5 min pero la caché ACERTÓ (otro turno la refrescó): leyó lo esperado y no se resta", () => {
    const t2 = dosTurnos(6 * MIN);
    expect(perdidosConRebajaAplicada(t2, uso(100_000, 0, 500))).toBe(0);
  });

  it("pasada 1h la entrada de 1h también habría caducado: no es culpa de la rebaja", () => {
    const t2 = dosTurnos(TTL_1H_MS + MIN);
    expect(t2.previo).toBeNull();
    expect(perdidosConRebajaAplicada(t2, uso(0, 0, 100_500))).toBe(0);
  });

  it("si el turno anterior NO se rebajó, un fallo no es de la palanca", () => {
    const t2 = dosTurnos(6 * MIN, { rebajado: false });
    expect(perdidosConRebajaAplicada(t2, uso(0, 0, 100_500))).toBe(0);
  });

  it("si la rebaja anterior no era atribuible (no se acreditó), tampoco se resta su fallo", () => {
    const t2 = dosTurnos(6 * MIN, { atribuible: false });
    expect(perdidosConRebajaAplicada(t2, uso(0, 0, 100_500))).toBe(0);
  });

  it("nunca más de lo que el turno anterior dejó a 5 min, ni de lo que este escribió", () => {
    const m = new MemoriaDeTurnos();
    const t1 = m.abrir("hilo", huella(3), T0, true);
    // Leyó 80.000 de una entrada de 1h y escribió 20.000 a 5 min: solo eso caduca.
    cerrarTurno(t1, uso(80_000, 20_000, 0), { sombra: false, atribuible: true, perdidos: 0 });
    const t2 = m.abrir("hilo", huella(4), T0 + 6 * MIN, false);
    expect(perdidosConRebajaAplicada(t2, uso(0, 0, 100_500))).toBe(20_000);
    expect(perdidosConRebajaAplicada(t2, uso(80_000, 0, 5_000))).toBe(5_000);
  });

  it("una compactación tras el hueco: solo se pierde lo que el turno conservaba del anterior", () => {
    const m = new MemoriaDeTurnos();
    const t1 = m.abrir("hilo", huella(8), T0, true);
    cerrarTurno(t1, uso(0, 100_000, 0), { sombra: false, atribuible: true, perdidos: 0 });
    const compactado: Huella = { ...huella(2), mensajes: ["m0", "resumen"] };
    const t2 = m.abrir("hilo", compactado, T0 + 6 * MIN, true);
    // Conserva el 30 % del cuerpo anterior: como mucho 30.000 tokens habrían sido lectura.
    expect(perdidosConRebajaAplicada(t2, uso(0, 60_000, 0))).toBe(30_000);
  });

  it("si el turno anterior aún no terminó cuando llega este, no se sabe y no se inventa", () => {
    const m = new MemoriaDeTurnos();
    m.abrir("hilo", huella(3), T0, true); // sin cerrar
    const t2 = m.abrir("hilo", huella(4), T0 + 6 * MIN, false);
    expect(t2.previo).toBeNull();
    expect(perdidosConRebajaAplicada(t2, uso(0, 0, 100_500))).toBe(0);
  });

  it("la memoria está acotada", () => {
    const m = new MemoriaDeTurnos(4);
    for (let i = 0; i < 20; i++) m.abrir(`h${i}`, huella(1), T0 + i, false);
    expect(m.tamano).toBe(4);
  });
});

describe("costeDeFallo: lectura que pasa a escritura", () => {
  it("a la prima del turno que reescribe, menos lo que habría costado leer", () => {
    // 100.000 tokens, entrada 0,01 $/1k, lectura 0,001 $/1k, reescritos a 1h (2×).
    expect(costeDeFallo({ perdidos: 100_000, inputPer1k: 0.01, cachedInputPer1k: 0.001, primaEscritura: PRIMA_1H })).toBeCloseTo(
      100 * (0.02 - 0.001),
      12,
    );
    expect(costeDeFallo({ perdidos: 100_000, inputPer1k: 0.01, cachedInputPer1k: 0.001, primaEscritura: PRIMA_5M })).toBeCloseTo(
      100 * (0.0125 - 0.001),
      12,
    );
  });
  it("sin precio de lectura en el catálogo, el 10 % de la entrada", () => {
    expect(costeDeFallo({ perdidos: 1_000, inputPer1k: 0.01, primaEscritura: PRIMA_1H })).toBeCloseTo(0.02 - 0.001, 12);
  });
  it("sin tokens perdidos o sin precio, 0", () => {
    expect(costeDeFallo({ perdidos: 0, inputPer1k: 0.01, primaEscritura: PRIMA_1H })).toBe(0);
    expect(costeDeFallo({ perdidos: 10, inputPer1k: 0, primaEscritura: PRIMA_1H })).toBe(0);
  });
});

describe("el informe medido en NETO", () => {
  type Coste = { cost: { baselineEstimate: number; actual: number; netSavingsRatio: number; netSavingsUsd: number; basis: string } };
  const precio = precioDeLista("claude-opus-5")!;
  const lectura = precio.cachedInputPer1k ?? precio.inputPer1k * 0.1;
  const REBAJA = { rebajadas: 2, yaEran5m: 0, herramientaDeServidor: false };

  it("el turno que sufre el fallo (sin rebaja propia) sale en NEGATIVO: pagó 2× lo que habría leído", () => {
    const medido = costeMedido("claude-opus-5", {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 100_500,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100_500 },
    })!;
    const inf = informeMedido("f-1", "claude-opus-5", medido, undefined, null, null, null, false, false, false, {
      perdidos: 100_000,
    }) as unknown as Coste;
    const fallo = 100 * (precio.inputPer1k * PRIMA_1H - lectura);
    expect(inf.cost.basis).toBe("measured");
    expect(inf.cost.actual).toBeCloseTo(medido.costeUsd, 12);
    expect(inf.cost.actual - inf.cost.baselineEstimate).toBeCloseTo(fallo, 9);
    expect(inf.cost.netSavingsUsd).toBeCloseTo(-fallo, 9);
    expect(inf.cost.netSavingsRatio).toBeLessThan(0);
    expect(inf.cost.netSavingsRatio).toBeGreaterThanOrEqual(-100);
    expect(inf.cost.baselineEstimate).toBeGreaterThanOrEqual(0);
  });

  it("si el turno que falla TAMBIÉN va rebajado, lo perdido no acredita prima y se resta a 1,25×", () => {
    const medido = costeMedido("claude-opus-5", {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 60_000,
      cache_creation: { ephemeral_5m_input_tokens: 60_000, ephemeral_1h_input_tokens: 0 },
    })!;
    const inf = informeMedido("f-2", "claude-opus-5", medido, undefined, null, REBAJA, null, false, false, false, {
      perdidos: 30_000,
    }) as unknown as Coste;
    // 30.000 nuevos de verdad: prima ahorrada. 30.000 perdidos: 1,25× en vez de lectura.
    const prima = 30 * precio.inputPer1k * (PRIMA_1H - PRIMA_5M);
    const fallo = 30 * (precio.inputPer1k * PRIMA_5M - lectura);
    expect(inf.cost.netSavingsUsd).toBeCloseTo(prima - fallo, 9);
  });

  it("sin fallo, el informe es EXACTAMENTE el de antes (el bruto era el neto)", () => {
    const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 100_000 };
    const medido = costeMedido("claude-opus-5", usage)!;
    const antes = informeMedido("f-3", "claude-opus-5", medido, undefined, null, REBAJA);
    const ahora = informeMedido("f-3", "claude-opus-5", medido, undefined, null, REBAJA, null, false, false, false, { perdidos: 0 });
    expect(ahora).toEqual(antes);
    expect(informeMedido("f-3", "claude-opus-5", medido, undefined, null, REBAJA, null, false, false, false, null)).toEqual(antes);
  });

  it("donde no se acredita ahorro (suscripción) tampoco se resta el fallo: baseline == actual", () => {
    const medido = costeMedido("claude-opus-5", {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 100_500,
    })!;
    const inf = informeMedido("f-4", "claude-opus-5", medido, undefined, null, null, null, true, false, false, {
      perdidos: 100_000,
    }) as unknown as Coste;
    expect(inf.cost.baselineEstimate).toBe(inf.cost.actual);
  });

  it("la suma de un hilo es el NETO: prima del arranque menos el fallo del turno siguiente", () => {
    const arranque = costeMedido("claude-opus-5", {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 100_000,
      cache_creation: { ephemeral_5m_input_tokens: 100_000, ephemeral_1h_input_tokens: 0 },
    })!;
    const siguiente = costeMedido("claude-opus-5", {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 100_500,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100_500 },
    })!;
    const a = informeMedido("h-1", "claude-opus-5", arranque, undefined, null, REBAJA) as unknown as Coste;
    const b = informeMedido("h-2", "claude-opus-5", siguiente, undefined, null, null, null, false, false, false, {
      perdidos: 100_000,
    }) as unknown as Coste;
    const bruto = 100 * precio.inputPer1k * (PRIMA_1H - PRIMA_5M);
    const fallo = 100 * (precio.inputPer1k * PRIMA_1H - lectura);
    expect(a.cost.netSavingsUsd).toBeCloseTo(bruto, 9);
    // Este hilo PIERDE dinero con la palanca, y el informe lo dice.
    expect(a.cost.netSavingsUsd + b.cost.netSavingsUsd).toBeCloseTo(bruto - fallo, 9);
    expect(a.cost.netSavingsUsd + b.cost.netSavingsUsd).toBeLessThan(0);
  });
});

describe("la rebaja EN SOMBRA usa la aritmética del banco de TTL", () => {
  it("fallo a fallo, coincide con benchmarks/ttl/nucleo.ts sobre una secuencia con huecos, cadenas y arranques", () => {
    const MODELO = "claude-opus-5";
    // [minuto, rebajada, lectura, escritura1h]
    const guion: [number, boolean, number, number][] = [
      [0, true, 0, 100_000], // arranque rebajado
      [2, false, 100_000, 1_000], // encadenado dentro de 5 min: re-cubre a 1h
      [10, false, 101_000, 1_000], // hueco, pero el anterior no iba rebajado
      [80, true, 0, 110_000], // pasada 1h: arranque rebajado
      [88, false, 110_000, 2_000], // hueco de 8 min tras rebaja: FALLO entero
      [90, true, 40_000, 70_000], // compactación rebajada: lee 40.000 de 1h
      [93, true, 110_000, 30_000], // otra rebajada dentro de 5 min: cadena
      [101, false, 140_000, 500], // hueco tras la cadena: FALLO parcial
      [103, false, 140_500, 500],
    ];
    const peticiones: PeticionTtl[] = guion.map(([min, rebajada, lectura, escritura1h]) => ({
      atMs: T0 + min * MIN,
      sesion: "s",
      hilo: "h",
      prefijoComun: "p",
      modelo: MODELO,
      uso: { entrada: 100, lectura, escritura5m: 0, escritura1h, escrituraSinDesglose: 0, salida: 50 },
      rebajada,
      yaEran5m: 0,
      herramientaDeServidor: false,
    }));
    const banco = simular(peticiones, { prefijoCompartido: false });

    const precio = precioDeLista(MODELO, T0)!;
    const m = new MemoriaDeTurnos();
    const mios = guion.map(([min, rebajada, lectura, escritura1h], i) => {
      const turno = m.abrir("h", huella(i + 1), T0 + min * MIN, rebajada);
      const u = uso(lectura, 0, escritura1h);
      const perdidos = perdidosConRebajaEnSombra(turno, u);
      cerrarTurno(turno, u, { sombra: true, atribuible: true, perdidos });
      return {
        perdidos,
        coste: costeDeFallo({
          perdidos,
          inputPer1k: precio.inputPer1k,
          cachedInputPer1k: precio.cachedInputPer1k,
          primaEscritura: rebajada ? PRIMA_5M : PRIMA_1H,
        }),
      };
    });

    expect(mios.map((f) => f.perdidos)).toEqual(banco.map((f) => f.tokensPerdidos));
    banco.forEach((f, i) => expect(mios[i]!.coste, `turno ${i}`).toBeCloseTo(f.costeFallos, 9));
    // El guion tiene fallos de verdad: si no, la prueba no probaría nada.
    expect(banco.filter((f) => f.fallo).length).toBeGreaterThanOrEqual(2);
    expect(TTL_5M_MS).toBe(5 * MIN);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// De punta a punta: el servidor, un upstream falso y la ingesta falsa.
// ─────────────────────────────────────────────────────────────────────────────

const TODAS = ["context_elision", "cache_ttl_tuning", "sibling_model_routing", "per_turn_effort"];
const LARGO = "contexto ".repeat(2_000);
const TURNO_1 = {
  model: "claude-opus-5",
  max_tokens: 64,
  system: [{ type: "text", text: "sé breve" }],
  messages: [{ role: "user", content: [{ type: "text", text: LARGO, cache_control: { type: "ephemeral", ttl: "1h" } }] }],
};
const TURNO_2 = {
  ...TURNO_1,
  messages: [
    { role: "user", content: [{ type: "text", text: LARGO }] },
    { role: "assistant", content: [{ type: "text", text: "vale" }] },
    { role: "user", content: [{ type: "text", text: "sigue", cache_control: { type: "ephemeral", ttl: "1h" } }] },
  ],
};

const sse = (lectura: number, e5m: number, e1h: number) => {
  const usage =
    `"input_tokens":100,"cache_creation_input_tokens":${e5m + e1h},` +
    `"cache_creation":{"ephemeral_5m_input_tokens":${e5m},"ephemeral_1h_input_tokens":${e1h}},"cache_read_input_tokens":${lectura}`;
  return [
    `event: message_start\ndata: {"type":"message_start","message":{"model":"claude-opus-5","usage":{${usage},"output_tokens":1}}}\n\n`,
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"OK"}}\n\n',
    `event: message_delta\ndata: {"type":"message_delta","usage":{${usage},"output_tokens":42}}\n\n`,
    "event: message_stop\ndata: {}\n\n",
  ].join("");
};

let recursos: (Server | GatewayArrancado)[] = [];
afterEach(async () => {
  vi.useRealTimers();
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

/** Un upstream que responde, por orden, con cada SSE de `respuestas`. */
function upstreamPorTurnos(recibidos: string[], respuestas: string[]): Promise<number> {
  return escuchar(
    createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      recibidos.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(respuestas[Math.min(recibidos.length, respuestas.length) - 1]);
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

async function gateway(upstream: number, plataforma: number, plan: string, lineas: string[]): Promise<GatewayArrancado> {
  const g = await arrancarGateway({
    license: testLicense({ plan, features: plan === "measure" ? [] : TODAS }),
    puerto: 0,
    ...oficialHaciaElMock(upstream),
    serviceAccountKey: "bvk_test",
    meteringUrl: `http://127.0.0.1:${plataforma}/api/metering/usage`,
    elision: true,
    log: (l) => lineas.push(l),
  });
  recursos.push(g);
  await new Promise((r) => setTimeout(r, 150)); // el canal asienta
  return g;
}

const pedir = async (puerto: number, cuerpo: unknown) => {
  const res = await fetch(`http://127.0.0.1:${puerto}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-beta": "prompt-caching-2024-07-31", "x-claude-code-session-id": "sesion-neto" },
    body: JSON.stringify(cuerpo),
  });
  await res.text();
};

async function registrosDe(g: GatewayArrancado, lotes: unknown[][], n: number): Promise<Record<string, unknown>[]> {
  vi.useRealTimers();
  await g.cerrar();
  recursos = recursos.filter((r) => r !== g);
  const t0 = Date.now();
  while (lotes.flat().length < n) {
    if (Date.now() - t0 > 3000) throw new Error(`timeout: ${lotes.flat().length} registros de ${n}`);
    await new Promise((r) => setTimeout(r, 20));
  }
  return lotes.flat() as Record<string, unknown>[];
}

/** Solo el reloj: los sockets y los temporizadores siguen siendo los de verdad. */
const relojEn = (ms: number) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(ms);
};

const neto = (r: Record<string, unknown>) => Number(r["baselineCost"]) - Number(r["actualCost"]);

describe("la pasarela, de punta a punta: el panel recibe el NETO", () => {
  const precio = precioDeLista("claude-opus-5")!;
  const lectura = precio.cachedInputPer1k ?? precio.inputPer1k * 0.1;
  const BRUTO = 100 * precio.inputPer1k * (PRIMA_1H - PRIMA_5M);

  it("PAGO · el turno que llega pasados 5 min resta el fallo que la rebaja le provocó", async () => {
    const recibidos: string[] = [];
    const lotes: unknown[][] = [];
    const lineas: string[] = [];
    // Turno 1: arranque, 100.000 escritos (a 5 min tras la rebaja). Turno 2: no
    // lee nada y reescribe el prefijo entero más su cola, a 1h (no va rebajado).
    const up = await upstreamPorTurnos(recibidos, [sse(0, 100_000, 0), sse(0, 0, 100_500)]);
    const g = await gateway(up, await plataformaFalsa(lotes), "pro", lineas);
    relojEn(T0);
    await pedir(g.puerto, TURNO_1);
    vi.setSystemTime(T0 + 6 * MIN);
    await pedir(g.puerto, TURNO_2);

    // La rebaja viajó en el arranque y NO en el turno encadenado.
    expect(recibidos[0]).toContain('"ttl":"5m"');
    expect(recibidos[1]).toContain('"ttl":"1h"');

    const registros = (await registrosDe(g, lotes, 2)).filter((r) => r["basis"] === "measured");
    expect(registros).toHaveLength(2);
    const fallo = 100 * (precio.inputPer1k * PRIMA_1H - lectura);
    expect(neto(registros[0]!)).toBeCloseTo(BRUTO, 9);
    expect(neto(registros[1]!)).toBeCloseTo(-fallo, 9);
    expect(Number(registros[1]!["netSavings"])).toBeLessThan(0);
    // La ingesta acepta un turno en negativo, y el log lo dice.
    expect(() => parseUsageRecords(registros, "org")).not.toThrow();
    expect(lineas.some((l) => l.includes("cache TTL miss: 100000 tok rewritten"))).toBe(true);
  });

  it("PAGO · si el turno siguiente llega dentro de los 5 min y lee la caché, no se resta nada", async () => {
    const recibidos: string[] = [];
    const lotes: unknown[][] = [];
    const up = await upstreamPorTurnos(recibidos, [sse(0, 100_000, 0), sse(100_000, 0, 500)]);
    const g = await gateway(up, await plataformaFalsa(lotes), "pro", []);
    relojEn(T0);
    await pedir(g.puerto, TURNO_1);
    vi.setSystemTime(T0 + 2 * MIN);
    await pedir(g.puerto, TURNO_2);

    const registros = (await registrosDe(g, lotes, 2)).filter((r) => r["basis"] === "measured");
    expect(neto(registros[0]!)).toBeCloseTo(BRUTO, 9);
    expect(neto(registros[1]!)).toBe(0);
  });

  it("MEDIR · la sombra también es neta: el turno que con la rebaja habría fallado se registra más caro", async () => {
    const recibidos: string[] = [];
    const lotes: unknown[][] = [];
    // Nada se reescribe: el arranque escribe a 1h y el turno siguiente lo LEE.
    const up = await upstreamPorTurnos(recibidos, [sse(0, 0, 100_000), sse(100_000, 0, 500)]);
    const g = await gateway(up, await plataformaFalsa(lotes), "measure", []);
    relojEn(T0);
    await pedir(g.puerto, TURNO_1);
    vi.setSystemTime(T0 + 6 * MIN);
    await pedir(g.puerto, TURNO_2);
    expect(recibidos[0]).toContain('"ttl":"1h"');
    expect(recibidos[0]).not.toContain('"ttl":"5m"');

    const registros = await registrosDe(g, lotes, 4);
    const sombra = registros.filter((r) => r["basis"] === "shadow");
    expect(sombra).toHaveLength(2);
    // Con la rebaja el turno 2 habría reescrito 100.000 tokens a 1h (no se rebaja: es encadenado).
    const fallo = 100 * (precio.inputPer1k * PRIMA_1H - lectura);
    expect(neto(sombra[0]!)).toBeCloseTo(BRUTO, 9);
    expect(neto(sombra[1]!)).toBeCloseTo(-fallo, 9);
    expect(() => parseUsageRecords(registros, "org")).not.toThrow();
  });
});

// La huella real del cuerpo de prueba: el turno 2 conserva el turno 1 entero.
describe("los cuerpos de la prueba de punta a punta", () => {
  it("el turno 2 es un turno encadenado del turno 1", () => {
    expect(fraccionCompartida(huellaDe(TURNO_1), huellaDe(TURNO_2))).toBe(1);
  });
});
