import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/cron/facturar-extractos · LA TERCERA VERJA (verificación de la 1.2.4).
 *
 * La verificación del 21-11-2026 pasó la cadena entera (ingesta → base real →
 * cierre → facturación) con 25 organizaciones y encontró 8 caminos por los que
 * se facturaba comisión a quien NO tenía la modalidad con comisión ese mes. Aquí
 * está el estado de cada una a las 07:00 del día 1 —sus suscripciones, sus
 * licencias y el extracto con el cargo que le dejó el cierre, cifras de la
 * cadena— y se fija:
 *   · los 8 cargos indebidos: 0 € — sin factura, sin línea, sin fila en cargos,
 *     y una alerta crítica por cada uno;
 *   · las 4 comisiones legítimas: el MISMO importe, al céntimo.
 */

const est = vi.hoisted(() => ({
  db: {} as Record<string, Array<Record<string, unknown>>>,
  fallar: {} as Record<string, boolean>,
  facturas: [] as Array<Record<string, any>>,
  lineas: [] as Array<Record<string, any>>,
  alertas: [] as Array<Record<string, any>>,
  monthly: "price_comision_antiguo",
  yearly: "price_comision_antiguo_y",
}));

type Fila = Record<string, unknown>;

function builder(tabla: string) {
  const filtros: Array<(f: Fila) => boolean> = [];
  let orden: { col: string; asc: boolean } | null = null;
  let limite: number | null = null;
  const filas = (): { data: Fila[] | null; error: { message: string } | null } => {
    if (est.fallar[tabla]) return { data: null, error: { message: `lectura de ${tabla} caída` } };
    let r = (est.db[tabla] ?? []).filter((f) => filtros.every((p) => p(f)));
    if (orden) {
      const { col, asc } = orden;
      r = [...r].sort((a, b) => (String(a[col] ?? "") < String(b[col] ?? "") ? -1 : 1) * (asc ? 1 : -1));
    }
    if (limite != null) r = r.slice(0, limite);
    return { data: r.map((f) => ({ ...f })), error: null };
  };
  const b: Record<string, unknown> = {
    select: () => b,
    eq: (col: string, v: unknown) => {
      filtros.push((f) => f[col] === v);
      return b;
    },
    in: (col: string, vs: unknown[]) => {
      filtros.push((f) => vs.includes(f[col]));
      return b;
    },
    not: (col: string, op: string, v: unknown) => {
      if (op === "is" && v === null) filtros.push((f) => f[col] != null);
      return b;
    },
    gt: (col: string, v: number) => {
      filtros.push((f) => Number(f[col]) > v);
      return b;
    },
    order: (col: string, o?: { ascending?: boolean }) => {
      orden = { col, asc: o?.ascending !== false };
      return b;
    },
    limit: (n: number) => {
      limite = n;
      return b;
    },
    range: async (desde: number, hasta: number) => {
      const r = filas();
      return { data: r.data ? r.data.slice(desde, hasta + 1) : null, error: r.error };
    },
    maybeSingle: async () => {
      const r = filas();
      return { data: r.data?.[0] ?? null, error: r.error };
    },
    upsert: async (fila: Fila) => {
      const t = (est.db[tabla] ??= []);
      if (!t.some((x) => x["org_id"] === fila["org_id"] && x["periodo"] === fila["periodo"])) t.push(fila);
      return { error: null };
    },
    then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(filas()).then(ok, ko),
  };
  return b;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ schema: () => ({ from: (t: string) => builder(t) }) }),
}));
vi.mock("@/lib/observabilidad/alerta", () => ({
  alertar: async (a: Record<string, any>) => {
    est.alertas.push(a);
  },
}));
vi.mock("@/lib/stripe/client", () => ({
  getStripe: () => ({
    invoices: {
      create: async (a: Record<string, any>) => {
        est.facturas.push(a);
        return { id: `in_${est.facturas.length}` };
      },
      finalizeInvoice: async (id: string) => ({ id, number: `N-${id}`, hosted_invoice_url: null, invoice_pdf: null }),
    },
    invoiceItems: {
      create: async (a: Record<string, any>) => {
        est.lineas.push(a);
        return { id: `ii_${est.lineas.length}` };
      },
    },
    subscriptions: { retrieve: async () => ({ default_payment_method: "pm_x" }) },
    customers: { retrieve: async () => ({ invoice_settings: { default_payment_method: "pm_x" } }) },
  }),
}));
vi.mock("@/lib/stripe/env", () => ({
  billingConfigured: true,
  preciosSinComision: () => ({ pro: ["price_pro_m", "price_pro_y"], equipo: ["price_team_m", "price_team_y"] }),
  get STRIPE_PRICE_ID_MONTHLY() {
    return est.monthly;
  },
  get STRIPE_PRICE_ID_YEARLY() {
    return est.yearly;
  },
}));

