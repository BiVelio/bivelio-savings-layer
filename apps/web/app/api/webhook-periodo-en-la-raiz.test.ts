import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A2-19 · EL FIN DE PERIODO SE LEE TAMBIÉN DE LA RAÍZ DE LA SUSCRIPCIÓN.
 *
 * Desde la versión 2025-03-31 de la API, Stripe pone `current_period_start/end`
 * en el ITEM de la suscripción; antes iban en la raíz. `subFacts` solo miraba el
 * item, así que con un aviso (o una lectura) en el formato anterior no veía la
 * fecha y la licencia salía con el vencimiento de respaldo de 31 días. A un
 * cliente ANUAL que cambia de asientos, con meses pagados por delante, se le
 * firmaba una licencia que caducaba al mes; pasada la gracia, el SDK se le
 * paraba, sin aviso. El mismo fichero ya preveía el formato anterior para la
 * suscripción de una factura (`invoiceSubId`), pero no para el periodo.
 *
 * El punto de recepción de avisos se crea sin fijar versión
 * (scripts/provision-stripe.mjs), así que hereda la de la cuenta.
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const AHORA = Math.floor(Date.now() / 1000);
const FIN_PAGADO = AHORA + 300 * 86400; // le quedan 300 días PAGADOS
const INICIO = FIN_PAGADO - 365 * 86400;

const escrituras: { tabla: string; fila: Record<string, unknown> }[] = [];
function tabla(nombre: string) {
  const q: Record<string, unknown> & { then?: unknown } = {};
  for (const m of ["select", "order", "limit", "eq", "neq", "in", "is", "like", "or"]) q[m] = () => q;
  q.update = (fila: Record<string, unknown>) => (escrituras.push({ tabla: nombre, fila }), q);
  q.insert = (fila: Record<string, unknown>) => (escrituras.push({ tabla: nombre, fila }), q);
  q.upsert = async () => ({ error: null });
  // La fila de la suscripción ya existe (un cambio de asientos de un cliente con plan).
  q.maybeSingle = async () => ({
    data: nombre === "subscriptions" ? { id: "fila-1", seats: 10, last_event_at: null, past_due_since: null, status: "active", org_id: ORG } : null,
    error: null,
  });
  q.then = (ok: (v: unknown) => unknown) => ok({ data: [{ id: "fila-1" }], error: null });
  return q;
}
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: (n: string) => tabla(n) }) }));
vi.mock("@/lib/stripe/env", () => ({
  billingFullyConfigured: true,
  priceIdFor: () => "price_legado",
  priceIdForPlan: () => "price_pro",
  preciosSinComision: () => ({ pro: ["price_pro"], equipo: ["price_team"] }),
  STRIPE_SECRET_KEY: "sk_test_falsa",
  STRIPE_WEBHOOK_SECRET: "whsec_falsa",
  STRIPE_PRICE_ID_MONTHLY: "price_pro",
  STRIPE_PRICE_ID_YEARLY: "price_legado",
}));
vi.mock("@/lib/observabilidad/alerta", () => ({ alertar: async () => {} }));

/** Formato ANTERIOR a 2025-03-31: el periodo en la raíz, no en el item. */
const enFormatoAnterior = (asientos: number) => ({
  id: "sub_1",
  status: "active",
  cancel_at_period_end: false,
  canceled_at: null,
  customer: "cus_1",
  metadata: { org_id: ORG },
  current_period_start: INICIO,
  current_period_end: FIN_PAGADO,
  items: { data: [{ id: "si_1", quantity: asientos, price: { id: "price_pro" } }] },
});

let enVivo = enFormatoAnterior(12);
const construirEvento = vi.fn();
vi.mock("@/lib/stripe/client", () => ({
  getStripe: () => ({
    webhooks: { constructEvent: (...a: unknown[]) => construirEvento(...a) },
    subscriptions: { retrieve: async () => enVivo },
  }),
}));

const emitir = vi.fn(async (..._a: unknown[]) => ({ jti: "j-nueva", token: "t", expiresAt: 0 }));
vi.mock("@/lib/license/issue", () => ({
  issueLicense: (...a: unknown[]) => emitir(...a),
  supersedeLicense: async () => {},
  currentPaidLicense: async () => ({ jti: "lic-10", seats: 10, expiresAt: new Date(FIN_PAGADO * 1000).toISOString() }),
  currentPaidLicenseJti: async () => "lic-10",
  revokeAllLicenses: async () => [],
}));
vi.mock("@/lib/license/medir", () => ({ volverAMedir: async () => ({ resultado: "emitida", jti: "m" }) }));

async function enviar(type: string, object: unknown) {
  construirEvento.mockReturnValueOnce({ id: `evt_${type}`, type, created: AHORA, data: { object } });
  const { POST } = await import("./stripe/webhook/route.js");
  return POST(new Request("https://savings.bivelio.com/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": "x" }, body: "{}" }));
}
const pedido = () => emitir.mock.calls[0]?.[1] as { seats: number; periodEndUnix: number } | undefined;
const filaSuscripcion = () => escrituras.filter((e) => e.tabla === "subscriptions").at(-1)?.fila;

beforeEach(() => {
  emitir.mockClear();
  escrituras.length = 0;
  enVivo = enFormatoAnterior(12);
});

describe("A2-19 · periodo en la raíz (formato anterior a 2025-03-31)", () => {
  it("⛔ cambio de asientos de un ANUAL: la licencia nueva vence al final de lo pagado, no a los 31 días", async () => {
    const r = await enviar("customer.subscription.updated", enFormatoAnterior(12));
    expect(r.status).toBe(200);
    expect(pedido()?.seats).toBe(12);
    expect(pedido()?.periodEndUnix).toBe(FIN_PAGADO);
  });

  it("la fila de la suscripción guarda también el periodo de la raíz", async () => {
    await enviar("customer.subscription.updated", enFormatoAnterior(12));
    expect(filaSuscripcion()?.current_period_start).toBe(new Date(INICIO * 1000).toISOString());
    expect(filaSuscripcion()?.current_period_end).toBe(new Date(FIN_PAGADO * 1000).toISOString());
  });

  it("⛔ la renovación (invoice.paid de ciclo) también lee el periodo de la raíz", async () => {
    enVivo = enFormatoAnterior(10);
    const r = await enviar("invoice.paid", { id: "in_1", subscription: "sub_1", billing_reason: "subscription_cycle", amount_paid: 129000 });
    expect(r.status).toBe(200);
    expect(pedido()?.periodEndUnix).toBe(FIN_PAGADO);
  });

  it("con el formato de hoy (periodo en el item) manda el del item, como siempre", async () => {
    const itemFin = FIN_PAGADO - 10 * 86400;
    const hoy = { ...enFormatoAnterior(12), items: { data: [{ id: "si_1", quantity: 12, price: { id: "price_pro" }, current_period_start: INICIO, current_period_end: itemFin }] } };
    enVivo = hoy;
    await enviar("customer.subscription.updated", hoy);
    expect(pedido()?.periodEndUnix).toBe(itemFin);
  });
});
