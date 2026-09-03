import { describe, it, expect } from "vitest";

import { construirExtracto, type FilaDiaria } from "./extracto";

/**
 * S2.7 · El carril sombra en el extracto. La única verja que importa de verdad:
 * la sombra es CONTEXTO — puede aparecer, desaparecer o salir negativa sin que
 * la base, el ahorro medido ni la comisión se muevan un céntimo.
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

describe("el carril sombra del extracto (0021)", () => {
  it("⛔ la sombra NO mueve ni la base ni la comisión — es contexto puro", () => {
    const sin = construirExtracto({ ...base, filas: [fila("2026-09-01")] });
    const con = construirExtracto({
      ...base,
      filas: [fila("2026-09-01", { shadow_requests: 50, shadow_baseline_cost: 30, shadow_actual_cost: 24 })],
    });
    expect(con.baseMedidaUsd).toBe(sin.baseMedidaUsd);
    expect(con.ahorroMedidoUsd).toBe(sin.ahorroMedidoUsd);
    expect(con.comision).toEqual(sin.comision);
    expect(con.cargoEur).toBe(sin.cargoEur);
    expect(con.sombra).toEqual({ requests: 50, ahorroUsd: 6 });
  });

  it("sin datos de sombra, null — la línea no se pinta (nada de ceros fabricados)", () => {
    const e = construirExtracto({ ...base, filas: [fila("2026-09-01")] });
    expect(e.sombra).toBeNull();
  });

  it("una política que PIERDE dinero sale negativa tal cual — este carril dice la verdad", () => {
    const e = construirExtracto({
      ...base,
      filas: [fila("2026-09-01", { shadow_requests: 10, shadow_baseline_cost: 20, shadow_actual_cost: 27.5 })],
    });
    expect(e.sombra).toEqual({ requests: 10, ahorroUsd: -7.5 });
  });

  it("solo suma la sombra del período pedido, como todo lo demás", () => {
    const e = construirExtracto({
      ...base,
      filas: [
        fila("2026-08-31", { shadow_requests: 99, shadow_baseline_cost: 999, shadow_actual_cost: 1 }),
        fila("2026-09-01", { shadow_requests: 5, shadow_baseline_cost: 10, shadow_actual_cost: 8 }),
      ],
    });
    expect(e.sombra).toEqual({ requests: 5, ahorroUsd: 2 });
  });
});
