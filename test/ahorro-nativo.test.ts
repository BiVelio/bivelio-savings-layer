import { describe, it, expect } from "vitest";

import { createSavingsLayer, type CostModel, type SavingsReport } from "../src/index.js";
import { ahorroNativo } from "../src/economics/ahorro-nativo.js";
import { UsageEmitter } from "../src/metering/emitter.js";
import { costeMedido, informeMedido } from "../gateway/medidor.js";
import { parseUsageRecord } from "../apps/web/lib/metering/usage.js";

/**
 * EL AHORRO NATIVO — «mostrar el ahorro de la caché de prefijo del proveedor
 * aparte, sin comisión» (decisión del dueño).
 *
 * Dos promesas, y este fichero las ata:
 *   1. CUADRA CON LA FACTURA. Con el `usage` de caché que devuelve cada
 *      proveedor (Anthropic con cache_control, OpenAI automática, Gemini
 *      implícita), `report.nativeSavings.netUsd` es exactamente la diferencia
 *      entre lo que el proveedor habría facturado sin caché y lo que factura con
 *      ella. La factura se calcula AQUÍ, a mano, con la tarifa pública de cada
 *      uno — no con el código que se está probando.
 *   2. LA COMISIÓN NO SE MUEVE NI UN CÉNTIMO. El bloque vive fuera de `cost`;
 *      el registro del cable lleva las mismas cifras de dinero con y sin él, y
 *      el ingest no toca ningún otro campo por su culpa.
 */

let n = 0;
const id = () => `nat-${n++}`;

/** Un proveedor que devuelve el `usage` que le digamos, como lo mapean los adaptadores. */
function proveedor(usage: {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  cacheWrite1hInputTokens?: number;
}) {
  return {
    id: "simulado",
    async generate() {
      return { text: "42", usage };
    },
  };
}

async function correr(model: string, precio: CostModel, usage: Parameters<typeof proveedor>[0]): Promise<SavingsReport> {
  const layer = createSavingsLayer({
    provider: proveedor(usage),
    generateId: id,
    costModels: { [model]: precio },
  });
  const r = await layer.generate({
    model,
    messages: [{ role: "user", content: `una pregunta neutra sobre historia ${n}` }],
    savings: { exactCache: false },
  });
  return r.report;
}