import { GET } from "./route";

const PRO_M = "price_pro_m";
const COMISION = "price_comision_antiguo";
const LEJOS = "2027-11-01T00:00:00Z";

type Caso = {
  cargo: number;
  subs?: Array<{ price_id: string | null; status: string; current_period_end: string | null }>;
  licencias?: Array<{ plan: string; issued_at: string; expires_at: string; revoked?: boolean }>;
};

/** Los 8 cargos indebidos de la verificación: con la tercera verja, 0 €. */
const INDEBIDOS: Record<string, Caso> = {
  // 09 · caso 308-A: Measure pura que el 16 adquiere un precio que no es Pro ni Team (hecho a mano en Stripe).
  "09_medir_con_precio_manual": {
    cargo: 236,
    subs: [{ price_id: "price_pro_antiguo_o_manual", status: "active", current_period_end: "2026-12-16T00:00:00Z" }],
    licencias: [
      { plan: "measure", issued_at: "2026-10-15T00:00:00Z", expires_at: LEJOS },
      { plan: "pro", issued_at: "2026-11-16T00:00:00Z", expires_at: "2026-12-16T00:00:00Z" },
    ],
  },
  // 10 · caso 308-B: ex-comisión (su período acabó el 1-11 a las 00:00) con Measure y la licencia de pago en gracia.
  "10_ex_comision_en_gracia": {
    cargo: 237.3,
    subs: [{ price_id: COMISION, status: "canceled", current_period_end: "2026-11-01T00:00:00Z" }],
    licencias: [
      { plan: "pro", issued_at: "2026-10-01T00:00:00Z", expires_at: "2026-11-01T00:00:00Z" },
      { plan: "measure", issued_at: "2026-10-20T00:00:00Z", expires_at: LEJOS },
    ],
  },
  // 14 · Pro que pasa a `unpaid`: el webhook no revoca ni emite Measure.
  "14_pro_unpaid": {
    cargo: 445.94,
    subs: [{ price_id: PRO_M, status: "unpaid", current_period_end: "2026-11-20T10:00:00Z" }],
    licencias: [{ plan: "pro", issued_at: "2026-10-20T10:00:00Z", expires_at: "2026-11-20T10:00:00Z" }],
  },
  // 15 · Pro cancelado el día 1 a las 03:00 UTC: su Measure nace después del fin de mes.
  "15_pro_cancelado_dia1_madrugada": {
    cargo: 445.94,
    subs: [{ price_id: PRO_M, status: "canceled", current_period_end: "2026-12-01T03:00:00Z" }],
    licencias: [
      { plan: "pro", issued_at: "2026-11-01T03:00:00Z", expires_at: "2026-12-01T03:00:00Z", revoked: true },
      { plan: "measure", issued_at: "2026-12-01T03:00:00Z", expires_at: LEJOS },
    ],
  },
  // 16 · Enterprise o piloto con licencia a mano, sin suscripción ni marca de exención.
  "16_enterprise_a_mano": {
    cargo: 445.94,
    licencias: [{ plan: "enterprise", issued_at: "2026-10-01T00:00:00Z", expires_at: "2027-10-01T00:00:00Z" }],
  },
  // 20 · Ex-comisión (acabó en septiembre) que volvió a Measure, compró Pro y lo canceló el 12.
  "20_ex_comision_pro_cancelado": {
    cargo: 128.65,
    subs: [
      { price_id: COMISION, status: "canceled", current_period_end: "2026-09-01T00:00:00Z" },
      { price_id: PRO_M, status: "canceled", current_period_end: "2026-12-01T10:00:00Z" },
    ],
    licencias: [
      { plan: "measure", issued_at: "2026-09-02T00:00:00Z", expires_at: LEJOS },
      { plan: "pro", issued_at: "2026-11-01T10:00:00Z", expires_at: "2026-12-01T10:00:00Z", revoked: true },
    ],
  },
  // 21 · Pro con la fila de suscripción SIN price_id.
  "21_pro_price_id_nulo": {
    cargo: 445.94,
    subs: [{ price_id: null, status: "active", current_period_end: "2026-12-01T10:00:00Z" }],
    licencias: [{ plan: "pro", issued_at: "2026-11-01T10:00:00Z", expires_at: "2026-12-01T10:00:00Z" }],
  },
  // 24 · Pro cancelado el 12 y la vuelta a Measure falló (o la org está bloqueada en el alta).
  "24_ex_pro_sin_vuelta_a_medir": {
    cargo: 237.3,
    subs: [{ price_id: PRO_M, status: "canceled", current_period_end: "2026-12-01T10:00:00Z" }],
    licencias: [{ plan: "pro", issued_at: "2026-11-01T10:00:00Z", expires_at: "2026-12-01T10:00:00Z", revoked: true }],
  },
};

