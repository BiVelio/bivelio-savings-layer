import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

import type { UsageRollup } from "@/app/[locale]/dashboard/data";

import { VERSION_PRECIOS_CATALOGO, esPeriodoDeCalibracion, extractoEnSombra, periodoDe } from "./extracto-sombra";

function rollup(day: string, medidoBase: number, medidoActual: number): UsageRollup {
  return {
    day,
    requests: 10,
    avoidedLlm: 0,
    actualLlm: 10,
    eliminatedInputTokens: 0,
    compressedInputTokens: 0,
    providerCachedInputTokens: 0,
    baselineCost: medidoBase + 5,
    actualCost: medidoActual + 5,
    measuredRequests: 10,
    measuredBaselineCost: medidoBase,
    measuredActualCost: medidoActual,
  };
}

describe("anclaje: la versión del catálogo no puede derivar en silencio", () => {
  it("VERSION_PRECIOS_CATALOGO es el PRECIOS_AL_DIA del SDK", () => {
    // apps/web no puede importar de src/ (proyecto aparte), así que el ancla
    // lee el FICHERO del catálogo — el mismo truco que precio-publicado.
    const src = readFileSync(new URL("../../../../src/pricing/catalogo.ts", import.meta.url), "utf8");
    const m = /PRECIOS_AL_DIA = "([0-9-]+)"/.exec(src);
    expect(m?.[1], "no se encontró PRECIOS_AL_DIA en el catálogo").toBeTruthy();
    expect(VERSION_PRECIOS_CATALOGO).toBe(m![1]);
  });
});

describe("esPeriodoDeCalibracion — ante la duda, calibración (el lado que no cobra)", () => {
  it("sin historia previa: calibración", () => {
    expect(esPeriodoDeCalibracion([rollup("2026-09-03", 10, 5)], "2026-09")).toBe(true);
    expect(esPeriodoDeCalibracion([], "2026-09")).toBe(true);
  });
  it("con uso en un período anterior: ya no", () => {
    expect(esPeriodoDeCalibracion([rollup("2026-08-20", 10, 5), rollup("2026-09-03", 10, 5)], "2026-09")).toBe(false);
  });
});

describe("extractoEnSombra", () => {
  it("produce el documento con FX de sombra y versión de catálogo declarados", () => {
    const e = extractoEnSombra("org-1", [rollup("2026-09-01", 2000, 1100)], "2026-09");
    expect(e.esCalibracion).toBe(true);
    expect(e.cargoEur).toBe(0);
    // 900 USD de ahorro a 0,9 → 810 € (ratio 45% → rampa 1, primer tramo)
    expect(e.ahorroMedidoEur).toBeCloseTo(810, 10);
    expect(e.comision.comisionEur).toBeCloseTo(81, 10);
    expect(e.parametros.versionPrecios).toBe(VERSION_PRECIOS_CATALOGO);
    expect(e.parametros.fx.fuente).toContain("sombra");
  });
});

describe("periodoDe", () => {
  it("YYYY-MM en UTC", () => {
    expect(periodoDe(new Date("2026-09-15T23:59:00Z"))).toBe("2026-09");
  });
});

describe("extractoEnSombra — el carril medido por referencia (0029)", () => {
  it("aFila mapea reference_* cuando el panel las trae: entran en la base del extracto", () => {
    const sin = extractoEnSombra("org-1", [rollup("2026-09-01", 2000, 1100)], "2026-09");
    const con = extractoEnSombra(
      "org-1",
      [{ ...rollup("2026-09-01", 2000, 1100), referenceRequests: 20, referenceBaselineCost: 50, referenceActualCost: 0 }],
      "2026-09",
    );
    expect(con.referencia).toEqual({ requests: 20, baseUsd: 50, ahorroUsd: 50, comisionada: true });
    expect(con.ahorroMedidoUsd).toBe(sin.ahorroMedidoUsd + 50);
    expect(con.requestsMedidas).toBe(sin.requestsMedidas + 20);
  });

  it("sin las columnas (proyecto por detrás de 0029), nada: referencia null", () => {
    expect(extractoEnSombra("org-1", [rollup("2026-09-01", 2000, 1100)], "2026-09").referencia).toBeNull();
  });
});