describe("report.nativeSavings cuadra con la factura del proveedor", () => {
  it("Anthropic (cache_control): lectura a 0,1× y escritura a 1,25× (5 min) y 2× (1 h)", async () => {
    const precio = { inputPer1k: 0.003, outputPer1k: 0.015, cachedInputPer1k: 0.0003 };
    // El adaptador de Anthropic suma a `inputTokens` las leídas y las escritas.
    const leidas = 8_000;
    const escritas = 1_500;
    const escritas1h = 500;
    const normales = 2_000;
    const salida = 300;
    const r = await correr("claude-sonnet-5", precio, {
      inputTokens: normales + leidas + escritas,
      outputTokens: salida,
      cachedInputTokens: leidas,
      cacheWriteInputTokens: escritas,
      cacheWrite1hInputTokens: escritas1h,
    });
    // La factura, a mano, con la tabla pública de Anthropic.
    const conCache =
      (normales / 1000) * 0.003 +
      (leidas / 1000) * 0.0003 +
      ((escritas - escritas1h) / 1000) * 0.003 * 1.25 +
      (escritas1h / 1000) * 0.003 * 2 +
      (salida / 1000) * 0.015;
    const sinCache = ((normales + leidas + escritas) / 1000) * 0.003 + (salida / 1000) * 0.015;
    const nat = r.nativeSavings!;
    expect(nat).toBeDefined();
    expect(nat.provider).toBe("anthropic");
    expect(nat.mechanism).toBe("explicit");
    expect(nat.basis).toBe("measured");
    expect(nat.cacheReadTokens).toBe(leidas);
    expect(nat.cacheWriteTokens).toBe(escritas);
    expect(nat.cacheWrite1hTokens).toBe(escritas1h);
    expect(nat.netUsd).toBeCloseTo(sinCache - conCache, 10);
    expect(nat.readDiscountUsd - nat.writePremiumUsd).toBeCloseTo(nat.netUsd, 10);
    // Y el bloque se puede recalcular sin creernos: todo lo que usa va dentro.
    expect(nat.readDiscountUsd).toBeCloseTo((nat.cacheReadTokens / 1000) * (nat.inputPer1k - nat.cachedInputPer1k), 12);
  });

  it("OpenAI (automática, gpt-5.6+): la prima de escritura de 1,25× que cobra por su cuenta se resta", async () => {
    const precio = { inputPer1k: 0.002, outputPer1k: 0.008, cachedInputPer1k: 0.0002 };
    const leidas = 5_000;
    const escritas = 2_000;
    const normales = 1_000;
    const r = await correr("gpt-5.6", precio, {
      inputTokens: normales + leidas + escritas,
      outputTokens: 100,
      cachedInputTokens: leidas,
      cacheWriteInputTokens: escritas,
    });
    const conCache = (normales / 1000) * 0.002 + (leidas / 1000) * 0.0002 + (escritas / 1000) * 0.002 * 1.25;
    const sinCache = ((normales + leidas + escritas) / 1000) * 0.002;
    expect(r.nativeSavings).toMatchObject({ provider: "openai", mechanism: "automatic", basis: "measured" });
    expect(r.nativeSavings!.netUsd).toBeCloseTo(sinCache - conCache, 10);
  });

  it("OpenAI anterior a la 5.6: sin prima de escritura", async () => {
    const precio = { inputPer1k: 0.0025, outputPer1k: 0.01, cachedInputPer1k: 0.00125 };
    const r = await correr("gpt-4o", precio, {
      inputTokens: 4_000,
      outputTokens: 50,
      cachedInputTokens: 3_000,
      cacheWriteInputTokens: 0,
    });
    expect(r.nativeSavings!.writePremiumUsd).toBe(0);
    expect(r.nativeSavings!.netUsd).toBeCloseTo((3_000 / 1000) * (0.0025 - 0.00125), 12);
  });

  it("Gemini (implícita, endpoint compatible): lectura descontada y sin prima", async () => {
    const precio = { inputPer1k: 0.002, outputPer1k: 0.012, cachedInputPer1k: 0.0002 };
    const leidas = 6_000;
    const r = await correr("gemini-3.1-pro-preview", precio, {
      inputTokens: 9_000,
      outputTokens: 80,
      cachedInputTokens: leidas,
    });
    const conCache = (3_000 / 1000) * 0.002 + (leidas / 1000) * 0.0002;
    const sinCache = (9_000 / 1000) * 0.002;
    expect(r.nativeSavings).toMatchObject({ provider: "google", mechanism: "implicit", basis: "measured" });
    expect(r.nativeSavings!.writePremiumUsd).toBe(0);
    expect(r.nativeSavings!.netUsd).toBeCloseTo(sinCache - conCache, 10);
  });

  it("escritura en frío sin lectura: el neto es NEGATIVO y se publica tal cual", async () => {
    const precio = { inputPer1k: 0.003, outputPer1k: 0.015, cachedInputPer1k: 0.0003 };
    const r = await correr("claude-sonnet-5", precio, {
      inputTokens: 5_000,
      outputTokens: 10,
      cacheWriteInputTokens: 4_000,
    });
    expect(r.nativeSavings!.netUsd).toBeCloseTo(-(4_000 / 1000) * 0.003 * 0.25, 12);
  });

  it("sin lecturas ni escrituras de caché no hay bloque", async () => {
    const r = await correr("claude-sonnet-5", { inputPer1k: 0.003, outputPer1k: 0.015, cachedInputPer1k: 0.0003 }, {
      inputTokens: 1_000,
      outputTokens: 10,
    });
    expect("nativeSavings" in r).toBe(false);
  });

  it("sin contador completo: conteos sí, dólares a 0 y basis unmeasured", () => {
    const b = ahorroNativo("claude-sonnet-5", { inputPer1k: 0.003, outputPer1k: 0.015, cachedInputPer1k: 0.0003 }, {
      leidos: 1_000, escritos: 0, escritos1h: 0, contadorCompleto: false,
    })!;
    expect(b).toMatchObject({ basis: "unmeasured", readDiscountUsd: 0, writePremiumUsd: 0, netUsd: 0, cacheReadTokens: 1_000 });
  });

  it("sin precio de lectura en el catálogo no se inventa un descuento", () => {
    const b = ahorroNativo("modelo-propio", { inputPer1k: 0.001, outputPer1k: 0.002 }, {
      leidos: 1_000, escritos: 0, escritos1h: 0, contadorCompleto: true,
    })!;
    expect(b).toMatchObject({ provider: "unknown", basis: "unmeasured", netUsd: 0 });
  });
});

