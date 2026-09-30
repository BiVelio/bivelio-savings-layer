import { describe, expect, it } from "vitest";

import {
  ASIENTOS_INCLUIDOS_EQUIPO,
  PLANES_DE_PAGO,
  PLANES_EN_VENTA,
  PLAN_POR_DEFECTO,
  PRECIOS_DE_LOS_PLANES,
  calcularCobroDelPeriodo,
  calcularCuota,
  llevaComision,
  planDelPrecio,
  tarifaDeEquipoDesdeTramos,
  tarifaPorAsiento,
} from "./planes";
import { orgsSinComisionPorPlan } from "./plan-de-la-org";
import { calcularComision } from "./tarifa";

/**
 * LO QUE SE COBRA: asientos × precio, el plan de equipo y la comisión opcional.
 *
 * Las cifras de los casos se derivan de PRECIOS_DE_LOS_PLANES, no se copian: si el
 * dueño cambia los precios, los tests siguen probando la REGLA.
 */

const pro = PRECIOS_DE_LOS_PLANES.pro.monthly;
const equipo = PRECIOS_DE_LOS_PLANES.equipo.monthly;

describe("los precios son coherentes consigo mismos", () => {
  it("el anual de cada plan sale más barato que doce meses, y nunca gratis", () => {
    for (const plan of [PRECIOS_DE_LOS_PLANES.pro, PRECIOS_DE_LOS_PLANES.equipo]) {
      expect(plan.yearly.asientoCentimos).toBeLessThan(plan.monthly.asientoCentimos * 12);
      expect(plan.yearly.asientoCentimos).toBeGreaterThan(0);
      expect(plan.yearly.fijaCentimos).toBeLessThanOrEqual(plan.monthly.fijaCentimos * 12);
    }
  });

  it("en Equipo, cada asiento incluido sale más barato que uno Pro, y el extra no pasa del Pro", () => {
    expect(equipo.fijaCentimos / equipo.asientosIncluidos).toBeLessThan(pro.asientoCentimos);
    expect(equipo.asientoCentimos).toBeLessThanOrEqual(pro.asientoCentimos);
  });

  it("Equipo compensa a partir de algún tamaño de flota por debajo de los incluidos (si no, nadie lo compraría)", () => {
    const umbral = Math.ceil(equipo.fijaCentimos / pro.asientoCentimos);
    expect(umbral).toBeLessThanOrEqual(ASIENTOS_INCLUIDOS_EQUIPO);
    expect(calcularCuota(pro, ASIENTOS_INCLUIDOS_EQUIPO).totalCentimos).toBeGreaterThan(equipo.fijaCentimos);
  });

  it("todo en la misma moneda que la comisión y que el Price de siempre", () => {
    for (const plan of [PRECIOS_DE_LOS_PLANES.pro, PRECIOS_DE_LOS_PLANES.equipo]) {
      expect(plan.monthly.currency).toBe("eur");
      expect(plan.yearly.currency).toBe("eur");
    }
  });
});

