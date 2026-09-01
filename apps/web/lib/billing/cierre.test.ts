import { describe, it, expect } from "vitest";

import { cerrarPeriodo as cerrarConFx, periodoAnterior, type UsoDeOrg } from "./cierre";
import type { FilaDiaria } from "./extracto";

// FX de prueba = 0,9 (el que antes estaba fijo dentro de cerrarPeriodo): mantiene
// intactas las cifras esperadas de estos tests, ahora que el FX es un parámetro.
const FX_PRUEBA = { eurPorUsd: 0.9, fuente: "test" };
const cerrarPeriodo = (uso: UsoDeOrg[], periodo: string) => cerrarConFx(uso, periodo, FX_PRUEBA);

function fila(day: string, medidoBase: number, medidoActual: number): FilaDiaria {
  return {
    day,
    baseline_cost: medidoBase,
    actual_cost: medidoActual,
    requests: 10,
    measured_requests: 10,
    measured_baseline_cost: medidoBase,
    measured_actual_cost: medidoActual,
  };
}

function org(orgId: string, primerPeriodoConUso: string, filas: FilaDiaria[]): UsoDeOrg {
  return { orgId, filas, primerPeriodoConUso };
}

describe("periodoAnterior — el mes que el cron del día 1 cierra", () => {
  it("un 1 de octubre cierra septiembre", () => {
    expect(periodoAnterior(new Date("2026-10-01T05:00:00Z"))).toBe("2026-09");
  });
  it("un 1 de enero cierra diciembre del año anterior", () => {
    expect(periodoAnterior(new Date("2027-01-01T05:00:00Z"))).toBe("2026-12");
  });
});

describe("cerrarPeriodo — la calibración REAL, por primer período con uso", () => {
  it("primer período con uso == período cerrado → calibración: cargo 0, comisión fijada como habría-sido", () => {
    const [c] = cerrarPeriodo([org("a", "2026-09", [fila("2026-09-10", 2000, 1100)])], "2026-09");
    expect(c!.es_calibracion).toBe(true);
    expect(c!.cargo_eur).toBe(0);
    expect(c!.comision_eur).toBeGreaterThan(0);
  });

  it("con historia anterior → ya no es calibración y el cargo ES la comisión", () => {
    const [c] = cerrarPeriodo([org("a", "2026-08", [fila("2026-09-10", 2000, 1100)])], "2026-09");
    expect(c!.es_calibracion).toBe(false);
    expect(c!.cargo_eur).toBe(c!.comision_eur);
    // 900 USD × 0,9 = 810 € de ahorro, ratio 45% → rampa 1, primer tramo → 81 €.
    expect(c!.cargo_eur).toBeCloseTo(81, 10);
  });

  it("HONRA el fx que recibe (no un 0,9 fijo): con fx distinto, el EUR y la fuente cambian", () => {
    // Este caso distingue «usa el parámetro» de «sigue hardcodeando 0,9», que el
    // resto de tests (todos a 0,9) no podían: mismo uso, fx del BCE de mentira.
    const [c] = cerrarConFx(
      [org("a", "2026-08", [fila("2026-09-10", 2000, 1100)])],
      "2026-09",
      { eurPorUsd: 0.8, fuente: "BCE 2026-08-31" },
    );
    // 900 USD × 0,8 = 720 € de ahorro (no 810), primer tramo 10% → 72 € (no 81).
    expect(c!.ahorro_medido_eur).toBeCloseTo(720, 10);
    expect(c!.cargo_eur).toBeCloseTo(72, 10);
    expect(c!.fx_eur_por_usd).toBe(0.8);
    expect(c!.fx_fuente).toContain("BCE");
  });

  it("una organización que EMPIEZA el 15: su mes parcial es calibración y el siguiente se cobra entero", () => {
    // Pregunta del dueño (2026-08-24): ¿los 15 días sueltos cuentan como mes?
    // ¿se prorratea? NO HAY NADA QUE PRORRATEAR: la comisión es % del ahorro
    // MEDIDO del período, así que 15 días generan el ahorro de 15 días — la
    // proporcionalidad viene de la medición, no de un prorrateo. Y además ese
    // primer mes parcial ES la calibración: cargo 0 por diseño.
    const filasAgosto = [fila("2026-08-15", 1000, 550), fila("2026-08-28", 1000, 550)];
    const [agosto] = cerrarPeriodo([org("a", "2026-08", filasAgosto)], "2026-08");
    expect(agosto!.dias).toBe(2); // días CON uso, no días del calendario
    expect(agosto!.es_calibracion).toBe(true);
    expect(agosto!.cargo_eur).toBe(0);
    // La cifra «que habría sido» queda fijada igualmente, para que el cliente
    // vea en el panel lo que la calibración le regaló.
    expect(agosto!.comision_eur).toBeGreaterThan(0);

    // Septiembre: mismo primer-uso (agosto), ya NO es calibración; el mes se
    // cobra por su ahorro medido — completo o parcial, la regla es la misma.
    const [sept] = cerrarPeriodo([org("a", "2026-08", [fila("2026-09-10", 2000, 1100)])], "2026-09");
    expect(sept!.es_calibracion).toBe(false);
    expect(sept!.cargo_eur).toBe(sept!.comision_eur);
  });

  it("SIN MÍNIMO (2026-09-01): un ratio modesto comisiona y se carga fuera de calibración", () => {
    // 220 USD de ahorro (22%) × fx → primer tramo al 10%. Bajo la tarifa
    // vieja (umbral 30%) esto era 0; la revisión del dueño lo convierte en
    // cargo real. El factor_rampa de la fila queda fijado a 1 desde entonces.
    const [c] = cerrarPeriodo([org("a", "2026-08", [fila("2026-09-10", 1000, 780)])], "2026-09");
    expect(c!.es_calibracion).toBe(false);
    expect(c!.comision_eur).toBeGreaterThan(0);
    expect(c!.cargo_eur).toBe(c!.comision_eur);
    expect(c!.factor_rampa).toBe(1);
  });

  it("cada organización se cierra por separado, con sus propias filas", () => {
    const cierre = cerrarPeriodo(
      [
        org("a", "2026-09", [fila("2026-09-01", 100, 50)]),
        org("b", "2026-07", [fila("2026-09-01", 2000, 1100)]),
      ],
      "2026-09",
    );
    expect(cierre.map((c) => [c.org_id, c.es_calibracion])).toEqual([
      ["a", true],
      ["b", false],
    ]);
  });

  it("las filas JSON de tramos no llevan Infinity (el último tramo cierra con null)", () => {
    const [c] = cerrarPeriodo([org("a", "2026-08", [fila("2026-09-10", 60000, 10000)])], "2026-09");
    // 50.000 USD ahorro → 45.000 € : cruza los cuatro tramos.
    expect(c!.tramos.length).toBe(4);
    expect(c!.tramos.at(-1)!.hastaEur).toBeNull();
    expect(JSON.stringify(c!.tramos)).not.toContain("Infinity");
  });

  it("las restricciones de la tabla se cumplen por construcción (calibración → cargo 0; cargo ≤ comisión)", () => {
    for (const primer of ["2026-09", "2026-01"]) {
      for (const [base, actual] of [
        [2000, 1100],
        [1000, 780],
        [0, 0],
        [100, 130],
      ] as const) {
        const [c] = cerrarPeriodo([org("a", primer, [fila("2026-09-10", base, actual)])], "2026-09");
        if (c!.es_calibracion) expect(c!.cargo_eur).toBe(0);
        expect(c!.cargo_eur).toBeLessThanOrEqual(c!.comision_eur);
        expect(c!.ahorro_medido_usd).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
