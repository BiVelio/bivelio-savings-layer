import { describe, it, expect } from "vitest";

import { degradarReferencias, parseUsageRecords, type UsageRecord } from "./usage";

/**
 * 0029 · EL INTERRUPTOR DE SERVIDOR del carril medido por referencia
 * (`BVSALA_INGEST_REFERENCE_AS_ESTIMATED=1` en la ruta del ingest). La función
 * pura que lo ejecuta: reescribe SOLO los registros "reference" a "estimated",
 * les quita los dos campos de la referencia y dice cuántos cambió. Los demás
 * basis, intactos — el interruptor no puede tocar el dinero medido ni la sombra.
 */

function registro(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    model: "openai/gpt-4o-mini",
    cacheResult: "exact",
    at: Date.now(),
    avoidedLlm: 1,
    actualLlm: 0,
    baselineInputTokens: 40,
    actualInputTokens: 0,
    eliminatedInputTokens: 0,
    compressedInputTokens: 0,
    baselineOutputTokens: 0,
    actualOutputTokens: 0,
    providerCachedInputTokens: 0,
    baselineCost: 0.000003,
    actualCost: 0,
    netSavings: 1,
    basis: "reference",
    referenceRequestId: "req-poblada",
    referenceAt: Date.now() - 1_000,
    ...extra,
  };
}

const medido = {
  cacheResult: "miss",
  avoidedLlm: 0,
  actualLlm: 1,
  actualInputTokens: 40,
  actualCost: 0.000006,
  netSavings: 0,
  basis: "measured",
};

describe("degradarReferencias — el interruptor de servidor", () => {
  it("cuenta y reescribe SOLO los reference, y les quita los dos campos", () => {
    const records = parseUsageRecords(
      [
        registro(),
        registro({ cacheResult: "singleflight" }),
        registro({ ...medido }),
        registro({ ...medido, basis: "shadow" }),
        registro({ basis: "estimated" }),
      ],
      "org",
    );
    expect(records.map((r) => r["basis"])).toEqual(["reference", "reference", "measured", "shadow", "estimated"]);

    const n = degradarReferencias(records);

    expect(n).toBe(2);
    expect(records.map((r) => r["basis"])).toEqual(["estimated", "estimated", "measured", "shadow", "estimated"]);
    for (const r of records) {
      expect("referenceRequestId" in r).toBe(false);
      expect("referenceAt" in r).toBe(false);
    }
    // El dinero no se mueve: solo cambia la etiqueta (la RPC lo sumará a los totales como un estimated).
    expect(records[0]!["baselineCost"]).toBe(0.000003);
  });

  it("sin referencias, 0 y nada cambia", () => {
    const records: UsageRecord[] = parseUsageRecords([registro({ ...medido })], "org");
    const antes = JSON.stringify(records);
    expect(degradarReferencias(records)).toBe(0);
    expect(JSON.stringify(records)).toBe(antes);
  });

  it("es idempotente: una segunda pasada no encuentra nada", () => {
    const records = parseUsageRecords([registro()], "org");
    expect(degradarReferencias(records)).toBe(1);
    expect(degradarReferencias(records)).toBe(0);
  });
});
