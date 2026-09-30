import { describe, it, expect, beforeEach } from "vitest";

import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { createSavingsLayer } from "../src/pipeline/create.js";
import { UsageEmitter } from "../src/metering/emitter.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";
import type { Provider, ProviderResponse } from "../src/providers/types.js";
import type { SavingsReport, SavingsRequest } from "../src/contracts/types.js";

/**
 * LAS PALANCAS DE PRECIO POR CONFIGURACIÓN, Y LO QUE NO PUEDEN TOCAR.
 *
 * `priceLevers.deferrable` y `priceLevers.standalone` son el valor por defecto
 * de cada petición, aplicado en la entrada: una petición diferible por
 * configuración tiene que ser indistinguible de una que lo declaró (cuerpo,
 * clave de singleflight, entrega del stream). Siempre gana la petición.
 *
 * Y lo que ninguna palanca de precio toca: el cable de metering y `cost.*`. Su
 * ahorro vive en `report.deferred.tierSaving` y `report.cacheWrites`; cobrar
 * sobre él exige servidor primero, y esta unidad no lo hace.
 */

const OFICIAL = "https://api.openai.com/v1";
const SISTEMA = "Eres un clasificador de incidencias. ".repeat(200);

// El `usage` con la forma del API de OpenAI: `cached_tokens` presente aunque sea 0.
function servidor(
  extra: Record<string, unknown> = {},
  uso: Record<string, unknown> = { prompt_tokens: 3000, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 0 } },
) {
  const enviados: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    enviados.push(JSON.parse(String(init.body)));
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: uso, ...extra }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { enviados, fetchImpl };
}

const peticion = (savings?: SavingsRequest["savings"], model = "openai/gpt-5-mini", pregunta = "enriquece esta fila"): SavingsRequest => ({
  model,
  messages: [
    { role: "system", content: SISTEMA },
    { role: "user", content: pregunta },
  ],
  ...(savings ? { savings } : {}),
});

beforeEach(() => reiniciarAvisos());

describe("priceLevers: el valor por defecto de cada petición", () => {
  it("`priceLevers.deferrable` pide `flex` y publica el bloque, como si la petición lo declarara", async () => {
    const s = servidor({ service_tier: "flex" });
    const layer = createSavingsLayer({
      provider: new OpenAICompatibleProvider({ baseUrl: OFICIAL, fetchImpl: s.fetchImpl }),
      priceLevers: { deferrable: true },
    });
    const { report } = await layer.generate(peticion());
    expect(s.enviados[0]!["service_tier"]).toBe("flex");
    expect(report.deferred!.credited).toBe(true);
    expect(report.deferred!.tierSaving!.basis).toBe("measured");
  });

  it("⛔ `savings.deferrable: false` le gana a la configuración", async () => {
    const s = servidor();
    const layer = createSavingsLayer({
      provider: new OpenAICompatibleProvider({ baseUrl: OFICIAL, fetchImpl: s.fetchImpl }),
      priceLevers: { deferrable: true, standalone: true },
    });
    const { report } = await layer.generate(peticion({ deferrable: false, standalone: false }, "openai/gpt-5.6-luna"));
    expect(s.enviados[0]).not.toHaveProperty("service_tier");
    expect(s.enviados[0]).not.toHaveProperty("prompt_cache_options");
    expect("deferred" in report).toBe(false);
    expect("cacheWrites" in report).toBe(false);
  });

  it("`priceLevers.standalone` manda el modo explícito en GPT-5.6", async () => {
    const s = servidor();
    const layer = createSavingsLayer({
      provider: new OpenAICompatibleProvider({ baseUrl: OFICIAL, fetchImpl: s.fetchImpl }),
      priceLevers: { standalone: true },
    });
    const { report } = await layer.generate(peticion(undefined, "openai/gpt-5.6-luna"));
    expect(s.enviados[0]!["prompt_cache_options"]).toEqual({ mode: "explicit" });
    expect(report.cacheWrites!.mode).toBe("explicit");
  });

  it("⛔ sin `priceLevers` (o con todo apagado) el cuerpo es el de siempre", async () => {
    for (const priceLevers of [undefined, {}, { deferrable: false, standalone: false }]) {
      const a = servidor();
      const b = servidor();
      await createSavingsLayer({ provider: new OpenAICompatibleProvider({ baseUrl: OFICIAL, fetchImpl: a.fetchImpl }) })
        .generate(peticion(undefined, "openai/gpt-5.6-luna"));
      await createSavingsLayer({
        provider: new OpenAICompatibleProvider({ baseUrl: OFICIAL, fetchImpl: b.fetchImpl }),
        ...(priceLevers ? { priceLevers } : {}),
      }).generate(peticion(undefined, "openai/gpt-5.6-luna"));
      expect(b.enviados[0]).toEqual(a.enviados[0]);
    }
  });

  it("un stream diferible por configuración se entrega entero, igual que uno declarado", async () => {
    const s = servidor({ service_tier: "flex" });
    const layer = createSavingsLayer({
      provider: new OpenAICompatibleProvider({ baseUrl: OFICIAL, fetchImpl: s.fetchImpl }),
      priceLevers: { deferrable: true },
    });
    const stream = layer.generateStream(peticion());
    const r = await stream.result;
    expect(r.report.streaming?.wholeReason).toBe("deferrable");
    expect(s.enviados[0]!["service_tier"]).toBe("flex");
  });
});

