import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Cobertura de las dos rutas del camino de PAGO. Existen porque una auditoría
 * encontró que `apps/web/app/api/**` no tenía NI UN test, y ahí vivían los dos
 * defectos que impedían lanzar:
 *
 *  B1 — el webhook emitía la licencia y DESCARTABA el token. Nadie podía
 *       recogerlo (0007 saca `licenses.token` del alcance de `authenticated`, no
 *       hay correo, y /api/license/trial da 402 y emite otra licencia distinta),
 *       así que el cliente pagaba y el SDK, fail-closed, no arrancaba nunca.
 *  B2 — nada impedía abrir una SEGUNDA suscripción, y el panel empujaba a
 *       hacerlo porque el webhook no creaba la fila de `org_members`.
 *
 * Se prueba el comportamiento observable de la ruta (código de estado y cuerpo),
 * no su implementación.
 */

// --- doble de cliente Supabase -------------------------------------------------

interface Escenario {
  usuario: { id: string; email?: string } | null;
  licencia: Record<string, unknown> | null;
  suscripcionActiva: Record<string, unknown> | null;
  serviceAccount: Record<string, unknown> | null;
  errorLicencia?: unknown;
  errorSuscripcion?: unknown;
}

const esc: Escenario = { usuario: null, licencia: null, suscripcionActiva: null, serviceAccount: null };

/** Petición de la vía de SESIÓN (sin cabecera de autorización). */
const peticionSesion = () => new Request("https://savings.bivelio.com/api/license/current");
/** Registra cada upsert para poder afirmar que la pertenencia SÍ se escribe. */
const upserts: { tabla: string; fila: unknown }[] = [];

/** Constructor de consultas encadenable: cada método devuelve `this` y el
 *  terminal resuelve según la tabla que se pidió. */
function tabla(nombre: string) {
  const q: Record<string, unknown> = {};
  const self = () => q;
  for (const m of ["select", "eq", "in", "order", "limit", "not", "neq"]) q[m] = self;
  q.upsert = (fila: unknown) => {
    upserts.push({ tabla: nombre, fila });
    return { ...q, error: null };
  };
  q.insert = (fila: unknown) => {
    upserts.push({ tabla: nombre, fila });
    return { ...q, error: null };
  };
  q.update = self;
  q.maybeSingle = async () => {
    if (nombre === "licenses") return { data: esc.licencia, error: esc.errorLicencia ?? null };
    if (nombre === "subscriptions") return { data: esc.suscripcionActiva, error: esc.errorSuscripcion ?? null };
    if (nombre === "service_accounts") return { data: esc.serviceAccount, error: null };
    if (nombre === "organizations") return { data: null, error: null };
    return { data: null, error: null };
  };
  // `org_members` sin `.maybeSingle()` devuelve una lista (así lo usa la ruta).
  (q as { then?: unknown }).then = (resolve: (v: unknown) => unknown) =>
    resolve({ data: nombre === "org_members" ? [] : [], error: null });
  return q;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: esc.usuario } }) },
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: (n: string) => tabla(n) }),
}));

vi.mock("@/lib/stripe/env", () => ({
  billingFullyConfigured: true,
  priceIdFor: () => "price_test_123",
  STRIPE_SECRET_KEY: "sk_test_x",
  STRIPE_WEBHOOK_SECRET: "whsec_x",
}));

const crearSesion = vi.fn(async () => ({ url: "https://checkout.stripe.com/c/test" }));
const construirEvento = vi.fn();
const suscripcionStripe = {
  id: "sub_123",
  status: "active",
  cancel_at_period_end: false,
  canceled_at: null,
  customer: "cus_123",
  metadata: {},
  items: {
    data: [
      {
        id: "si_1",
        quantity: 2,
        price: { id: "price_test_123" },
        current_period_start: 1_800_000_000,
        current_period_end: 1_802_592_000,
      },
    ],
  },
};
vi.mock("@/lib/stripe/client", () => ({
  getStripe: () => ({
    checkout: { sessions: { create: crearSesion } },
    webhooks: { constructEvent: (...a: unknown[]) => construirEvento(...a) },
    subscriptions: { retrieve: async () => suscripcionStripe },
  }),
}));

// La emisión real necesita la clave Ed25519 del servidor; aquí solo interesa que
// la PERTENENCIA se escriba, así que se sustituye por un doble. Es un espía para
// poder afirmar también cuándo NO debe emitirse (checkout reentregado).
const emitirLicencia = vi.fn(async () => ({ jti: "jti-1", token: "bvl.t", expiresAt: 1_802_592_000 }));
vi.mock("@/lib/license/issue", () => ({
  issueLicense: (...a: unknown[]) => emitirLicencia(...(a as [])),
  supersedeLicense: async () => {},
  currentLicense: async () => null,
  currentLicenseJti: async () => null,
  revokeAllLicenses: async () => [],
}));

beforeEach(() => {
  esc.usuario = { id: "11111111-1111-4111-8111-111111111111", email: "cliente@example.com" };
  esc.licencia = null;
  esc.suscripcionActiva = null;
  esc.serviceAccount = null;
  esc.errorLicencia = undefined;
  esc.errorSuscripcion = undefined;
  upserts.length = 0;
  crearSesion.mockClear();
  emitirLicencia.mockClear();
  suscripcionStripe.status = "active";
});