describe("calcularCuota — asientos × precio", () => {
  it("Pro: n asientos a precio unitario, sin cuota fija", () => {
    const c = calcularCuota(pro, 7);
    expect(c.totalCentimos).toBe(7 * pro.asientoCentimos);
    expect(c.asientosCubiertos).toBe(7);
    expect(c.lineas).toEqual([{ concepto: "asientos", cantidad: 7, unitarioCentimos: pro.asientoCentimos, importeCentimos: 7 * pro.asientoCentimos }]);
  });

  it("Equipo con los incluidos justos: solo la cuota fija", () => {
    const c = calcularCuota(equipo, ASIENTOS_INCLUIDOS_EQUIPO);
    expect(c.totalCentimos).toBe(equipo.fijaCentimos);
    expect(c.asientosAPrecioUnitario).toBe(0);
    expect(c.lineas.map((l) => l.concepto)).toEqual(["cuota_fija"]);
  });

  it("Equipo con extras: cuota fija + cada asiento de más a su precio", () => {
    const extra = 5;
    const c = calcularCuota(equipo, ASIENTOS_INCLUIDOS_EQUIPO + extra);
    expect(c.totalCentimos).toBe(equipo.fijaCentimos + extra * equipo.asientoCentimos);
    expect(c.asientosCubiertos).toBe(ASIENTOS_INCLUIDOS_EQUIPO + extra);
  });

  it("⛔ Equipo por debajo de los incluidos NO se abarata: cubre y cobra los incluidos", () => {
    const c = calcularCuota(equipo, 1);
    expect(c.totalCentimos).toBe(equipo.fijaCentimos);
    expect(c.asientosCubiertos).toBe(ASIENTOS_INCLUIDOS_EQUIPO);
  });

  it("entradas absurdas caen en un asiento, y un decimal se trunca (nunca se cobra un asiento no pedido)", () => {
    expect(calcularCuota(pro, 0).asientosCubiertos).toBe(1);
    expect(calcularCuota(pro, Number.NaN).asientosCubiertos).toBe(1);
    expect(calcularCuota(pro, 2.9).asientosCubiertos).toBe(2);
  });

  it("la modalidad con comisión: el importe unitario de su Price, por asiento", () => {
    const t = tarifaPorAsiento({ amount: 400, currency: "eur" });
    expect(calcularCuota(t, 3).totalCentimos).toBe(1_200);
  });
});

describe("calcularCobroDelPeriodo — la comisión es opcional", () => {
  const ahorro = { baseMedidaEur: 10_000, ahorroMedidoEur: 3_000 };

  it("Pro y Equipo NO llevan comisión, haya el ahorro que haya", () => {
    for (const [plan, tarifa] of [["pro", pro], ["equipo", equipo]] as const) {
      const c = calcularCobroDelPeriodo({ plan, tarifa, asientos: 12, ahorro });
      expect(c.comision).toBeNull();
      expect(c.comisionEur).toBe(0);
      expect(c.cuota.totalCentimos).toBe(calcularCuota(tarifa, 12).totalCentimos);
    }
  });

  it("⛔ la modalidad con comisión cobra EXACTAMENTE lo de tarifa.ts: quien la tiene no nota nada", () => {
    const t = tarifaPorAsiento({ amount: 400, currency: "eur" });
    const c = calcularCobroDelPeriodo({ plan: "comision", tarifa: t, asientos: 2, ahorro });
    const esperada = calcularComision(ahorro.baseMedidaEur, ahorro.ahorroMedidoEur);
    expect(c.comision).toEqual(esperada);
    expect(c.comisionEur).toBe(esperada.comisionEur);
    expect(c.cuota.totalCentimos).toBe(800);
  });

  it("sin ahorro medido la modalidad con comisión solo paga la cuota", () => {
    const t = tarifaPorAsiento({ amount: 400, currency: "eur" });
    expect(calcularCobroDelPeriodo({ plan: "comision", tarifa: t, asientos: 1 }).comisionEur).toBe(0);
  });

  it("llevaComision: solo la modalidad «comision»", () => {
    expect(llevaComision("comision")).toBe(true);
    expect(llevaComision("pro")).toBe(false);
    expect(llevaComision("equipo")).toBe(false);
  });
});

describe("el Price de Equipo en Stripe (graduated, dos tramos)", () => {
  it("se lee: incluidos = up_to del primer tramo, fija = su flat_amount, extra = unit_amount del segundo", () => {
    const t = tarifaDeEquipoDesdeTramos(
      [
        { up_to: equipo.asientosIncluidos, flat_amount: equipo.fijaCentimos, unit_amount: 0 },
        { up_to: null, flat_amount: null, unit_amount: equipo.asientoCentimos },
      ],
      "eur",
    );
    expect(t).toEqual(equipo);
  });

  it("un Price con otra forma NO se interpreta: null, y quien llama avisa y cae al respaldo", () => {
    expect(tarifaDeEquipoDesdeTramos(null, "eur")).toBeNull();
    expect(tarifaDeEquipoDesdeTramos([{ up_to: null, flat_amount: null, unit_amount: 1 }], "eur")).toBeNull();
    expect(
      tarifaDeEquipoDesdeTramos(
        [
          { up_to: 10, flat_amount: 100, unit_amount: 0 },
          { up_to: 20, flat_amount: null, unit_amount: 5 },
        ],
        "eur",
      ),
    ).toBeNull();
  });
});

