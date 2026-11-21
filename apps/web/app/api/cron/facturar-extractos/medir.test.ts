import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/cron/facturar-extractos · LA SEGUNDA VERJA de la licencia Medir.
 *
 * La primera verja es el cargo 0 del cierre (cierre-extractos/medir.test.ts).
 * Esta fija que, aunque un extracto de una organización Medir llegara aquí con
 * cargo > 0 (cerrado antes del cambio, o por un fallo de la primera verja), la
 * facturación NO crea ninguna factura ni ninguna línea en Stripe, ni escribe un
 * cargo. Y que una organización de la modalidad con comisión sigue su camino.
 */

const MEDIR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LEGADO = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const extracto = (org_id: string) => ({
  org_id,
  periodo: "2026-11",
  es_calibracion: false,
  cargo_eur: 120,
  ahorro_medido_eur: 2700,
  base_medida_eur: 3600,
  ratio: 0.75,
});

let escritos: Array<{ tabla: string; fila: unknown }> = [];
let fallarLicencias = false;
const stripe = {
  invoiceItems: { create: vi.fn(async () => ({ id: "ii_test" })) },
  invoices: { create: vi.fn(async () => ({ id: "in_test" })), finalizeInvoice: vi.fn(async () => ({ id: "in_test" })) },
  subscriptions: { retrieve: vi.fn(async () => ({ default_payment_method: "pm_test" })) },
  customers: { retrieve: vi.fn(async () => ({ invoice_settings: { default_payment_method: "pm_test" } })) },
};

function builder(tabla: string) {
  const filtros: Record<string, unknown> = {};
  const b: Record<string, unknown> = {};
  const encadenar = () => b;
  const filas = () => {
    const org = filtros["org_id"];
    if (tabla === "licenses") {
      if (fallarLicencias) return { data: null, error: { message: "boom" } };
      return { data: org === MEDIR ? [{ org_id: MEDIR, issued_at: "2026-11-02T09:00:00Z" }] : [], error: null };
    }
    if (tabla === "subscriptions") {
      return {
        data: org === LEGADO ? [{ org_id: LEGADO, price_id: "price_comision_antiguo", status: "active", stripe_subscription_id: "sub_test" }] : [],
        error: null,
      };
    }
    return { data: [], error: null };
  };
  Object.assign(b, {
    select: encadenar,
    eq: (col: string, v: unknown) => {
      filtros[col] = v;
      return b;
    },
    in: encadenar,
    not: encadenar,
    gt: encadenar,
    order: encadenar,
    limit: encadenar,
    range: async () => {
      if (tabla === "extractos") return { data: [extracto(MEDIR), extracto(LEGADO)], error: null };
      return { data: [], error: null };
    },
    maybeSingle: async () => {
      if (tabla === "organizations") return { data: { stripe_customer_id: "cus_test", comision_exenta: false }, error: null };
      const r = filas();
      return { data: (r.data ?? [])[0] ?? null, error: r.error };
    },
    upsert: async (fila: unknown) => {
      escritos.push({ tabla, fila });
      return { error: null };
    },
    then: (ok: (v: unknown) => unknown) => Promise.resolve(filas()).then(ok),
  });
  return b;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ schema: () => ({ from: (t: string) => builder(t) }) }),
}));
vi.mock("@/lib/observabilidad/alerta", () => ({ alertar: async () => {} }));
vi.mock("@/lib/stripe/client", () => ({ getStripe: () => stripe }));
vi.mock("@/lib/stripe/env", () => ({
  billingConfigured: true,
  preciosSinComision: () => ({ pro: ["price_pro_m"], equipo: ["price_team_m"] }),
  // Los precios de la modalidad CON comisión: la tercera verja (tercera-verja.test.ts)
  // solo deja facturar a quien tiene uno de ellos en el período.
  STRIPE_PRICE_ID_MONTHLY: "price_comision_antiguo",
  STRIPE_PRICE_ID_YEARLY: "price_comision_antiguo_y",
}));

import { GET } from "./route";

const peticion = (extra = "") =>
  new Request(`https://savings.bivelio.com/api/cron/facturar-extractos?periodo=2026-11${extra}`, {
    headers: { authorization: "Bearer secreto-de-prueba" },
  });

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "secreto-de-prueba");
  escritos = [];
  fallarLicencias = false;
  for (const grupo of Object.values(stripe)) for (const f of Object.values(grupo)) (f as ReturnType<typeof vi.fn>).mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe("facturar-extractos · una org Medir nunca recibe factura de comisión", () => {
  it("ensayo en seco: el extracto de la org Medir sale «exenta»; el de la modalidad con comisión, «facturar»", async () => {
    const res = await GET(peticion("&seco=1"));
    expect(res.status).toBe(200);
    const cuerpo = (await res.json()) as { ensayo: Array<{ org_id: string; accion: string }> };
    const lista = cuerpo.ensayo;
    expect(lista.find((x) => x.org_id === MEDIR)?.accion).toBe("exenta");
    expect(lista.find((x) => x.org_id === LEGADO)?.accion).toBe("facturar");
  });

  it("de verdad: ninguna línea ni factura de Stripe para la org Medir, ni fila en cargos", async () => {
    await GET(peticion());
    const clientes = (stripe.invoiceItems.create.mock.calls as unknown as Array<[{ metadata?: Record<string, string> }]>).map(
      ([a]) => JSON.stringify(a),
    );
    for (const c of clientes) expect(c).not.toContain(MEDIR);
    for (const e of escritos) expect(JSON.stringify(e.fila)).not.toContain(MEDIR);
    // Y la de comisión SÍ se factura: la verja no ha apagado el cobro legítimo.
    expect(stripe.invoices.create).toHaveBeenCalledTimes(1);
    expect(escritos.some((e) => e.tabla === "cargos" && JSON.stringify(e.fila).includes(LEGADO))).toBe(true);
  });

  it("FALLA CERRADO: si la licencia Medir no se puede leer, esa organización NO se factura", async () => {
    fallarLicencias = true;
    await GET(peticion());
    expect(stripe.invoices.create).not.toHaveBeenCalled();
    expect(stripe.invoiceItems.create).not.toHaveBeenCalled();
  });
});
