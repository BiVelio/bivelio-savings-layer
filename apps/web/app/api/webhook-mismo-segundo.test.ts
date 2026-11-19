import { beforeEach, describe, expect, it, vi } from "vitest";

import { ganaLaEscritura } from "@/lib/stripe/guardia-orden";

/**
 * A2-17 · LOS AVISOS DE UNA COMPRA, DEL MISMO SEGUNDO Y DESORDENADOS, NO DEJAN
 * «SIN PLAN» A QUIEN HA PAGADO.
 *
 * Una compra con tarjeta manda cuatro avisos casi a la vez y Stripe no garantiza
 * el orden. `customer.subscription.created` lleva la foto del momento de crear,
 * que puede decir `incomplete` (https://docs.stripe.com/billing/subscriptions/webhooks).
 * Si ese aviso se procesaba el último y todos nacían en el mismo segundo, la
 * guardia de orden lo dejaba pasar (a igual instante se escribe, salvo sobre
 * `canceled`) y `handleSubUpsert` escribía la foto vieja: fila `incomplete`, org
 * `free`, panel «sin plan activo» y, al pulsar comprar, «tu pago aún se está
 * procesando». Ha pagado y Stripe lo tiene activo. Reproducido con estos mismos
 * dobles en la auditoría del 19-11.
 *
 * El arreglo: `created` y `updated` leen la suscripción FRESCA de Stripe antes de
 * guardar, como ya hacían el checkout y `invoice.paid`. Aquí la base de datos es
 * un doble CON ESTADO y el UPDATE guardado aplica la misma regla que el WHERE real
 * (`ganaLaEscritura`, la referencia ejecutable de `condicionEscritura`).
 */

// --- base de datos falsa CON ESTADO -------------------------------------------
type Fila = Record<string, unknown>;
const db: Record<string, Fila[]> = {};
function reiniciarDb() {
  for (const k of Object.keys(db)) delete db[k];
  for (const t of ["subscriptions", "organizations", "org_members", "licenses", "stripe_events", "billing_audit"]) db[t] = [];
}
reiniciarDb();

function tabla(nombre: string) {
  const filas = (db[nombre] ??= []);
  const filtros: ((f: Fila) => boolean)[] = [];
  let accion: "select" | "update" | "insert" = "select";
  let cambio: Fila = {};
  const q: Record<string, unknown> & { then?: unknown } = {};
  const self = () => q;
  q.select = self;
  q.order = self;
  q.limit = self;
  q.eq = (c: string, v: unknown) => (filtros.push((f) => f[c] === v), q);
  q.neq = (c: string, v: unknown) => (filtros.push((f) => f[c] !== v), q);
  q.in = (c: string, v: unknown[]) => (filtros.push((f) => v.includes(f[c])), q);
  q.is = (c: string, v: unknown) => (filtros.push((f) => (f[c] ?? null) === v), q);
  q.like = () => (filtros.push(() => false), q);
  q.or = (cond: string) => {
    const iso = /last_event_at\.lt\."([^"]+)"/.exec(cond)![1]!;
    filtros.push((f) => ganaLaEscritura(iso, (f.last_event_at as string) ?? null, (f.status as string) ?? null));
    return q;
  };
  q.update = (c: Fila) => ((accion = "update"), (cambio = c), q);
  q.insert = (c: Fila) => {
    accion = "insert";
    if (nombre === "subscriptions" && filas.some((f) => f.stripe_subscription_id === c.stripe_subscription_id)) {
      cambio = { __dup: true };
      return q;
    }
    filas.push({ id: `${nombre}-${filas.length + 1}`, ...c });
    cambio = c;
    return q;
  };
  q.upsert = (c: Fila) => {
    filas.push(c);
    return Promise.resolve({ error: null });
  };
  const ejecutar = () => {
    if (accion === "insert") return cambio.__dup ? { data: null, error: { code: "23505" } } : { data: [filas[filas.length - 1]], error: null };
    const sel = filas.filter((f) => filtros.every((p) => p(f)));
    if (accion === "update") sel.forEach((f) => Object.assign(f, cambio));
    return { data: sel, error: null };
  };
  q.maybeSingle = async () => {
    const r = ejecutar();
    return { data: (r.data as unknown[] | null)?.[0] ?? null, error: r.error };
  };
  q.then = (ok: (v: unknown) => unknown) => ok(ejecutar());
  return q;
}

