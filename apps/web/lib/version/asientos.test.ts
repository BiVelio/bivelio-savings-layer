import { describe, it, expect } from "vitest";

import { agregarAsientos, type FilaAsiento } from "./asientos";
import { DIA_MS } from "./aviso-version";

/**
 * De filas asiento-DÍA (seat_activity, 0024) a un asiento por máquina. Lo que
 * importa: la versión que se cita es la de la ventana de 7 días (no la de hace
 * tres semanas), la ventana se decide por el DÍA de la fila y no por
 * last_seen_at, y el dinero de 7 días es la suma medida de esas filas.
 */
const AHORA = Date.parse("2026-09-07T12:00:00Z");
const dia = (haceDias: number) => new Date(AHORA - haceDias * DIA_MS).toISOString().slice(0, 10);
const visto = (haceDias: number, hora = "10:00:00") => `${dia(haceDias)}T${hora}Z`;

function fila(p: Partial<FilaAsiento> = {}): FilaAsiento {
  return {
    seatId: "m-a",
    isCi: false,
    day: dia(1),
    lastSeenAt: visto(1),
    versionMin: "gateway/0.4.17",
    versionMax: "gateway/0.4.17",
    requestsSinVersion: 0,
    measuredBaselineCost: 0,
    measuredActualCost: 0,
    ...p,
  };
}

describe("agregarAsientos", () => {
  it("sin filas, sin asientos", () => {
    expect(agregarAsientos([], AHORA)).toEqual([]);
  });

  it("una fila = un asiento con sus campos y la superficie del prefijo", () => {
    expect(agregarAsientos([fila({ measuredBaselineCost: 1.5, measuredActualCost: 1 })], AHORA)).toEqual([
      {
        seatId: "m-a",
        isCi: false,
        surface: "gateway",
        versionMin: "gateway/0.4.17",
        versionMax: "gateway/0.4.17",
        sinVersion7d: false,
        lastSeenAt: visto(1),
        ahorroMedido7dUsd: 0.5,
        ahorroReferencia7dUsd: 0,
        conDatos7d: true,
      },
    ]);
  });

  it("lastSeenAt es la mayor de las filas del asiento", () => {
    const [a] = agregarAsientos([fila({ day: dia(3), lastSeenAt: visto(3) }), fila({ day: dia(1), lastSeenAt: visto(1, "18:30:00") }), fila({ day: dia(2), lastSeenAt: visto(2) })], AHORA);
    expect(a!.lastSeenAt).toBe(visto(1, "18:30:00"));
  });

  it("min/max por orden semver entre filas: 0.10.0 es mayor que 0.4.16", () => {
    const [a] = agregarAsientos(
      [
        fila({ day: dia(1), versionMin: "gateway/0.4.16", versionMax: "gateway/0.4.16" }),
        fila({ day: dia(2), versionMin: "gateway/0.10.0", versionMax: "gateway/0.10.0" }),
        fila({ day: dia(3), versionMin: "gateway/0.4.9", versionMax: "gateway/0.4.9" }),
      ],
      AHORA,
    );
    expect(a!.versionMin).toBe("gateway/0.4.9");
    expect(a!.versionMax).toBe("gateway/0.10.0");
  });

  it("prefiere la versión de la ventana de 7 días; cae a 30 días solo si en 7 no declaró nada", () => {
    // Se actualizó anteayer: la explicación no debe citar la 0.4.15 de hace 20 días.
    const [reciente] = agregarAsientos(
      [fila({ day: dia(20), versionMin: "gateway/0.4.15", versionMax: "gateway/0.4.15" }), fila({ day: dia(2), versionMin: "gateway/0.4.17", versionMax: "gateway/0.4.17" })],
      AHORA,
    );
    expect(reciente!.versionMin).toBe("gateway/0.4.17");
    expect(reciente!.versionMax).toBe("gateway/0.4.17");
    // En 7 días habló, pero sin versión: la única pista es la de hace 20 días.
    const [viejo] = agregarAsientos(
      [fila({ day: dia(20), versionMin: "gateway/0.4.15", versionMax: "gateway/0.4.15" }), fila({ day: dia(2), versionMin: null, versionMax: null, requestsSinVersion: 4 })],
      AHORA,
    );
    expect(viejo!.versionMin).toBe("gateway/0.4.15");
    expect(viejo!.sinVersion7d).toBe(true);
  });

  it("la ventana de 7 días se decide por el DÍA de la fila, no por last_seen_at", () => {
    const [a] = agregarAsientos(
      [fila({ day: dia(8), lastSeenAt: visto(0), requestsSinVersion: 3, measuredBaselineCost: 10, measuredActualCost: 5 }), fila({ day: dia(7), requestsSinVersion: 0, measuredBaselineCost: 2, measuredActualCost: 1 })],
      AHORA,
    );
    expect(a!.sinVersion7d).toBe(false);
    expect(a!.ahorroMedido7dUsd).toBe(1);
    expect(a!.lastSeenAt).toBe(visto(0));
  });

  it("sinVersion7d y ahorro de 7 días solo miran las filas de la ventana", () => {
    const [a] = agregarAsientos(
      [
        fila({ day: dia(1), measuredBaselineCost: 3, measuredActualCost: 2 }),
        fila({ day: dia(4), measuredBaselineCost: 1.25, measuredActualCost: 1 }),
        fila({ day: dia(15), requestsSinVersion: 9, measuredBaselineCost: 100, measuredActualCost: 1 }),
      ],
      AHORA,
    );
    expect(a!.sinVersion7d).toBe(false);
    expect(a!.ahorroMedido7dUsd).toBeCloseTo(1.25, 10);
  });

  it("un asiento es CI si CUALQUIER fila lo marcó", () => {
    const [a] = agregarAsientos([fila({ isCi: false }), fila({ day: dia(2), isCi: true })], AHORA);
    expect(a!.isCi).toBe(true);
  });

  it("una versión guardada que no casa no rompe y cede ante una válida", () => {
    const [a] = agregarAsientos([fila({ day: dia(1), versionMin: "basura", versionMax: "basura" }), fila({ day: dia(2) })], AHORA);
    expect(a!.versionMin).toBe("gateway/0.4.17");
    expect(a!.versionMax).toBe("gateway/0.4.17");
    const [solo] = agregarAsientos([fila({ versionMin: "basura", versionMax: "basura" })], AHORA);
    expect(solo!.versionMin).toBe("basura");
    expect(solo!.surface).toBeNull();
  });

  it("un día ilegible no entra en la ventana de 7 días", () => {
    const [a] = agregarAsientos([fila({ day: "ayer", measuredBaselineCost: 5, measuredActualCost: 1 })], AHORA);
    expect(a!.ahorroMedido7dUsd).toBe(0);
  });

  it("agrupa por asiento y ordena los más recientes primero", () => {
    const out = agregarAsientos(
      [fila({ seatId: "m-viejo", day: dia(5), lastSeenAt: visto(5) }), fila({ seatId: "m-nuevo", day: dia(0), lastSeenAt: visto(0) }), fila({ seatId: "m-viejo", day: dia(4), lastSeenAt: visto(4) })],
      AHORA,
    );
    expect(out.map((a) => a.seatId)).toEqual(["m-nuevo", "m-viejo"]);
  });
});

