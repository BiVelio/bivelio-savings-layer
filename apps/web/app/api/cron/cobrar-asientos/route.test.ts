import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/cron/cobrar-asientos — el cobro de los asientos usados de más, con
 * una base en memoria que IMITA el trigger de 0034 (cobrado terminal, cifras
 * fijadas, no se vuelve a seco) y un doble de Stripe. Nada toca Stripe de verdad.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const SUB = "sub_test_1";
const ITEM = "si_test_1";
const CUS = "cus_test_1";
const PRICE_PRO_M = "price_pro_m";
const PRICE_PRO_Y = "price_pro_y";

type Fila = Record<string, unknown>;
interface Db {
  subscriptions: Fila[];
  ajustes_asientos: Fila[];
  usage_daily: Fila[];
  billing_audit: Fila[];
}
const db: Db = { subscriptions: [], ajustes_asientos: [], usage_daily: [], billing_audit: [] };
const control = {
  usados: 7,
  sinTabla: false,
  /** Falla la escritura de la fila al pasar a `cobrado` (el proceso «muere» tras cobrar). */
  pierdeCobrado: false,
};
const alertas: Array<{ nivel: string; asunto: string }> = [];

/** El trigger de 0034, en JS. */
function trigger(viejo: Fila, nuevo: Fila): string | null {
  if (viejo.estado === "cobrado") return "cobrado es terminal";
  if (nuevo.estado === "seco" && viejo.estado !== "seco") return "no se vuelve a seco";
  if (viejo.estado !== "seco") {
    for (const k of ["plan", "periodo_pago", "usados", "pagados", "exceso", "importe_eur"]) {
      if (k in nuevo && nuevo[k] !== viejo[k]) return `cifra fijada: ${k}`;
    }
  }
  return null;
}

function consulta(tabla: keyof Db) {
  let op: "select" | "insert" | "update" | "upsert" = "select";
  let payload: Fila | Fila[] = {};
  const filtros: Array<(f: Fila) => boolean> = [];
  let limite = Infinity;

  const ejecutar = async (desde = 0, hasta = Infinity): Promise<{ data: unknown; error: unknown }> => {
    if (tabla === "ajustes_asientos" && control.sinTabla) {
      return { data: null, error: { code: "PGRST205", message: "Could not find the table 'bvsala.ajustes_asientos'" } };
    }
    const filas = db[tabla];
    const casan = () => filas.filter((f) => filtros.every((p) => p(f)));
    if (op === "select") return { data: casan().slice(desde, Math.min(hasta + 1, limite)), error: null };
    if (op === "insert") {
      const nueva = payload as Fila;
      if (filas.some((f) => f.org_id === nueva.org_id && f.periodo === nueva.periodo)) {
        return { data: null, error: { code: "23505", message: "duplicate key" } };
      }
      filas.push({ ...nueva });
      return { data: [nueva], error: null };
    }
    if (op === "upsert") {
      const nueva = payload as Fila;
      const vieja = filas.find((f) => f.org_id === nueva.org_id && f.periodo === nueva.periodo);
      if (!vieja) {
        filas.push({ ...nueva });
        return { data: null, error: null };
      }
      const e = trigger(vieja, nueva);
      if (e) return { data: null, error: { code: "P0001", message: e } };
      Object.assign(vieja, nueva);
      return { data: null, error: null };
    }
    // update
    const cambios = payload as Fila;
    if (tabla === "ajustes_asientos" && control.pierdeCobrado && cambios.estado === "cobrado") {
      return { data: null, error: { code: "08006", message: "connection lost" } };
    }
    const tocadas = casan();
    for (const f of tocadas) {
      const e = trigger(f, cambios);
      if (e) return { data: null, error: { code: "P0001", message: e } };
    }
    for (const f of tocadas) Object.assign(f, cambios);
    return { data: tocadas.map((f) => ({ org_id: f.org_id })), error: null };
  };

  const q: Record<string, unknown> = {
    select: () => q,
    eq: (k: string, v: unknown) => (filtros.push((f) => f[k] === v), q),
    in: (k: string, vs: unknown[]) => (filtros.push((f) => vs.includes(f[k])), q),
    gte: (k: string, v: string) => (filtros.push((f) => String(f[k]) >= v), q),
    lt: (k: string, v: string) => (filtros.push((f) => String(f[k]) < v), q),
    order: () => q,
    limit: (n: number) => ((limite = n), q),
    range: (a: number, b: number) => ejecutar(a, b),
    insert: (p: Fila) => ((op = "insert"), (payload = p), q),
    update: (p: Fila) => ((op = "update"), (payload = p), q),
    upsert: (p: Fila) => ((op = "upsert"), (payload = p), q),
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => ejecutar().then(res, rej),
  };
  return q;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    schema: () => ({ from: (t: keyof Db) => consulta(t) }),
    rpc: async (nombre: string) => (nombre === "billable_seats" ? { data: control.usados, error: null } : { data: null, error: { message: "?" } }),
  }),
}));
vi.mock("@/lib/observabilidad/alerta", () => ({
  alertar: async (a: { nivel: string; asunto: string }) => {
    alertas.push(a);
  },
}));
vi.mock("@/lib/stripe/env", () => ({
  billingConfigured: true,
  STRIPE_PRICE_ID_MONTHLY: "price_old_m",
  STRIPE_PRICE_ID_YEARLY: "price_old_y",
  STRIPE_PRICE_ID_PRO_MONTHLY: "price_pro_m",
  STRIPE_PRICE_ID_PRO_YEARLY: "price_pro_y",
  STRIPE_PRICE_ID_TEAM_MONTHLY: "price_team_m",
  STRIPE_PRICE_ID_TEAM_YEARLY: "price_team_y",
  priceIdFor: () => "price_old_m",
  priceIdForPlan: () => "price_pro_m",
}));

