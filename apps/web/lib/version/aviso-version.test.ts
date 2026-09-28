import { describe, it, expect } from "vitest";

import { agregarAsientos, type FilaAsiento } from "./asientos";
import { VERSION_MINIMA_REFERENCIA } from "../metering/version";
import { DIA_MS, decidirAvisoReferencia, decidirAvisoVersion, estadoVersion, type AsientoVisto } from "./aviso-version";

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
    ahorroReferencia7dUsd: 0,
    conDatos7d: true,
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

describe("decidirAvisoVersion · el falso positivo del día de la migración", () => {
  it("un asiento SIN datos en 7 días (filas anteriores a 0024) no enciende el banner aunque su ahorro sea 0", () => {
    expect(decidirAvisoVersion([asiento({ conDatos7d: false, ahorroMedido7dUsd: 0 })], AHORA, MINIMA)).toBeNull();
  });

  it("con datos y 0 € sigue avisando — la verja solo excluye lo que no tiene medida", () => {
    expect(decidirAvisoVersion([asiento({ conDatos7d: true, ahorroMedido7dUsd: 0 })], AHORA, MINIMA)).not.toBeNull();
  });
});

/**
 * 0031 · Un gateway al día cuyo ahorro de la semana son repeticiones medidas por
 * referencia NO es un gateway con «0 € medidos»: con COMISIONAR_REFERENCIA,
 * `agregarAsientos` las suma a ahorroMedido7dUsd y el aviso no salta. La
 * decisión sigue siendo la misma (`> 0`); lo que cambia es lo que llega.
 */
describe("decidirAvisoVersion · el ahorro medido por referencia también es dinero (0031)", () => {
  it("gateway ≥ mínima, con datos de 7 días y ahorro SOLO por referencia: null", () => {
    const soloReferencia: FilaAsiento = {
      seatId: "m-ref",
      isCi: false,
      day: new Date(AHORA - DIA_MS).toISOString().slice(0, 10),
      lastSeenAt: hace(1),
      versionMin: "gateway/0.4.17",
      versionMax: "gateway/0.4.17",
      requestsSinVersion: 0,
      measuredBaselineCost: 0,
      measuredActualCost: 0,
      referenceBaselineCost: 0.03,
      referenceActualCost: 0,
    };
    const [con] = agregarAsientos([soloReferencia], AHORA, { incluirReferencia: true });
    expect(con!.conDatos7d).toBe(true);
    expect(decidirAvisoVersion([con!], AHORA, MINIMA)).toBeNull();
    // Y sin el interruptor, el mismo asiento sí avisa: la regla es la del cobro.
    const [sin] = agregarAsientos([soloReferencia], AHORA, { incluirReferencia: false });
    expect(decidirAvisoVersion([sin!], AHORA, MINIMA)).toMatchObject({ sinPalanca: 1 });
  });

  it("con el campo ya agregado: ahorro por referencia > 0 y medido 0 → el aviso lo decide ahorroMedido7dUsd", () => {
    expect(decidirAvisoVersion([asiento({ ahorroMedido7dUsd: 0.03, ahorroReferencia7dUsd: 0.03 })], AHORA, MINIMA)).toBeNull();
  });
});

/**
 * El aviso de la referencia: un SDK por debajo de VERSION_MINIMA_REFERENCIA
 * (0.4.29) ve sus repeticiones entrar como estimated. Decide la VERSIÓN, con la
 * misma verja que el ingest; el gateway y «sin versión» no avisan.
 */
