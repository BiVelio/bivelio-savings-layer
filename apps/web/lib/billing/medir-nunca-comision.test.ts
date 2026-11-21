import { describe, expect, it } from "vitest";

import { cerrarPeriodo } from "./cierre";
import type { FilaDiaria } from "./extracto";
import { orgsExentasPorMedir, tieneHistoriaDeComision } from "./plan-de-la-org";

/**
 * LA LICENCIA GRATUITA «MEDIR» NUNCA GENERA COMISIÓN (1.2.4).
 *
 * Desde la 1.2.4 una organización Medir ahorra de verdad y su ahorro MEDIDO se
 * guarda para el panel. Antes el candado era que ese ahorro llegaba a cero; ahora
 * es esta regla, que el cierre y la facturación aplican: una organización con
 * licencia Medir y sin historia de la modalidad con comisión está EXENTA.
 */

const PRECIOS = { pro: ["price_pro_m", "price_pro_y"], equipo: ["price_team_m"] };
const FIN = "2026-12-01"; // primer día del período siguiente a 2026-11
const MEDIR = (org: string, issued_at = "2026-11-03T10:00:00Z") => ({ org_id: org, issued_at });

describe("tieneHistoriaDeComision", () => {
  it("sin suscripciones: no", () => {
    expect(tieneHistoriaDeComision([], PRECIOS)).toBe(false);
  });
  it("solo Pro o Equipo, vivas o canceladas: no", () => {
    expect(tieneHistoriaDeComision([{ price_id: "price_pro_m" }, { price_id: "price_team_m" }], PRECIOS)).toBe(false);
  });
  it("una suscripción de la modalidad con comisión, aunque esté cancelada: sí", () => {
    expect(tieneHistoriaDeComision([{ price_id: "price_pro_m" }, { price_id: "price_comision_antiguo" }], PRECIOS)).toBe(true);
  });
  it("CONSERVADOR: un price id nulo o un despliegue sin Prices de Pro/Equipo cuentan como comisión (nada cambia para esa org)", () => {
    expect(tieneHistoriaDeComision([{ price_id: null }], PRECIOS)).toBe(true);
    expect(tieneHistoriaDeComision([{ price_id: "price_pro_m" }], { pro: [], equipo: [] })).toBe(true);
  });
});

describe("orgsExentasPorMedir", () => {
  it("una org que solo tiene Medir, sin ninguna suscripción: exenta", () => {
    expect([...orgsExentasPorMedir([MEDIR("a")], [], PRECIOS, FIN)]).toEqual(["a"]);
  });
  it("Medir + Pro cancelado (volvió a Medir): exenta — Pro nunca llevó comisión", () => {
    expect(orgsExentasPorMedir([MEDIR("a")], [{ org_id: "a", price_id: "price_pro_m" }], PRECIOS, FIN).has("a")).toBe(true);
  });
  it("Medir + modalidad con comisión (viva o cancelada): NO exenta — su cierre es el de siempre", () => {
    const subs = [{ org_id: "a", price_id: "price_comision_antiguo" }];
    expect(orgsExentasPorMedir([MEDIR("a")], subs, PRECIOS, FIN).has("a")).toBe(false);
  });
  it("una org SIN licencia Medir no entra en esta exención, tenga lo que tenga", () => {
    expect(orgsExentasPorMedir([MEDIR("a")], [], PRECIOS, FIN).has("b")).toBe(false);
    expect(orgsExentasPorMedir([], [{ org_id: "b", price_id: "price_pro_m" }], PRECIOS, FIN).size).toBe(0);
  });
  it("una Medir emitida DESPUÉS del período no exime ese período; sin fecha legible, tampoco", () => {
    expect(orgsExentasPorMedir([MEDIR("a", "2026-12-01T00:00:00Z")], [], PRECIOS, FIN).size).toBe(0);
    expect(orgsExentasPorMedir([{ org_id: "a", issued_at: null }], [], PRECIOS, FIN).size).toBe(0);
  });
  it("la suscripción con comisión de OTRA org no le quita la exención a esta", () => {
    const subs = [{ org_id: "otra", price_id: "price_comision_antiguo" }];
    expect(orgsExentasPorMedir([MEDIR("a"), MEDIR("otra")], subs, PRECIOS, FIN)).toEqual(new Set(["a"]));
  });
});

describe("el cierre de una org Medir que AHORRA DE VERDAD", () => {
  // Un mes con ahorro medido serio: 4 000 $ de base, 1 000 $ pagados.
  const filas: FilaDiaria[] = [
    {
      day: "2026-11-10",
      requests: 5000,
      baseline_cost: 4000,
      actual_cost: 1000,
      measured_requests: 5000,
      measured_baseline_cost: 4000,
      measured_actual_cost: 1000,
    },
  ];
  const fx = { eurPorUsd: 0.9, fuente: "test" };

  it("con la exención por Medir: comisión calculada, CARGO 0 y marcada exenta", () => {
    const exentas = orgsExentasPorMedir([MEDIR("medir")], [], PRECIOS, FIN);
    const [fila] = cerrarPeriodo(
      [{ orgId: "medir", filas, primerPeriodoConUso: "2026-10", comisionExenta: exentas.has("medir") }],
      "2026-11",
      fx,
    );
    expect(fila!.ahorro_medido_usd).toBe(3000); // el panel y el extracto ven el ahorro real
    expect(fila!.es_exento).toBe(true);
    expect(fila!.cargo_eur).toBe(0);
  });

  it("CONTRASTE: el mismo uso en una org con comisión SÍ lleva cargo (la exención es lo que protege a Medir)", () => {
    const exentas = orgsExentasPorMedir([MEDIR("legado")], [{ org_id: "legado", price_id: "price_comision_antiguo" }], PRECIOS, FIN);
    const [fila] = cerrarPeriodo(
      [{ orgId: "legado", filas, primerPeriodoConUso: "2026-10", comisionExenta: exentas.has("legado") }],
      "2026-11",
      fx,
    );
    expect(fila!.es_exento).toBe(false);
    expect(fila!.cargo_eur).toBeGreaterThan(0);
  });
});