/** Las 4 comisiones legítimas de la verificación: mismo importe que sin la verja. */
const LEGITIMOS: Record<string, Caso> = {
  "05_comision_viva": {
    cargo: 445.94,
    subs: [{ price_id: COMISION, status: "active", current_period_end: "2026-12-01T10:00:00Z" }],
    licencias: [{ plan: "pro", issued_at: "2026-11-01T10:00:00Z", expires_at: "2026-12-01T10:00:00Z" }],
  },
  // 07 · comisión cancelada a mitad de mes y vuelta a Measure: su último mes se cierra con comisión.
  "07_comision_cancelada_a_mitad": {
    cargo: 237.3,
    subs: [{ price_id: COMISION, status: "canceled", current_period_end: "2026-12-01T10:00:00Z" }],
    licencias: [
      { plan: "pro", issued_at: "2026-11-01T10:00:00Z", expires_at: "2026-12-01T10:00:00Z", revoked: true },
      { plan: "measure", issued_at: "2026-11-15T10:00:00Z", expires_at: LEJOS },
    ],
  },
  "18_comision_con_fallos_de_lectura": {
    cargo: 445.94,
    subs: [{ price_id: COMISION, status: "active", current_period_end: "2026-12-01T10:00:00Z" }],
    licencias: [{ plan: "pro", issued_at: "2026-11-01T10:00:00Z", expires_at: "2026-12-01T10:00:00Z" }],
  },
  "19_comision_con_lotes_duplicados": {
    cargo: 128.65,
    subs: [{ price_id: COMISION, status: "active", current_period_end: "2026-12-01T10:00:00Z" }],
    licencias: [{ plan: "pro", issued_at: "2026-11-01T10:00:00Z", expires_at: "2026-12-01T10:00:00Z" }],
  },
};

let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const ids: Record<string, string> = {};

function sembrar(casos: Record<string, Caso>) {
  for (const [nombre, c] of Object.entries(casos)) {
    const id = (ids[nombre] = uuid());
    est.db["organizations"]!.push({ id, stripe_customer_id: `cus_${nombre}`, comision_exenta: false });
    for (const s of c.subs ?? []) {
      est.db["subscriptions"]!.push({ org_id: id, stripe_subscription_id: `sub_${nombre}`, ...s });
    }
    for (const l of c.licencias ?? []) est.db["licenses"]!.push({ org_id: id, revoked: false, ...l });
    est.db["extractos"]!.push({
      org_id: id,
      periodo: "2026-11",
      es_calibracion: false,
      cargo_eur: c.cargo,
      ahorro_medido_eur: c.cargo * 8,
      base_medida_eur: c.cargo * 20,
      ratio: 0.4,
    });
  }
}

