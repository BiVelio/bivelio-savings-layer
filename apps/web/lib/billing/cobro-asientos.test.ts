import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  claveIdempotenciaAsientos,
  comportamientoHaciaDelante,
  decidirAjuste,
  descripcionDelAjuste,
  ESTADOS_DE_AJUSTE,
  esEstadoFinal,
  esItemDelAjuste,
  importeDelExceso,
  metadataDelAjuste,
  modoDeCobro,
  planYPeriodoDelPrecio,
  tarifaDelPlan,
  type EntradaDeAjuste,
} from "./cobro-asientos";
import { claveIdempotencia } from "./facturacion";
import { PRECIOS_DE_LOS_PLANES } from "./planes";

/**
 * EL COBRO DE LOS ASIENTOS DE MÁS. Cada caso es dinero de un cliente real: el
 * importe sale de las constantes del plan (nunca de una cifra escrita aquí como
 * precio: los esperados se DERIVAN de PRECIOS_DE_LOS_PLANES), el recuento no
 * fiable no se cobra y lo que no se puede cobrar deja rastro.
 */

const RESPALDO = { monthly: { amount: 400, currency: "eur" }, yearly: { amount: 3900, currency: "eur" } };
const PRO = PRECIOS_DE_LOS_PLANES.pro;
const EQUIPO = PRECIOS_DE_LOS_PLANES.equipo;

describe("importeDelExceso — precio(usados) − precio(pagados), de UN mes", () => {
  it("Pro mensual: cada asiento de más a su precio mensual", () => {
    const r = importeDelExceso({ tarifa: PRO.monthly, periodoPago: "monthly", usados: 7, pagados: 4 });
    expect(r).toEqual({ exceso: 3, centimos: 3 * PRO.monthly.asientoCentimos });
  });

  it("Pro anual: el precio anual del asiento entre 12", () => {
    const r = importeDelExceso({ tarifa: PRO.yearly, periodoPago: "yearly", usados: 5, pagados: 3 });
    expect(r).toEqual({ exceso: 2, centimos: Math.round((2 * PRO.yearly.asientoCentimos) / 12) });
  });

  it("Equipo por debajo de los incluidos: no hay nada que cobrar", () => {
    const incl = EQUIPO.monthly.asientosIncluidos;
    // Pagados = los incluidos (el mínimo del checkout) y usados por debajo.
    expect(importeDelExceso({ tarifa: EQUIPO.monthly, periodoPago: "monthly", usados: incl - 2, pagados: incl }).centimos).toBe(0);
    // Hasta con menos pagados que incluidos (una suscripción antigua): los incluidos cubren.
    expect(importeDelExceso({ tarifa: EQUIPO.monthly, periodoPago: "monthly", usados: incl, pagados: incl - 3 }).centimos).toBe(0);
  });

  it("Equipo por encima de los incluidos: cada extra a su precio, la cuota fija no se repite", () => {
    const incl = EQUIPO.monthly.asientosIncluidos;
    const r = importeDelExceso({ tarifa: EQUIPO.monthly, periodoPago: "monthly", usados: incl + 3, pagados: incl });
    expect(r).toEqual({ exceso: 3, centimos: 3 * EQUIPO.monthly.asientoCentimos });
    // Cruzando el umbral: pagaba menos de los incluidos, usa más.
    const cruza = importeDelExceso({ tarifa: EQUIPO.monthly, periodoPago: "monthly", usados: incl + 2, pagados: incl - 4 });
    expect(cruza.centimos).toBe(2 * EQUIPO.monthly.asientoCentimos);
  });

  it("Equipo anual: los extra a anual/12", () => {
    const incl = EQUIPO.yearly.asientosIncluidos;
    const r = importeDelExceso({ tarifa: EQUIPO.yearly, periodoPago: "yearly", usados: incl + 3, pagados: incl + 1 });
    expect(r).toEqual({ exceso: 2, centimos: Math.round((2 * EQUIPO.yearly.asientoCentimos) / 12) });
  });

  it("modalidad antigua por asiento (comisión): su precio de respaldo, mensual y anual/12", () => {
    const m = importeDelExceso({ tarifa: tarifaDelPlan("comision", "monthly", RESPALDO), periodoPago: "monthly", usados: 3, pagados: 1 });
    expect(m.centimos).toBe(2 * RESPALDO.monthly.amount);
    const y = importeDelExceso({ tarifa: tarifaDelPlan("comision", "yearly", RESPALDO), periodoPago: "yearly", usados: 3, pagados: 1 });
    expect(y.centimos).toBe(Math.round((2 * RESPALDO.yearly.amount) / 12));
  });

  it("sin exceso, cero; y nunca negativo", () => {
    expect(importeDelExceso({ tarifa: PRO.monthly, periodoPago: "monthly", usados: 2, pagados: 5 })).toEqual({ exceso: 0, centimos: 0 });
  });

  it("la tarifa de Pro/Equipo es LA de PRECIOS_DE_LOS_PLANES, no una copia", () => {
    expect(tarifaDelPlan("pro", "monthly", RESPALDO)).toBe(PRO.monthly);
    expect(tarifaDelPlan("equipo", "yearly", RESPALDO)).toBe(EQUIPO.yearly);
  });
});

