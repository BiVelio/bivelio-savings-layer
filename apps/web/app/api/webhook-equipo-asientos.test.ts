import { beforeEach, describe, expect, it, vi } from "vitest";

import { ASIENTOS_INCLUIDOS_EQUIPO } from "@/lib/billing/planes";

/**
 * A2-20 · EN EL PLAN TEAM, LA LICENCIA Y EL PANEL DICEN LOS ASIENTOS QUE SE PAGAN.
 *
 * Team cobra una cuota fija que incluye 10 asientos «aunque uses menos». El
 * checkout no deja comprar menos de 10, pero el portal de Stripe sí deja bajar la
 * cantidad (su mínimo es por producto, y Pro y Team comparten producto). Con la
 * cantidad en 4, Stripe sigue cobrando la cuota de 10, pero el webhook firmaba una
 * licencia de 4 y guardaba `subscriptions.seats = 4`: el panel comparaba el uso
 * contra 4 y con 8 máquinas marcaba 4 de exceso a quien paga por 10. No se cobraba
 * de más (cobro-asientos.ts ya trata ese caso como cubierto), pero la cifra era falsa.
 *
 * Ahora, con un precio de Team, los asientos son max(cantidad, incluidos).
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const T = 1_800_000_100;
const FIN = T + 30 * 86400;

const escrituras: { tabla: string; fila: Record<string, unknown> }[] = [];
function tabla(nombre: string) {
  const q: Record<string, unknown> & { then?: unknown } = {};
  for (const m of ["select", "order", "limit", "eq", "neq", "in", "is", "like", "or"]) q[m] = () => q;
  q.update = (fila: Record<string, unknown>) => (escrituras.push({ tabla: nombre, fila }), q);
  q.insert = (fila: Record<string, unknown>) => (escrituras.push({ tabla: nombre, fila }), q);
  q.upsert = async () => ({ error: null });
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
  priceIdForPlan: (p: string) => (p === "pro" ? "price_pro" : p === "equipo" ? "price_team" : "price_legado"),
  preciosSinComision: () => ({ pro: ["price_pro"], equipo: ["price_team"] }),
  STRIPE_SECRET_KEY: "sk_test_falsa",
  STRIPE_WEBHOOK_SECRET: "whsec_falsa",
  STRIPE_PRICE_ID_MONTHLY: "price_legado",
  STRIPE_PRICE_ID_YEARLY: "price_legado_anual",
}));
vi.mock("@/lib/observabilidad/alerta", () => ({ alertar: async () => {} }));

const suscripcion = (precio: string, cantidad: number) => ({
  id: "sub_1",
  status: "active",
  cancel_at_period_end: false,
  canceled_at: null,
  customer: "cus_1",
  metadata: { org_id: ORG },
  items: { data: [{ id: "si_1", quantity: cantidad, price: { id: precio }, current_period_start: T, current_period_end: FIN }] },
});
let enVivo = suscripcion("price_team", 4);
const construirEvento = vi.fn();
vi.mock("@/lib/stripe/client", () => ({
  getStripe: () => ({
    webhooks: { constructEvent: (...a: unknown[]) => construirEvento(...a) },
    subscriptions: { retrieve: async () => enVivo },
    customers: { list: async () => ({ data: [] }) },
  }),
}));

/** La licencia de pago vigente (null = ninguna). */
let vigente: { jti: string; seats: number; expiresAt: string } | null = null;
const emitir = vi.fn(async (..._a: unknown[]) => ({ jti: "j-nueva", token: "t", expiresAt: 0 }));
vi.mock("@/lib/license/issue", () => ({
  issueLicense: (...a: unknown[]) => emitir(...a),
  supersedeLicense: async () => {},
  currentPaidLicense: async () => vigente,
  currentPaidLicenseJti: async () => vigente?.jti ?? null,
  revokeAllLicenses: async () => [],
}));
vi.mock("@/lib/license/medir", () => ({ volverAMedir: async () => ({ resultado: "emitida", jti: "m" }) }));

async function enviar(type: string, object: unknown) {
  construirEvento.mockReturnValueOnce({ id: `evt_${type}`, type, created: T, data: { object } });
  const { POST } = await import("./stripe/webhook/route.js");
  return POST(new Request("https://savings.bivelio.com/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": "x" }, body: "{}" }));
}
const asientosEmitidos = () => emitir.mock.calls.map((c) => (c[1] as { seats: number }).seats);
const asientosGuardados = () => escrituras.filter((e) => e.tabla === "subscriptions").at(-1)?.fila.seats;
const vence = new Date(FIN * 1000).toISOString();

// La verja de producto reconoce los precios de Pro y Team por el entorno
// (lib/stripe/atribucion.ts#preciosPropios), no por el doble de env.ts.
vi.stubEnv("STRIPE_PRICE_ID_PRO_MONTHLY", "price_pro");
vi.stubEnv("STRIPE_PRICE_ID_TEAM_MONTHLY", "price_team");

beforeEach(() => {
  emitir.mockClear();
  escrituras.length = 0;
  vigente = null;
});

describe("A2-20 · Team: los asientos son max(cantidad, incluidos)", () => {
  it("el plan incluye 10 asientos (si cambia, esta prueba sigue valiendo con el número nuevo)", () => {
    expect(ASIENTOS_INCLUIDOS_EQUIPO).toBe(10);
  });

  it("⛔ Team bajado a 4 en el portal, con licencia de 10: ni se reemite a 4 ni la fila guarda 4", async () => {
    enVivo = suscripcion("price_team", 4);
    vigente = { jti: "lic-10", seats: 10, expiresAt: vence };
    const r = await enviar("customer.subscription.updated", enVivo);
    expect(r.status).toBe(200);
    expect(asientosEmitidos()).not.toContain(4);
    expect(asientosGuardados()).toBe(ASIENTOS_INCLUIDOS_EQUIPO);
  });

  it("⛔ Team bajado de 12 a 4: la licencia nueva es de 10, no de 4", async () => {
    enVivo = suscripcion("price_team", 4);
    vigente = { jti: "lic-12", seats: 12, expiresAt: vence };
    await enviar("customer.subscription.updated", enVivo);
    expect(asientosEmitidos()).toEqual([ASIENTOS_INCLUIDOS_EQUIPO]);
    expect(asientosGuardados()).toBe(ASIENTOS_INCLUIDOS_EQUIPO);
  });

  it("⛔ primera licencia de un Team con cantidad 4: sale de 10", async () => {
    enVivo = suscripcion("price_team", 4);
    await enviar("customer.subscription.created", enVivo);
    expect(asientosEmitidos()).toEqual([ASIENTOS_INCLUIDOS_EQUIPO]);
  });

  it("Team por encima de los incluidos: la cantidad tal cual", async () => {
    enVivo = suscripcion("price_team", 15);
    vigente = { jti: "lic-10", seats: 10, expiresAt: vence };
    await enviar("customer.subscription.updated", enVivo);
    expect(asientosEmitidos()).toEqual([15]);
    expect(asientosGuardados()).toBe(15);
  });

  it("Pro y el plan cerrado no tienen asientos incluidos: la cantidad tal cual", async () => {
    for (const precio of ["price_pro", "price_legado"]) {
      emitir.mockClear();
      escrituras.length = 0;
      enVivo = suscripcion(precio, 4);
      vigente = { jti: "lic-10", seats: 10, expiresAt: vence };
      await enviar("customer.subscription.updated", enVivo);
      expect(asientosEmitidos(), precio).toEqual([4]);
      expect(asientosGuardados(), precio).toBe(4);
    }
  });
});