describe("⛔ el ahorro nativo no mueve la comisión ni un céntimo", () => {
  const precio = { inputPer1k: 0.003, outputPer1k: 0.015, cachedInputPer1k: 0.0003 };

  it("en el SDK: el ahorro acreditado (baseline − actual) es el mismo con 8.000 tokens de caché que con 0", async () => {
    const con = await correr("claude-sonnet-5", precio, {
      inputTokens: 10_000, outputTokens: 100, cachedInputTokens: 8_000,
    });
    const sin = await correr("claude-sonnet-5", precio, { inputTokens: 10_000, outputTokens: 100 });
    expect(con.nativeSavings!.netUsd).toBeGreaterThan(0.02);
    expect(con.cost.baselineEstimate - con.cost.actual).toBe(sin.cost.baselineEstimate - sin.cost.actual);
    expect(con.cost.netSavingsRatio).toBe(sin.cost.netSavingsRatio);
    expect(con.cost.basis).toBe(sin.cost.basis);
  });

  it("en el cable: con y sin el bloque, las cifras de dinero y el basis son idénticas", async () => {
    const informe = await correr("claude-sonnet-5", precio, {
      inputTokens: 10_000, outputTokens: 100, cachedInputTokens: 8_000, cacheWriteInputTokens: 1_000,
    });
    const { nativeSavings: _fuera, ...sinBloque } = informe;
    const cable = async (r: SavingsReport) => {
      const calls: RequestInit[] = [];
      const fetchImpl = ((_u: string, init: RequestInit) => {
        calls.push(init);
        return Promise.resolve({ ok: true, status: 202 } as Response);
      }) as unknown as typeof fetch;
      const em = new UsageEmitter({ url: "https://x.test/api/metering/usage", serviceAccountKey: "bvk_x", fetchImpl, now: () => 1_790_000_000_000 });
      em.record(r);
      await em.flush();
      return JSON.parse(calls[0]!.body as string)[0] as Record<string, unknown>;
    };
    const con = await cable(informe);
    const sin = await cable(sinBloque as SavingsReport);
    expect(con["nativeCacheReadSavings"]).toBeCloseTo(8 * (0.003 - 0.0003), 12);
    expect(con["nativeCacheWritePremium"]).toBeCloseTo(1 * 0.003 * 0.25, 12);
    const { nativeCacheReadSavings: _a, nativeCacheWritePremium: _b, ...resto } = con;
    expect(resto).toEqual(sin);
  });

  it("en el ingest (servidor): los dos campos no cambian ningún otro campo del registro", () => {
    const base = {
      requestId: "req-nativo-1",
      model: "claude-sonnet-5",
      at: Date.now(),
      avoidedLlm: 0,
      actualLlm: 1,
      baselineInputTokens: 10_000,
      actualInputTokens: 10_000,
      eliminatedInputTokens: 0,
      compressedInputTokens: 0,
      baselineOutputTokens: 100,
      actualOutputTokens: 100,
      providerCachedInputTokens: 8_000,
      cacheResult: "miss",
      baselineCost: 0.0069,
      actualCost: 0.0069,
      netSavings: 0,
      basis: "measured",
    };
    const sin = parseUsageRecord(base, "org");
    const con = parseUsageRecord({ ...base, nativeCacheReadSavings: 0.0216, nativeCacheWritePremium: 0.00075 }, "org");
    const { nativeCacheReadSavings, nativeCacheWritePremium, ...resto } = con as Record<string, unknown>;
    expect(nativeCacheReadSavings).toBe(0.0216);
    expect(nativeCacheWritePremium).toBe(0.00075);
    expect(resto).toEqual(sin);
  });
});

