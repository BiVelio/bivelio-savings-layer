import { describe, it, expect, vi, afterEach } from "vitest";

import { parseUsageRecord, UsageValidationError } from "./usage";
import { TECHO_PRECIO_LECTURA_PER_1K } from "./techo-precio-lectura";

/**
 * B1 · La verja del ingest ante el dinero de la elisión del proveedor
 * (`eliminatedInputFloorCost`, migración 0025). Tres reglas y sus razones:
 *   · OPCIONAL: un gateway ≤ 0.4.16 no lo manda y sigue en 202.
 *   · Tipo/signo se RECHAZAN (payload malformado = bug del emisor).
 *   · Dominio se RECORTA (dinero sin conteo → 0; sobre el techo → techo): un
 *     rechazo aquí tira el lote entero del cliente y le deja sin reportar nada.
 */

function cuerpoValido(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: "req-1",
    model: "claude-fable-5-1",
    cacheResult: "miss",
    at: Date.now(),
    avoidedLlm: 0,
    actualLlm: 1,
    baselineInputTokens: 10_000,
    actualInputTokens: 10_000,
    eliminatedInputTokens: 10_000,
    compressedInputTokens: 0,
    baselineOutputTokens: 5,
    actualOutputTokens: 5,
    providerCachedInputTokens: 0,
    baselineCost: 0.1,
    actualCost: 0.1,
    netSavings: 0,
    basis: "measured",
    ...extra,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("ingesta — el suelo de la elisión del proveedor (0025)", () => {
  it("ausente: el registro pasa y el campo NO existe (un 0.4.16 sigue en 202)", () => {
    const rec = parseUsageRecord(cuerpoValido(), "org-1");
    expect("eliminatedInputFloorCost" in rec).toBe(false);
  });

  it("0 explícito pasa tal cual", () => {
    const rec = parseUsageRecord(cuerpoValido({ eliminatedInputFloorCost: 0 }), "org-1");
    expect(rec["eliminatedInputFloorCost"]).toBe(0);
  });

  it("un suelo a precio de lectura (10.000 tokens de fable-5-1 = $0,0025) viaja intacto", () => {
    const rec = parseUsageRecord(cuerpoValido({ eliminatedInputFloorCost: 0.0025 }), "org-1");
    expect(rec["eliminatedInputFloorCost"]).toBe(0.0025);
  });

  it("⛔ negativo, NaN, Infinity o no-número → UsageValidationError", () => {
    for (const mal of [-0.01, Number.NaN, Number.POSITIVE_INFINITY, "0.01", null]) {
      expect(() => parseUsageRecord(cuerpoValido({ eliminatedInputFloorCost: mal }), "org-1"), String(mal)).toThrow(
        UsageValidationError,
      );
    }
  });

  it("dinero SIN conteo (suelo > 0 con eliminatedInputTokens 0) se recorta a 0 y avisa — no rompe el lote", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rec = parseUsageRecord(cuerpoValido({ eliminatedInputTokens: 0, eliminatedInputFloorCost: 0.5 }), "org-1");
    expect(rec["eliminatedInputFloorCost"]).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("⛔ tarifado a precio de ENTRADA (×40 en fable-5-1: $0,10) se recorta al techo, no se rechaza", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rec = parseUsageRecord(cuerpoValido({ eliminatedInputFloorCost: 0.1 }), "org-1");
    expect(rec["eliminatedInputFloorCost"]).toBe((10_000 / 1_000) * TECHO_PRECIO_LECTURA_PER_1K);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("dentro del techo no hay aviso: el camino normal es silencioso", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    parseUsageRecord(cuerpoValido({ eliminatedInputFloorCost: 0.0025 }), "org-1");
    expect(warn).not.toHaveBeenCalled();
  });

  it("⛔ un campo desconocido sigue rechazado: la lista sigue cerrada", () => {
    expect(() => parseUsageRecord(cuerpoValido({ eliminatedInputCost: 0.1 }), "org-1")).toThrow(/disallowed field/);
  });

  it("⛔ eliminatedInputFloorCost NO es obligatorio: no está entre los que dan 400 por ausencia", () => {
    // La prueba negativa de la doctrina: si alguien lo mueve a USAGE_NUMBER_FIELDS,
    // el registro de arriba (sin el campo) dejaría de pasar y este test lo caza.
    expect(() => parseUsageRecord(cuerpoValido(), "org-1")).not.toThrow();
  });
});
