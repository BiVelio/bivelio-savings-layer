import { describe, expect, it } from "vitest";

import { cerrarPeriodo } from "./cierre";
import {
  comisionDe,
  comisionPorOrg,
  decidirComisionDelPeriodo,
  idsDelCatalogo,
  type SuscripcionEnElPeriodo,
} from "./plan-de-la-org";

/**
 * ⛔ QUIÉN PAGA COMISIÓN EN UN PERÍODO CERRADO (LICENSE-CLOUD §6(b)).
 *
 * Solo la organización cuya suscripción, DURANTE el período, estuvo en un Price
 * de la lista explícita de comisión. La regla anterior era la inversa («todo el
 * que no tenga HOY una suscripción viva en Pro o Equipo paga») y facturaba
 * comisión al cliente de Pro que cancelaba a mitad de mes, al de Equipo impagado
 * y al Enterprise sin suscripción. Cada caso de aquí es uno de esos.
 *
 * El período de los casos es 2026-10 salvo que se diga otra cosa.
 */

const catalogo = {
  comision: ["price_legacy_m", "price_legacy_y"],
  pro: ["price_pro_m", "price_pro_y"],
  equipo: ["price_team_m", "price_team_y"],
};
const PERIODO = "2026-10";

function sub(parcial: Partial<SuscripcionEnElPeriodo> & { price_id: string | null; status: string }): SuscripcionEnElPeriodo {
  return {
    org_id: "org",
    created_at: "2026-06-03T09:00:00Z",
    canceled_at: null,
    current_period_end: "2026-11-03T09:00:00Z",
    cancel_at_period_end: false,
    ...parcial,
  };
}

const decidir = (subs: SuscripcionEnElPeriodo[], periodo = PERIODO) => decidirComisionDelPeriodo(subs, catalogo, periodo);
const SIN = { comision: false, motivo: "sin_suscripcion_con_comision" };
const MIXTO = { comision: false, motivo: "plan_sin_comision_en_el_periodo" };

describe("Pro y Equipo no pagan comisión, sigan vivos o no", () => {
  it("⛔ Pro cancelado a mitad de mes: cargo 0 (era el caso que se facturaba el día 1)", () => {
    expect(decidir([sub({ price_id: "price_pro_m", status: "canceled", canceled_at: "2026-10-20T10:00:00Z" })])).toEqual(SIN);
  });

  it("⛔ Equipo impagado (`unpaid`) o en mora (`past_due`): cargo 0", () => {
    expect(decidir([sub({ price_id: "price_team_m", status: "unpaid" })])).toEqual(SIN);
    expect(decidir([sub({ price_id: "price_team_y", status: "past_due" })])).toEqual(SIN);
  });

  it("Pro y Equipo vivos: cargo 0, como antes", () => {
    expect(decidir([sub({ price_id: "price_pro_y", status: "active" })])).toEqual(SIN);
    expect(decidir([sub({ price_id: "price_team_m", status: "trialing" })])).toEqual(SIN);
  });
});

describe("sin un Price de comisión PROBADO no hay comisión", () => {
  it("⛔ solo «Medir» o Enterprise sin suscripción (ninguna fila): cargo 0", () => {
    expect(decidir([])).toEqual(SIN);
  });

  it("⛔ un Price desconocido, uno de STRIPE_PRICE_IDS_EXTRA (cortesía) o ninguno NO demuestran comisión", () => {
    for (const price_id of ["price_cortesia", "price_que_nadie_conoce", null]) {
      expect(decidir([sub({ price_id, status: "active" })]), String(price_id)).toEqual(SIN);
    }
  });

  it("sin ningún Price de comisión configurado, nadie la paga (ni el Price de siempre)", () => {
    const sinComision = { ...catalogo, comision: [] };
    expect(decidirComisionDelPeriodo([sub({ price_id: "price_legacy_m", status: "active" })], sinComision, PERIODO)).toEqual(SIN);
  });

  it("una suscripción de comisión que nunca se activó no cuenta", () => {
    for (const status of ["incomplete", "incomplete_expired", "paused"]) {
      expect(decidir([sub({ price_id: "price_legacy_m", status })]), status).toEqual(SIN);
    }
  });

  it("sin fecha de alta no se puede probar que estuviera en el período: no cobra", () => {
    expect(decidir([sub({ price_id: "price_legacy_m", status: "active", created_at: null })])).toEqual(SIN);
  });

  it("un id puesto por error en la lista de comisión Y en la de Pro es de cuota fija", () => {
    const liado = { ...catalogo, comision: [...catalogo.comision, "price_pro_m"] };
    expect(decidirComisionDelPeriodo([sub({ price_id: "price_pro_m", status: "active" })], liado, PERIODO)).toEqual(SIN);
  });
});

