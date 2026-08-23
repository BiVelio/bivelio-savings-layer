import { describe, it, expect } from "vitest";

import { construirExtracto, type FilaDiaria } from "./extracto";

/** Fila diaria de ejemplo; solo lo medido cuenta para la base. */
function fila(day: string, medidoBase: number, medidoActual: number, extra?: Partial<FilaDiaria>): FilaDiaria {
  return {
    day,
    baseline_cost: medidoBase + 40, // +40 de estimado por defecto (contexto)
    actual_cost: medidoActual + 10,
    requests: 100,
    measured_requests: 80,
    measured_baseline_cost: medidoBase,
    measured_actual_cost: medidoActual,
    ...extra,
  };
}

const FX = { eurPorUsd: 1, fuente: "BCE 2026-08-31 (test)" };

describe("construirExtracto — el documento único sombra/factura", () => {
  it("suma solo las filas del período pedido", () => {
    const e = construirExtracto({
      orgId: "org-1",
      periodo: "2026-09",
      filas: [fila("2026-08-31", 999, 1), fila("2026-09-01", 100, 60), fila("2026-09-02", 100, 40), fila("2026-10-01", 999, 1)],
      esCalibracion: false,
      versionPrecios: "2026-08-13",
      fx: FX,
    });
    expect(e.dias).toBe(2);
    expect(e.baseMedidaUsd).toBe(200);
    expect(e.ahorroMedidoUsd).toBe(100);
    expect(e.requestsMedidas).toBe(160);
  });

  it("la base es SOLO lo medido; lo estimado queda aparte y jamás suma", () => {
    const e = construirExtracto({
      orgId: "org-1",
      periodo: "2026-09",
      filas: [fila("2026-09-01", 100, 50)], // total: base 140 / actual 60 → ahorro total 80
      esCalibracion: false,
      versionPrecios: "2026-08-13",
      fx: FX,
    });
    expect(e.baseMedidaUsd).toBe(100);
    expect(e.ahorroMedidoUsd).toBe(50);
    expect(e.ahorroEstimadoExcluidoUsd).toBe(30); // 80 total − 50 medido
    // Y la comisión se calculó sobre 50, no sobre 80:
    expect(e.comision.ahorroMedidoEur).toBe(50);
  });

  it("calibración: mismo documento, cargo 0, la comisión queda como «habría sido»", () => {
    const filas = [fila("2026-09-01", 2_000, 1_100)]; // ahorro 900, ratio 45%
    const sombra = construirExtracto({ orgId: "o", periodo: "2026-09", filas, esCalibracion: true, versionPrecios: "v", fx: FX });
    const real = construirExtracto({ orgId: "o", periodo: "2026-09", filas, esCalibracion: false, versionPrecios: "v", fx: FX });
    // El cálculo es idéntico byte a byte…
    expect(sombra.comision).toEqual(real.comision);
    expect(sombra.comision.comisionEur).toBe(90);
    // …y solo difiere el cargo.
    expect(sombra.cargoEur).toBe(0);
    expect(real.cargoEur).toBe(90);
  });

  it("bajo el umbral el cargo es 0 también fuera de calibración", () => {
    const e = construirExtracto({
      orgId: "o",
      periodo: "2026-09",
      filas: [fila("2026-09-01", 1_000, 780)], // 22%
      esCalibracion: false,
      versionPrecios: "v",
      fx: FX,
    });
    expect(e.cargoEur).toBe(0);
    expect(e.comision.factorRampa).toBe(0);
  });

  it("el FX convierte la base ANTES de los tramos (los cortes son en EUR)", () => {
    // 1.200 USD de ahorro a 0,5 €/USD son 600 € → todo dentro del primer tramo.
    const e = construirExtracto({
      orgId: "o",
      periodo: "2026-09",
      filas: [fila("2026-09-01", 2_400, 1_200)],
      esCalibracion: false,
      versionPrecios: "v",
      fx: { eurPorUsd: 0.5, fuente: "test" },
    });
    expect(e.ahorroMedidoEur).toBe(600);
    expect(e.comision.comisionEur).toBe(60); // 10% liso, ratio 50% → rampa 1
  });

  it("el extracto es auto-contenido: fija precios, fx, umbral y tramos", () => {
    const e = construirExtracto({
      orgId: "o",
      periodo: "2026-09",
      filas: [],
      esCalibracion: true,
      versionPrecios: "2026-08-13",
      fx: FX,
    });
    expect(e.parametros.versionPrecios).toBe("2026-08-13");
    expect(e.parametros.fx.fuente).toContain("BCE");
    expect(e.parametros.umbralRatio).toBe(0.3);
    expect(e.parametros.tramos.length).toBe(4);
  });

  it("período malformado o FX inválido: se niega, nunca un extracto silencioso", () => {
    expect(() =>
      construirExtracto({ orgId: "o", periodo: "septiembre", filas: [], esCalibracion: true, versionPrecios: "v", fx: FX }),
    ).toThrow(/período inválido/);
    expect(() =>
      construirExtracto({ orgId: "o", periodo: "2026-09", filas: [], esCalibracion: true, versionPrecios: "v", fx: { eurPorUsd: 0, fuente: "x" } }),
    ).toThrow(/eurPorUsd/);
  });

  it("una reparación cara (actual > baseline) no produce ahorro negativo", () => {
    const e = construirExtracto({
      orgId: "o",
      periodo: "2026-09",
      filas: [fila("2026-09-01", 100, 130, { baseline_cost: 100, actual_cost: 130 })],
      esCalibracion: false,
      versionPrecios: "v",
      fx: FX,
    });
    expect(e.ahorroMedidoUsd).toBe(0);
    expect(e.cargoEur).toBe(0);
  });
});
