import { createHash } from "node:crypto";
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

/** El hash que la ruta calcula de una clave de servicio, para que el doble
 *  pueda comprobar de verdad el `.eq("key_hash", …)` que la autentica. */
const hashDe = (clave: string) => createHash("sha256").update(clave).digest("hex");

/** Petición de la vía de SESIÓN (sin cabecera de autorización). */
const peticionSesion = () => new Request("https://savings.bivelio.com/api/license/current");
/** Registra cada upsert para poder afirmar que la pertenencia SÍ se escribe. */
const upserts: { tabla: string; fila: unknown }[] = [];

/** Constructor de consultas encadenable: cada método devuelve `this` y el
 *  terminal resuelve según la tabla que se pidió. */
function tabla(nombre: string) {
  // Los filtros se REGISTRAN y se aplican en el terminal. Antes `eq`/`in` eran
  // no-ops que devolvían `this`, así que el doble entregaba la fila del escenario
  // pasara lo que pasara: se podía sustituir `[sa.org_id]` por la org de otro
  // cliente, borrar el `.eq("key_hash", …)` que autentica la clave de servicio o
  // borrar el `.eq("revoked", false)` que impide re-entregar una licencia
  // revocada, y los tests seguían verdes. Una superficie que sirve credenciales
  // no puede tener el control de acceso sin cobertura.
  const filtros: { col: string; op: "eq" | "in"; val: unknown }[] = [];
  const q: Record<string, unknown> = {};
  const self = () => q;
  for (const m of ["select", "order", "limit", "not", "neq"]) q[m] = self;
  q.eq = (col: string, val: unknown) => {
    filtros.push({ col, op: "eq", val });
    return q;
  };
  q.in = (col: string, val: unknown) => {
    filtros.push({ col, op: "in", val });
    return q;
  };
  const pasa = (fila: Record<string, unknown> | null): boolean =>
    fila != null &&
    filtros.every((f) =>
      f.op === "eq"
        ? fila[f.col] === f.val
        : Array.isArray(f.val) && (f.val as unknown[]).includes(fila[f.col]),
    );
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
    if (nombre === "licenses") {
      if (esc.errorLicencia) return { data: null, error: esc.errorLicencia };
      return { data: pasa(esc.licencia) ? esc.licencia : null, error: null };
    }
    if (nombre === "subscriptions") {
      if (esc.errorSuscripcion) return { data: null, error: esc.errorSuscripcion };
      return { data: pasa(esc.suscripcionActiva) ? esc.suscripcionActiva : null, error: null };
    }
    if (nombre === "service_accounts") {
      return { data: pasa(esc.serviceAccount) ? esc.serviceAccount : null, error: null };
    }
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
/** Lo que ve el webhook al preguntar "¿esta org ya tiene licencia viva?" — es lo
 *  que decide si la red de seguridad de la PRIMERA licencia entra o no. */
let licenciaVigente: { jti: string; seats: number } | null = null;
vi.mock("@/lib/license/issue", () => ({
  issueLicense: (...a: unknown[]) => emitirLicencia(...(a as [])),
  supersedeLicense: async () => {},
  currentLicense: async () => licenciaVigente,
  currentLicenseJti: async () => licenciaVigente?.jti ?? null,
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
  licenciaVigente = null;
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
      revoked: false,
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
      revoked: false,
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
    esc.licencia = { id: "l", org_id: "o", plan: "pro", seats: 1, token: "SECRETO", revoked: false, expires_at: "x", grace_days: 14 };
    const { GET } = await import("./license/current/route.js");
    const res = await GET(peticionSesion());
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toContain("SECRETO");
  });

  it("una licencia revocada sin token no se entrega como si fuera válida", async () => {
    esc.licencia = { id: "l", org_id: esc.usuario!.id, plan: "pro", seats: 1, token: null, revoked: false, expires_at: "x", grace_days: 14 };
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
    esc.serviceAccount = { org_id: "org-maquina", key_hash: hashDe("bvk_test_123") };
    esc.licencia = {
      id: "lic-renovada",
      org_id: "org-maquina",
      plan: "pro",
      seats: 2,
      token: "bvl.renovado",
      revoked: false,
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
    esc.licencia = { id: "l", org_id: "o", plan: "pro", seats: 1, token: "SECRETO", revoked: false, expires_at: "x", grace_days: 14 };
    const { GET } = await import("./license/current/route.js");
    const res = await GET(conBvk("bvk_falsa"));
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toContain("SECRETO");
  });

  it("una bvk_ EQUIVOCADA no vale aunque existan claves de servicio: 401", async () => {
    // Discrimina "la ruta filtra por key_hash" de "el fixture no tenía nada":
    // aquí SÍ hay una clave registrada, pero es la de otra máquina. Sin esta
    // prueba, borrar el `.eq("key_hash", …)` de la ruta pasaba desapercibido.
    esc.serviceAccount = { org_id: "org-maquina", key_hash: hashDe("bvk_la_buena") };
    esc.licencia = {
      id: "l", org_id: "org-maquina", plan: "pro", seats: 1,
      token: "SECRETO", revoked: false, expires_at: "x", grace_days: 14,
    };
    const { GET } = await import("./license/current/route.js");
    const res = await GET(conBvk("bvk_la_equivocada"));
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toContain("SECRETO");
  });

  it("una licencia REVOCADA no se re-entrega, ni por sesión ni por bvk_", async () => {
    // El plano de control no puede seguir sirviendo una credencial revocada:
    // es lo que convierte una revocación manual en efectiva.
    esc.serviceAccount = { org_id: "org-maquina", key_hash: hashDe("bvk_test_123") };
    esc.licencia = {
      id: "l", org_id: "org-maquina", plan: "pro", seats: 1,
      token: "TOKEN-REVOCADO", revoked: true, expires_at: "x", grace_days: 14,
    };
    const { GET } = await import("./license/current/route.js");
    const res = await GET(conBvk("bvk_test_123"));
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain("TOKEN-REVOCADO");
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
    esc.suscripcionActiva = { id: "sub-row-1", org_id: esc.usuario!.id, status: "active" };
    const { POST } = await import("./stripe/checkout/route.js");
    const res = await POST(peticionCheckout());
    expect(res.status).toBe(409);
    // Lo esencial: ni siquiera se crea la sesión, así que no hay segundo cobro.
    expect(crearSesion).not.toHaveBeenCalled();
  });

  it("también bloquea en past_due y trialing, no solo en active", async () => {
    for (const status of ["past_due", "trialing"]) {
      esc.suscripcionActiva = { id: "sub-row-1", org_id: esc.usuario!.id, status };
      const { POST } = await import("./stripe/checkout/route.js");
      expect((await POST(peticionCheckout())).status).toBe(409);
    }
    expect(crearSesion).not.toHaveBeenCalled();
  });

  // El agujero de verdad, y el único que no necesita ninguna carrera para darse:
  // un adeudo SEPA deja la suscripción en `incomplete` DURANTE DÍAS. El panel
  // muestra "Sin plan activo" (planForStatus manda incomplete a free) y reofrece
  // comprar; el comprador, que no ve nada de lo que pagó, pulsa otra vez. Antes
  // de esto la guardia no miraba `incomplete`, así que se abría una segunda
  // suscripción real y liquidaban las dos.
  it("bloquea con un pago SEPA en vuelo (`incomplete`): es el doble cobro del camino normal", async () => {
    esc.suscripcionActiva = { id: "sub-row-1", org_id: esc.usuario!.id, status: "incomplete" };
    const { POST } = await import("./stripe/checkout/route.js");
    const res = await POST(peticionCheckout());
    expect(res.status).toBe(409);
    expect(crearSesion).not.toHaveBeenCalled();
  });

  it("a quien tiene el pago en vuelo le dice que espere, no que gestione un plan que aún no tiene", async () => {
    esc.suscripcionActiva = { id: "sub-row-1", org_id: esc.usuario!.id, status: "incomplete" };
    const { POST } = await import("./stripe/checkout/route.js");
    const cuerpo = (await (await POST(peticionCheckout())).json()) as { error: string };
    expect(cuerpo.error).toMatch(/still being processed/i);
    expect(cuerpo.error).not.toMatch(/Manage plan/i);
  });

  // `unpaid` queda FUERA a propósito: Stripe ya agotó los reintentos, no hay
  // dinero en vuelo, y bloquear aquí dejaría al cliente sin salida desde la web.
  it("NO bloquea en `unpaid`: ahí no hay cobro en curso y el cliente necesita poder comprar", async () => {
    esc.suscripcionActiva = { id: "sub-row-1", org_id: esc.usuario!.id, status: "unpaid" };
    const { POST } = await import("./stripe/checkout/route.js");
    expect((await POST(peticionCheckout())).status).toBe(200);
    expect(crearSesion).toHaveBeenCalledTimes(1);
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

  it("fuera de orden pero la org YA tiene licencia: no se emite otra", async () => {
    esc.suscripcionActiva = { id: "sub-row-1", org_id: orgId, stripe_subscription_id: "sub_123", seats: 2, last_event_at: "2099-01-01T00:00:00.000Z" };
    licenciaVigente = { jti: "ya-existe", seats: 2 };
    construirEvento.mockReturnValueOnce(eventoCheckout());
    const res = await dispara();
    expect(res.status).toBe(200);
    expect(emitirLicencia).not.toHaveBeenCalled();
  });

  it("fuera de orden y SIN licencia: se emite igual — si no, el que paga se queda sin producto", async () => {
    // `checkout.session.completed` es el ÚNICO camino que mina la PRIMERA
    // licencia. Un `customer.subscription.updated` que se adelante (Stripe no
    // garantiza orden) adelanta `last_event_at` y deja el checkout stale; si la
    // guardia de orden se aplicara también a la primera emisión, la org quedaría
    // cobrada, con plan pro y CERO filas en `licenses`, y el SDK moriría con
    // LicenseError de forma permanente.
    esc.suscripcionActiva = { id: "sub-row-1", org_id: orgId, stripe_subscription_id: "sub_123", seats: 2, last_event_at: "2099-01-01T00:00:00.000Z" };
    licenciaVigente = null;
    construirEvento.mockReturnValueOnce(eventoCheckout());
    const res = await dispara();
    expect(res.status).toBe(200);
    expect(emitirLicencia).toHaveBeenCalledTimes(1);
  });

  it("el camino feliz sigue emitiendo la licencia (el cobro no se rompió)", async () => {
    construirEvento.mockReturnValueOnce(eventoCheckout());
    const res = await dispara();
    expect(res.status).toBe(200);
    expect(emitirLicencia).toHaveBeenCalledTimes(1);
  });
});

// --- los dos textos que decían al que paga que no se le puede vender ----------

/**
 * En el momento exacto en que un cliente pagaba y venía a por su clave, la ruta
 * respondía con una frase fija en inglés: «Subscription checkout is coming online
 * — self-serve license keys aren't issued yet». Copia fósil de cuando el checkout
 * no existía. Ahora devuelve un CÓDIGO que el cliente traduce, y distingue los dos
 * motivos, que llevan a acciones OPUESTAS: a quien ya pagó no se le puede sugerir
 * que pague otra vez.
 */
describe("POST /api/license/trial — el 402 dice el motivo, no una frase en inglés", () => {
  const sinAllowList = () => {
    delete process.env.LICENSE_ISSUER_EMAILS; // fail-closed: no emite a nadie
  };

  it("con un pago en curso responde `pago_en_curso` y NO invita a pagar de nuevo", async () => {
    sinAllowList();
    esc.suscripcionActiva = { id: "s1", org_id: esc.usuario!.id, status: "incomplete" };
    const { POST } = await import("./license/trial/route.js");
    const res = await POST();
    expect(res.status).toBe(402);
    const body = (await res.json()) as { code?: string; error?: string };
    expect(body.code).toBe("pago_en_curso");
    // Lo que NO debe volver a aparecer nunca:
    expect(JSON.stringify(body)).not.toContain("coming online");
  });

  it("sin suscripción responde `sin_suscripcion`", async () => {
    sinAllowList();
    esc.suscripcionActiva = null;
    const { POST } = await import("./license/trial/route.js");
    const res = await POST();
    expect(res.status).toBe(402);
    expect(((await res.json()) as { code?: string }).code).toBe("sin_suscripcion");
  });

  it("si no se puede comprobar, falla hacia el lado que NO provoca un segundo cobro", async () => {
    sinAllowList();
    esc.errorSuscripcion = { message: "connection reset" };
    const { POST } = await import("./license/trial/route.js");
    const res = await POST();
    expect(((await res.json()) as { code?: string }).code).toBe("pago_en_curso");
  });
});