describe("el gateway publica el mismo bloque, y solo donde hay factura por tokens", () => {
  const uso = {
    input_tokens: 2_000,
    output_tokens: 300,
    cache_read_input_tokens: 40_000,
    cache_creation_input_tokens: 3_000,
  };

  it("Anthropic medido: cuadra con la factura y el coste del informe no cambia", () => {
    const medido = costeMedido("claude-sonnet-5", uso)!;
    const r = informeMedido("req-g1", "claude-sonnet-5", medido);
    const p = medido.precio;
    const sinCache = ((2_000 + 40_000 + 3_000) / 1000) * p.inputPer1k + (300 / 1000) * p.outputPer1k;
    expect(r.nativeSavings).toMatchObject({ provider: "anthropic", basis: "measured", cacheReadTokens: 40_000 });
    expect(r.nativeSavings!.netUsd).toBeCloseTo(sinCache - medido.costeUsd, 10);
    // El carril propio no toca `cost`: sin palanca, baseline == actual y 0 de ahorro.
    expect(r.cost.baselineEstimate).toBe(medido.costeUsd);
    expect(r.cost.actual).toBe(medido.costeUsd);
    expect(r.cost.netSavingsRatio).toBe(0);
  });

  it("suscripción, upstream no oficial y negativa no cobrada: sin bloque (no hay factura por tokens que lo respalde)", () => {
    const medido = costeMedido("claude-sonnet-5", uso)!;
    expect(informeMedido("a", "claude-sonnet-5", medido, undefined, null, null, null, true).nativeSavings).toBeUndefined();
    expect(informeMedido("b", "claude-sonnet-5", medido, undefined, null, null, null, false, true).nativeSavings).toBeUndefined();
    expect(informeMedido("c", "claude-sonnet-5", medido, undefined, null, null, null, false, false, true).nativeSavings).toBeUndefined();
  });
});

describe("una llamada, un bloque", () => {
  it("el seguidor coalescido NO hereda el bloque del líder (se contaría N+1 veces)", async () => {
    const layer = createSavingsLayer({
      provider: {
        id: "lento",
        async generate() {
          await new Promise((r) => setTimeout(r, 10));
          return { text: "compartida", usage: { inputTokens: 9_000, outputTokens: 5, cachedInputTokens: 8_000 } };
        },
      },
      generateId: id,
      costModels: { "claude-sonnet-5": { inputPer1k: 0.003, outputPer1k: 0.015, cachedInputPer1k: 0.0003 } },
    });
    const req = { model: "claude-sonnet-5", messages: [{ role: "user" as const, content: "pregunta cara y única xyz" }] };
    const todos = await Promise.all([layer.generate(req), layer.generate(req), layer.generate(req)]);
    const conBloque = todos.filter((r) => r.report.nativeSavings !== undefined);
    expect(conBloque).toHaveLength(1);
    expect(conBloque[0]!.report.cache.result).toBe("miss");
  });

  it("un acierto de la caché exacta no lleva bloque: no llamó al proveedor", async () => {
    const layer = createSavingsLayer({
      provider: proveedor({ inputTokens: 9_000, outputTokens: 5, cachedInputTokens: 8_000 }),
      generateId: id,
      costModels: { "claude-sonnet-5": { inputPer1k: 0.003, outputPer1k: 0.015, cachedInputPer1k: 0.0003 } },
    });
    const req = { model: "claude-sonnet-5", messages: [{ role: "user" as const, content: "capital de Francia" }] };
    const primera = await layer.generate(req);
    const segunda = await layer.generate(req);
    expect(primera.report.nativeSavings).toBeDefined();
    expect(segunda.report.cache.result).toBe("exact");
    expect(segunda.report.nativeSavings).toBeUndefined();
  });
});

describe("el registro en sombra de Medir no repite el ahorro nativo", () => {
  it("la sombra lleva su hipotético, pero no las cifras nativas del registro medido (se contarían dos veces)", async () => {
    const { informeSombraDeMedir } = await import("../src/metering/emitter.js");
    const medido = {
      requestId: "req-1",
      cache: { result: "miss" },
      cost: { baselineEstimate: 1, actual: 1, netSavingsRatio: 0, basis: "measured" },
      measure: { mode: "shadow", wouldHaveSaved: { usd: 0.4, basis: "shadow", avoidedCall: null } },
      nativeSavings: { provider: "anthropic", mechanism: "cache_control", basis: "measured", readDiscountUsd: 0.2, writePremiumUsd: 0.05, netUsd: 0.15 },
    } as unknown as SavingsReport;
    const sombra = informeSombraDeMedir(medido)!;
    expect(sombra.requestId).toBe("req-1:shadow");
    expect(sombra.cost).toMatchObject({ baselineEstimate: 1, basis: "shadow" });
    expect(sombra.cost.actual).toBeCloseTo(0.6, 12);
    expect(sombra.cost.netSavingsUsd).toBeCloseTo(0.4, 12);
    expect(sombra.cost.netSavingsRatio).toBeCloseTo(0.4, 12);
    expect("nativeSavings" in sombra).toBe(false);
    expect("measure" in sombra).toBe(false);
  });
});
