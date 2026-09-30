import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EmisorDeVerificacion, muestraEnElCable, type SobreDeVerificacion } from "../src/verification/emisor.js";
import { UsageEmitter } from "../src/metering/emitter.js";
import { BV_SALA_VERSION } from "../src/version.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";
import type { VerificationCheck } from "../src/contracts/verification.js";
import type { SavingsReport } from "../src/contracts/types.js";

/**
 * EL EMISOR DE LOS PARES: canal propio, sobre cerrado, reintento con el MISMO
 * batchId, y ninguna interferencia con la medición de uso.
 */

const URL_VERIF = "https://savings.example.test/api/metering/verification";
const AT = 1_790_000_000_000;

function check(extra: Partial<VerificationCheck> = {}): VerificationCheck {
  return {
    requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
    at: AT,
    stratum: "tokens_removed",
    outcome: "paired",
    requestedModel: "openai/gpt-4o-mini",
    servedModel: "openai/gpt-4o-mini",
    cacheResult: "miss",
    optimized: { cost: 0.0001234, inputTokens: 900, cachedInputTokens: 0, outputTokens: 120 },
    naive: { cost: 0.000270, inputTokens: 1300, cachedInputTokens: 0, outputTokens: 125, finishReason: "stop", contract: "none" },
    prices: { inputPer1k: 0.00015, cachedInputPer1k: 0.000075, outputPer1k: 0.0006 },
    ...extra,
  };
}

interface Envio {
  url: string;
  init: RequestInit;
  cuerpo: { batchId: string; samples: Array<Record<string, unknown>>; counts: Array<Record<string, unknown>> };
}

function fetchConEstados(estados: number[]) {
  const envios: Envio[] = [];
  const f = (async (url: string, init: RequestInit) => {
    envios.push({ url: String(url), init, cuerpo: JSON.parse(String(init.body)) });
    const status = estados.length > 0 ? estados.shift()! : 202;
    return new Response("{}", { status });
  }) as unknown as typeof fetch;
  return { envios, f };
}

let avisos: string[] = [];
beforeEach(() => {
  reiniciarAvisos();
  avisos = [];
  vi.spyOn(console, "warn").mockImplementation((m: unknown) => {
    avisos.push(String(m));
  });
});
afterEach(() => vi.restoreAllMocks());

