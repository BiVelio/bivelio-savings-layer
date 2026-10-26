import { describe, it, expect } from "vitest";

import { UsageEmitter } from "../src/metering/emitter.js";
import type { SavingsReport } from "../src/contracts/types.js";
import { BV_SALA_VERSION, CABECERA_VERSION } from "../src/version.js";
import { CAMPOS_DEL_REGISTRO_DE_USO } from "../apps/web/lib/metering/usage.js";

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
    cost: { baselineEstimate: 0.001, actual: 0.0004, netSavingsRatio: 0.0006 },
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
      "eliminatedInputFloorCost", // B2 (0.4.17): opcional, solo con dinero y conteo
      "basis", "referenceRequestId", "referenceAt", // medido por referencia: ids y un instante
      "nativeCacheReadSavings", "nativeCacheWritePremium", // 0032: ahorro nativo, carril propio sin comisión
    ]);
    for (const k of Object.keys(rec)) expect(ALLOWED.has(k)).toBe(true);
    for (const forbidden of ["prompt", "completion", "messages", "text", "content", "data"]) {
      expect(rec[forbidden]).toBeUndefined();
    }
  });

  /**
   * B2 · el suelo de la elisión del proveedor en el wire. Es el campo que
   * cumple al pie de la letra la regla «servidor primero»: la lista blanca y
   * la migración 0025 se desplegaron ANTES de que el emisor lo mandara, y aun
   * así viaja solo cuando hay dinero y conteo.
   */
  describe("eliminatedInputFloorCost (B2)", () => {
    async function wireDe(report: SavingsReport): Promise<Record<string, unknown>> {
      const { fn, calls } = okFetch();
      const em = new UsageEmitter({ url: URL, serviceAccountKey: "bvk_x", fetchImpl: fn });
      em.record(report);
      await em.flush();
      return (JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>[])[0]!;
    }
    function conSuelo(suelo: number | undefined, eliminatedInput = 60): SavingsReport {
      const r = mkReport() as unknown as { tokens: { eliminatedInput: number }; cost: Record<string, unknown> };
      r.tokens.eliminatedInput = eliminatedInput;
      if (suelo !== undefined) r.cost["eliminatedInputFloorCost"] = suelo;
      return r as unknown as SavingsReport;
    }

    it("un informe sin suelo manda el wire de siempre: la clave NO existe", async () => {
      expect("eliminatedInputFloorCost" in (await wireDe(mkReport()))).toBe(false);
    });

    it("con suelo > 0 y conteo > 0 viaja tal cual", async () => {
      expect((await wireDe(conSuelo(0.0009)))["eliminatedInputFloorCost"]).toBe(0.0009);
    });

    it("⛔ «dinero sin conteo» no sale de aquí (el ingest lo recortaría a 0 de todas formas)", async () => {
      expect("eliminatedInputFloorCost" in (await wireDe(conSuelo(0.5, 0)))).toBe(false);
    });

    it("⛔ ni 0, ni negativo, ni NaN", async () => {
      for (const malo of [0, -0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect("eliminatedInputFloorCost" in (await wireDe(conSuelo(malo))), String(malo)).toBe(false);
      }
    });
  });

  /**
   * EL LIBRO DE CALIDAD NO VIAJA. Su promesa pública es «never leaves your
   * process», y el ingest valida con lista blanca: un campo desconocido tumbaría
   * el lote entero. Se registra un informe con el libro COMPLETO (todos los
   * bloques) y se compara el cuerpo del POST con la lista blanca DEL SERVIDOR,
   * no con una copia local que podría quedarse atrás.
   */
  it("el libro de calidad no viaja: el cuerpo ⊆ la lista blanca del ingest", async () => {
    const { fn, calls } = okFetch();
    const em = new UsageEmitter({ url: URL, serviceAccountKey: "bvk_x", fetchImpl: fn });
    const conLibro = {
      ...mkReport("req-libro"),
      qualityStatus: "task_equivalent",
      qualityLedger: {
        source: "coalesced",
        sharedFrom: "semantic_cache",
        schema: { outcome: "passed", decodeTimeConstraint: false, errorCount: 0, unwrapped: true },
        repair: { outcome: "skipped", skipReason: "output_truncated" },
        truncation: { truncated: false, finishReason: "stop", capSetByCaller: true, outputLimit: 256 },
        cacheMatch: {
          kind: "semantic", ageMs: 10, similarity: 0.93, similarityFloor: 0.72, acceptFloor: 0.85,
          verifierScore: 0.9, embedder: "built_in", factGuard: "passed",
        },
        cascade: { mode: "shadow", gate: "structural", outcome: "not_applied", sampleDiverged: false },
      },
    } as unknown as SavingsReport;
    em.record(conLibro);
    await em.flush();
    const rec = JSON.parse(calls[0]!.init.body as string)[0] as Record<string, unknown>;
    const permitidos = new Set(CAMPOS_DEL_REGISTRO_DE_USO);
    for (const k of Object.keys(rec)) expect(permitidos.has(k), k).toBe(true);
    expect(rec["qualityLedger"]).toBeUndefined();
    expect(rec["qualityStatus"]).toBeUndefined();
    // Y nada del libro aparece con otro nombre: ningún valor suyo en el cuerpo.
    const cuerpo = calls[0]!.init.body as string;
    for (const pista of ["semantic_cache", "not_applied", "similarityFloor", "0.93", "output_truncated"]) {
      expect(cuerpo).not.toContain(pista);
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
    expect(em.stats()).toEqual({ sent: 0, requeued: 0, discarded: 1, dropped: 0 });
  });

  it("requeues 429, honors Retry-After and reports the eventual delivery", async () => {
    let hits = 0;
    const fn = (() => {
      hits++;
      return Promise.resolve(
        hits === 1
          ? new Response(null, { status: 429, headers: { "retry-after": "0" } })
          : new Response(null, { status: 202 }),
      );
    }) as unknown as typeof fetch;
    const em = new UsageEmitter({ url: URL, serviceAccountKey: "bvk_x", fetchImpl: fn, retryDelayMs: 0 });
    em.record(mkReport());
    await em.flush();
    expect(em.stats()).toEqual({ sent: 0, requeued: 1, discarded: 0, dropped: 0 });
    await em.flush();
    expect(hits).toBe(2);
    expect(em.stats()).toEqual({ sent: 1, requeued: 1, discarded: 0, dropped: 0 });
  });

  it("times out a stalled POST without throwing or losing the buffered record", async () => {
    const fn = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as unknown as typeof fetch;
    const em = new UsageEmitter({ url: URL, serviceAccountKey: "bvk_x", fetchImpl: fn, requestTimeoutMs: 5 });
    em.record(mkReport());
    await em.flush();
    expect(em.stats()).toEqual({ sent: 0, requeued: 1, discarded: 0, dropped: 0 });
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