// ── El doble de Stripe ────────────────────────────────────────────────────────
interface ItemCreado {
  id: string;
  params: Record<string, unknown>;
  clave: string;
  metadata: Record<string, string>;
}
const stripe = {
  itemsCreados: [] as ItemCreado[],
  llamadasCrear: 0,
  cantidades: [] as Array<{ id: string; params: Record<string, unknown> }>,
  facturas: [] as Array<Record<string, unknown>>,
  cantidadEnStripe: 4,
  priceId: PRICE_PRO_M,
  unitAmount: 1_500,
  falla: false,
};
const dobleStripe = {
  subscriptions: {
    retrieve: async () => ({
      id: SUB,
      status: "active",
      items: {
        data: [
          {
            id: ITEM,
            quantity: stripe.cantidadEnStripe,
            price: { id: stripe.priceId, billing_scheme: "per_unit", unit_amount: stripe.unitAmount, currency: "eur", tiers: null },
          },
        ],
      },
    }),
  },
  invoiceItems: {
    create: async (params: Record<string, unknown>, opts: { idempotencyKey: string }) => {
      stripe.llamadasCrear += 1;
      if (stripe.falla) throw new Error("Stripe 500");
      // Idempotencia de Stripe (24 h): la misma clave devuelve el mismo item.
      const previo = stripe.itemsCreados.find((i) => i.clave === opts.idempotencyKey);
      if (previo) return { id: previo.id };
      const item = { id: `ii_${stripe.itemsCreados.length + 1}`, params, clave: opts.idempotencyKey, metadata: params.metadata as Record<string, string> };
      stripe.itemsCreados.push(item);
      return { id: item.id };
    },
    list: async () => ({ data: stripe.itemsCreados.map((i) => ({ id: i.id, metadata: i.metadata })) }),
  },
  invoices: {
    create: async (params: Record<string, unknown>) => {
      stripe.facturas.push(params);
      return { id: `in_${stripe.facturas.length}`, status: "draft" };
    },
    finalizeInvoice: async (id: string) => ({ id, status: "open" }),
  },
  subscriptionItems: {
    retrieve: async () => ({ id: ITEM, quantity: stripe.cantidadEnStripe }),
    update: async (id: string, params: Record<string, unknown>) => {
      stripe.cantidades.push({ id, params });
      stripe.cantidadEnStripe = Number(params.quantity);
      return { id };
    },
  },
};
vi.mock("@/lib/stripe/client", () => ({ getStripe: () => dobleStripe }));