describe("el sobre", () => {
  it("va a /api/metering/verification con EXACTAMENTE tres cabeceras", async () => {
    const { envios, f } = fetchConEstados([]);
    const e = new EmisorDeVerificacion({ url: URL_VERIF, serviceAccountKey: "bvk_prueba", fetchImpl: f });
    e.encolar(check());
    await e.flush();
    expect(envios).toHaveLength(1);
    expect(envios[0]!.url).toBe(URL_VERIF);
    expect(envios[0]!.init.method).toBe("POST");
    expect(envios[0]!.init.headers).toEqual({
      authorization: "Bearer bvk_prueba",
      "content-type": "application/json",
      "x-bvsala-version": `sdk/${BV_SALA_VERSION}`,
    });
  });

  it("claves del cuerpo exactas y lista blanca de cada muestra", async () => {
    const { envios, f } = fetchConEstados([]);
    const e = new EmisorDeVerificacion({ url: URL_VERIF, serviceAccountKey: "bvk_prueba", fetchImpl: f });
    e.encolar(check());
    e.encolar(check({ outcome: "abandoned", naive: undefined }));
    e.contar("2026-09-25", "tokens_removed");
    e.contar("2026-09-25", "tokens_removed");
    e.contar("2026-09-25", "fail_open");
    await e.flush();
    const cuerpo = envios[0]!.cuerpo;
    expect(Object.keys(cuerpo).sort()).toEqual(["batchId", "counts", "samples"]);
    expect(cuerpo.batchId).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(Object.keys(cuerpo.samples[0]!).sort()).toEqual(
      [
        "at", "basis", "cacheResult", "cachedInputPer1k", "inputPer1k", "naiveCachedInputTokens", "naiveContract",
        "naiveCost", "naiveFinishReason", "naiveInputTokens", "naiveOutputTokens", "optimizedCachedInputTokens",
        "optimizedCost", "optimizedInputTokens", "optimizedOutputTokens", "outcome", "outputPer1k", "requestId",
        "requestedModel", "servedModel", "stratum",
      ].sort(),
    );
    expect(cuerpo.samples[0]!["basis"]).toBe("verification");
    // Sin par, ni una clave `naive*`.
    expect(Object.keys(cuerpo.samples[1]!).filter((k) => k.startsWith("naive"))).toEqual([]);
    expect(cuerpo.counts).toEqual([
      { day: "2026-09-25", category: "tokens_removed", requests: 2 },
      { day: "2026-09-25", category: "fail_open", requests: 1 },
    ]);
    // Nada de contenido: ni una cadena larga en todo el sobre.
    expect(JSON.stringify(cuerpo)).not.toMatch(/prompt|content|text/);
  });

  it("los conteos se ponen a cero al crear el sobre", async () => {
    const { envios, f } = fetchConEstados([]);
    const e = new EmisorDeVerificacion({ url: URL_VERIF, serviceAccountKey: "bvk_prueba", fetchImpl: f });
    e.contar("2026-09-25", "unchanged");
    await e.flush();
    expect(e.estado.conteos).toBe(0);
    await e.flush();
    expect(envios).toHaveLength(1);
    e.contar("2026-09-25", "unchanged");
    await e.flush();
    expect(envios[1]!.cuerpo.counts).toEqual([{ day: "2026-09-25", category: "unchanged", requests: 1 }]);
  });

  it("una muestra que el servidor rechazaría no viaja (no tumba el lote)", () => {
    expect(muestraEnElCable(check({ requestId: "con espacios" }))).toBeNull();
    expect(muestraEnElCable(check({ requestedModel: "modelo@vertex" }))).toBeNull();
    expect(muestraEnElCable(check({ at: 1000 }))).toBeNull();
    expect(muestraEnElCable(check({ optimized: { cost: 5000, inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 } }))).toBeNull();
    expect(muestraEnElCable(check({ optimized: { cost: 0.1, inputTokens: 1.5, cachedInputTokens: 0, outputTokens: 1 } }))).toBeNull();
    expect(muestraEnElCable(check())).not.toBeNull();
  });

  it("un `at` más de 48 h por delante del reloj del emisor no viaja (el servidor tumbaría el lote, conteos incluidos)", async () => {
    const h = 3600 * 1000;
    expect(muestraEnElCable(check({ at: AT + 49 * h }), { ahora: AT })).toBeNull();
    expect(muestraEnElCable(check({ at: AT + 47 * h }), { ahora: AT })).not.toBeNull();
    // Por el emisor, con su `now`: la muestra adelantada se cae sola y el sobre sale con los conteos.
    const { envios, f } = fetchConEstados([]);
    const e = new EmisorDeVerificacion({ url: URL_VERIF, serviceAccountKey: "bvk_prueba", fetchImpl: f, now: () => AT });
    e.encolar(check({ at: AT + 72 * h }));
    e.encolar(check());
    e.contar("2026-09-21", "unchanged");
    await e.flush();
    expect(envios).toHaveLength(1);
    expect(envios[0]!.cuerpo.samples).toHaveLength(1);
    expect(envios[0]!.cuerpo.counts).toHaveLength(1);
  });
});