const USUARIO = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const T = 1_800_000_100; // TODOS los avisos de la compra nacen en el MISMO segundo

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: USUARIO, email: "cliente@example.com" } } }) } }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: (n: string) => tabla(n) }) }));
vi.mock("@/lib/stripe/env", () => ({
  billingFullyConfigured: true,
  priceIdFor: () => "price_legado",
  priceIdForPlan: (p: string) => (p === "pro" ? "price_pro" : p === "equipo" ? "price_team" : "price_legado"),
  preciosSinComision: () => ({ pro: ["price_pro"], equipo: ["price_team"] }),
  STRIPE_SECRET_KEY: "sk_test_falsa",
  STRIPE_WEBHOOK_SECRET: "whsec_falsa",
  STRIPE_PRICE_ID_MONTHLY: "price_pro",
  STRIPE_PRICE_ID_YEARLY: "price_legado",
}));
vi.mock("@/lib/observabilidad/alerta", () => ({ alertar: async () => {} }));
vi.mock("@/lib/org/resolver", () => ({
  resolverOrgDelUsuario: async () => ({ orgId: ORG, role: "owner" }),
  resolverOrgSiExiste: async () => ({ orgId: ORG, role: "owner" }),
}));

const sub = (status: string, extra: Fila = {}) => ({
  id: "sub_1",
  status,
  cancel_at_period_end: false,
  canceled_at: null,
  customer: "cus_1",
  metadata: { org_id: ORG, user_id: USUARIO, plan: "pro" },
  items: { data: [{ id: "si_1", quantity: 3, price: { id: "price_pro" }, current_period_start: T, current_period_end: T + 30 * 86400 }] },
  ...extra,
});

/** Lo que Stripe dice EN VIVO de la suscripción. Por defecto: activa y cobrada. */
let estadoVivo: ReturnType<typeof sub> = sub("active");
const leerEnVivo = vi.fn(async () => estadoVivo);
const construirEvento = vi.fn();
vi.mock("@/lib/stripe/client", () => ({
  getStripe: () => ({
    webhooks: { constructEvent: (...a: unknown[]) => construirEvento(...a) },
    checkout: { sessions: { create: async () => ({ url: "https://checkout.stripe.com/c/falsa" }) } },
    customers: { list: async () => ({ data: [] }) },
    subscriptions: { retrieve: (...a: unknown[]) => leerEnVivo(...(a as [])), list: async () => ({ data: [] }) },
  }),
}));

const revocar = vi.fn(async () => [] as string[]);
vi.mock("@/lib/license/issue", () => ({
  issueLicense: async (_a: unknown, i: { orgId: string; seats: number }) => {
    db.licenses!.push({ id: `lic-${db.licenses!.length + 1}`, org_id: i.orgId, seats: i.seats, plan: "pro", revoked: false });
    return { jti: "j", token: "t", expiresAt: 0 };
  },
  supersedeLicense: async () => {},
  currentPaidLicense: async () => {
    const l = db.licenses!.at(-1);
    return l ? { jti: l.id as string, seats: l.seats as number, expiresAt: new Date((T + 30 * 86400) * 1000).toISOString() } : null;
  },
  currentPaidLicenseJti: async () => (db.licenses!.at(-1)?.id as string) ?? null,
  revokeAllLicenses: (...a: unknown[]) => revocar(...(a as [])),
}));
vi.mock("@/lib/license/medir", () => ({ volverAMedir: async () => ({ resultado: "emitida", jti: "m" }) }));

const AVISOS: Record<string, () => unknown> = {
  "checkout.session.completed": () => ({
    id: "cs_1",
    mode: "subscription",
    subscription: "sub_1",
    client_reference_id: USUARIO,
    customer_email: "cliente@example.com",
    amount_total: 4500,
    metadata: { org_id: ORG, user_id: USUARIO, email: "cliente@example.com", plan: "pro" },
  }),
  "customer.subscription.updated": () => sub("active"),
  "invoice.paid": () => ({ id: "in_1", subscription: "sub_1", billing_reason: "subscription_create", amount_paid: 4500 }),
  // La foto del momento de crear: todavía sin cobrar.
  "customer.subscription.created": () => sub("incomplete"),
};

async function enviar(type: string, object: unknown) {
  construirEvento.mockReturnValueOnce({ id: `evt_${type}`, type, created: T, data: { object } });
  const { POST } = await import("./stripe/webhook/route.js");
  return POST(new Request("https://savings.bivelio.com/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": "x" }, body: "{}" }));
}