import { GET } from "./route";

const peticion = (extra = "") =>
  new Request(`https://savings.bivelio.com/api/cron/cobrar-asientos?periodo=2026-09${extra}`, {
    headers: { authorization: "Bearer secreto-de-prueba" },
  });
const correr = async (extra = ""): Promise<{ status: number; cuerpo: Record<string, unknown> }> => {
  const res = await GET(peticion(extra));
  return { status: res.status, cuerpo: (await res.json()) as Record<string, unknown> };
};
const ajuste = () => db.ajustes_asientos.find((f) => f.org_id === ORG && f.periodo === "2026-09");

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "secreto-de-prueba");
  vi.stubEnv("BVSALA_COBRO_ASIENTOS", "vivo");
  db.subscriptions = [
    { org_id: ORG, status: "active", seats: 4, price_id: PRICE_PRO_M, stripe_subscription_id: SUB, stripe_item_id: ITEM, stripe_customer_id: CUS },
  ];
  db.ajustes_asientos = [];
  db.usage_daily = [{ org_id: ORG, day: "2026-09-10", requests: 20_000 }];
  db.billing_audit = [];
  control.usados = 7;
  control.sinTabla = false;
  control.pierdeCobrado = false;
  alertas.length = 0;
  Object.assign(stripe, { itemsCreados: [], llamadasCrear: 0, cantidades: [], facturas: [], cantidadEnStripe: 4, priceId: PRICE_PRO_M, unitAmount: 1_500, falla: false });
});
afterEach(() => vi.unstubAllEnvs());

describe("cobrar-asientos — seco", () => {
  it("por defecto (sin la variable) es SECO: registra `seco`, devuelve el informe y no toca Stripe", async () => {
    vi.stubEnv("BVSALA_COBRO_ASIENTOS", "");
    const { status, cuerpo } = await correr();
    expect(status).toBe(200);
    expect(cuerpo.modo).toBe("seco");
    expect(ajuste()).toMatchObject({ estado: "seco", usados: 7, pagados: 4, exceso: 3, importe_eur: 45 });
    expect(cuerpo.informe).toEqual([expect.objectContaining({ org_id: ORG, resultado: "cobraria", importe_eur: 45 })]);
    expect(stripe.llamadasCrear).toBe(0);
    expect(stripe.cantidades).toHaveLength(0);
  });

  it("`?seco=1` fuerza el ensayo aunque la variable diga vivo", async () => {
    const { cuerpo } = await correr("&seco=1");
    expect(cuerpo.modo).toBe("seco");
    expect(stripe.llamadasCrear).toBe(0);
  });

  it("seco y después vivo: el ensayo se sustituye y se cobra UNA vez", async () => {
    await correr("&seco=1");
    await correr();
    expect(ajuste()).toMatchObject({ estado: "cobrado", stripe_invoice_item_id: "ii_1" });
    expect(stripe.itemsCreados).toHaveLength(1);
  });
});