describe("fallos", () => {
  it("5xx → reintento con el MISMO batchId", async () => {
    const { envios, f } = fetchConEstados([503, 202]);
    const e = new EmisorDeVerificacion({ url: URL_VERIF, serviceAccountKey: "bvk_prueba", fetchImpl: f });
    e.encolar(check());
    await e.flush();
    expect(e.estado.reintentos).toBe(1);
    await e.flush();
    expect(envios).toHaveLength(2);
    expect(envios[1]!.cuerpo.batchId).toBe(envios[0]!.cuerpo.batchId);
    expect(envios[1]!.cuerpo).toEqual(envios[0]!.cuerpo);
    expect(e.estado.reintentos).toBe(0);
  });

  it("error de red → reintento con el mismo batchId", async () => {
    const envios: string[] = [];
    let n = 0;
    const f = (async (_url: string, init: RequestInit) => {
      envios.push(JSON.parse(String(init.body)).batchId);
      if (n++ === 0) throw new Error("ECONNRESET");
      return new Response("{}", { status: 202 });
    }) as unknown as typeof fetch;
    const e = new EmisorDeVerificacion({ url: URL_VERIF, serviceAccountKey: "bvk_prueba", fetchImpl: f });
    e.encolar(check());
    await e.flush();
    await e.flush();
    expect(envios).toHaveLength(2);
    expect(envios[0]).toBe(envios[1]);
  });

  it("401/403 → se descarta y avisa UNA vez (W4)", async () => {
    const { envios, f } = fetchConEstados([401, 401]);
    const e = new EmisorDeVerificacion({ url: URL_VERIF, serviceAccountKey: "bvk_prueba", fetchImpl: f });
    e.encolar(check());
    await e.flush();
    e.encolar(check());
    await e.flush();
    expect(envios).toHaveLength(2);
    expect(e.estado.reintentos).toBe(0);
    expect(avisos).toEqual([
      `[bvsala] verification reporting is being rejected with HTTP 401 at ${URL_VERIF}. Check \`serviceAccountKey\`. Pairs are not reaching your dashboard; your requests and your usage reporting are not affected.`,
    ]);
  });

  it("otro 4xx → se descarta; W5 al 3.º seguido y luego cada 12", async () => {
    const { f } = fetchConEstados(Array.from({ length: 20 }, () => 404));
    const e = new EmisorDeVerificacion({ url: URL_VERIF, serviceAccountKey: "bvk_prueba", fetchImpl: f });
    for (let i = 0; i < 15; i++) {
      e.encolar(check());
      await e.flush();
    }
    expect(e.estado.reintentos).toBe(0);
    expect(avisos).toHaveLength(2);
    expect(avisos[0]).toBe(
      `[bvsala] verification reporting has failed 3 times in a row against ${URL_VERIF} (HTTP 404: the reporting URL looks wrong, or the server does not have this feature yet). Your requests and usage reporting keep working; the pairs are not arriving.`,
    );
    expect(avisos[1]).toMatch(/has failed 15 times in a row/);
  });

  it("`silenceWarnings` calla W4 y W5", async () => {
    const { f } = fetchConEstados([401, 404, 404, 404]);
    const e = new EmisorDeVerificacion({ url: URL_VERIF, serviceAccountKey: "bvk_prueba", fetchImpl: f, silenceWarnings: true });
    for (let i = 0; i < 4; i++) {
      e.encolar(check());
      await e.flush();
    }
    expect(avisos).toEqual([]);
  });
});