/**
 * EL FALSO POSITIVO DEL DÍA DE LA MIGRACIÓN. Las filas de seat_activity anteriores a
 * 0024 no traen versión ni contador de sin-versión, y sus measured_* son los defaults
 * (0). Sumarlas como «0 € medidos en 7 días» encendería el banner ámbar en TODAS las
 * máquinas el día que se aplica 0024, sin que ninguna haya dejado de ahorrar.
 */
describe("agregarAsientos · filas anteriores a 0024 no cuentan como «sin ahorro»", () => {
  it("un asiento con solo filas pre-canal sale con conDatos7d=false y ahorro 0", () => {
    const [a] = agregarAsientos([fila({ versionMin: null, versionMax: null, requestsSinVersion: 0, measuredBaselineCost: 0, measuredActualCost: 0 })], AHORA);
    expect(a!.conDatos7d).toBe(false);
    expect(a!.ahorroMedido7dUsd).toBe(0);
  });

  it("en cuanto una fila de 7 días trae versión O contador de sin-versión, hay datos", () => {
    const [conVersion] = agregarAsientos([fila({ versionMin: "gateway/0.4.16", versionMax: "gateway/0.4.16" })], AHORA);
    expect(conVersion!.conDatos7d).toBe(true);
    const [sinDeclarar] = agregarAsientos([fila({ versionMin: null, versionMax: null, requestsSinVersion: 3 })], AHORA);
    expect(sinDeclarar!.conDatos7d).toBe(true);
  });

  it("las filas pre-canal NO diluyen el ahorro de las filas con datos del mismo asiento", () => {
    const [a] = agregarAsientos(
      [
        fila({ day: dia(1), versionMin: null, versionMax: null, requestsSinVersion: 0, measuredBaselineCost: 0, measuredActualCost: 0 }),
        fila({ day: dia(2), versionMin: "gateway/0.4.16", versionMax: "gateway/0.4.16", measuredBaselineCost: 2, measuredActualCost: 1.5 }),
      ],
      AHORA,
    );
    expect(a!.conDatos7d).toBe(true);
    expect(a!.ahorroMedido7dUsd).toBeCloseTo(0.5, 9);
  });
});