describe("cobrar-asientos — vivo", () => {
  it("cobra el exceso con un invoice item del importe exacto en la suscripción, y sube la cantidad SIN prorrateo", async () => {
    const { cuerpo } = await correr();
    expect(cuerpo).toMatchObject({ modo: "vivo", cobrados: 1, fallos: 0 });
    expect(stripe.itemsCreados).toHaveLength(1);
    const [item] = stripe.itemsCreados;
    expect(item!.params).toMatchObject({ customer: CUS, subscription: SUB, amount: 4_500, currency: "eur" });
    expect(item!.metadata).toMatchObject({ bvsala_org_id: ORG, bvsala_periodo: "2026-09", bvsala_usados: "7", bvsala_pagados: "4" });
    expect(String(item!.params.description)).toContain("7 seats in use");
    expect(stripe.cantidades).toEqual([{ id: ITEM, params: { quantity: 7, proration_behavior: "none" } }]);
    expect(stripe.facturas).toHaveLength(0); // mensual: va en la próxima factura de la suscripción
    expect(ajuste()).toMatchObject({ estado: "cobrado", stripe_invoice_item_id: "ii_1", importe_eur: 45 });
  });

  it("IDEMPOTENTE: dos ejecuciones = un cobro", async () => {
    await correr();
    const segunda = await correr();
    expect(stripe.llamadasCrear).toBe(1);
    expect(stripe.itemsCreados).toHaveLength(1);
    expect(stripe.cantidades).toHaveLength(1);
    expect(segunda.cuerpo.informe).toEqual([expect.objectContaining({ resultado: "ya_registrado" })]);
  });

  it("anual: el item se factura YA en la suscripción y la cantidad NO se toca", async () => {
    db.subscriptions[0]!.price_id = PRICE_PRO_Y;
    stripe.priceId = PRICE_PRO_Y;
    stripe.unitAmount = 15_000;
    await correr();
    expect(stripe.itemsCreados[0]!.params.amount).toBe(Math.round((3 * 15_000) / 12));
    expect(stripe.facturas).toEqual([expect.objectContaining({ customer: CUS, subscription: SUB, pending_invoice_items_behavior: "include" })]);
    expect(stripe.cantidades).toHaveLength(0);
    expect(ajuste()).toMatchObject({ estado: "cobrado" });
  });

  it("recuento NO fiable: revisión humana, alerta crítica y ni un céntimo", async () => {
    db.usage_daily = [{ org_id: ORG, day: "2026-09-10", requests: 90_000_000 }];
    const { cuerpo } = await correr();
    expect(cuerpo.revision).toBe(1);
    expect(ajuste()).toMatchObject({ estado: "revision_humana" });
    expect(stripe.llamadasCrear).toBe(0);
    expect(alertas.some((a) => a.nivel === "critico" && /REVISIÓN HUMANA/.test(a.asunto))).toBe(true);
    // Y no se reintenta: la revisión es de un humano.
    await correr();
    expect(stripe.llamadasCrear).toBe(0);
  });

  it("rotación de clave en el mes: revisión humana, no se cobra", async () => {
    db.billing_audit = [{ org_id: ORG, kind: "service_account_revoked", at: "2026-09-15T10:00:00Z", id: 1 }];
    await correr();
    expect(ajuste()).toMatchObject({ estado: "revision_humana" });
    expect(stripe.llamadasCrear).toBe(0);
  });

  it("la cantidad pagada en Stripe no cuadra con el espejo: revisión humana antes de cobrar", async () => {
    stripe.cantidadEnStripe = 6;
    await correr();
    expect(ajuste()).toMatchObject({ estado: "revision_humana" });
    expect(stripe.llamadasCrear).toBe(0);
  });

  it("el Price de Stripe no cuesta lo publicado: revisión humana", async () => {
    stripe.unitAmount = 999;
    await correr();
    expect(ajuste()).toMatchObject({ estado: "revision_humana" });
    expect(stripe.llamadasCrear).toBe(0);
  });

  it("suscripción no activa: omitido_no_activa, sin Stripe", async () => {
    db.subscriptions[0]!.status = "past_due";
    await correr();
    expect(ajuste()).toMatchObject({ estado: "omitido_no_activa" });
    expect(stripe.llamadasCrear).toBe(0);
  });

  it("price sin configurar: omitido_sin_precio", async () => {
    db.subscriptions[0]!.price_id = "price_extra_desconocido";
    await correr();
    expect(ajuste()).toMatchObject({ estado: "omitido_sin_precio" });
    expect(stripe.llamadasCrear).toBe(0);
  });

  it("dentro de lo pagado: ni fila ni cobro", async () => {
    control.usados = 3;
    await correr();
    expect(ajuste()).toBeUndefined();
    expect(stripe.llamadasCrear).toBe(0);
  });
});

