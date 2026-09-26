import { describe, it, expect, vi } from "vitest";

import { construirExtracto, type FilaDiaria } from "./extracto";
import { COMISIONAR_REFERENCIA, REGLA_REFERENCIA } from "./tarifa";

/**
 * 0029 · El carril MEDIDO POR REFERENCIA en el extracto. A diferencia de la
 * sombra (0021) y del suelo de la elisión (0025), esto SÍ es medido: el
 * contador que el proveedor devolvió para la petición idéntica que ya corrió,
 * valorado a la baja. Bajo COMISIONAR_REFERENCIA entra en la base, en el
 * ahorro, en las peticiones medidas y, por tanto, en la comisión.
 *
 * En las filas de usage_daily la RPC suma una referencia a los TOTALES como un
 * estimado (baseline_cost/actual_cost) y, además, a reference_*: por eso las
 * filas de prueba llevan la referencia dentro del total.
 */

function fila(day: string, extra?: Partial<FilaDiaria>): FilaDiaria {
  return {
    day,
    baseline_cost: 140,
    actual_cost: 110,
    requests: 100,
    measured_requests: 80,
    measured_baseline_cost: 100,
    measured_actual_cost: 60,
    ...extra,
  };
}

/** Una fila con 20 repeticiones por referencia que valen 10 USD (dentro del total). */
function conReferencia(day: string, extra?: Partial<FilaDiaria>): FilaDiaria {
  return fila(day, {
    baseline_cost: 150,
    requests: 120,
    reference_requests: 20,
    reference_baseline_cost: 10,
    reference_actual_cost: 0,
    ...extra,
  });
}

const FX = { eurPorUsd: 1, fuente: "BCE 2026-08-31 (test)" };
const base = { orgId: "org-1", periodo: "2026-09", esCalibracion: false, versionPrecios: "v", fx: FX };

