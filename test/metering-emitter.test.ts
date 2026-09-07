import { describe, it, expect } from "vitest";

import { UsageEmitter } from "../src/metering/emitter.js";
import type { SavingsReport } from "../src/contracts/types.js";
import { BV_SALA_VERSION, CABECERA_VERSION } from "../src/version.js";

function mkReport(requestId = "req-abc"): SavingsReport {
  return {
    requestId,
    model: "openai/gpt-4o-mini",
    calls: { avoidedLlm: 0, actualLlm: 1 },
    tokens: {
      baselineInput: 100,
      actualInput: 40,
      eliminatedInput: 60,
      compressedInput: 0,
      baselineOutput: 20,
      actualOutput: 20,
    },
    cache: { result: "miss" },
    cost: { baselineEstimate: 0.001, actual: 0.0004, netSavings: 0.0006 },
  } as unknown as SavingsReport;
}

function okFetch() {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve({ ok: true, status: 202 } as Response);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const URL = "https://savings.bivelio.com/api/metering/usage";

describe("UsageEmitter", () => {
  it("POSTs counts-only records with the Bearer key, seatId and ci stamped", async () => {
    const { fn, calls } = okFetch();
    const em = new UsageEmitter({ url: URL, serviceAccountKey: "bvk_secret", fetchImpl: fn });
    em.setSeat("m-abc123", true);
    em.record(mkReport("req-1"));
    await em.flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(URL);
    expect((calls[0]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer bvk_secret");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].seatId).toBe("m-abc123");
    expect(body[0].ci).toBe(true);
    expect(body[0].requestId).toBe("req-1");
    expect(body[0].actualInputTokens).toBe(40);
  });

  /**
   * EL CONJUNTO DE CABECERAS ES EXACTO, no «contiene». La versión viaja en una
   * cabecera precisamente porque una cabecera esquiva la lista blanca del
   * ingest (un servidor viejo la ignora): ese mismo argumento serviría para
   * colar cualquier campo futuro sin pasar por el cortafuegos de contenido. La
   * excepción es UNA y este test la ata: quien quiera otra cabecera tiene que
   * venir aquí a declararla.
   */
  it("el POST lleva EXACTAMENTE content-type, authorization y x-bvsala-version (sdk/ por defecto)", async () => {
    const { fn, calls } = okFetch();
    const em = new UsageEmitter({ url: URL, serviceAccountKey: "bvk_x", fetchImpl: fn });
    em.record(mkReport());
    await em.flush();
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(Object.keys(headers).sort()).toEqual(["authorization", "content-type", "x-bvsala-version"]);
    expect(CABECERA_VERSION).toBe("x-bvsala-version");
    expect(headers[CABECERA_VERSION]).toBe(`sdk/${BV_SALA_VERSION}`);
    // El valor casa el patrón cerrado que valida el servidor: superficie/semver.
    expect(headers[CABECERA_VERSION]).toMatch(/^(gateway|sdk)\/\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z.-]{1,16})?$/);
  });

  it("con surface: \"gateway\" la cabecera declara gateway/<versión>", async () => {
    const { fn, calls } = okFetch();
    const em = new UsageEmitter({ url: URL, serviceAccountKey: "bvk_x", fetchImpl: fn, surface: "gateway" });
    em.record(mkReport());
    await em.flush();
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers[CABECERA_VERSION]).toBe(`gateway/${BV_SALA_VERSION}`);
    expect(Object.keys(headers).sort()).toEqual(["authorization", "content-type", "x-bvsala-version"]);
  });

  it("la versión NO viaja en el cuerpo: el wire sigue sin ningún campo de versión", async () => {
    const { fn, calls } = okFetch();
    const em = new UsageEmitter({ url: URL, serviceAccountKey: "bvk_x", fetchImpl: fn, surface: "gateway" });
    em.record(mkReport());
    await em.flush();
    const rec = JSON.parse(calls[0]!.init.body as string)[0];
    for (const k of ["clientVersion", "version", "sdkVersion", "surface"]) expect(rec[k]).toBeUndefined();
  });

  it("PRIVACY: the wire body carries only counts/metadata — never content", async () => {
    const { fn, calls } = okFetch();
    const em = new UsageEmitter({ url: URL, serviceAccountKey: "bvk_x", fetchImpl: fn });
    em.record(mkReport());
    await em.flush();
    const rec = JSON.parse(calls[0]!.init.body as string)[0];
    const ALLOWED = new Set([
      "orgId", "seatId", "ci", "requestId", "model", "at",
      "avoidedLlm", "actualLlm", "baselineInputTokens", "actualInputTokens",
      "eliminatedInputTokens", "compressedInputTokens", "baselineOutputTokens",
      "actualOutputTokens", "providerCachedInputTokens", "cacheResult",
      "baselineCost", "actualCost", "netSavings",
    ]);
    for (const k of Object.keys(rec)) expect(ALLOWED.has(k)).toBe(true);
    for (const forbidden of ["prompt", "completion", "messages", "text", "content", "data"]) {
      expect(rec[forbidden]).toBeUndefined();
    }
  });

  it("stamps the seat resolved AFTER records were buffered (none lost)", async () => {
    const { fn, calls } = okFetch();
    const em = new UsageEmitter({ url: URL, serviceAccountKey: "bvk_x", fetchImpl: fn });
    em.record(mkReport("early")); // recorded before the seat is known
    em.setSeat("m-late", false); // seat resolves later
    await em.flush();
    expect(JSON.parse(calls[0]!.init.body as string)[0].seatId).toBe("m-late");
  });

  it("never throws and re-queues on a network error (retry later)", async () => {
    let attempts = 0;
    const fn = (() => {
      attempts++;
      return Promise.reject(new Error("network down"));
    }) as unknown as typeof fetch;
    const em = new UsageEmitter({ url: URL, serviceAccountKey: "bvk_x", fetchImpl: fn });
    em.record(mkReport());
    await expect(em.flush()).resolves.toBeUndefined(); // never throws
    await em.flush(); // the record survived the failure → it is retried
    expect(attempts).toBe(2);
  });

  it("drops a batch on a 4xx (retrying a rejected payload would loop)", async () => {
    let hits = 0;
    const fn = (() => {
      hits++;
      return Promise.resolve({ ok: false, status: 400 } as Response);
    }) as unknown as typeof fetch;
    const em = new UsageEmitter({ url: URL, serviceAccountKey: "bvk_x", fetchImpl: fn });
    em.record(mkReport());
    await em.flush();
    await em.flush(); // buffer should be empty now → no second POST
    expect(hits).toBe(1);
  });

  it("caps records per POST at maxBatch", async () => {
    const { fn, calls } = okFetch();
    const em = new UsageEmitter({ url: URL, serviceAccountKey: "bvk_x", fetchImpl: fn, maxBatch: 3 });
    for (let i = 0; i < 5; i++) em.record(mkReport(`r${i}`));
    await em.flush();
    expect(JSON.parse(calls[0]!.init.body as string)).toHaveLength(3);
  });

  it("hard-caps the buffer (drops oldest) so an outage can't grow memory unbounded", async () => {
    const { fn, calls } = okFetch();
    const em = new UsageEmitter({ url: URL, serviceAccountKey: "bvk_x", fetchImpl: fn, maxBuffer: 2, maxBatch: 10 });
    em.record(mkReport("oldest"));
    em.record(mkReport("mid"));
    em.record(mkReport("newest"));
    await em.flush();
    const ids = JSON.parse(calls[0]!.init.body as string).map((r: { requestId: string }) => r.requestId);
    expect(ids).toEqual(["mid", "newest"]); // "oldest" dropped
  });

  it("stopAndDrain ESPERA el envío del último lote (el que `bvsala claude` perdía al salir)", async () => {
    const { fn, calls } = okFetch();
    const em = new UsageEmitter({ url: URL, serviceAccountKey: "bvk_x", fetchImpl: fn });
    em.record(mkReport("ultimo"));
    await em.stopAndDrain();
    // La promesa resolvió SOLO tras el POST: el lote ya salió, no se perdió.
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.init.body as string)[0].requestId).toBe("ultimo");
  });

  it("stopAndDrain vacía un buffer mayor que un lote, en varias tandas", async () => {
    const { fn, calls } = okFetch();
    const em = new UsageEmitter({ url: URL, serviceAccountKey: "bvk_x", fetchImpl: fn, maxBatch: 2 });
    for (let i = 0; i < 5; i++) em.record(mkReport(`r${i}`));
    await em.stopAndDrain();
    const enviados = calls.flatMap((c) => JSON.parse(c.init.body as string).length);
    expect(enviados.reduce((a, b) => a + b, 0)).toBe(5); // los 5, ninguno perdido
  });

  it("stopAndDrain no se cuelga si el control plane devuelve 5xx (apagado acotado)", async () => {
    const fn = (() => Promise.resolve({ ok: false, status: 503 } as Response)) as unknown as typeof fetch;
    const em = new UsageEmitter({ url: URL, serviceAccountKey: "bvk_x", fetchImpl: fn });
    em.record(mkReport("atascado"));
    await em.stopAndDrain(); // resuelve pese al 5xx que re-encola
    expect(true).toBe(true);
  });
});