const peticion = (extra = "") =>
  new Request(`https://savings.bivelio.com/api/cron/facturar-extractos?periodo=2026-11${extra}`, {
    headers: { authorization: "Bearer secreto-de-prueba" },
  });

const facturadoA = (nombre: string) =>
  est.lineas.filter((l) => l["customer"] === `cus_${nombre}`).reduce((s, l) => s + Number(l["amount"]), 0) / 100;
const cargoDe = (nombre: string) => (est.db["cargos"] ?? []).filter((c) => c["org_id"] === ids[nombre]);

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "secreto-de-prueba");
  vi.stubEnv("STRIPE_PRICE_IDS_EXTRA", "");
  est.db = { organizations: [], subscriptions: [], licenses: [], extractos: [], cargos: [] };
  est.fallar = {};
  est.facturas.length = 0;
  est.lineas.length = 0;
  est.alertas.length = 0;
  est.monthly = "price_comision_antiguo";
  est.yearly = "price_comision_antiguo_y";
  sembrar(INDEBIDOS);
  sembrar(LEGITIMOS);
});
afterEach(() => vi.unstubAllEnvs());

describe("facturar-extractos · la tercera verja: solo paga comisión quien tuvo la modalidad con comisión", () => {
  it("los 8 cargos indebidos de la verificación quedan a 0: sin factura, sin línea y sin fila en cargos", async () => {
    const res = await GET(peticion());
    expect(res.status).toBe(200);
    for (const nombre of Object.keys(INDEBIDOS)) {
      expect(facturadoA(nombre), nombre).toBe(0);
      expect(est.facturas.some((f) => f["customer"] === `cus_${nombre}`), nombre).toBe(false);
      expect(cargoDe(nombre), nombre).toEqual([]);
    }
  });

  it("las 4 comisiones legítimas se facturan con el MISMO importe, al céntimo", async () => {
    const res = await GET(peticion());
    const cuerpo = (await res.json()) as { facturadas: number; omitidas: number; fallos: number };
    expect(cuerpo).toMatchObject({ facturadas: 4, omitidas: 0, fallos: 0 });
    expect(facturadoA("05_comision_viva")).toBe(445.94);
    expect(facturadoA("07_comision_cancelada_a_mitad")).toBe(237.3);
    expect(facturadoA("18_comision_con_fallos_de_lectura")).toBe(445.94);
    expect(facturadoA("19_comision_con_lotes_duplicados")).toBe(128.65);
    for (const nombre of Object.keys(LEGITIMOS)) {
      expect(cargoDe(nombre).map((c) => [c["estado"], c["importe_eur"]]), nombre).toEqual([["facturado", LEGITIMOS[nombre]!.cargo]]);
    }
    expect(est.facturas).toHaveLength(4);
  });

  it("cada cargo parado deja una alerta CRÍTICA para revisarlo a mano, con su org y su importe", async () => {
    await GET(peticion());
    const paradas = est.alertas.filter((a) => /SIN la modalidad con comisión/.test(String(a["asunto"])));
    expect(paradas).toHaveLength(8);
    for (const a of paradas) expect(a["nivel"]).toBe("critico");
    expect(paradas.map((a) => a["detalle"]["orgId"]).sort()).toEqual(Object.keys(INDEBIDOS).map((k) => ids[k]).sort());
    expect(paradas.find((a) => a["detalle"]["orgId"] === ids["09_medir_con_precio_manual"])?.["detalle"]["cargoEur"]).toBe(236);
  });

  it("ensayo en seco: los 8 salen «revisar» y las 4 «facturar» con sus céntimos", async () => {
    const res = await GET(peticion("&seco=1"));
    const { ensayo } = (await res.json()) as { ensayo: Array<{ org_id: string; accion: string; centimos: number | null }> };
    for (const nombre of Object.keys(INDEBIDOS)) expect(ensayo.find((x) => x.org_id === ids[nombre])?.accion, nombre).toBe("revisar");
    expect(ensayo.find((x) => x.org_id === ids["05_comision_viva"])).toMatchObject({ accion: "facturar", centimos: 44594 });
    expect(ensayo.find((x) => x.org_id === ids["07_comision_cancelada_a_mitad"])).toMatchObject({ accion: "facturar", centimos: 23730 });
    expect(ensayo.find((x) => x.org_id === ids["18_comision_con_fallos_de_lectura"])).toMatchObject({ accion: "facturar", centimos: 44594 });
    expect(ensayo.find((x) => x.org_id === ids["19_comision_con_lotes_duplicados"])).toMatchObject({ accion: "facturar", centimos: 12865 });
    expect(est.facturas).toHaveLength(0);
    expect(est.db["cargos"]).toEqual([]);
  });

  it("STRIPE_PRICE_IDS_EXTRA se trocea y se recorta: un precio de comisión de ahí, con espacios y salto de línea, factura igual", async () => {
    vi.stubEnv("STRIPE_PRICE_IDS_EXTRA", " price_comision_extra , \n");
    est.db = { organizations: [], subscriptions: [], licenses: [], extractos: [], cargos: [] };
    sembrar({
      extra: {
        cargo: 99.5,
        subs: [{ price_id: "price_comision_extra", status: "active", current_period_end: "2026-12-01T10:00:00Z" }],
      },
      // Y el anual de siempre, con un período que llega a 2027.
      anual: {
        cargo: 50,
        subs: [{ price_id: "price_comision_antiguo_y", status: "active", current_period_end: "2027-03-01T00:00:00Z" }],
      },
      // Y una fila de comisión sin fecha de fin: no se le quita la comisión a quien la tiene.
      sin_fecha: { cargo: 10, subs: [{ price_id: COMISION, status: "active", current_period_end: null }] },
    });
    await GET(peticion());
    expect(facturadoA("extra")).toBe(99.5);
    expect(facturadoA("anual")).toBe(50);
    expect(facturadoA("sin_fecha")).toBe(10);
  });

  it("un despliegue SIN precios de comisión configurados no factura comisión a nadie (y lo grita)", async () => {
    est.monthly = "";
    est.yearly = "";
    await GET(peticion());
    expect(est.facturas).toHaveLength(0);
    expect(est.db["cargos"]).toEqual([]);
    expect(est.alertas.filter((a) => /SIN la modalidad con comisión/.test(String(a["asunto"])))).toHaveLength(12);
  });

  it("FALLA CERRADO: si las suscripciones no se pueden leer, no se factura", async () => {
    est.fallar["subscriptions"] = true;
    await GET(peticion());
    expect(est.facturas).toHaveLength(0);
    expect(est.lineas).toHaveLength(0);
  });

  it("sin cliente de Stripe y sin la modalidad: ni siquiera la fila «omitido» (nada que reclamar)", async () => {
    est.db = { organizations: [], subscriptions: [], licenses: [], extractos: [], cargos: [] };
    sembrar({ sin_cliente: { cargo: 445.94, licencias: [{ plan: "enterprise", issued_at: "2026-10-01T00:00:00Z", expires_at: LEJOS }] } });
    est.db["organizations"]![0]!["stripe_customer_id"] = null;
    await GET(peticion());
    expect(est.db["cargos"]).toEqual([]);
    expect(est.alertas.some((a) => /SIN cliente de Stripe/.test(String(a["asunto"])))).toBe(false);
  });

  it("ya registrado (relanzada del cron): ni factura ni alerta nueva", async () => {
    est.db["cargos"]!.push({ org_id: ids["14_pro_unpaid"], periodo: "2026-11", estado: "facturado" });
    await GET(peticion());
    const paradas = est.alertas.filter((a) => /SIN la modalidad con comisión/.test(String(a["asunto"])));
    expect(paradas.map((a) => a["detalle"]["orgId"])).not.toContain(ids["14_pro_unpaid"]);
    expect(paradas).toHaveLength(7);
  });
});
