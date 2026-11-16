import { describe, expect, it } from "vitest";

import { cerrarPeriodo } from "./cierre";
import {
  clasificarPrecio,
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
 * Y TRES SALIDAS, NO DOS (revisión del 2026-11-16): cobra, cargo 0, o REVISAR
 * —no se sella—. La primera versión de estos tests exigía un 0 callado para un
 * Price desconocido; eso habría cerrado a 0, para siempre, a los clientes de
 * comisión cuyos Prices se rotaron a STRIPE_PRICE_IDS_EXTRA en agosto (#53).
 *
 * El período de los casos es 2026-10 salvo que se diga otra cosa.
 */

const catalogo = {
  comision: ["price_legacy_m", "price_legacy_y", "price_legacy_rotado"],
  pro: ["price_pro_m", "price_pro_y"],
  equipo: ["price_team_m", "price_team_y"],
  sinComision: ["price_socio"],
};
const PERIODO = "2026-10";

/**
 * Una fila como la escribe el webhook. Una cancelada, salvo que el caso diga
 * otra cosa, es una cancelación INMEDIATA: el último evento (el `deleted`) es
 * del mismo instante que `canceled_at`.
 */
function sub(parcial: Partial<SuscripcionEnElPeriodo> & { price_id: string | null; status: string }): SuscripcionEnElPeriodo {
  return {
    org_id: "org",
    created_at: "2026-06-03T09:00:00Z",
    canceled_at: null,
    current_period_end: "2026-11-03T09:00:00Z",
    cancel_at_period_end: false,
    last_event_at: parcial.status === "canceled" ? (parcial.canceled_at ?? null) : "2026-10-03T09:00:05Z",
    ...parcial,
  };
}

const decidir = (subs: SuscripcionEnElPeriodo[], periodo = PERIODO) => decidirComisionDelPeriodo(subs, catalogo, periodo);
const COBRA = { comision: true, revisar: false, motivo: "plan_con_comision" };
const SIN = { comision: false, revisar: false, motivo: "sin_suscripcion_con_comision" };
const PLANO = { comision: false, revisar: false, motivo: "plan_de_cuota_fija" };
const revisar = (motivo: string, precios: string[]) => ({ comision: false, revisar: true, motivo, precios });

describe("Pro y Equipo no pagan comisión, sigan vivos o no", () => {
  it("⛔ Pro cancelado a mitad de mes: cargo 0 (era el caso que se facturaba el día 1)", () => {
    expect(decidir([sub({ price_id: "price_pro_m", status: "canceled", canceled_at: "2026-10-20T10:00:00Z" })])).toEqual(PLANO);
  });

  it("⛔ Equipo impagado (`unpaid`) o en mora (`past_due`): cargo 0", () => {
    expect(decidir([sub({ price_id: "price_team_m", status: "unpaid" })])).toEqual(PLANO);
    expect(decidir([sub({ price_id: "price_team_y", status: "past_due" })])).toEqual(PLANO);
  });

  it("Pro y Equipo vivos: cargo 0, como antes", () => {
    expect(decidir([sub({ price_id: "price_pro_y", status: "active" })])).toEqual(PLANO);
    expect(decidir([sub({ price_id: "price_team_m", status: "trialing" })])).toEqual(PLANO);
  });

  it("un Price declarado sin comisión (STRIPE_PRICE_IDS_SIN_COMISION: socio, cortesía): cargo 0, sin revisar nada", () => {
    expect(decidir([sub({ price_id: "price_socio", status: "active" })])).toEqual(PLANO);
  });

  it("un Pro que acabó antes del período ya no es «plan de cuota fija» de este mes: sin suscripción", () => {
    expect(decidir([sub({ price_id: "price_pro_m", status: "canceled", canceled_at: "2026-09-10T10:00:00Z" })])).toEqual(SIN);
  });
});

describe("⛔ un Price SIN DECLARAR no se sella: ni cobra ni cierra a 0", () => {
  // ANTES estos casos exigían `sin_suscripcion_con_comision` —un 0 callado—.
  // Era el fallo P0 de la revisión: los Prices de comisión anteriores a la
  // rotación del 2026-08-13 solo están en STRIPE_PRICE_IDS_EXTRA, que el
  // catálogo no lee; sus clientes habrían cerrado a 0 de forma inmutable y sin
  // ninguna alerta. «No está en ninguna lista» es «no lo sé», no «no cobra».
  it("uno que solo está en STRIPE_PRICE_IDS_EXTRA, uno que nadie conoce o una fila sin Price → revisar, con el id", () => {
    expect(decidir([sub({ price_id: "price_solo_en_extra", status: "active" })])).toEqual(revisar("precio_desconocido", ["price_solo_en_extra"]));
    expect(decidir([sub({ price_id: "price_que_nadie_conoce", status: "past_due" })])).toEqual(
      revisar("precio_desconocido", ["price_que_nadie_conoce"]),
    );
    expect(decidir([sub({ price_id: null, status: "active" })])).toEqual(revisar("precio_desconocido", ["(sin price_id)"]));
  });

  it("el Price de comisión ROTADO, una vez declarado en STRIPE_PRICE_IDS_COMISION, se cobra como el vigente", () => {
    expect(decidir([sub({ price_id: "price_legacy_rotado", status: "active" })])).toEqual(COBRA);
  });

  it("gana a todo lo demás: con Pro vivo o con comisión viva al lado, sigue sin poder decidirse", () => {
    expect(decidir([sub({ price_id: "price_pro_m", status: "active" }), sub({ price_id: "price_x", status: "active" })])).toEqual(
      revisar("precio_desconocido", ["price_x"]),
    );
    expect(decidir([sub({ price_id: "price_legacy_m", status: "active" }), sub({ price_id: "price_x", status: "canceled", canceled_at: "2026-10-02T00:00:00Z" })])).toEqual(
      revisar("precio_desconocido", ["price_x"]),
    );
  });

  it("⛔ un Pro en un Price que el despliegue no lista NO pasa por comisión limpia: revisar", () => {
    // Antes: la fila de Pro no se veía y la de comisión cobraba el mes entero, días de Pro incluidos.
    expect(
      decidir([
        sub({ price_id: "price_legacy_m", status: "canceled", canceled_at: "2026-10-05T10:00:00Z" }),
        sub({ price_id: "price_pro_sin_listar", status: "active", created_at: "2026-10-05T10:05:00Z" }),
      ]),
    ).toEqual(revisar("precio_desconocido", ["price_pro_sin_listar"]));
  });

  it("uno desconocido que NO pudo tocar el período (acabó antes, empezó después o nunca se activó) no estorba", () => {
    const viva = sub({ price_id: "price_legacy_m", status: "active" });
    expect(decidir([viva, sub({ price_id: "price_x", status: "canceled", created_at: "2026-01-01T00:00:00Z", canceled_at: "2026-02-01T00:00:00Z", current_period_end: "2026-02-01T00:00:00Z" })])).toEqual(COBRA);
    expect(decidir([viva, sub({ price_id: "price_x", status: "active", created_at: "2026-11-02T00:00:00Z" })])).toEqual(COBRA);
    expect(decidir([viva, sub({ price_id: "price_x", status: "incomplete_expired", created_at: "2026-10-12T00:00:00Z" })])).toEqual(COBRA);
    expect(decidir([sub({ price_id: "price_x", status: "incomplete_expired", created_at: "2026-10-12T00:00:00Z" })])).toEqual(SIN);
  });

  it("sin ningún Price de comisión configurado, el Price de siempre es un desconocido: revisar, no 0", () => {
    // ANTES exigía un 0: con MONTHLY/YEARLY ausentes en Production, todos los
    // clientes con comisión se sellaban a 0. (El cron, además, aplaza el cierre entero.)
    const sinComision = { ...catalogo, comision: [] };
    expect(decidirComisionDelPeriodo([sub({ price_id: "price_legacy_m", status: "active" })], sinComision, PERIODO)).toEqual(
      revisar("precio_desconocido", ["price_legacy_m"]),
    );
  });

  it("clasificarPrecio: una lista explícita por clase; en dos a la vez gana «sin comisión»", () => {
    expect(clasificarPrecio("price_legacy_m", catalogo)).toBe("comision");
    expect(clasificarPrecio("price_pro_m", catalogo)).toBe("sin_comision");
    expect(clasificarPrecio("price_team_y", catalogo)).toBe("sin_comision");
    expect(clasificarPrecio("price_socio", catalogo)).toBe("sin_comision");
    expect(clasificarPrecio("price_x", catalogo)).toBe("desconocido");
    expect(clasificarPrecio(null, catalogo)).toBe("desconocido");
    expect(clasificarPrecio("price_pro_m", { ...catalogo, comision: [...catalogo.comision, "price_pro_m"] })).toBe("sin_comision");
    // Un catálogo sin la lista opcional (los mocks antiguos) sigue valiendo.
    expect(clasificarPrecio("price_socio", { comision: [], pro: [], equipo: [] })).toBe("desconocido");
  });
});

describe("sin una suscripción con comisión no hay comisión", () => {
  it("⛔ solo «Medir» o Enterprise sin suscripción (ninguna fila): cargo 0", () => {
    expect(decidir([])).toEqual(SIN);
  });

  it("un checkout de comisión que no llegó a completarse (`incomplete`, `incomplete_expired`) no cuenta", () => {
    for (const status of ["incomplete", "incomplete_expired"]) {
      expect(decidir([sub({ price_id: "price_legacy_m", status })]), status).toEqual(SIN);
    }
  });

  it("un id puesto por error en la lista de comisión Y en la de Pro es de cuota fija", () => {
    const liado = { ...catalogo, comision: [...catalogo.comision, "price_pro_m"] };
    expect(decidirComisionDelPeriodo([sub({ price_id: "price_pro_m", status: "active" })], liado, PERIODO)).toEqual(PLANO);
  });
});

describe("la modalidad con comisión la sigue pagando quien la tiene", () => {
  it("comisión viva (active, trialing, past_due): se cobra", () => {
    for (const status of ["active", "trialing", "past_due"]) {
      expect(decidir([sub({ price_id: "price_legacy_m", status })]), status).toEqual(COBRA);
    }
    expect(decidir([sub({ price_id: "price_legacy_y", status: "active" })])).toEqual(COBRA);
  });

  it("comisión impagada (`unpaid`): la suscripción sigue en el plan con comisión, se cobra", () => {
    expect(decidir([sub({ price_id: "price_legacy_m", status: "unpaid" })])).toEqual(COBRA);
  });

  it("`paused` NO es «nunca activada»: la prueba fue en un Price de comisión y sus días la llevan", () => {
    // ANTES `paused` se agrupaba con `incomplete` y cerraba a 0: una prueba que
    // acaba sin medio de pago perdía la comisión de los días en que estuvo viva.
    // Los días de prueba cuentan SOLO si la prueba fue en un Price de comisión:
    expect(decidir([sub({ price_id: "price_legacy_m", status: "paused" })])).toEqual(COBRA);
    // …una prueba de Pro pausada sigue sin llevarla.
    expect(decidir([sub({ price_id: "price_pro_m", status: "paused" })])).toEqual(PLANO);
  });

  it("comisión cancelada a mitad de mes: ese mes se cobra, el siguiente ya no", () => {
    const cancelada = sub({ price_id: "price_legacy_m", status: "canceled", canceled_at: "2026-10-15T08:00:00Z" });
    expect(decidir([cancelada], "2026-10")).toEqual(COBRA);
    expect(decidir([cancelada], "2026-11")).toEqual(SIN);
  });

  it("dada de alta después del período (cierre relanzado de un mes viejo): no cobra ese mes", () => {
    expect(decidir([sub({ price_id: "price_legacy_m", status: "active", created_at: "2026-11-01T00:00:00Z" })])).toEqual(SIN);
    expect(decidir([sub({ price_id: "price_legacy_m", status: "active", created_at: "2026-10-31T23:59:59Z" })])).toEqual(COBRA);
  });
});

describe("⛔ el último mes parcial de una cancelación a fin de ciclo NO depende de `cancel_at_period_end`", () => {
  // El portal cancela a fin de ciclo: es la salida normal de un cliente con
  // comisión (y el paso obligado antes de comprar Pro). `canceled_at` es el día
  // en que se PIDIÓ —25 de octubre—; la suscripción vivió hasta el 10 de
  // noviembre. Con la marca a `false` (hay versiones de la API que la entregan
  // así en el objeto borrado) la primera versión daba noviembre por no tocado y
  // esos diez días con comisión se sellaban a 0.
  const aFinDeCiclo = (cancel_at_period_end: boolean | null) =>
    sub({
      price_id: "price_legacy_m",
      status: "canceled",
      canceled_at: "2026-10-25T08:00:00Z",
      current_period_end: "2026-11-10T09:00:00Z",
      last_event_at: "2026-11-10T09:00:02Z", // el `customer.subscription.deleted`
      cancel_at_period_end,
    });

  it("marca = false: noviembre se cobra igual (el final sale de current_period_end y last_event_at)", () => {
    expect(decidir([aFinDeCiclo(false)], "2026-10")).toEqual(COBRA);
    expect(decidir([aFinDeCiclo(false)], "2026-11")).toEqual(COBRA);
    expect(decidir([aFinDeCiclo(false)], "2026-12")).toEqual(SIN);
  });

  it("marca = true (o ausente): lo mismo", () => {
    for (const marca of [true, null]) {
      expect(decidir([aFinDeCiclo(marca)], "2026-11"), String(marca)).toEqual(COBRA);
      expect(decidir([aFinDeCiclo(marca)], "2026-12"), String(marca)).toEqual(SIN);
    }
  });

  it("cancelación INMEDIATA con el ciclo pagado hasta el mes siguiente: el final es el día de la baja, no el fin de ciclo", () => {
    // current_period_end queda en noviembre, pero el último evento es del 25 de octubre.
    const inmediata = sub({
      price_id: "price_legacy_m",
      status: "canceled",
      canceled_at: "2026-10-25T08:00:00Z",
      current_period_end: "2026-11-10T09:00:00Z",
      last_event_at: "2026-10-25T08:00:01Z",
    });
    expect(decidir([inmediata], "2026-10")).toEqual(COBRA);
    expect(decidir([inmediata], "2026-11")).toEqual(SIN);
  });

  it("un evento tardío tras la baja no alarga el final más allá del ciclo pagado", () => {
    const conEventoTardio = sub({
      price_id: "price_legacy_m",
      status: "canceled",
      canceled_at: "2026-10-25T08:00:00Z",
      current_period_end: "2026-11-10T09:00:00Z",
      last_event_at: "2026-12-04T00:00:00Z",
    });
    expect(decidir([conEventoTardio], "2026-12")).toEqual(SIN);
  });

  it("fila anterior a 0012 (sin last_event_at): con la marca a true vale current_period_end…", () => {
    const vieja = sub({
      price_id: "price_legacy_m",
      status: "canceled",
      canceled_at: "2026-09-25T08:00:00Z",
      current_period_end: "2026-10-03T09:00:00Z",
      cancel_at_period_end: true,
      last_event_at: null,
    });
    expect(decidir([vieja], "2026-10")).toEqual(COBRA);
    expect(decidir([vieja], "2026-11")).toEqual(SIN);
  });

  it("…y con la marca a false no se puede probar ni descartar: REVISAR, no un 0 callado", () => {
    const ambigua = sub({
      price_id: "price_legacy_m",
      status: "canceled",
      canceled_at: "2026-09-25T08:00:00Z",
      current_period_end: "2026-10-03T09:00:00Z",
      cancel_at_period_end: false,
      last_event_at: null,
    });
    expect(decidir([ambigua], "2026-09")).toEqual(COBRA);
    expect(decidir([ambigua], "2026-10")).toEqual(revisar("final_no_probado", ["price_legacy_m"]));
    expect(decidir([ambigua], "2026-11")).toEqual(SIN);
  });

  it("cancelada sin NINGUNA fecha de final, o viva sin fecha de alta: revisar (antes cerraba a 0)", () => {
    const sinFechas = sub({ price_id: "price_legacy_m", status: "canceled", canceled_at: null, current_period_end: null, last_event_at: null });
    expect(decidir([sinFechas])).toEqual(revisar("final_no_probado", ["price_legacy_m"]));
    expect(decidir([sub({ price_id: "price_legacy_m", status: "active", created_at: null })])).toEqual(
      revisar("final_no_probado", ["price_legacy_m"]),
    );
  });
});

describe("varias suscripciones", () => {
  it("⛔ comisión y Pro en el MISMO período (cambio de plan a mitad de mes): no se sella, lo revisa el dueño", () => {
    // ANTES cerraba a 0 con un `aviso` que no llega por correo: se regalaban,
    // de forma inmutable, los días con comisión. Ahora ni cobra ni sella.
    expect(
      decidir([
        sub({ price_id: "price_legacy_m", status: "canceled", canceled_at: "2026-10-05T10:00:00Z" }),
        sub({ price_id: "price_pro_m", status: "active", created_at: "2026-10-05T10:05:00Z" }),
      ]),
    ).toEqual(revisar("plan_sin_comision_en_el_periodo", ["price_legacy_m", "price_pro_m"]));
  });

  it("un Pro sin fechas junto a la comisión: no se puede descartar que fuera ese mes, revisar", () => {
    expect(
      decidir([
        sub({ price_id: "price_legacy_m", status: "active" }),
        sub({ price_id: "price_team_m", status: "canceled", created_at: null, canceled_at: null, current_period_end: null }),
      ]),
    ).toEqual(revisar("plan_sin_comision_en_el_periodo", ["price_legacy_m", "price_team_m"]));
  });

  it("⛔ un checkout de Pro todavía `incomplete` en el instante del cierre: revisar (mañana puede estar vivo)", () => {
    // Antes no se veía y la comisión cobraba el mes entero.
    expect(
      decidir([
        sub({ price_id: "price_legacy_m", status: "canceled", canceled_at: "2026-10-30T10:00:00Z" }),
        sub({ price_id: "price_pro_m", status: "incomplete", created_at: "2026-10-31T23:50:00Z" }),
      ]),
    ).toEqual(revisar("plan_sin_comision_en_el_periodo", ["price_legacy_m", "price_pro_m"]));
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
    ).toEqual(COBRA);
  });

  it("un Pro que empieza DESPUÉS del período tampoco", () => {
    expect(
      decidir([
        sub({ price_id: "price_legacy_m", status: "canceled", canceled_at: "2026-10-28T00:00:00Z" }),
        sub({ price_id: "price_pro_m", status: "active", created_at: "2026-11-01T00:00:00Z" }),
      ]),
    ).toEqual(COBRA);
  });

  it("un checkout de Pro que caducó sin completarse no quita la comisión", () => {
    expect(
      decidir([
        sub({ price_id: "price_legacy_m", status: "active" }),
        sub({ price_id: "price_pro_m", status: "incomplete_expired", created_at: "2026-10-12T00:00:00Z" }),
      ]),
    ).toEqual(COBRA);
  });

  it("dos suscripciones de comisión (una vieja cancelada y la viva): se cobra, una sola decisión", () => {
    expect(
      decidir([
        sub({ price_id: "price_legacy_m", status: "canceled", canceled_at: "2026-03-01T00:00:00Z" }),
        sub({ price_id: "price_legacy_y", status: "active" }),
      ]),
    ).toEqual(COBRA);
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
    expect(comisionDe(decisiones, "legado")).toEqual(COBRA);
    expect(comisionDe(decisiones, "pro-cancelado")).toEqual(PLANO);
    expect(comisionDe(decisiones, "mixta")).toEqual(revisar("plan_sin_comision_en_el_periodo", ["price_legacy_m", "price_team_m"]));
  });

  it("⛔ una organización que no aparece (sin ninguna suscripción) NO paga comisión", () => {
    expect(comisionDe(decisiones, "solo-medir")).toEqual(SIN);
    expect(comisionDe(new Map(), "cualquiera")).toEqual(SIN);
  });

  it("idsDelCatalogo: los de comisión y los de cuota fija, sin repetir", () => {
    expect(idsDelCatalogo({ comision: ["a", "b"], pro: ["b", "c"], equipo: ["d"], sinComision: ["e"] }).sort()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("un período mal formado no se decide a ojo", () => {
    expect(() => decidirComisionDelPeriodo([sub({ price_id: "price_legacy_m", status: "active" })], catalogo, "2026-1")).toThrow();
    expect(() => decidirComisionDelPeriodo([], catalogo, "octubre")).toThrow();
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