describe("la modalidad con comisión la sigue pagando quien la tiene", () => {
  it("comisión viva (active, trialing, past_due): se cobra", () => {
    for (const status of ["active", "trialing", "past_due"]) {
      expect(decidir([sub({ price_id: "price_legacy_m", status })]), status).toEqual({ comision: true });
    }
    expect(decidir([sub({ price_id: "price_legacy_y", status: "active" })])).toEqual({ comision: true });
  });

  it("comisión impagada (`unpaid`): la suscripción sigue en el plan con comisión, se cobra", () => {
    expect(decidir([sub({ price_id: "price_legacy_m", status: "unpaid" })])).toEqual({ comision: true });
  });

  it("comisión cancelada a mitad de mes: ese mes se cobra, el siguiente ya no", () => {
    const cancelada = sub({ price_id: "price_legacy_m", status: "canceled", canceled_at: "2026-10-15T08:00:00Z" });
    expect(decidir([cancelada], "2026-10")).toEqual({ comision: true });
    expect(decidir([cancelada], "2026-11")).toEqual(SIN);
  });

  it("cancelada a fin de ciclo: termina en `current_period_end`, no el día en que se pidió", () => {
    const aFinDeCiclo = sub({
      price_id: "price_legacy_m",
      status: "canceled",
      canceled_at: "2026-09-25T08:00:00Z",
      cancel_at_period_end: true,
      current_period_end: "2026-10-03T09:00:00Z",
    });
    expect(decidir([aFinDeCiclo], "2026-10")).toEqual({ comision: true });
    expect(decidir([aFinDeCiclo], "2026-11")).toEqual(SIN);
  });

  it("cancelada sin ninguna fecha de final: no se puede probar que tocara el período, no cobra", () => {
    expect(decidir([sub({ price_id: "price_legacy_m", status: "canceled", canceled_at: null })])).toEqual(SIN);
  });

  it("dada de alta después del período (cierre relanzado de un mes viejo): no cobra ese mes", () => {
    expect(decidir([sub({ price_id: "price_legacy_m", status: "active", created_at: "2026-11-01T00:00:00Z" })])).toEqual(SIN);
    expect(decidir([sub({ price_id: "price_legacy_m", status: "active", created_at: "2026-10-31T23:59:59Z" })])).toEqual({ comision: true });
  });
});

describe("varias suscripciones", () => {
  it("⛔ comisión y Pro en el MISMO período (cambio de plan a mitad de mes): cargo 0 y motivo propio", () => {
    expect(
      decidir([
        sub({ price_id: "price_legacy_m", status: "canceled", canceled_at: "2026-10-05T10:00:00Z" }),
        sub({ price_id: "price_pro_m", status: "active", created_at: "2026-10-05T10:05:00Z" }),
      ]),
    ).toEqual(MIXTO);
  });

  it("un Pro sin fechas junto a la comisión: la duda es a favor del cliente, cargo 0", () => {
    expect(
      decidir([
        sub({ price_id: "price_legacy_m", status: "active" }),
        sub({ price_id: "price_team_m", status: "canceled", created_at: null, canceled_at: null, current_period_end: null }),
      ]),
    ).toEqual(MIXTO);
  });

  it("un Pro que acabó ANTES del período no quita la comisión de hoy", () => {
    expect(
      decidir([
        sub({ price_id: "price_legacy_m", status: "active" }),
        sub({
          price_id: "price_pro_m",
          status: "canceled",
          created_at: "2026-02-01T00:00:00Z",
          canceled_at: "2026-05-10T00:00:00Z",
          current_period_end: "2026-06-01T00:00:00Z",
        }),
      ]),
    ).toEqual({ comision: true });
  });

  it("un Pro que empieza DESPUÉS del período tampoco", () => {
    expect(
      decidir([
        sub({ price_id: "price_legacy_m", status: "canceled", canceled_at: "2026-10-28T00:00:00Z" }),
        sub({ price_id: "price_pro_m", status: "active", created_at: "2026-11-01T00:00:00Z" }),
      ]),
    ).toEqual({ comision: true });
  });

  it("un checkout de Pro que nunca se completó no quita la comisión", () => {
    expect(
      decidir([
        sub({ price_id: "price_legacy_m", status: "active" }),
        sub({ price_id: "price_pro_m", status: "incomplete_expired", created_at: "2026-10-12T00:00:00Z" }),
      ]),
    ).toEqual({ comision: true });
  });

  it("dos suscripciones de comisión (una vieja cancelada y la viva): se cobra, una sola decisión", () => {
    expect(
      decidir([
        sub({ price_id: "price_legacy_m", status: "canceled", canceled_at: "2026-03-01T00:00:00Z" }),
        sub({ price_id: "price_legacy_y", status: "active" }),
      ]),
    ).toEqual({ comision: true });
  });
});

