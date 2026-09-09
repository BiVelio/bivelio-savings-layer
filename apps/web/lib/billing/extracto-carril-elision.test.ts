import { describe, it, expect, vi } from "vitest";

import { construirExtracto, type FilaDiaria } from "./extracto";
import { COMISIONAR_ELISION_SUELO } from "./tarifa";

/**
 * B1 · El carril del borrado del proveedor (0025) en el extracto. La única
 * verja que importa: es CONTEXTO — puede aparecer, desaparecer o crecer sin
 * que la base, el ahorro medido ni la comisión se muevan un céntimo, mientras
 * COMISIONAR_ELISION_SUELO sea false.
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

const FX = { eurPorUsd: 1, fuente: "BCE 2026-08-31 (test)" };
const base = { orgId: "org-1", periodo: "2026-09", esCalibracion: false, versionPrecios: "v", fx: FX };

describe("el carril del borrado del proveedor en el extracto (0025)", () => {
  it("🔒 SELLO (2026-09-09): con el interruptor encendido el extracto REVIENTA, no factura", async () => {
    // El suelo es un BRUTO: cuenta lo borrado a precio de lectura y jamás resta
    // la invalidación de prefijo que el mismo corte provoca. Medido sobre el
    // tráfico real del 08 y el 09 de septiembre, el NETO de esos días es
    // NEGATIVO. Facturarlo sería cobrarle al cliente el daño causado.
    //
    // Las dos mitades del sello: el interruptor sigue apagado, y si alguien lo
    // enciende el extracto lanza en vez de sumar el bruto a la base en
    // silencio. Quien quiera cobrarlo tiene que borrar el guardia a mano.
    expect(COMISIONAR_ELISION_SUELO).toBe(false);

    vi.resetModules();
    vi.doMock("./tarifa", async () => ({
      ...(await vi.importActual<typeof import("./tarifa")>("./tarifa")),
      COMISIONAR_ELISION_SUELO: true,
    }));
    const { construirExtracto: conElInterruptor } = await import("./extracto");
    expect(() =>
      conElInterruptor({
        ...base,
        filas: [fila("2026-09-01", { eliminated_floor_cost: 40, eliminated_credited_requests: 10 })],
      }),
    ).toThrow(/BRUTO|no se puede facturar/i);
    vi.doUnmock("./tarifa");
    vi.resetModules();
  });

  it("⛔ el suelo NO mueve ni la base ni el ahorro ni la comisión — contexto puro con el interruptor apagado", () => {
    expect(COMISIONAR_ELISION_SUELO).toBe(false);
    const sin = construirExtracto({ ...base, filas: [fila("2026-09-01")] });
    const con = construirExtracto({
      ...base,
      // Un suelo ENORME a propósito: si se colara en la base, la comisión saltaría de tramo.
      filas: [fila("2026-09-01", { eliminated_credited_requests: 40, eliminated_floor_cost: 9_999 })],
    });
    expect(con.baseMedidaUsd).toBe(sin.baseMedidaUsd);
    expect(con.ahorroMedidoUsd).toBe(sin.ahorroMedidoUsd);
    expect(con.baseMedidaEur).toBe(sin.baseMedidaEur);
    expect(con.ahorroMedidoEur).toBe(sin.ahorroMedidoEur);
    expect(con.comision).toEqual(sin.comision);
    expect(con.cargoEur).toBe(sin.cargoEur);
    expect(con.ahorroEstimadoExcluidoUsd).toBe(sin.ahorroEstimadoExcluidoUsd);
    expect(con.elisionProveedor).toEqual({ requests: 40, floorUsd: 9_999 });
  });

  it("sin acreditadas, null — la línea no se pinta (nada de ceros fabricados)", () => {
    expect(construirExtracto({ ...base, filas: [fila("2026-09-01")] }).elisionProveedor).toBeNull();
    // Columnas presentes pero a cero (día sin borrado): tampoco.
    expect(
      construirExtracto({
        ...base,
        filas: [fila("2026-09-01", { eliminated_credited_requests: 0, eliminated_floor_cost: 0 })],
      }).elisionProveedor,
    ).toBeNull();
  });

  it("el dólar suelo viaja redondeado a céntimos, para auditoría — la vista solo pinta requests", () => {
    const e = construirExtracto({
      ...base,
      filas: [
        fila("2026-09-01", { eliminated_credited_requests: 3, eliminated_floor_cost: 0.004 }),
        fila("2026-09-02", { eliminated_credited_requests: 2, eliminated_floor_cost: 0.003 }),
      ],
    });
    expect(e.elisionProveedor).toEqual({ requests: 5, floorUsd: 0.01 });
  });

  it("solo suma el carril del período pedido, como todo lo demás", () => {
    const e = construirExtracto({
      ...base,
      filas: [
        fila("2026-08-31", { eliminated_credited_requests: 99, eliminated_floor_cost: 99 }),
        fila("2026-09-01", { eliminated_credited_requests: 5, eliminated_floor_cost: 0.5 }),
      ],
    });
    expect(e.elisionProveedor).toEqual({ requests: 5, floorUsd: 0.5 });
  });

  it("la sombra y el borrado del proveedor conviven como dos carriles distintos, ninguno en la base", () => {
    const sin = construirExtracto({ ...base, filas: [fila("2026-09-01")] });
    const con = construirExtracto({
      ...base,
      filas: [
        fila("2026-09-01", {
          shadow_requests: 50, shadow_baseline_cost: 30, shadow_actual_cost: 24,
          eliminated_credited_requests: 7, eliminated_floor_cost: 0.07,
        }),
      ],
    });
    expect(con.comision).toEqual(sin.comision);
    expect(con.sombra).toEqual({ requests: 50, ahorroUsd: 6 });
    expect(con.elisionProveedor).toEqual({ requests: 7, floorUsd: 0.07 });
  });
});