describe("planYPeriodoDelPrecio", () => {
  const precios = {
    pro: { monthly: "price_pro_m", yearly: "price_pro_y" },
    equipo: { monthly: "price_team_m", yearly: "" },
    comision: { monthly: "price_old_m", yearly: "price_old_y" },
  };
  it("reconoce cada plan y período configurado", () => {
    expect(planYPeriodoDelPrecio("price_pro_y", precios)).toEqual({ plan: "pro", periodoPago: "yearly" });
    expect(planYPeriodoDelPrecio("price_team_m", precios)).toEqual({ plan: "equipo", periodoPago: "monthly" });
    expect(planYPeriodoDelPrecio("price_old_m", precios)).toEqual({ plan: "comision", periodoPago: "monthly" });
  });
  it("un price desconocido o vacío NO se supone: null (sin precio, no se cobra)", () => {
    expect(planYPeriodoDelPrecio("price_extra", precios)).toBeNull();
    expect(planYPeriodoDelPrecio("", precios)).toBeNull();
    expect(planYPeriodoDelPrecio(null, precios)).toBeNull();
  });
});

describe("decidirAjuste", () => {
  const base: EntradaDeAjuste = {
    usados: 7,
    pagados: 4,
    requests: 10_000,
    status: "active",
    plan: { plan: "pro", periodoPago: "monthly" },
    rotacionEnElMes: false,
    variasSuscripciones: false,
    respaldoComision: RESPALDO,
  };

  it("cobra el exceso al precio del plan", () => {
    expect(decidirAjuste(base)).toMatchObject({ accion: "cobrar", exceso: 3, centimos: 3 * PRO.monthly.asientoCentimos });
  });

  it("dentro de lo pagado: nada", () => {
    expect(decidirAjuste({ ...base, usados: 4 }).accion).toBe("nada");
  });

  it("recuento NO fiable (volumen implausible por asiento): revisión humana, no cobra", () => {
    const d = decidirAjuste({ ...base, requests: 50_000_000 });
    expect(d).toMatchObject({ accion: "registrar", estado: "revision_humana" });
    // …también sin exceso: el colapso de seat_id infra-declara.
    expect(decidirAjuste({ ...base, usados: 1, pagados: 1, requests: 50_000_000 })).toMatchObject({ estado: "revision_humana", exceso: 0 });
  });

  it("rotación de clave en el mes: revisión humana, no se cobra un recuento inflado", () => {
    expect(decidirAjuste({ ...base, rotacionEnElMes: true })).toMatchObject({ accion: "registrar", estado: "revision_humana" });
  });

  it("varias suscripciones vivas: revisión humana", () => {
    expect(decidirAjuste({ ...base, variasSuscripciones: true })).toMatchObject({ estado: "revision_humana" });
  });

  it("suscripción no activa (past_due, trialing): omitido_no_activa", () => {
    expect(decidirAjuste({ ...base, status: "past_due" })).toMatchObject({ accion: "registrar", estado: "omitido_no_activa" });
    expect(decidirAjuste({ ...base, status: "trialing" })).toMatchObject({ estado: "omitido_no_activa" });
  });

  it("sin precio del plan: omitido_sin_precio", () => {
    expect(decidirAjuste({ ...base, plan: null })).toMatchObject({ accion: "registrar", estado: "omitido_sin_precio", centimos: 0 });
  });

  it("por debajo de 0,50 €: omitido_bajo_minimo (sin arrastre)", () => {
    // Un asiento de la modalidad antigua anual: 39 €/12 = 3,25 € — por encima.
    // Para quedar por debajo se usa un respaldo diminuto.
    const d = decidirAjuste({
      ...base,
      usados: 2,
      pagados: 1,
      plan: { plan: "comision", periodoPago: "yearly" },
      respaldoComision: { monthly: RESPALDO.monthly, yearly: { amount: 300, currency: "eur" } },
    });
    expect(d).toMatchObject({ accion: "registrar", estado: "omitido_bajo_minimo", centimos: 25 });
  });

  it("Equipo con extras cubiertos por los incluidos: nada", () => {
    const incl = EQUIPO.monthly.asientosIncluidos;
    expect(decidirAjuste({ ...base, plan: { plan: "equipo", periodoPago: "monthly" }, usados: incl, pagados: incl - 2 }).accion).toBe("nada");
  });
});