describe("decidirAvisoReferencia — un SDK por debajo de la mínima de la referencia", () => {
  const sdk = (v: string | null, p: Partial<AsientoVisto> = {}) =>
    asiento({ surface: v ? "sdk" : null, versionMin: v, versionMax: v, ...p });

  it("usa la mínima del espejo del ingest (0.4.29), sin copia propia", () => {
    expect(VERSION_MINIMA_REFERENCIA).toBe("0.4.29");
    expect(decidirAvisoReferencia([sdk("sdk/0.4.28")], AHORA)?.minima).toBe(VERSION_MINIMA_REFERENCIA);
  });

  it("sdk/0.4.28 → aviso, con la versión más antigua para el texto", () => {
    expect(decidirAvisoReferencia([sdk("sdk/0.4.28"), sdk("sdk/0.4.26", { seatId: "otra" })], AHORA)).toEqual({
      tipo: "sdkSinReferencia",
      desactualizadas: 2,
      versionMasAntigua: "sdk/0.4.26",
      minima: "0.4.29",
    });
  });

  it("sdk/0.4.29 y posteriores → sin aviso (0.10.0 por orden numérico)", () => {
    for (const v of ["sdk/0.4.29", "sdk/0.4.30", "sdk/0.10.0", "sdk/1.0.0"]) {
      expect(decidirAvisoReferencia([sdk(v)], AHORA), v).toBeNull();
    }
  });

  it("una preliminar de la mínima (sdk/0.4.29-rc.1) avisa: el ingest también la degrada", () => {
    expect(decidirAvisoReferencia([sdk("sdk/0.4.29-rc.1")], AHORA)?.desactualizadas).toBe(1);
  });

  it("gateway → sin aviso, a cualquier versión (no emite referencias comisionables)", () => {
    for (const v of ["gateway/0.4.16", "gateway/0.4.28", "gateway/0.4.29"]) {
      expect(decidirAvisoReferencia([asiento({ surface: "gateway", versionMin: v, versionMax: v })], AHORA), v).toBeNull();
    }
  });

  it("un asiento que mezcla gateway (la menor) y SDK (la mayor) no se atribuye: sin aviso", () => {
    expect(
      decidirAvisoReferencia([asiento({ surface: "sdk", versionMin: "gateway/0.4.20", versionMax: "sdk/0.4.28" })], AHORA),
    ).toBeNull();
  });

  it("sin versión → sin aviso: nunca declaró, o algún registro de 7 días vino sin ella", () => {
    expect(decidirAvisoReferencia([sdk(null)], AHORA)).toBeNull();
    expect(decidirAvisoReferencia([sdk("sdk/0.4.28", { sinVersion7d: true })], AHORA)).toBeNull();
    expect(decidirAvisoReferencia([sdk("basura")], AHORA)).toBeNull();
  });

  it("CI y asientos no vistos en 7 días (o con fecha futura o inválida) no cuentan", () => {
    expect(decidirAvisoReferencia([sdk("sdk/0.4.28", { isCi: true })], AHORA)).toBeNull();
    expect(decidirAvisoReferencia([sdk("sdk/0.4.28", { lastSeenAt: hace(8) })], AHORA)).toBeNull();
    expect(decidirAvisoReferencia([sdk("sdk/0.4.28", { lastSeenAt: hace(-1) })], AHORA)).toBeNull();
    expect(decidirAvisoReferencia([sdk("sdk/0.4.28", { lastSeenAt: "nunca" })], AHORA)).toBeNull();
  });

  it("decide la versión, no el dinero: un SDK 0.4.28 con ahorro medido también avisa", () => {
    expect(decidirAvisoReferencia([sdk("sdk/0.4.28", { ahorroMedido7dUsd: 5 })], AHORA)?.desactualizadas).toBe(1);
  });

  it("con los dos avisos a la vez, ninguno pisa al otro", () => {
    const gatewayViejoSinEuro = asiento({ seatId: "gw", versionMin: "gateway/0.4.15", versionMax: "gateway/0.4.15" });
    const sdkViejo = sdk("sdk/0.4.28", { seatId: "sdk" });
    const sdkAlDia = sdk("sdk/0.4.29", { seatId: "sdk-nuevo" });
    const todos = [gatewayViejoSinEuro, sdkViejo, sdkAlDia];

    const tarifa = decidirAvisoVersion(todos, AHORA, MINIMA);
    const referencia = decidirAvisoReferencia(todos, AHORA);
    // El de tarifa ve solo el gateway, igual que sin los SDK.
    expect(tarifa).toEqual(decidirAvisoVersion([gatewayViejoSinEuro], AHORA, MINIMA));
    expect(tarifa).toMatchObject({ tipo: "gatewaySinAhorro", activas: 1, desactualizadas: 1 });
    // El de referencia ve solo el SDK viejo, igual que sin el gateway.
    expect(referencia).toEqual(decidirAvisoReferencia([sdkViejo], AHORA));
    expect(referencia).toMatchObject({ tipo: "sdkSinReferencia", desactualizadas: 1 });
  });
});
