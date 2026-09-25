import { describe, it, expect } from "vitest";

import {
  CATEGORIAS,
  leerInterruptorVerificacion,
  parseVerificationBatch,
  precioDelUso,
  VerificationValidationError,
} from "./wire";

const AHORA = Date.UTC(2026, 8, 25, 12, 0, 0);

function muestra(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    basis: "verification",
    requestId: "req-0001",
    at: AHORA - 60_000,
    stratum: "tokens_removed",
    outcome: "paired",
    requestedModel: "openai/gpt-4o-mini",
    servedModel: "openai/gpt-4o-mini",
    cacheResult: "miss",
    optimizedCost: 0.0001234,
    optimizedInputTokens: 900,
    optimizedCachedInputTokens: 0,
    optimizedOutputTokens: 120,
    naiveInputTokens: 1300,
    naiveCachedInputTokens: 0,
    naiveOutputTokens: 125,
    naiveFinishReason: "stop",
    naiveContract: "none",
    inputPer1k: 0.00015,
    cachedInputPer1k: 0.000075,
    outputPer1k: 0.0006,
  };
  const m = { ...base, ...extra };
  if (m["outcome"] === "paired" && m["naiveCost"] === undefined) {
    m["naiveCost"] = precioDelUso(
      {
        inputTokens: m["naiveInputTokens"] as number,
        outputTokens: m["naiveOutputTokens"] as number,
        cachedInputTokens: m["naiveCachedInputTokens"] as number,
      },
      m as { inputPer1k: number; outputPer1k: number; cachedInputPer1k?: number },
    );
  }
  for (const [k, v] of Object.entries(m)) if (v === undefined) delete m[k];
  return m;
}

const sinCopia = (outcome: string) =>
  muestra({
    requestId: `req-${outcome}`,
    outcome,
    naiveCost: undefined,
    naiveInputTokens: undefined,
    naiveCachedInputTokens: undefined,
    naiveOutputTokens: undefined,
    naiveFinishReason: undefined,
    naiveContract: undefined,
  });

const lote = (samples: unknown[] = [muestra()], counts: unknown[] = [{ day: "2026-09-25", category: "tokens_removed", requests: 3 }]) => ({
  batchId: "0f3c2a1e-aaaa-4bbb-8ccc-123456789abc",
  samples,
  counts,
});

const falla = (body: unknown, patron?: RegExp) => {
  expect(() => parseVerificationBatch(body, AHORA)).toThrow(VerificationValidationError);
  if (patron) expect(() => parseVerificationBatch(body, AHORA)).toThrow(patron);
};

describe("el sobre bueno pasa entero", () => {
  it("una muestra con par, una sin par y un conteo", () => {
    const r = parseVerificationBatch(lote([muestra(), sinCopia("abandoned")]), AHORA);
    expect(r.samples).toHaveLength(2);
    expect(r.counts).toEqual([{ day: "2026-09-25", category: "tokens_removed", requests: 3 }]);
    expect(r.dropped).toBe(0);
  });

  it("todas las categorías de conteo son válidas", () => {
    const r = parseVerificationBatch(lote([], CATEGORIAS.map((c) => ({ day: "2026-09-24", category: c, requests: 1 }))), AHORA);
    expect(r.counts).toHaveLength(CATEGORIAS.length);
  });
});