/**
 * 0031 · LO MEDIDO POR REFERENCIA, POR ASIENTO. Con COMISIONAR_REFERENCIA, el
 * titular y el extracto suman la referencia como medida; la tarjeta de máquinas
 * y el aviso tienen que hacer lo mismo, o una máquina que solo ahorra por
 * repeticiones sale con «0 € medidos». `ahorroReferencia7dUsd` es siempre la
 * parte de referencia (para la nota), con el interruptor como esté.
 */
describe("agregarAsientos · lo medido por referencia (0031)", () => {
  it("asiento solo con referencia: bajo el interruptor cuenta como medido; sin él, no", () => {
    const filas = [fila({ referenceBaselineCost: 0.02, referenceActualCost: 0 })];
    const [con] = agregarAsientos(filas, AHORA, { incluirReferencia: true });
    expect(con!.ahorroMedido7dUsd).toBeCloseTo(0.02, 12);
    expect(con!.ahorroReferencia7dUsd).toBeCloseTo(0.02, 12);
    const [sin] = agregarAsientos(filas, AHORA, { incluirReferencia: false });
    expect(sin!.ahorroMedido7dUsd).toBe(0);
    // La parte de referencia se sigue viendo: el interruptor decide qué suma, no qué existe.
    expect(sin!.ahorroReferencia7dUsd).toBeCloseTo(0.02, 12);
  });

  it("por defecto sigue al interruptor de cobro (hoy encendido)", () => {
    const [a] = agregarAsientos([fila({ referenceBaselineCost: 0.5, referenceActualCost: 0 })], AHORA);
    expect(a!.ahorroMedido7dUsd).toBeCloseTo(0.5, 12);
  });

  it("la referencia de más de 7 días no cuenta (ventana por el DÍA de la fila)", () => {
    const [a] = agregarAsientos(
      [fila({ day: dia(9), lastSeenAt: visto(0), referenceBaselineCost: 3, referenceActualCost: 0 })],
      AHORA,
      { incluirReferencia: true },
    );
    expect(a!.ahorroMedido7dUsd).toBe(0);
    expect(a!.ahorroReferencia7dUsd).toBe(0);
  });

  it("una fila pre-canal no suma referencia (misma regla que lo medido)", () => {
    const [a] = agregarAsientos(
      [fila({ versionMin: null, versionMax: null, requestsSinVersion: 0, referenceBaselineCost: 4, referenceActualCost: 0 })],
      AHORA,
      { incluirReferencia: true },
    );
    expect(a!.conDatos7d).toBe(false);
    expect(a!.ahorroMedido7dUsd).toBe(0);
    expect(a!.ahorroReferencia7dUsd).toBe(0);
  });

  it("medido y referencia a la vez: se suman, y la nota ve solo la referencia", () => {
    const [a] = agregarAsientos(
      [
        fila({ day: dia(1), measuredBaselineCost: 2, measuredActualCost: 1.5, referenceBaselineCost: 0.25, referenceActualCost: 0 }),
        fila({ day: dia(3), measuredBaselineCost: 1, measuredActualCost: 1, referenceBaselineCost: 0.25, referenceActualCost: 0 }),
      ],
      AHORA,
      { incluirReferencia: true },
    );
    expect(a!.ahorroMedido7dUsd).toBeCloseTo(1, 12);
    expect(a!.ahorroReferencia7dUsd).toBeCloseTo(0.5, 12);
  });

  it("sin las columnas de 0031 (campos ausentes) la referencia es 0", () => {
    const [a] = agregarAsientos([fila({ measuredBaselineCost: 1, measuredActualCost: 0.5 })], AHORA, { incluirReferencia: true });
    expect(a!.ahorroMedido7dUsd).toBeCloseTo(0.5, 12);
    expect(a!.ahorroReferencia7dUsd).toBe(0);
  });
});