describe("comisionPorOrg — la decisión de todas las organizaciones leídas", () => {
  const decisiones = comisionPorOrg(
    [
      { ...sub({ price_id: "price_legacy_m", status: "active" }), org_id: "legado" },
      { ...sub({ price_id: "price_pro_m", status: "canceled", canceled_at: "2026-10-20T00:00:00Z" }), org_id: "pro-cancelado" },
      { ...sub({ price_id: "price_legacy_m", status: "canceled", canceled_at: "2026-10-02T00:00:00Z" }), org_id: "mixta" },
      { ...sub({ price_id: "price_team_m", status: "active", created_at: "2026-10-02T00:00:00Z" }), org_id: "mixta" },
    ],
    catalogo,
    PERIODO,
  );

  it("agrupa por organización y no mezcla las filas de una con las de otra", () => {
    expect(comisionDe(decisiones, "legado")).toEqual({ comision: true });
    expect(comisionDe(decisiones, "pro-cancelado")).toEqual(SIN);
    expect(comisionDe(decisiones, "mixta")).toEqual(MIXTO);
  });

  it("⛔ una organización que no aparece (sin ninguna suscripción) NO paga comisión", () => {
    expect(comisionDe(decisiones, "solo-medir")).toEqual(SIN);
    expect(comisionDe(new Map(), "cualquiera")).toEqual(SIN);
  });

  it("idsDelCatalogo: los de comisión y los de cuota fija, sin repetir", () => {
    expect(idsDelCatalogo({ comision: ["a", "b"], pro: ["b", "c"], equipo: ["d"] }).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("un período mal formado no se decide a ojo", () => {
    expect(() => decidirComisionDelPeriodo([sub({ price_id: "price_legacy_m", status: "active" })], catalogo, "2026-1")).toThrow();
  });
});

describe("el extracto de quien no paga comisión se conserva, con cargo 0", () => {
  const fila = (base: number, actual: number) => ({
    day: "2026-10-10",
    requests: 10,
    baseline_cost: base,
    actual_cost: actual,
    measured_requests: 10,
    measured_baseline_cost: base,
    measured_actual_cost: actual,
  });
  const fx = { eurPorUsd: 0.9, fuente: "test" };

  it("Pro cancelado: la fila existe, enseña lo que habría sido y no cobra", () => {
    const d = decidir([sub({ price_id: "price_pro_m", status: "canceled", canceled_at: "2026-10-20T10:00:00Z" })]);
    const [c] = cerrarPeriodo(
      [{ orgId: "a", filas: [fila(2000, 1100)], primerPeriodoConUso: "2026-08", comisionExenta: !d.comision }],
      PERIODO,
      fx,
    );
    expect(c!.cargo_eur).toBe(0);
    expect(c!.es_exento).toBe(true);
    expect(c!.comision_eur).toBeGreaterThan(0);
    expect(c!.ahorro_medido_usd).toBe(900);
  });

  it("«Medir» (el ingest deja base = real): extracto a 0 con o sin la decisión", () => {
    const [c] = cerrarPeriodo(
      [{ orgId: "m", filas: [fila(2000, 2000)], primerPeriodoConUso: "2026-08", comisionExenta: !decidir([]).comision }],
      PERIODO,
      fx,
    );
    expect(c!.cargo_eur).toBe(0);
    expect(c!.comision_eur).toBe(0);
  });

  it("comisión viva: el cargo es la comisión, como siempre", () => {
    const d = decidir([sub({ price_id: "price_legacy_m", status: "active" })]);
    const [c] = cerrarPeriodo(
      [{ orgId: "l", filas: [fila(2000, 1100)], primerPeriodoConUso: "2026-08", comisionExenta: !d.comision }],
      PERIODO,
      fx,
    );
    expect(c!.es_exento).toBe(false);
    expect(c!.cargo_eur).toBe(c!.comision_eur);
    expect(c!.cargo_eur).toBeGreaterThan(0);
  });
});