describe("el carril medido por referencia en el extracto (0029)", () => {
  it("está COMISIONADO: el interruptor nace encendido", () => {
    expect(COMISIONAR_REFERENCIA).toBe(true);
  });

  it("suma a la base, al ahorro, a las peticiones medidas y a la comisión", () => {
    const sin = construirExtracto({ ...base, filas: [fila("2026-09-01")] });
    const con = construirExtracto({ ...base, filas: [conReferencia("2026-09-01")] });
    expect(con.baseMedidaUsd).toBe(sin.baseMedidaUsd + 10);
    expect(con.ahorroMedidoUsd).toBe(sin.ahorroMedidoUsd + 10);
    expect(con.requestsMedidas).toBe(sin.requestsMedidas + 20);
    expect(con.baseMedidaEur).toBe(sin.baseMedidaEur + 10);
    expect(con.comision.comisionEur).toBeGreaterThan(sin.comision.comisionEur);
    expect(con.cargoEur).toBe(con.comision.comisionEur);
    expect(con.referencia).toEqual({ requests: 20, baseUsd: 10, ahorroUsd: 10, comisionada: true });
  });

  it("sin columnas de 0029 (o a cero) → referencia null y el dinero igual que antes de 0029", () => {
    const antes = construirExtracto({ ...base, filas: [fila("2026-09-01")] });
    const aCero = construirExtracto({
      ...base,
      filas: [fila("2026-09-01", { reference_requests: 0, reference_baseline_cost: 0, reference_actual_cost: 0 })],
    });
    for (const e of [antes, aCero]) {
      expect(e.referencia).toBeNull();
    }
    // Todo lo demás, byte a byte: lo único nuevo del documento son `referencia`
    // (null) y la regla en los parámetros.
    const { referencia: _r1, parametros: p1, ...resto1 } = antes;
    const { referencia: _r2, parametros: p2, ...resto2 } = aCero;
    expect(resto2).toEqual(resto1);
    expect(p2).toEqual(p1);
    expect(antes.baseMedidaUsd).toBe(100);
    expect(antes.ahorroMedidoUsd).toBe(40);
    expect(antes.requestsMedidas).toBe(80);
  });

  it("en calibración: el MISMO documento, con cargo 0", () => {
    const real = construirExtracto({ ...base, filas: [conReferencia("2026-09-01")] });
    const calib = construirExtracto({ ...base, esCalibracion: true, filas: [conReferencia("2026-09-01")] });
    expect(calib.cargoEur).toBe(0);
    expect(calib.comision).toEqual(real.comision);
    expect(calib.referencia).toEqual(real.referencia);
  });

  it("lo estimado excluido es total − (medido + referencia)", () => {
    const e = construirExtracto({ ...base, filas: [conReferencia("2026-09-01")] });
    // total: 150 − 110 = 40; medido 40 (100−60) … más la referencia 10 → estimado 0 (nunca negativo).
    expect(e.ahorroEstimadoExcluidoUsd).toBe(0);
    const conEstimado = construirExtracto({
      ...base,
      filas: [conReferencia("2026-09-01", { baseline_cost: 200, actual_cost: 130 })],
    });
    // total 70 − medido 40 − referencia 10 = 20 de estimado.
    expect(conEstimado.ahorroEstimadoExcluidoUsd).toBe(20);
  });

  it("los parámetros llevan la regla: el extracto es autocontenido", () => {
    const e = construirExtracto({ ...base, filas: [fila("2026-09-01")] });
    expect(e.parametros.referencia).toBe(REGLA_REFERENCIA);
    expect(e.parametros.referencia.version).toBe("reference-v2");
  });

  it("la sombra y el borrado del proveedor NO se mueven con la referencia", () => {
    const extra = { shadow_requests: 50, shadow_baseline_cost: 20, shadow_actual_cost: 14, eliminated_credited_requests: 7, eliminated_floor_cost: 0.07 };
    const sin = construirExtracto({ ...base, filas: [fila("2026-09-01", extra)] });
    const con = construirExtracto({ ...base, filas: [conReferencia("2026-09-01", extra)] });
    expect(con.sombra).toEqual(sin.sombra);
    expect(con.elisionProveedor).toEqual(sin.elisionProveedor);
    expect(con.sombra).toEqual({ requests: 50, ahorroUsd: 6 });
  });

  it("solo cuentan los días DEL período", () => {
    const e = construirExtracto({
      ...base,
      filas: [conReferencia("2026-08-31"), fila("2026-09-01")],
    });
    expect(e.referencia).toBeNull();
  });

  it("con el interruptor APAGADO: contexto en su línea, fuera de la base y de la comisión — y fuera del estimado", async () => {
    vi.resetModules();
    vi.doMock("./tarifa", async () => ({
      ...(await vi.importActual<typeof import("./tarifa")>("./tarifa")),
      COMISIONAR_REFERENCIA: false,
    }));
    try {
      const { construirExtracto: apagado } = await import("./extracto");
      const sin = apagado({ ...base, filas: [fila("2026-09-01", { baseline_cost: 200, actual_cost: 130 })] });
      const con = apagado({ ...base, filas: [conReferencia("2026-09-01", { baseline_cost: 200, actual_cost: 130 })] });
      expect(con.baseMedidaUsd).toBe(sin.baseMedidaUsd);
      expect(con.ahorroMedidoUsd).toBe(sin.ahorroMedidoUsd);
      expect(con.requestsMedidas).toBe(sin.requestsMedidas);
      expect(con.comision).toEqual(sin.comision);
      expect(con.referencia).toEqual({ requests: 20, baseUsd: 10, ahorroUsd: 10, comisionada: false });
      // La referencia no es estimado aunque no se cobre: total 70 − medido 40 − referencia 10.
      expect(con.ahorroEstimadoExcluidoUsd).toBe(20);
    } finally {
      vi.doUnmock("./tarifa");
      vi.resetModules();
    }
  });
});