describe("cuándo se envía", () => {
  it("al llegar a 200 muestras, sin esperar al intervalo", async () => {
    const { envios, f } = fetchConEstados([]);
    const e = new EmisorDeVerificacion({ url: URL_VERIF, serviceAccountKey: "bvk_prueba", fetchImpl: f });
    for (let i = 0; i < 199; i++) e.encolar(check());
    await Promise.resolve();
    expect(envios).toHaveLength(0);
    e.encolar(check());
    await new Promise((r) => setTimeout(r, 0));
    expect(envios).toHaveLength(1);
    expect(envios[0]!.cuerpo.samples).toHaveLength(200);
  });

  it("stop() vacía lo pendiente", async () => {
    const { envios, f } = fetchConEstados([]);
    const e = new EmisorDeVerificacion({ url: URL_VERIF, serviceAccountKey: "bvk_prueba", fetchImpl: f, flushIntervalMs: 60_000 });
    e.start();
    e.encolar(check());
    e.stop();
    await new Promise((r) => setTimeout(r, 0));
    expect(envios).toHaveLength(1);
  });

  it("con un reintento de un fallo RECIENTE, el umbral y el reposo esperan al intervalo (sin POST por cada comprobación)", async () => {
    let t = AT;
    const { envios, f } = fetchConEstados([503, 202, 202]);
    const e = new EmisorDeVerificacion({ url: URL_VERIF, serviceAccountKey: "bvk_prueba", fetchImpl: f, now: () => t, flushIntervalMs: 15_000 });
    e.encolar(check());
    await e.flush(); // 503 → reintento pendiente
    expect(envios).toHaveLength(1);
    expect(e.estado.reintentos).toBe(1);
    for (let i = 0; i < 250; i++) e.encolar(check()); // cruza el umbral de 200
    await e.flushSiToca(); // el reposo tras la última copia
    await new Promise((r) => setTimeout(r, 0));
    expect(envios).toHaveLength(1);
    // Pasado el intervalo desde el fallo, vuelve a enviar: primero el reintento, con el MISMO batchId.
    t += 15_000;
    await e.flushSiToca();
    expect(envios.length).toBeGreaterThanOrEqual(2);
    expect(envios[1]!.cuerpo.batchId).toBe(envios[0]!.cuerpo.batchId);
    expect(e.estado.reintentos).toBe(0);
  });

  it("sin reintentos pendientes, el reposo vacía en el acto (serverless no pierde el par)", async () => {
    const { envios, f } = fetchConEstados([]);
    const e = new EmisorDeVerificacion({ url: URL_VERIF, serviceAccountKey: "bvk_prueba", fetchImpl: f, flushIntervalMs: 60_000 });
    e.encolar(check());
    await e.flushSiToca();
    expect(envios).toHaveLength(1);
  });

  it("más de 10 reintentos: se descarta el MÁS ANTIGUO (el del fondo), no el que acaba de fallar", () => {
    // Hoy no llega a pasar (siguienteSobre no crea sobres nuevos mientras quede
    // un reintento), pero el comentario prometía esto y el código hacía lo contrario.
    const e = new EmisorDeVerificacion({ url: URL_VERIF, serviceAccountKey: "bvk_prueba", fetchImpl: fetchConEstados([]).f });
    const interno = e as unknown as { reencolar(s: SobreDeVerificacion): void; reintentos: SobreDeVerificacion[] };
    for (let i = 0; i < 11; i++) interno.reencolar({ batchId: `lote-${i}`, samples: [], counts: [] });
    expect(interno.reintentos.map((s) => s.batchId)).toEqual(Array.from({ length: 10 }, (_, k) => `lote-${10 - k}`));
  });

  it("el buffer está acotado a 2000 (se tiran las más antiguas)", () => {
    const e = new EmisorDeVerificacion({ url: URL_VERIF, serviceAccountKey: "bvk_prueba", fetchImpl: (async () => new Promise(() => {})) as unknown as typeof fetch });
    for (let i = 0; i < 2500; i++) e.encolar(check());
    expect(e.estado.pendientes).toBeLessThanOrEqual(2000);
  });
});

describe("independencia de la medición de uso", () => {
  it("un 404 del canal de verificación no altera los POST de UsageEmitter", async () => {
    const usos: string[] = [];
    const f = (async (url: string, init: RequestInit) => {
      if (String(url).endsWith("/api/metering/verification")) return new Response("not found", { status: 404 });
      usos.push(String(init.body));
      return new Response("{}", { status: 202 });
    }) as unknown as typeof fetch;
    const uso = new UsageEmitter({ url: "https://savings.example.test/api/metering/usage", serviceAccountKey: "bvk_prueba", fetchImpl: f });
    const verif = new EmisorDeVerificacion({ url: URL_VERIF, serviceAccountKey: "bvk_prueba", fetchImpl: f });
    const informe = {
      requestId: "r-1",
      model: "openai/gpt-4o-mini",
      calls: { avoidedLlm: 0, actualLlm: 1 },
      tokens: { baselineInput: 10, actualInput: 10, eliminatedInput: 0, compressedInput: 0, baselineOutput: 5, actualOutput: 5 },
      cache: { result: "miss" },
      cost: { baselineEstimate: 0.01, actual: 0.01, netSavingsRatio: 0, basis: "measured" },
    } as unknown as SavingsReport;
    for (let i = 0; i < 5; i++) {
      verif.encolar(check());
      await verif.flush();
      uso.record({ ...informe, requestId: `r-${i}` });
      await uso.flush();
    }
    expect(usos).toHaveLength(5);
    expect(usos.every((b) => JSON.parse(b).length === 1)).toBe(true);
  });
});