describe("lo que ve Stripe", () => {
  const a = { orgId: "org-1", periodo: "2026-09", plan: "equipo" as const, periodoPago: "monthly" as const, usados: 13, pagados: 10, exceso: 3, centimos: 3600 };

  it("metadata con org, período, usados, pagados y exceso; reconocible en el reintento", () => {
    const md = metadataDelAjuste(a);
    expect(md).toMatchObject({ bvsala_org_id: "org-1", bvsala_periodo: "2026-09", bvsala_usados: "13", bvsala_pagados: "10", bvsala_exceso: "3" });
    expect(esItemDelAjuste(md, "org-1", "2026-09")).toBe(true);
    expect(esItemDelAjuste(md, "org-1", "2026-08")).toBe(false);
    expect(esItemDelAjuste({ bvsala_tipo: "comision-ahorro", bvsala_org_id: "org-1", bvsala_periodo: "2026-09" }, "org-1", "2026-09")).toBe(false);
  });

  it("descripción legible con las cifras del ajuste", () => {
    const d = descripcionDelAjuste(a);
    expect(d).toContain("2026-09");
    expect(d).toContain("13 seats in use");
    expect(d).toContain("10 paid for");
    expect(d).toContain("€36.00");
  });

  it("claves de idempotencia estables por (org, período) y distintas de las de la comisión", () => {
    expect(claveIdempotenciaAsientos("o", "2026-09", "item")).toBe(claveIdempotenciaAsientos("o", "2026-09", "item"));
    expect(claveIdempotenciaAsientos("o", "2026-09", "item")).not.toBe(claveIdempotenciaAsientos("o", "2026-10", "item"));
    expect(claveIdempotenciaAsientos("o", "2026-09", "factura")).not.toBe(claveIdempotencia("o", "2026-09", "factura"));
  });

  it("hacia delante: mensual sube la cantidad; anual no la toca y factura ya", () => {
    expect(comportamientoHaciaDelante("monthly")).toEqual({ subirCantidad: true, facturarYa: false });
    expect(comportamientoHaciaDelante("yearly")).toEqual({ subirCantidad: false, facturarYa: true });
  });
});

describe("el modo", () => {
  it("seco por defecto; vivo solo con la palabra exacta y sin ?seco=1", () => {
    expect(modoDeCobro(undefined, false)).toBe("seco");
    expect(modoDeCobro("", false)).toBe("seco");
    expect(modoDeCobro("VIVO", false)).toBe("seco");
    expect(modoDeCobro("vivo", false)).toBe("vivo");
    expect(modoDeCobro("vivo", true)).toBe("seco");
  });
  it("estados finales: cobrado, revisión y omitidos; pendiente/fallido/seco se retoman", () => {
    for (const e of ["cobrado", "revision_humana", "omitido_bajo_minimo", "omitido_sin_precio", "omitido_no_activa"]) expect(esEstadoFinal(e)).toBe(true);
    for (const e of ["pendiente", "fallido", "seco"]) expect(esEstadoFinal(e)).toBe(false);
  });
});

describe("el código y la migración 0034 hablan de los mismos estados", () => {
  it("el CHECK de estado de ajustes_asientos es EXACTAMENTE ESTADOS_DE_AJUSTE", () => {
    const sql = readFileSync(new URL("../../../../db/migrations/0034_cobro_asientos.sql", import.meta.url), "utf8");
    const m = sql.match(/estado\s+text not null check \(estado in \(([\s\S]*?)\)\)/);
    expect(m).not.toBeNull();
    const enSql = [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
    expect(enSql).toEqual([...ESTADOS_DE_AJUSTE].sort());
  });
});