describe("cobrar-asientos — fallos", () => {
  it("fallo de Stripe: queda `fallido` con alerta, y el reintento cobra UNA vez con las mismas cifras", async () => {
    stripe.falla = true;
    const primera = await correr();
    expect(primera.cuerpo.fallos).toBe(1);
    expect(ajuste()).toMatchObject({ estado: "fallido", importe_eur: 45 });
    expect(alertas.some((a) => /FALLIDO/.test(a.asunto))).toBe(true);

    // Entre tanto el cliente usa aún más: el reintento cobra LO APUNTADO, no un recálculo.
    stripe.falla = false;
    control.usados = 9;
    await correr();
    expect(stripe.itemsCreados).toHaveLength(1);
    expect(stripe.itemsCreados[0]!.params.amount).toBe(4_500);
    expect(ajuste()).toMatchObject({ estado: "cobrado", usados: 7 });
    await correr();
    expect(stripe.itemsCreados).toHaveLength(1);
  });

  it("cobró y murió antes de apuntarlo: el reintento ADOPTA el item existente, no crea otro", async () => {
    control.pierdeCobrado = true;
    await correr();
    expect(ajuste()).toMatchObject({ estado: "pendiente" });
    expect(stripe.itemsCreados).toHaveLength(1);
    expect(alertas.some((a) => /NO quedó registrada/.test(a.asunto))).toBe(true);

    control.pierdeCobrado = false;
    // La idempotencia de Stripe caducó (24 h): sin el tercer candado, esto crearía otro.
    stripe.itemsCreados[0]!.clave = "caducada";
    await correr();
    expect(stripe.llamadasCrear).toBe(1);
    expect(stripe.itemsCreados).toHaveLength(1);
    expect(ajuste()).toMatchObject({ estado: "cobrado", stripe_invoice_item_id: "ii_1" });
  });

  it("sin la migración 0034: 503 con alerta crítica y sin tocar Stripe", async () => {
    control.sinTabla = true;
    const { status } = await correr();
    expect(status).toBe(503);
    expect(alertas[0]).toMatchObject({ nivel: "critico" });
    expect(alertas[0]!.asunto).toMatch(/0034/);
    expect(stripe.llamadasCrear).toBe(0);
  });

  it("sin CRON_SECRET: 501; con otro Bearer: 401", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await GET(peticion())).status).toBe(501);
    vi.stubEnv("CRON_SECRET", "otro");
    expect((await GET(peticion())).status).toBe(401);
  });
});

describe("la comisión no cambia", () => {
  const leer = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  it("facturar-extractos sigue excluyendo items pendientes ajenos y no sabe nada de los asientos", () => {
    const src = leer("../facturar-extractos/route.ts");
    expect(src).toContain('pending_invoice_items_behavior: "exclude"');
    expect(src).not.toMatch(/cobro-asientos|ajustes_asientos/);
  });
  it("el cierre tampoco", () => {
    expect(leer("../cierre-extractos/route.ts")).not.toMatch(/cobro-asientos|ajustes_asientos/);
  });
  it("el cron nuevo no toca cargos ni extractos", () => {
    const src = leer("./route.ts");
    expect(src).not.toMatch(/from\("cargos"\)|from\("extractos"\)/);
  });
  it("vercel.json: el cron nuevo va el día 1 después de la comisión, y los de la comisión siguen igual", () => {
    const crons = (JSON.parse(leer("../../../../vercel.json")) as { crons: Array<{ path: string; schedule: string }> }).crons;
    const por = Object.fromEntries(crons.map((c) => [c.path, c.schedule]));
    expect(por["/api/cron/cierre-extractos"]).toBe("0 5 1 * *");
    expect(por["/api/cron/facturar-extractos"]).toBe("0 7 1 * *");
    expect(por["/api/cron/cobrar-asientos"]).toBe("30 7 1 * *");
  });
});
