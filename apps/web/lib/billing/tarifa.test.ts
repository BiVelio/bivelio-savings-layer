import { describe, it, expect } from "vitest";

import {
  UMBRAL_RATIO,
  FIN_RAMPA_RATIO,
  TRAMOS,
  factorDeRampa,
  comisionPorTramos,
  calcularComision,
} from "./tarifa";

/**
 * La tarifa variable decidida el 2026-08-23. Estos tests son el ANCLA de los
 * números: los ejemplos del plan maestro, la propiedad garantista de la rampa
 * y la marginalidad de los tramos. Si alguien toca una constante, esto es lo
 * que le obliga a tocar también el plan (y, en F3, la web publicada).
 */

describe("las constantes decididas", () => {
  it("umbral 30%, rampa hasta 35%", () => {
    expect(UMBRAL_RATIO).toBe(0.3);
    expect(FIN_RAMPA_RATIO).toBe(0.35);
  });
  it("tramos 10/8/6/4 con cortes en 1.000/5.000/20.000 €", () => {
    expect(TRAMOS.map((t) => [t.hastaEur, t.tipo])).toEqual([
      [1_000, 0.1],
      [5_000, 0.08],
      [20_000, 0.06],
      [Number.POSITIVE_INFINITY, 0.04],
    ]);
  });
  it("los tipos solo bajan: cuanto más ahorras, menor porcentaje", () => {
    for (let i = 1; i < TRAMOS.length; i++) {
      expect(TRAMOS[i]!.tipo).toBeLessThan(TRAMOS[i - 1]!.tipo);
    }
  });
});

describe("la rampa 30→35%", () => {
  it("bajo el umbral no hay comisión, exactamente en él tampoco", () => {
    expect(factorDeRampa(0)).toBe(0);
    expect(factorDeRampa(0.299)).toBe(0);
    expect(factorDeRampa(0.3)).toBe(0);
  });
  it("entra linealmente y satura en el 35%", () => {
    expect(factorDeRampa(0.31)).toBeCloseTo(0.2, 10);
    expect(factorDeRampa(0.325)).toBeCloseTo(0.5, 10);
    expect(factorDeRampa(0.35)).toBe(1);
    expect(factorDeRampa(0.9)).toBe(1);
  });
});

describe("los tramos son marginales (como el IRPF), nunca por el total", () => {
  it("un ahorro dentro del primer tramo paga 10% liso", () => {
    expect(comisionPorTramos(900).totalEur).toBeCloseTo(90, 10);
  });
  it("cruzar un corte solo cambia el tipo del EXCESO", () => {
    // 1.000 × 10% + 1 × 8% — no 1.001 × 8%.
    expect(comisionPorTramos(1_001).totalEur).toBeCloseTo(100.08, 10);
  });
  it("el ejemplo de la flota grande del plan: 15.600 → 1.056 (6,8% efectivo)", () => {
    const { totalEur, tramos } = comisionPorTramos(15_600);
    expect(totalEur).toBeCloseTo(1_056, 10);
    expect(tramos.map((t) => t.comisionEur)).toEqual([100, 320, 636]);
    expect(totalEur / 15_600).toBeLessThan(0.07);
  });
  it("por encima de 20.000 € el marginal es el 4%", () => {
    const a = comisionPorTramos(20_000).totalEur;
    const b = comisionPorTramos(21_000).totalEur;
    expect(b - a).toBeCloseTo(1_000 * 0.04, 10);
  });
});

describe("calcularComision — los ejemplos literales del plan maestro", () => {
  it("caso típico: 900 de ahorro sobre 2.000 (45%) → 90", () => {
    const c = calcularComision(2_000, 900);
    expect(c.factorRampa).toBe(1);
    expect(c.comisionEur).toBe(90);
    expect(c.netoClienteEur).toBe(810);
  });
  it("en el filo: 3.100 sobre 10.000 (31%) → 53,60 (el «~54» del plan)", () => {
    const c = calcularComision(10_000, 3_100);
    expect(c.factorRampa).toBeCloseTo(0.2, 10);
    expect(c.comisionEur).toBeCloseTo(53.6, 10);
  });
  it("flota grande: 15.600 sobre 30.000 (52%) → 1.056", () => {
    expect(calcularComision(30_000, 15_600).comisionEur).toBe(1_056);
  });
  it("bajo el umbral: 110 sobre 500 (22%) → 0, siempre 0", () => {
    const c = calcularComision(500, 110);
    expect(c.comisionEur).toBe(0);
    expect(c.netoClienteEur).toBe(110);
  });
  it("base cero no divide por cero ni comisiona nada", () => {
    const c = calcularComision(0, 0);
    expect(c.ratio).toBe(0);
    expect(c.comisionEur).toBe(0);
  });
});

describe("LA GARANTÍA: el ahorro neto del cliente nunca baja del 30% de su base", () => {
  it("se cumple en una rejilla densa de ratios y bases", () => {
    for (const base of [100, 1_000, 3_333.33, 10_000, 50_000, 250_000]) {
      for (let ratio = 0.301; ratio <= 0.99; ratio += 0.007) {
        const c = calcularComision(base, base * ratio);
        expect(c.netoClienteEur / base, `base=${base} ratio=${ratio.toFixed(3)}`).toBeGreaterThanOrEqual(
          UMBRAL_RATIO - 1e-9,
        );
      }
    }
  });
  it("y en el peor punto teórico de la rampa (35%) queda margen real", () => {
    const c = calcularComision(100_000, 35_000);
    // Neto = 35% − 10%·max sobre los primeros tramos → ≥ 31,5% aquí.
    expect(c.netoClienteEur / 100_000).toBeGreaterThan(0.31);
  });
});
