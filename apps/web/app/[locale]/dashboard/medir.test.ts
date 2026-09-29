import { describe, expect, it } from "vitest";

import { ahorroEnSombra, estadoMedir } from "./medir";
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