function permutaciones<X>(xs: X[]): X[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutaciones([...xs.slice(0, i), ...xs.slice(i + 1)]).map((r) => [x, ...r]));
}

beforeEach(() => {
  reiniciarDb();
  estadoVivo = sub("active");
  leerEnVivo.mockClear();
  revocar.mockClear();
  construirEvento.mockReset();
});

describe("A2-17 · avisos de una compra en el mismo segundo", () => {
  it("⛔ el `created` con foto `incomplete` entregado el ÚLTIMO no deja «sin plan» al que ha pagado", async () => {
    for (const tipo of ["checkout.session.completed", "customer.subscription.updated", "invoice.paid", "customer.subscription.created"]) {
      expect((await enviar(tipo, AVISOS[tipo]!())).status, tipo).toBe(200);
    }
    expect(db.subscriptions![0]!.status).toBe("active");
    expect(db.organizations![0]!.plan).toBe("pro");
    expect(db.licenses).toHaveLength(1);
    // Y si el cliente pulsa comprar, se le dice que ya tiene plan, no que su pago se está procesando.
    const { POST } = await import("./stripe/checkout/route.js");
    const r = await POST(new Request("https://savings.bivelio.com/api/stripe/checkout", { method: "POST", body: JSON.stringify({ plan: "pro", seats: 3, locale: "en" }) }));
    expect(r.status).toBe(409);
    expect(((await r.json()) as { code?: string }).code).toBe("ya_suscrito");
  });

  it("created y updated preguntan a Stripe por la suscripción antes de guardar", async () => {
    await enviar("customer.subscription.created", sub("incomplete"));
    await enviar("customer.subscription.updated", sub("incomplete"));
    expect(leerEnVivo).toHaveBeenCalledTimes(2);
    expect(leerEnVivo).toHaveBeenCalledWith("sub_1");
  });

  for (const orden of permutaciones(Object.keys(AVISOS))) {
    it(`en cualquier orden acaba activa, pro y con licencia: ${orden.map((t) => t.split(".").at(-1)).join(" → ")}`, async () => {
      for (const tipo of orden) expect((await enviar(tipo, AVISOS[tipo]!())).status, tipo).toBe(200);
      expect(db.subscriptions![0]!.status).toBe("active");
      expect(db.organizations![0]!.plan).toBe("pro");
      // «Al menos una»: si un `updated` se adelanta al checkout, la red de la
      // primera licencia emite una y el checkout otra (las dos vivas, revocadas
      // juntas al cancelar). Es anterior a A2-17 y no es lo que esto prueba.
      expect(db.licenses!.length).toBeGreaterThanOrEqual(1);
    });
  }

  it("un pago SEPA aún sin liquidar sigue siendo `incomplete`: la lectura fresca no inventa un cobro", async () => {
    estadoVivo = sub("incomplete");
    await enviar("customer.subscription.created", sub("incomplete"));
    expect(db.subscriptions![0]!.status).toBe("incomplete");
    expect(db.licenses).toHaveLength(0);
  });

  it("si Stripe ya la canceló, un `updated` del mismo segundo no le roba al `deleted` la revocación", async () => {
    // La cancelación la resuelve SOLO `customer.subscription.deleted` (revoca y
    // devuelve a Medir). Si el `updated` escribiera la foto fresca `canceled`, el
    // `deleted` del mismo segundo se vería frenado por la guardia (`canceled` es
    // pegajoso a igual instante) y no revocaría nada.
    estadoVivo = sub("canceled", { canceled_at: T });
    await enviar("customer.subscription.updated", sub("active", { cancel_at_period_end: true }));
    await enviar("customer.subscription.deleted", sub("canceled", { canceled_at: T }));
    expect(revocar).toHaveBeenCalledTimes(1);
    expect(db.subscriptions![0]!.status).toBe("canceled");
    expect(db.organizations).toHaveLength(0); // ni siquiera se creó: el plan se escribe con update
  });

  it("si no se puede leer la suscripción en Stripe: 503 para que Stripe reintente, y no se escribe nada", async () => {
    leerEnVivo.mockRejectedValueOnce(new Error("stripe caído"));
    const r = await enviar("customer.subscription.created", sub("incomplete"));
    expect(r.status).toBe(503);
    expect(db.subscriptions).toHaveLength(0);
    expect(db.stripe_events).toHaveLength(0);
  });
});
