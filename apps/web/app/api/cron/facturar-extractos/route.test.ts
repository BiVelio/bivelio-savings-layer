import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * GET /api/cron/facturar-extractos — ⛔ LA SEGUNDA VERJA DEL PLAN (2026-11-16).
 *
 * LICENSE-CLOUD §6(b): solo se factura comisión a quien llevó una suscripción
 * con Price de comisión en el período. El cierre ya sella cargo 0 para los
 * demás, pero esta verja NO es redundante: un extracto sellado con la regla
 * anterior —que cobraba a quien había cancelado Pro— sigue trayendo
 * `cargo_eur > 0`, y aquí es donde eso se habría convertido en una factura de
 * Stripe con cobro automático.
 */

const CATALOGO = { comision: ["price_legacy_m"], pro: ["price_pro_m"], equipo: ["price_team_m"] };

interface Estado {
  /** Extractos del período con cargo > 0 (uno por org). */
  extractos: string[];
  orgs: Record<string, { stripe_customer_id: string | null; comision_exenta: boolean }>;
  subs: Array<Record<string, unknown>>;
  falloSubs: boolean;
  facturas: Array<Record<string, unknown>>;
  lineas: Array<Record<string, unknown>>;
  cargos: Array<Record<string, unknown>>;
  alertas: Array<{ nivel: string; asunto: string }>;
}
const estado: Estado = { extractos: [], orgs: {}, subs: [], falloSubs: false, facturas: [], lineas: [], cargos: [], alertas: [] };

function builder(tabla: string) {
  let columnas = "";
  let org: string | null = null;
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    select: (c: string) => {
      columnas = c;
      return b;
    },
    eq: (col: string, valor: string) => {
      if (col === "org_id" || col === "id") org = valor;
      return b;
    },
    gt: () => b,
    not: () => b,
    order: () => b,
    limit: () => b,
    range: async () => {
      if (tabla === "extractos") {
        return {
          data: estado.extractos.map((org_id) => ({
            org_id,
            periodo: "2026-10",
            es_calibracion: false,
            cargo_eur: 12.34,
            ahorro_medido_eur: 810,
            base_medida_eur: 1800,
            ratio: 0.45,
          })),
          error: null,
        };
      }
      return { data: [], error: null }; // cargos: ninguno registrado todavía
    },
    maybeSingle: async () => {
      if (tabla === "organizations") return { data: estado.orgs[org!] ?? null, error: null };
      // medioDePagoDeLaOrg: la suscripción más reciente con id de Stripe.
      return { data: { stripe_subscription_id: "sub_x" }, error: null };
    },
    upsert: async (fila: Record<string, unknown>) => {
      estado.cargos.push(fila);
      return { error: null };
    },
    // La lectura del plan: `select(COLUMNAS).eq("org_id", …)` se espera directamente.
    then: (resolver: (v: { data: unknown; error: unknown }) => unknown) => {
      if (tabla !== "subscriptions" || !columnas.includes("created_at")) return resolver({ data: [], error: null });
      if (estado.falloSubs) return resolver({ data: null, error: { message: "timeout" } });
      return resolver({ data: estado.subs.filter((s) => s.org_id === org), error: null });
    },
  });
  return b;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ schema: () => ({ from: (t: string) => builder(t) }) }),
}));
vi.mock("@/lib/stripe/env", () => ({ billingConfigured: true, catalogoDeComision: () => CATALOGO }));
vi.mock("@/lib/stripe/client", () => ({
  getStripe: () => ({
    subscriptions: { retrieve: async () => ({ default_payment_method: "pm_x" }) },
    customers: { retrieve: async () => ({ deleted: false, invoice_settings: {} }) },
    invoices: {
      create: async (p: Record<string, unknown>) => {
        estado.facturas.push(p);
        return { id: `in_${estado.facturas.length}` };
      },
      finalizeInvoice: async (id: string) => ({ id, number: "F-1", hosted_invoice_url: null, invoice_pdf: null }),
    },
    invoiceItems: {
      create: async (p: Record<string, unknown>) => {
        estado.lineas.push(p);
        return {};
      },
    },
  }),
}));
vi.mock("@/lib/observabilidad/alerta", () => ({
  alertar: async (a: Estado["alertas"][number]) => {
    estado.alertas.push(a);
  },
}));

import { GET } from "./route";

const facturar = (extra = "") =>
  GET(
    new Request(`https://savings.bivelio.com/api/cron/facturar-extractos?periodo=2026-10${extra}`, {
      headers: { authorization: "Bearer secreto-de-prueba" },
    }),
  );