describe("400 — errores estructurales", () => {
  it("el cuerpo: objeto con exactamente batchId, samples y counts", () => {
    falla([], /body must be an object/);
    falla({ batchId: "0f3c2a1e-aaaa", samples: [] }, /exactly batchId, samples and counts/);
    falla({ ...lote(), orgId: "x" }, /unknown field "orgId" in body/);
  });

  it("batchId con forma", () => {
    falla({ ...lote(), batchId: "corto" }, /batchId/);
    falla({ ...lote(), batchId: "con espacios en medio" }, /batchId/);
  });

  it("topes de 500 muestras y 200 conteos", () => {
    falla(lote(Array.from({ length: 501 }, (_, i) => muestra({ requestId: `r-${i}` }))), /max 500 samples/);
    falla(lote([], Array.from({ length: 201 }, () => ({ day: "2026-09-25", category: "unchanged", requests: 1 }))), /max 200 counts/);
  });

  it("clave desconocida o campo que falta", () => {
    falla(lote([{ ...muestra(), prompt: "hola" }]), /unknown field "prompt" in sample 0/);
    const sinModelo = muestra();
    delete sinModelo["servedModel"];
    falla(lote([sinModelo]), /missing field "servedModel"/);
    falla(lote([], [{ day: "2026-09-25", category: "unchanged", requests: 1, org: "x" }]), /unknown field "org" in count 0/);
  });

  it('basis tiene que ser "verification"', () => {
    falla(lote([muestra({ basis: "measured" })]), /field "basis" must be "verification"/);
  });

  it("identidades con el patrón del ingest de uso", () => {
    falla(lote([muestra({ requestId: "con espacio" })]), /requestId/);
    falla(lote([muestra({ requestedModel: "modelo@vertex" })]), /requestedModel/);
    falla(lote([muestra({ servedModel: "x".repeat(129) })]), /servedModel/);
  });

  it("at: entero, ≥ 1e12 y no más de 48 h en el futuro", () => {
    falla(lote([muestra({ at: 1.5e12 + 0.5 })]), /"at"/);
    falla(lote([muestra({ at: 999 })]), /"at"/);
    falla(lote([muestra({ at: AHORA + 49 * 3600_000 })]), /"at"/);
    expect(parseVerificationBatch(lote([muestra({ at: AHORA + 47 * 3600_000 })]), AHORA).samples).toHaveLength(1);
  });

  it("estrato, resultado, caché y contrato dentro de su conjunto", () => {
    falla(lote([muestra({ stratum: "inventado" })]), /stratum/);
    falla(lote([muestra({ outcome: "won" })]), /outcome/);
    falla(lote([muestra({ cacheResult: "warm" })]), /cacheResult/);
    falla(lote([muestra({ naiveContract: "maybe" })]), /naiveContract/);
  });

  it("dinero y tarifas: finitos, ≥ 0 y acotados", () => {
    falla(lote([muestra({ optimizedCost: -0.1 })]), /optimizedCost/);
    falla(lote([muestra({ optimizedCost: 1000.5 })]), /optimizedCost/);
    falla(lote([muestra({ inputPer1k: Number.POSITIVE_INFINITY })]), /inputPer1k/);
    falla(lote([muestra({ cachedInputPer1k: -1 })]), /cachedInputPer1k/);
  });

  it("tokens: enteros seguros ≥ 0 y cacheados ≤ entrada", () => {
    falla(lote([muestra({ optimizedInputTokens: 1.5 })]), /optimizedInputTokens/);
    falla(lote([muestra({ optimizedOutputTokens: -1 })]), /optimizedOutputTokens/);
    falla(lote([muestra({ optimizedCachedInputTokens: 901 })]), /cannot exceed/);
    falla(lote([muestra({ naiveCachedInputTokens: 2000 })]), /cannot exceed/);
  });

  it("las claves naive* van si y solo si outcome es paired", () => {
    falla(lote([{ ...sinCopia("check_failed"), naiveCost: 0.1 }]), /only allowed when outcome is "paired"/);
    falla(lote([{ ...sinCopia("dropped"), naiveFinishReason: "stop" }]), /only allowed/);
    const sinCoste = muestra();
    delete sinCoste["naiveOutputTokens"];
    falla(lote([sinCoste]), /missing field "naiveOutputTokens"/);
  });

  it("naiveFinishReason con forma", () => {
    falla(lote([muestra({ naiveFinishReason: "Stop Sequence" })]), /naiveFinishReason/);
  });

  it("conteos: categoría conocida y requests de 1 a 10 millones", () => {
    falla(lote([], [{ day: "2026-09-25", category: "extra", requests: 1 }]), /category/);
    falla(lote([], [{ day: "2026-09-25", category: "unchanged", requests: 0 }]), /requests/);
    falla(lote([], [{ day: "2026-09-25", category: "unchanged", requests: 10_000_001 }]), /requests/);
    falla(lote([], [{ day: "2026-09-25", category: "unchanged", requests: 1.5 }]), /requests/);
  });
});

describe("descartes que NO rompen el lote", () => {
  it("un par con el coste incoherente con sus tokens y tarifas", () => {
    const r = parseVerificationBatch(lote([muestra({ naiveCost: 0.5 }), muestra({ requestId: "req-2" })]), AHORA);
    expect(r.samples.map((s) => s.requestId)).toEqual(["req-2"]);
    expect(r.dropped).toBe(1);
  });

  it("la tolerancia es de 2e-10", () => {
    const m = muestra();
    const r = parseVerificationBatch(lote([{ ...m, naiveCost: (m["naiveCost"] as number) + 1e-10 }]), AHORA);
    expect(r.dropped).toBe(0);
  });

  it("un conteo con día inválido o fuera de [hoy−30, hoy+1]", () => {
    const r = parseVerificationBatch(
      lote([], [
        { day: "2026-02-31", category: "unchanged", requests: 1 },
        { day: "2026-08-25", category: "unchanged", requests: 1 },
        { day: "2026-08-26", category: "unchanged", requests: 1 },
        { day: "2026-09-26", category: "unchanged", requests: 1 },
        { day: "2026-09-27", category: "unchanged", requests: 1 },
      ]),
      AHORA,
    );
    expect(r.counts.map((c) => c.day)).toEqual(["2026-08-26", "2026-09-26"]);
    expect(r.dropped).toBe(3);
  });

  it("requestId repetido dentro del lote: se queda el primero", () => {
    const r = parseVerificationBatch(lote([muestra(), muestra({ optimizedCost: 0.2 })]), AHORA);
    expect(r.samples).toHaveLength(1);
    expect(r.samples[0]!.optimizedCost).toBe(0.0001234);
    expect(r.dropped).toBe(1);
  });
});

describe("el interruptor de incidencias", () => {
  it("apagado por defecto; 1/true/yes/on lo encienden; lo raro, también (con aviso)", () => {
    expect(leerInterruptorVerificacion(undefined)).toEqual({ activo: false, reconocido: true });
    expect(leerInterruptorVerificacion("0")).toEqual({ activo: false, reconocido: true });
    for (const v of ["1", "true", "YES", " on "]) expect(leerInterruptorVerificacion(v)).toEqual({ activo: true, reconocido: true });
    expect(leerInterruptorVerificacion("quizas")).toEqual({ activo: true, reconocido: false });
  });
});