/** Dos peticiones concurrentes contra un proveedor que espera a que entren las dos. */
async function concurrentes(
  priceLevers: { deferrable?: boolean },
  a: SavingsRequest,
  b: SavingsRequest,
): Promise<number> {
  let soltar: (() => void) | undefined;
  const puerta = new Promise<void>((res) => (soltar = res));
  let llamadas = 0;
  const lento: Provider = {
    id: "lento",
    async generate(): Promise<ProviderResponse> {
      llamadas += 1;
      await puerta;
      return { text: "ok", usage: { inputTokens: 1000, outputTokens: 20 } };
    },
  };
  const layer = createSavingsLayer({ provider: lento, priceLevers });
  const pa = layer.generate(a);
  const pb = layer.generate(b);
  await new Promise((r) => setTimeout(r, 0));
  soltar!();
  await Promise.all([pa, pb]);
  return llamadas;
}

describe("priceLevers y las claves: igual que el valor por petición", () => {
  it("diferible por configuración coalesce con diferible declarado (misma clave)", async () => {
    expect(await concurrentes({ deferrable: true }, peticion(), peticion({ deferrable: true }))).toBe(1);
  });

  it("⛔ diferible por configuración NO coalesce con quien dijo `deferrable: false`", async () => {
    expect(await concurrentes({ deferrable: true }, peticion(), peticion({ deferrable: false }))).toBe(2);
  });

  it("`standalone` no parte la caché exacta: no cambia la respuesta", async () => {
    const s = servidor();
    const layer = createSavingsLayer({ provider: new OpenAICompatibleProvider({ baseUrl: OFICIAL, fetchImpl: s.fetchImpl }) });
    await layer.generate(peticion({ standalone: true }, "openai/gpt-5.6-luna"));
    const segunda = await layer.generate(peticion(undefined, "openai/gpt-5.6-luna"));
    expect(segunda.report.cache.result).toBe("exact");
    expect(s.enviados).toHaveLength(1);
  });
});

// ── El cable y el dinero: ninguna palanca de precio los toca ────────────────

async function alCable(report: SavingsReport): Promise<Record<string, unknown>> {
  const cuerpos: string[] = [];
  const fetchImpl = ((_url: string, init: RequestInit) => {
    cuerpos.push(String(init.body));
    return Promise.resolve({ ok: true, status: 202 } as Response);
  }) as unknown as typeof fetch;
  const em = new UsageEmitter({ url: "https://savings.example.com/api/metering/usage", serviceAccountKey: "bvk_prueba", fetchImpl });
  em.record(report);
  await em.flush();
  return (JSON.parse(cuerpos[0]!) as Record<string, unknown>[])[0]!;
}

describe("el cable y `cost.*` no cambian con las palancas de precio", () => {
  it("⛔ con `tierSaving` y `cacheWrites` presentes, las claves del cable son las de siempre", async () => {
    const uso = { prompt_tokens: 3000, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 1200 } };
    const sin = await createSavingsLayer({
      provider: new OpenAICompatibleProvider({ baseUrl: OFICIAL, fetchImpl: servidor({ service_tier: "flex" }, uso).fetchImpl }),
    }).generate(peticion(undefined, "openai/gpt-5.6-luna"));
    const con = await createSavingsLayer({
      provider: new OpenAICompatibleProvider({ baseUrl: OFICIAL, fetchImpl: servidor({ service_tier: "flex" }, uso).fetchImpl }),
      priceLevers: { deferrable: true, standalone: true },
    }).generate(peticion(undefined, "openai/gpt-5.6-luna"));

    expect(con.report.deferred!.tierSaving).toBeDefined();
    expect(con.report.cacheWrites!.avoidedWritePremium).toBeDefined();

    const cableSin = await alCable(sin.report);
    const cableCon = await alCable(con.report);
    expect(Object.keys(cableCon).sort()).toEqual(Object.keys(cableSin).sort());
    expect(JSON.stringify(cableCon)).not.toMatch(/tierSaving|cacheWrites|avoidedWritePremium/);

    // Y el dinero publicado es el mismo: ni el tier ni el modo explícito entran en `cost.*`.
    expect(con.report.cost.baselineEstimate).toBe(sin.report.cost.baselineEstimate);
    expect(con.report.cost.actual).toBe(sin.report.cost.actual);
    expect(con.report.cost.netSavingsRatio).toBe(sin.report.cost.netSavingsRatio);
    expect(con.report.cost.basis).toBe(sin.report.cost.basis);
    expect(cableCon["actualCost"]).toBe(cableSin["actualCost"]);
    expect(cableCon["netSavings"]).toBe(cableSin["netSavings"]);
  });
});
