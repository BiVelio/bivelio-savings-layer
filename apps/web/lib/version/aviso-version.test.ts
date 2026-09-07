import { describe, it, expect } from "vitest";

import { DIA_MS, decidirAvisoVersion, estadoVersion, type AsientoVisto } from "./aviso-version";

/**
 * El aviso se decide por DINERO y la versión solo explica. Los dos errores que
 * se prueban son opuestos: gritar sobre un 0.4.16 que mide (falso positivo, al
 * lado de un titular con ahorro > 0) y bendecir como «al día» a un proceso sin
 * palanca (SDK, CI, org sin feature) que lleva una semana a 0 €.
 */
const AHORA = Date.parse("2026-09-07T12:00:00Z");
const hace = (dias: number) => new Date(AHORA - dias * DIA_MS).toISOString();
const MINIMA = "0.4.16";

function asiento(p: Partial<AsientoVisto> = {}): AsientoVisto {
  return {
    seatId: "m-" + "a".repeat(32),
    isCi: false,
    surface: "gateway",
    versionMin: "gateway/0.4.17",
    versionMax: "gateway/0.4.17",
    sinVersion7d: false,
    lastSeenAt: hace(1),
    ahorroMedido7dUsd: 0,
    ...p,
  };
}

describe("decidirAvisoVersion — decide el dinero, explica la versión", () => {
  it("sin asientos: null", () => {
    expect(decidirAvisoVersion([], AHORA, MINIMA)).toBeNull();
  });

  it("todo produce dinero: null aunque la versión sea vieja o no se declare (jamás un falso positivo sobre un 0.4.16 que mide)", () => {
    expect(
      decidirAvisoVersion(
        [asiento({ versionMin: "gateway/0.4.15", versionMax: "gateway/0.4.15", ahorroMedido7dUsd: 0.01 })],
        AHORA,
        MINIMA,
      ),
    ).toBeNull();
    expect(
      decidirAvisoVersion(
        [asiento({ surface: null, versionMin: null, versionMax: null, sinVersion7d: true, ahorroMedido7dUsd: 3 })],
        AHORA,
        MINIMA,
      ),
    ).toBeNull();
  });

  it("versión anterior a la mínima y 0 €: desactualizada («esta versión no lleva la palanca»)", () => {
    const a = decidirAvisoVersion([asiento({ versionMin: "gateway/0.4.15", versionMax: "gateway/0.4.15" })], AHORA, MINIMA);
    expect(a).toEqual({ tipo: "gatewaySinAhorro", activas: 1, desactualizadas: 1, sinDeclarar: 0, sinPalanca: 0, minima: MINIMA });
  });

  it("sin declarar (gateway anterior al canal) y 0 €: sinDeclarar, sin afirmar nada de la versión", () => {
    const a = decidirAvisoVersion([asiento({ surface: null, versionMin: null, versionMax: null, sinVersion7d: true })], AHORA, MINIMA);
    expect(a).toMatchObject({ desactualizadas: 0, sinDeclarar: 1, sinPalanca: 0 });
  });

  it("sinVersion7d con versión presente (réplica vieja al lado de una nueva) → sinDeclarar, no al día", () => {
    const a = decidirAvisoVersion([asiento({ sinVersion7d: true })], AHORA, MINIMA);
    expect(a).toMatchObject({ desactualizadas: 0, sinDeclarar: 1, sinPalanca: 0 });
  });

  it("≥ mínima y 0 €: sinPalanca; 0.10.0 cuenta como al día (orden numérico, no de cadenas)", () => {
    const a = decidirAvisoVersion(
      [asiento({ versionMin: "gateway/0.10.0", versionMax: "gateway/0.10.0" }), asiento({ seatId: "m-b" })],
      AHORA,
      MINIMA,
    );
    expect(a).toMatchObject({ activas: 2, desactualizadas: 0, sinDeclarar: 0, sinPalanca: 2 });
  });

  it("la mínima del asiento decide con versionMin: min < mínima ≤ max es desactualizada", () => {
    const a = decidirAvisoVersion([asiento({ versionMin: "gateway/0.4.15", versionMax: "gateway/0.4.17" })], AHORA, MINIMA);
    expect(a).toMatchObject({ desactualizadas: 1 });
  });

  it("un SDK no tiene palanca de tarifa: se ignora aunque lleve 0 €", () => {
    expect(decidirAvisoVersion([asiento({ surface: "sdk", versionMin: "sdk/0.4.15", versionMax: "sdk/0.4.15" })], AHORA, MINIMA)).toBeNull();
  });

  it("los asientos de CI se ignoran (cada job es un asiento nuevo)", () => {
    expect(decidirAvisoVersion([asiento({ isCi: true, versionMin: "gateway/0.4.15", versionMax: "gateway/0.4.15" })], AHORA, MINIMA)).toBeNull();
  });

  it("solo cuentan los vistos en los últimos 7 días; fechas inválidas o futuras quedan fuera", () => {
    expect(decidirAvisoVersion([asiento({ lastSeenAt: hace(8) })], AHORA, MINIMA)).toBeNull();
    expect(decidirAvisoVersion([asiento({ lastSeenAt: "no es una fecha" })], AHORA, MINIMA)).toBeNull();
    expect(decidirAvisoVersion([asiento({ lastSeenAt: hace(-1) })], AHORA, MINIMA)).toBeNull();
    expect(decidirAvisoVersion([asiento({ lastSeenAt: hace(7) })], AHORA, MINIMA)).not.toBeNull();
  });

  it("un ahorro NaN o negativo cae del lado que avisa", () => {
    expect(decidirAvisoVersion([asiento({ ahorroMedido7dUsd: Number.NaN })], AHORA, MINIMA)).toMatchObject({ sinPalanca: 1 });
    expect(decidirAvisoVersion([asiento({ ahorroMedido7dUsd: -0.5 })], AHORA, MINIMA)).toMatchObject({ sinPalanca: 1 });
  });

  it("activas cuenta también las que producen; los tres motivos se reparten sin solaparse", () => {
    const a = decidirAvisoVersion(
      [
        asiento({ seatId: "m-1", ahorroMedido7dUsd: 2 }),
        asiento({ seatId: "m-2", versionMin: "gateway/0.4.15", versionMax: "gateway/0.4.15" }),
        asiento({ seatId: "m-3", surface: null, versionMin: null, versionMax: null, sinVersion7d: true }),
        asiento({ seatId: "m-4" }),
        asiento({ seatId: "m-5", isCi: true }),
        asiento({ seatId: "m-6", surface: "sdk", versionMin: "sdk/0.4.17", versionMax: "sdk/0.4.17" }),
      ],
      AHORA,
      MINIMA,
    );
    expect(a).toEqual({ tipo: "gatewaySinAhorro", activas: 4, desactualizadas: 1, sinDeclarar: 1, sinPalanca: 1, minima: MINIMA });
  });

  it("por defecto usa VERSION_MINIMA_PALANCA_TARIFA (la del espejo)", () => {
    expect(decidirAvisoVersion([asiento({ versionMin: "gateway/0.0.1", versionMax: "gateway/0.0.1" })], AHORA)).toMatchObject({ desactualizadas: 1 });
    expect(decidirAvisoVersion([asiento({ versionMin: "gateway/9999.0.0", versionMax: "gateway/9999.0.0" })], AHORA)).toMatchObject({ sinPalanca: 1 });
  });
});

describe("estadoVersion — el chip de la tarjeta, sin decir nada del dinero", () => {
  it("alDia / desactualizada según versionMin frente a la mínima", () => {
    expect(estadoVersion({ versionMin: "gateway/0.4.16", sinVersion7d: false }, MINIMA)).toBe("alDia");
    expect(estadoVersion({ versionMin: "gateway/0.10.0", sinVersion7d: false }, MINIMA)).toBe("alDia");
    expect(estadoVersion({ versionMin: "gateway/0.4.15", sinVersion7d: false }, MINIMA)).toBe("desactualizada");
  });

  it("desconocida si no hay versión, si algún registro de 7 días vino sin ella, o si lo guardado no casa", () => {
    expect(estadoVersion({ versionMin: null, sinVersion7d: false }, MINIMA)).toBe("desconocida");
    expect(estadoVersion({ versionMin: "gateway/0.4.17", sinVersion7d: true }, MINIMA)).toBe("desconocida");
    expect(estadoVersion({ versionMin: "basura", sinVersion7d: false }, MINIMA)).toBe("desconocida");
  });
});
