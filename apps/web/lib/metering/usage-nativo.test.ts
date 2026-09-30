import { describe, it, expect } from "vitest";

import { parseUsageRecord, parseUsageRecords, UsageValidationError, CAMPOS_DEL_REGISTRO_DE_USO } from "./usage";
import { TECHO_PRECIO_ENTRADA_PER_1K } from "./techo-precio-lectura";

/**
 * 0032 · la verja del ingest para el AHORRO NATIVO. Dos campos OPCIONALES y no
 * negativos que van a su carril propio. Lo que se garantiza aquí, en el
 * servidor: un cliente viejo sigue en 202, un valor malo no tumba el lote por
 * dominio (se recorta), y NINGÚN otro campo del registro —basis, costes,
 * referencia— se mueve por su culpa. La prueba de que no llegan a la comisión
 * está en lib/billing/extracto-carril-nativo.test.ts y en test/migracion-0032.test.ts.
 */

const BASE = {
  requestId: "req-n-1",
  model: "claude-sonnet-5",
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
const reg = (extra: Record<string, unknown> = {}) => ({ ...BASE, at: Date.now(), ...extra });

describe("el ahorro nativo en la verja del ingest (0032)", () => {
  it("están en la lista blanca (y por tanto en la página de privacidad)", () => {
    expect(CAMPOS_DEL_REGISTRO_DE_USO).toContain("nativeCacheReadSavings");
    expect(CAMPOS_DEL_REGISTRO_DE_USO).toContain("nativeCacheWritePremium");
  });

  it("OPCIONALES: un registro sin ellos sigue pasando y no los inventa", () => {
    const r = parseUsageRecord(reg(), "org") as Record<string, unknown>;
    expect("nativeCacheReadSavings" in r).toBe(false);
    expect("nativeCacheWritePremium" in r).toBe(false);
  });

  it("se guardan tal cual dentro del techo, y no tocan basis ni el dinero", () => {
    const r = parseUsageRecord(reg({ nativeCacheReadSavings: 0.0216, nativeCacheWritePremium: 0.00075 }), "org");
    expect(r["nativeCacheReadSavings"]).toBe(0.0216);
    expect(r["nativeCacheWritePremium"]).toBe(0.00075);
    expect(r["basis"]).toBe("measured");
    expect(r["baselineCost"]).toBe(0.0069);
    expect(r["actualCost"]).toBe(0.0069);
  });

  it("tipo y signo se RECHAZAN (bug del emisor)", () => {
    for (const malo of [-0.01, Number.NaN, "0.1", null]) {
      expect(() => parseUsageRecord(reg({ nativeCacheReadSavings: malo }), "org"), String(malo)).toThrow(UsageValidationError);
      expect(() => parseUsageRecord(reg({ nativeCacheWritePremium: malo }), "org"), String(malo)).toThrow(UsageValidationError);
    }
  });

  it("el dominio se RECORTA, nunca se rechaza: lectura ≤ leídos × techo, prima ≤ entrada × techo, sin conteo 0", () => {
    const r = parseUsageRecord(reg({ nativeCacheReadSavings: 999, nativeCacheWritePremium: 999 }), "org");
    expect(r["nativeCacheReadSavings"]).toBe((8_000 / 1_000) * TECHO_PRECIO_ENTRADA_PER_1K);
    expect(r["nativeCacheWritePremium"]).toBe((10_000 / 1_000) * TECHO_PRECIO_ENTRADA_PER_1K);
    const sinConteo = parseUsageRecord(reg({ providerCachedInputTokens: 0, nativeCacheReadSavings: 0.5 }), "org");
    expect(sinConteo["nativeCacheReadSavings"]).toBe(0);
  });

  it("un lote mezcla clientes viejos y nuevos sin 400", () => {
    const out = parseUsageRecords(
      [reg({ requestId: "a" }), reg({ requestId: "b", nativeCacheReadSavings: 0.01 })],
      "org",
    );
    expect(out).toHaveLength(2);
  });

  it("⛔ no cuelan una referencia: una evitada con dinero nativo sigue siendo lo que es y sus campos se recortan a 0", () => {
    const evitada = parseUsageRecord(
      reg({
        avoidedLlm: 1, actualLlm: 0, actualInputTokens: 0, actualOutputTokens: 0, providerCachedInputTokens: 0,
        actualCost: 0, netSavings: 1, cacheResult: "exact", basis: "estimated",
        nativeCacheReadSavings: 0.5, nativeCacheWritePremium: 0.5,
      }),
      "org",
    );
    expect(evitada["basis"]).toBe("estimated");
    expect(evitada["nativeCacheReadSavings"]).toBe(0);
    expect(evitada["nativeCacheWritePremium"]).toBe(0);
  });
});
