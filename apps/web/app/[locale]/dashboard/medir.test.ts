import { describe, expect, it } from "vitest";

import { ahorroEnSombra, ahorroRealDeMedir, estadoMedir } from "./medir";
import type { UsageRollup } from "./data";

const AHORA = Date.UTC(2026, 8, 29);
const FUTURO = "2099-01-01T00:00:00Z";

describe("estadoMedir", () => {
  it("solo una Medir viva → solo-medir", () => {
    expect(estadoMedir([{ plan: "measure", revoked: false, expires_at: FUTURO, grace_days: 30 }], null, AHORA)).toBe("solo-medir");
  });
  it("Medir + pago, o Medir + suscripción que cubre → de-pago", () => {
    const medir = { plan: "measure", revoked: false, expires_at: FUTURO, grace_days: 30 };
    expect(estadoMedir([medir, { plan: "pro", revoked: false, expires_at: FUTURO, grace_days: 14 }], null, AHORA)).toBe("de-pago");
    expect(estadoMedir([medir], "active", AHORA)).toBe("de-pago");
    expect(estadoMedir([medir], "canceled", AHORA)).toBe("solo-medir");
  });
  it("nada vivo (o solo revocadas) → sin-licencia", () => {
    expect(estadoMedir([], null, AHORA)).toBe("sin-licencia");
    expect(estadoMedir([{ plan: "measure", revoked: true, expires_at: FUTURO, grace_days: 30 }], null, AHORA)).toBe("sin-licencia");
  });
});

describe("ahorroEnSombra", () => {
  const fila = (o: Partial<UsageRollup>): UsageRollup =>
    ({ day: "2026-09-01", requests: 10, actualCost: 1, baselineCost: 1, ...o }) as UsageRollup;

  it("suma la diferencia sombra y el gasto real, por separado", () => {
    const r = ahorroEnSombra([
      fila({ shadowBaselineCost: 0.5, shadowActualCost: 0 }),
      fila({ shadowBaselineCost: 0.2, shadowActualCost: 0.1 }),
    ]);
    expect(r.habriasAhorradoUsd).toBeCloseTo(0.6, 10);
    expect(r.gastoUsd).toBe(2);
    expect(r.peticiones).toBe(20);
  });
  it("sin columnas sombra: null («no disponible»), nunca 0", () => {
    expect(ahorroEnSombra([fila({})]).habriasAhorradoUsd).toBeNull();
  });
});

// 1.2.4 · Medir ahorra de verdad: la tarjeta enseña el ahorro REAL, y la sombra aparte.
describe("ahorroRealDeMedir", () => {
  const fila = (o: Partial<UsageRollup>): UsageRollup =>
    ({ day: "2026-11-21", requests: 10, actualCost: 1, baselineCost: 1, ...o }) as UsageRollup;

  it("separa lo MEDIDO (contador del proveedor) de lo estimado (llamadas evitadas), sin sumarlos", () => {
    const r = ahorroRealDeMedir([
      // 3 $ de base, 1 $ pagado: 1,5 $ medidos con contador + 0,5 $ de llamadas evitadas.
      fila({ baselineCost: 3, actualCost: 1, measuredBaselineCost: 2.5, measuredActualCost: 1 }),
    ]);
    expect(r.medidoUsd).toBeCloseTo(1.5, 10);
    expect(r.estimadoUsd).toBeCloseTo(0.5, 10);
    expect(r.hay).toBe(true);
  });

  it("un cliente ≤ 1.2.3 en sombra (baseline == actual) no tiene ahorro real, aunque tenga sombra", () => {
    const uso = [fila({ baselineCost: 1, actualCost: 1, measuredBaselineCost: 1, measuredActualCost: 1, shadowBaselineCost: 0.4, shadowActualCost: 0 })];
    expect(ahorroRealDeMedir(uso)).toEqual({ medidoUsd: 0, estimadoUsd: 0, hay: false });
    expect(ahorroEnSombra(uso).habriasAhorradoUsd).toBeCloseTo(0.4, 10);
  });

  it("la sombra NUNCA entra en el ahorro real", () => {
    const r = ahorroRealDeMedir([fila({ baselineCost: 2, actualCost: 1, shadowBaselineCost: 50, shadowActualCost: 0 })]);
    expect(r.medidoUsd).toBe(0);
    expect(r.estimadoUsd).toBeCloseTo(1, 10);
  });

  it("sin uso, o con ruido de coma flotante, no hay nada que enseñar", () => {
    expect(ahorroRealDeMedir([]).hay).toBe(false);
    expect(ahorroRealDeMedir([fila({ baselineCost: 1.000000001, actualCost: 1 })]).hay).toBe(false);
  });
});
