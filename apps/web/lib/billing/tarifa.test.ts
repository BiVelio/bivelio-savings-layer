import { describe, it, expect } from "vitest";

import {
  TRAMOS,
  GARANTIA_NETA_RATIO,
  comisionPorTramos,
  calcularComision,
} from "./tarifa";

/**
 * La tarifa variable decidida el 2026-08-23 y revisada el 2026-09-01 (decisión
 * del dueño: SIN MÍNIMO — el umbral del 30% y la rampa 30→35% se retiran; la
 * comisión por tramos aplica desde el primer euro medido). Estos tests son el
 * ANCLA de los números y de la garantía que sustituye a la vieja: el cliente
 * se queda SIEMPRE con GARANTIA_NETA_RATIO o más de cada euro ahorrado.
 */

describe("las constantes decididas", () => {
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
  it("la garantía se DERIVA del tramo más caro — no puede divergir de la tarifa", () => {
    expect(GARANTIA_NETA_RATIO).toBe(0.9);
    expect(GARANTIA_NETA_RATIO).toBe(1 - Math.max(...TRAMOS.map((t) => t.tipo)));
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

describe("calcularComision — sin mínimo (2026-09-01)", () => {
  it("caso típico: 900 de ahorro sobre 2.000 (45%) → 90", () => {
    const c = calcularComision(2_000, 900);
    expect(c.comisionEur).toBe(90);
    expect(c.netoClienteEur).toBe(810);
  });
  it("SIN UMBRAL: 110 sobre 500 (22%) ya comisiona — 11, y el cliente neta 99", () => {
    // Bajo la tarifa anterior esto era 0 (umbral 30%). La franja 0–35% es
    // exactamente lo que la revisión del 2026-09-01 convierte en ingresos.
    const c = calcularComision(500, 110);
    expect(c.comisionEur).toBe(11);
    expect(c.netoClienteEur).toBe(99);
  });
  it("SIN RAMPA: 3.100 sobre 10.000 (31%) paga los tramos enteros — 268", () => {
    // Antes: 53,60 (factor 0,2 de la rampa). Ahora los tramos, sin factor:
    // 1.000×10% + 2.100×8% = 268.
    const c = calcularComision(10_000, 3_100);
    expect(c.comisionEur).toBeCloseTo(268, 10);
  });
  it("≥35% no nota el cambio: flota grande 15.600 sobre 30.000 (52%) → 1.056", () => {
    expect(calcularComision(30_000, 15_600).comisionEur).toBe(1_056);
  });
  it("ahorro cero → comisión cero: solo cobramos si ahorra", () => {
    const c = calcularComision(10_000, 0);
    expect(c.comisionEur).toBe(0);
    expect(c.netoClienteEur).toBe(0);
  });
  it("base cero no divide por cero ni comisiona nada", () => {
    const c = calcularComision(0, 0);
    expect(c.ratio).toBe(0);
    expect(c.comisionEur).toBe(0);
  });
});

describe("LA GARANTÍA: el cliente se queda con ≥ GARANTIA_NETA_RATIO de cada euro ahorrado", () => {
  it("se cumple en una rejilla densa de ratios y bases — incluida la franja sin umbral", () => {
    for (const base of [100, 1_000, 3_333.33, 10_000, 50_000, 250_000]) {
      for (let ratio = 0.01; ratio <= 0.99; ratio += 0.007) {
        const c = calcularComision(base, base * ratio);
        if (c.ahorroMedidoEur === 0) continue;
        expect(
          c.netoClienteEur / c.ahorroMedidoEur,
          `base=${base} ratio=${ratio.toFixed(3)}`,
        ).toBeGreaterThanOrEqual(GARANTIA_NETA_RATIO - 1e-6);
      }
    }
  });
  it("el peor caso es exactamente el primer tramo: 10% de comisión, 90% para el cliente", () => {
    const c = calcularComision(10_000, 1_000);
    expect(c.comisionEur).toBe(100);
    expect(c.netoClienteEur / c.ahorroMedidoEur).toBeCloseTo(GARANTIA_NETA_RATIO, 10);
  });
});