const sub = (org_id: string, price_id: string, status: string, mas: Record<string, unknown> = {}) => ({
  org_id,
  price_id,
  status,
  created_at: "2026-06-03T09:00:00Z",
  canceled_at: null,
  current_period_end: "2026-11-03T09:00:00Z",
  cancel_at_period_end: false,
  ...mas,
});
const conCliente = { stripe_customer_id: "cus_x", comision_exenta: false };

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "secreto-de-prueba");
  Object.assign(estado, { extractos: [], orgs: {}, subs: [], falloSubs: false, facturas: [], lineas: [], cargos: [], alertas: [] });
});
afterEach(() => vi.unstubAllEnvs());

describe("⛔ facturar-extractos: un cargo sellado no se factura sin un plan con comisión en el período", () => {
  it("Pro cancelado, Equipo impagado y sin suscripción: NINGUNA factura, aunque el extracto traiga cargo y haya cliente de Stripe", async () => {
    estado.extractos = ["pro-cancelado", "equipo-impagado", "enterprise-sin-sub"];
    for (const o of estado.extractos) estado.orgs[o] = conCliente;
    estado.subs = [
      sub("pro-cancelado", "price_pro_m", "canceled", { canceled_at: "2026-10-20T10:00:00Z" }),
      sub("equipo-impagado", "price_team_m", "unpaid"),
    ];
    const res = await facturar();
    expect(await res.json()).toMatchObject({ facturadas: 0, omitidas: 0, fallos: 0 });
    expect(estado.facturas).toEqual([]);
    expect(estado.lineas).toEqual([]);
    // Ni siquiera queda un «omitido»: no es un cargo que se dejó de cobrar, es uno que no existe.
    expect(estado.cargos).toEqual([]);
    expect(estado.alertas).toEqual([]);
  });

  it("la modalidad con comisión, viva o cancelada ese mes, se factura como siempre: el cargo del extracto, céntimo a céntimo", async () => {
    estado.extractos = ["legado-vivo", "legado-cancelado"];
    for (const o of estado.extractos) estado.orgs[o] = conCliente;
    estado.subs = [
      sub("legado-vivo", "price_legacy_m", "active"),
      sub("legado-cancelado", "price_legacy_m", "canceled", { canceled_at: "2026-10-15T10:00:00Z" }),
    ];
    const res = await facturar();
    expect(await res.json()).toMatchObject({ facturadas: 2, fallos: 0 });
    expect(estado.lineas.map((l) => l.amount)).toEqual([1234, 1234]);
    expect(estado.cargos.map((c) => c.estado)).toEqual(["facturado", "facturado"]);
  });

  it("comisión y Pro en el mismo mes: no se factura (lo revisa el dueño)", async () => {
    estado.extractos = ["mixta"];
    estado.orgs.mixta = conCliente;
    estado.subs = [
      sub("mixta", "price_legacy_m", "canceled", { canceled_at: "2026-10-05T10:00:00Z" }),
      sub("mixta", "price_pro_m", "active", { created_at: "2026-10-05T10:05:00Z" }),
    ];
    await facturar();
    expect(estado.facturas).toEqual([]);
  });

  it("la marca de exención sigue ganando aunque la suscripción sea de comisión", async () => {
    estado.extractos = ["cortesia"];
    estado.orgs.cortesia = { stripe_customer_id: "cus_x", comision_exenta: true };
    estado.subs = [sub("cortesia", "price_legacy_m", "active")];
    await facturar();
    expect(estado.facturas).toEqual([]);
  });

  it("falla CERRADO: si el plan no se puede leer, no se factura y se alerta", async () => {
    estado.extractos = ["legado-vivo"];
    estado.orgs["legado-vivo"] = conCliente;
    estado.subs = [sub("legado-vivo", "price_legacy_m", "active")];
    estado.falloSubs = true;
    const res = await facturar();
    expect(await res.json()).toMatchObject({ facturadas: 0, fallos: 1 });
    expect(estado.facturas).toEqual([]);
    expect(estado.alertas[0]).toMatchObject({ nivel: "critico" });
  });

  it("?seco=1 dice por qué no se facturaría", async () => {
    estado.extractos = ["legado-vivo", "pro-cancelado"];
    for (const o of estado.extractos) estado.orgs[o] = conCliente;
    estado.subs = [
      sub("legado-vivo", "price_legacy_m", "active"),
      sub("pro-cancelado", "price_pro_m", "canceled", { canceled_at: "2026-10-20T10:00:00Z" }),
    ];
    const res = await facturar("&seco=1");
    const { ensayo } = (await res.json()) as { ensayo: Array<{ org_id: string; accion: string; detalle: string; centimos: number | null }> };
    expect(ensayo.find((e) => e.org_id === "legado-vivo")).toMatchObject({ accion: "facturar", centimos: 1234 });
    expect(ensayo.find((e) => e.org_id === "pro-cancelado")).toMatchObject({ accion: "sin_comision", centimos: null });
    expect(ensayo.find((e) => e.org_id === "pro-cancelado")!.detalle).toMatch(/sin_suscripcion_con_comision/);
    expect(estado.facturas).toEqual([]);
  });
});