describe("⛔ de qué plan es una suscripción: por PRICE, y lo desconocido sigue con comisión", () => {
  const precios = { pro: ["price_pro_m", "price_pro_y"], equipo: ["price_team_m"] };

  it("los Prices de Pro y Equipo son sus planes", () => {
    expect(planDelPrecio("price_pro_y", precios)).toBe("pro");
    expect(planDelPrecio("price_team_m", precios)).toBe("equipo");
  });

  it("el Price de siempre, uno de EXTRA, uno desconocido o ninguno: modalidad con comisión, como hoy", () => {
    for (const p of ["price_legacy_4eur", "price_cortesia", null, undefined, ""]) {
      expect(planDelPrecio(p, precios)).toBe("comision");
    }
  });

  it("sin Prices sin comisión configurados, NADIE deja de llevar comisión", () => {
    expect(planDelPrecio("price_pro_m", { pro: [], equipo: [] })).toBe("comision");
  });

  it("el cierre saca de la comisión solo a las orgs con una suscripción VIVA en Pro o Equipo", () => {
    const fuera = orgsSinComisionPorPlan(
      [
        { org_id: "a", price_id: "price_pro_m", status: "active" },
        { org_id: "b", price_id: "price_team_m", status: "past_due" },
        { org_id: "c", price_id: "price_pro_m", status: "canceled" },
        { org_id: "d", price_id: "price_legacy_4eur", status: "active" },
        { org_id: "e", price_id: null, status: "active" },
      ],
      precios,
    );
    expect([...fuera].sort()).toEqual(["a", "b"]);
  });
});

describe("⛔ la modalidad con comisión: CERRADA a clientes nuevos, intacta para quien la tiene (2026-09-29)", () => {
  const precios = { pro: ["price_pro_m", "price_pro_y"], equipo: ["price_team_m", "price_team_y"] };

  it("no se vende: ni en los planes en venta ni por defecto; sí se sigue reconociendo", () => {
    expect(PLANES_EN_VENTA).toEqual(["pro", "equipo"]);
    expect(PLANES_EN_VENTA).not.toContain("comision");
    expect(PLAN_POR_DEFECTO).toBe("pro");
    // La guardia anti-doble-compra y la atribución siguen viendo sus suscripciones.
    expect(PLANES_DE_PAGO).toContain("comision");
  });

  it("su suscripción viva sigue siendo «comision» con TODOS los Prices nuevos configurados", () => {
    expect(planDelPrecio("price_legacy_4eur", precios)).toBe("comision");
    expect(llevaComision(planDelPrecio("price_legacy_4eur", precios))).toBe(true);
  });

  it("el cierre y la facturación la siguen cobrando: no entra en las orgs sin comisión", () => {
    const fuera = orgsSinComisionPorPlan(
      [
        { org_id: "legado", price_id: "price_legacy_4eur", status: "active" },
        { org_id: "nuevo", price_id: "price_pro_m", status: "active" },
      ],
      precios,
    );
    expect(fuera.has("legado")).toBe(false);
    expect(fuera.has("nuevo")).toBe(true);
  });

  it("su comisión y su extracto salen de tarifa.ts exactamente como antes", () => {
    const tarifa = tarifaPorAsiento({ amount: 400, currency: "eur" });
    const ahorro = { baseMedidaEur: 5_000, ahorroMedidoEur: 1_800 };
    const cobro = calcularCobroDelPeriodo({ plan: planDelPrecio("price_legacy_4eur", precios), tarifa, asientos: 3, ahorro });
    const esperada = calcularComision(ahorro.baseMedidaEur, ahorro.ahorroMedidoEur);
    expect(cobro.plan).toBe("comision");
    expect(cobro.comision).toEqual(esperada);
    expect(cobro.comisionEur).toBeCloseTo(esperada.comisionEur, 2);
    expect(cobro.cuota.totalCentimos).toBe(3 * 400);
  });
});