// --- B1: la licencia pagada se puede recoger -----------------------------------

describe("GET /api/license/current — B1: la licencia pagada llega al cliente", () => {
  it("devuelve el token de la licencia vigente a su dueño", async () => {
    esc.licencia = {
      id: "lic-1",
      org_id: esc.usuario!.id,
      plan: "pro",
      seats: 3,
      token: "bvl.header.payload.sig",
      expires_at: "2026-12-31T00:00:00.000Z",
      grace_days: 14,
    };
    const { GET } = await import("./license/current/route.js");
    const res = await GET(peticionSesion());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token?: string; seats?: number; plan?: string };
    // ESTE es el defecto B1: antes el token no era recuperable por ninguna vía.
    expect(body.token).toBe("bvl.header.payload.sig");
    expect(body.seats).toBe(3);
    expect(body.plan).toBe("pro");
  });

  it("no cachea la respuesta: es una credencial", async () => {
    esc.licencia = {
      id: "lic-1",
      org_id: esc.usuario!.id,
      plan: "pro",
      seats: 1,
      token: "t",
      expires_at: "2026-12-31T00:00:00.000Z",
      grace_days: 14,
    };
    const { GET } = await import("./license/current/route.js");
    const res = await GET(peticionSesion());
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("404 cuando no hay licencia, sin filtrar nada", async () => {
    const { GET } = await import("./license/current/route.js");
    const res = await GET(peticionSesion());
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain("bvl.");
  });

  it("401 sin sesión — el token jamás se sirve a un anónimo", async () => {
    esc.usuario = null;
    esc.licencia = { id: "l", org_id: "o", plan: "pro", seats: 1, token: "SECRETO", expires_at: "x", grace_days: 14 };
    const { GET } = await import("./license/current/route.js");
    const res = await GET(peticionSesion());
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toContain("SECRETO");
  });

  it("una licencia revocada sin token no se entrega como si fuera válida", async () => {
    esc.licencia = { id: "l", org_id: esc.usuario!.id, plan: "pro", seats: 1, token: null, expires_at: "x", grace_days: 14 };
    const { GET } = await import("./license/current/route.js");
    expect((await GET(peticionSesion())).status).toBe(404);
  });
});

// --- la RENOVACIÓN también llega: vía máquina con la clave de servicio ---------

describe("GET /api/license/current — vía máquina (bvk_): la renovación se recoge sin humanos", () => {
  const conBvk = (clave: string) =>
    new Request("https://savings.bivelio.com/api/license/current", {
      headers: { authorization: `Bearer ${clave}` },
    });

  it("una clave de servicio válida recibe el token vigente de SU org", async () => {
    esc.usuario = null; // sin sesión: es una máquina, no un humano
    esc.serviceAccount = { org_id: "org-maquina" };
    esc.licencia = {
      id: "lic-renovada",
      org_id: "org-maquina",
      plan: "pro",
      seats: 2,
      token: "bvl.renovado",
      expires_at: "2027-01-31T00:00:00.000Z",
      grace_days: 14,
    };
    const { GET } = await import("./license/current/route.js");
    const res = await GET(conBvk("bvk_test_123"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { token?: string }).token).toBe("bvl.renovado");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("una bvk_ desconocida: 401 y ni rastro del token", async () => {
    esc.serviceAccount = null;
    esc.licencia = { id: "l", org_id: "o", plan: "pro", seats: 1, token: "SECRETO", expires_at: "x", grace_days: 14 };
    const { GET } = await import("./license/current/route.js");
    const res = await GET(conBvk("bvk_falsa"));
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toContain("SECRETO");
  });

  it("sin sesión y sin bvk_, sigue siendo 401 (la vía de sesión no se relajó)", async () => {
    esc.usuario = null;
    const { GET } = await import("./license/current/route.js");
    const res = await GET(new Request("https://savings.bivelio.com/api/license/current"));
    expect(res.status).toBe(401);
  });
});

// --- B2: no se puede pagar dos veces -------------------------------------------

function peticionCheckout() {
  return new Request("https://savings.bivelio.com/api/stripe/checkout", {
    method: "POST",
    body: JSON.stringify({ period: "monthly", seats: 1, locale: "es" }),
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/stripe/checkout — B2: guardia anti-doble-cobro", () => {
  it("409 si la organización YA tiene una suscripción activa, y NO llama a Stripe", async () => {
    esc.suscripcionActiva = { id: "sub-row-1", status: "active" };
    const { POST } = await import("./stripe/checkout/route.js");
    const res = await POST(peticionCheckout());
    expect(res.status).toBe(409);
    // Lo esencial: ni siquiera se crea la sesión, así que no hay segundo cobro.
    expect(crearSesion).not.toHaveBeenCalled();
  });

  it("también bloquea en past_due y trialing, no solo en active", async () => {
    for (const status of ["past_due", "trialing"]) {
      esc.suscripcionActiva = { id: "sub-row-1", status };
      const { POST } = await import("./stripe/checkout/route.js");
      expect((await POST(peticionCheckout())).status).toBe(409);
    }
    expect(crearSesion).not.toHaveBeenCalled();
  });

  it("deja pasar el primer pago cuando no hay suscripción", async () => {
    const { POST } = await import("./stripe/checkout/route.js");
    const res = await POST(peticionCheckout());
    expect(res.status).toBe(200);
    expect(crearSesion).toHaveBeenCalledTimes(1);
  });

  it("falla CERRADA si no puede comprobar el estado: bloquea antes que arriesgar un doble cobro", async () => {
    esc.errorSuscripcion = { message: "connection reset" };
    const { POST } = await import("./stripe/checkout/route.js");
    const res = await POST(peticionCheckout());
    expect(res.status).toBe(503);
    expect(crearSesion).not.toHaveBeenCalled();
  });

  it("401 sin sesión", async () => {
    esc.usuario = null;
    const { POST } = await import("./stripe/checkout/route.js");
    expect((await POST(peticionCheckout())).status).toBe(401);
    expect(crearSesion).not.toHaveBeenCalled();
  });
});

// --- B2 (otra mitad): el que paga consta como miembro de su organización -------

describe("POST /api/stripe/webhook — B2: la pertenencia se crea al pagar", () => {
  it("un checkout completado escribe la fila de org_members", async () => {
    const orgId = "22222222-2222-4222-8222-222222222222";
    const evento = {
      id: "evt_1",
      type: "checkout.session.completed",
      data: {
        object: {
          mode: "subscription",
          metadata: { org_id: orgId, email: "cliente@example.com" },
          client_reference_id: orgId,
          subscription: "sub_123",
        },
      },
    };
    construirEvento.mockReturnValueOnce(evento);

    const { POST } = await import("./stripe/webhook/route.js");
    const res = await POST(
      new Request("https://savings.bivelio.com/api/stripe/webhook", {
        method: "POST",
        body: "{}",
        headers: { "stripe-signature": "t=1,v1=x" },
      }),
    );
    expect(res.status).toBe(200);

    // EL DEFECTO: `ensureOrg` solo escribía en `organizations`. Sin esta fila,
    // getOrgContext resuelve la org con un join sobre org_members, ctx.org queda
    // null, el panel muestra "Sin plan activo" y reofrece el checkout.
    const pertenencia = upserts.find((u) => u.tabla === "org_members");
    expect(pertenencia, "el webhook debe crear la pertenencia del que paga").toBeTruthy();
    expect(pertenencia!.fila).toMatchObject({ org_id: orgId, user_id: orgId, role: "owner" });
  });
});

// --- un checkout.session.completed reentregado no reabre una org cancelada -----

describe("POST /api/stripe/webhook — el reintento tardío de un checkout no resucita una org", () => {
  const orgId = "33333333-3333-4333-8333-333333333333";
  const eventoCheckout = () => ({
    id: "evt_replay",
    type: "checkout.session.completed",
    created: 1_700_000_000,
    data: {
      object: {
        mode: "subscription",
        metadata: { org_id: orgId, email: "cliente@example.com" },
        client_reference_id: orgId,
        subscription: "sub_123",
      },
    },
  });
  const dispara = async () => {
    const { POST } = await import("./stripe/webhook/route.js");
    return POST(
      new Request("https://savings.bivelio.com/api/stripe/webhook", {
        method: "POST",
        body: "{}",
        headers: { "stripe-signature": "t=1,v1=x" },
      }),
    );
  };

  it("con la suscripción YA cancelada: ni plan pro, ni pertenencia, ni licencia", async () => {
    // El escenario: el primer intento del evento respondió 503, Stripe reintenta
    // hasta 72 h y entre medias se procesó subscription.deleted. El retrieve
    // fresco devuelve la suscripción cancelada.
    suscripcionStripe.status = "canceled";
    construirEvento.mockReturnValueOnce(eventoCheckout());
    const res = await dispara();
    expect(res.status).toBe(200); // reconocido y registrado, pero SIN efectos
    expect(emitirLicencia).not.toHaveBeenCalled();
    expect(upserts.find((u) => u.tabla === "org_members")).toBeFalsy();
    expect(upserts.find((u) => u.tabla === "organizations")).toBeFalsy();
  });

  it("fuera de orden (la fila ya refleja un evento más nuevo): no se emite OTRA licencia", async () => {
    esc.suscripcionActiva = { id: "sub-row-1", seats: 2, last_event_at: "2099-01-01T00:00:00.000Z" };
    construirEvento.mockReturnValueOnce(eventoCheckout());
    const res = await dispara();
    expect(res.status).toBe(200);
    expect(emitirLicencia).not.toHaveBeenCalled();
  });

  it("el camino feliz sigue emitiendo la licencia (el cobro no se rompió)", async () => {
    construirEvento.mockReturnValueOnce(eventoCheckout());
    const res = await dispara();
    expect(res.status).toBe(200);
    expect(emitirLicencia).toHaveBeenCalledTimes(1);
  });
});
