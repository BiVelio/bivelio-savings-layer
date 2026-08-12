import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * EL ROL SE COMPRUEBA EN LAS CUATRO PUERTAS (fase 7).
 *
 * La tabla de `lib/org/permisos` se prueba aparte. Aquí se prueba lo otro, que es
 * lo que de verdad se rompe: que cada RUTA la consulte. Una tabla de permisos
 * impecable que nadie llama no protege nada, y ese fallo no se ve leyendo el
 * fichero de permisos — solo se ve desde fuera.
 *
 * Las cuatro puertas, por orden de lo que cuesta perderlas:
 *
 *  1. `/api/license/current` (sesión) — entrega el TOKEN FIRMADO COMPLETO. Vale
 *     para toda la flota, en cualquier máquina, hasta que caduque.
 *  2. `POST /api/service-accounts` — acuña una `bvk_`, que sirve para descargar
 *     ese mismo token. Es la misma llave por otra puerta.
 *  3. `DELETE /api/service-accounts` — revocar deja sin medición ni renovación a
 *     toda la flota de la empresa.
 *  4. `checkout` y `portal` — dinero real: cobrar, cancelar, cambiar la tarjeta.
 *
 * El escenario no es hipotético: es el de la fase 8. Invitar a alguien a ver el
 * panel de gasto no puede darle la credencial de producción.
 */

const USUARIO = "11111111-1111-1111-1111-111111111111";
const ORG = "99999999-9999-4999-8999-999999999999";

/** El rol del usuario en la organización. Es la única variable de estos tests. */
let rol: string | undefined = "owner";

const licencia = {
  id: "lic-1",
  org_id: ORG,
  plan: "pro",
  seats: 3,
  token: "EL.TOKEN.FIRMADO",
  revoked: false,
  expires_at: "2099-01-01",
  grace_days: 21,
  features: [],
  issued_at: "2026-01-01",
};

const consulta = (tabla: string) => {
  const q: Record<string, unknown> = {
    select: () => q,
    order: () => q,
    limit: () => q,
    eq: () => q,
    in: () => q,
    is: () => q,
    delete: () => q,
    update: () => q,
    maybeSingle: async () => ({
      data:
        tabla === "licenses" ? licencia
        : tabla === "organizations" ? { id: ORG, stripe_customer_id: "cus_1" }
        : tabla === "subscriptions" ? null
        : null,
      error: null,
    }),
    insert: () =>
      Object.assign(Promise.resolve({ data: null, error: null }), {
        select: () => ({ single: async () => ({ data: { id: ORG }, error: null }) }),
      }),
    then: (res: (v: { data: unknown; error: null }) => unknown) =>
      res({
        data:
          tabla === "org_members" ? [{ org_id: ORG, role: rol, created_at: "2026-01-01", user_id: USUARIO }]
          : tabla === "licenses" ? [licencia]
          : tabla === "service_accounts" ? [{ id: "clave-1", key_prefix: "bvk_abcd1234" }]
          : [],
        error: null,
      }),
  };
  return q;
};

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: consulta }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: USUARIO, email: "yo@example.com" } } }) },
  }),
}));
vi.mock("@/lib/stripe/env", () => ({ billingFullyConfigured: true, priceIdFor: () => "price_x" }));

const crearCheckout = vi.fn(async () => ({ url: "https://checkout.stripe.com/x" }));
const crearPortal = vi.fn(async () => ({ url: "https://billing.stripe.com/x" }));
vi.mock("@/lib/stripe/client", () => ({
  getStripe: () => ({
    checkout: { sessions: { create: crearCheckout } },
    billingPortal: { sessions: { create: crearPortal }, configurations: { list: async () => ({ data: [] }) } },
  }),
}));

beforeEach(() => {
  rol = "owner";
  crearCheckout.mockClear();
  crearPortal.mockClear();
  vi.resetModules();
});

const post = (url: string, cuerpo: unknown = {}) =>
  new Request(url, { method: "POST", body: JSON.stringify(cuerpo), headers: { "content-type": "application/json" } });

/**
 * Cada puerta: qué rol la abre y qué rol NO. La tabla del test es a propósito una
 * COPIA de la intención, no un import de `permisos.ts` — si se importara, cambiar
 * la tabla de producción cambiaría el test con ella y los dos dirían que sí.
 */
const PUERTAS = [
  {
    nombre: "GET /api/license/current — el token firmado",
    abren: ["owner", "admin"],
    cierran: ["member", "billing", undefined, "loquesea"],
    async llamar() {
      const { GET } = await import("./license/current/route");
      return GET(new Request("https://savings.bivelio.com/api/license/current"));
    },
  },
  {
    nombre: "POST /api/service-accounts — acuñar una bvk_",
    abren: ["owner", "admin"],
    cierran: ["member", "billing", undefined, "loquesea"],
    async llamar() {
      const { POST } = await import("./service-accounts/route");
      return POST(post("https://savings.bivelio.com/api/service-accounts", { label: "x" }));
    },
  },
  {
    nombre: "DELETE /api/service-accounts — revocar una bvk_",
    abren: ["owner", "admin"],
    cierran: ["member", "billing", undefined, "loquesea"],
    async llamar() {
      const { DELETE } = await import("./service-accounts/route");
      return DELETE(
        new Request("https://savings.bivelio.com/api/service-accounts", {
          method: "DELETE",
          body: JSON.stringify({ id: "clave-1" }),
          headers: { "content-type": "application/json" },
        }),
      );
    },
  },
  {
    nombre: "POST /api/stripe/checkout — mover dinero",
    abren: ["owner", "admin", "billing"],
    cierran: ["member", undefined, "loquesea"],
    async llamar() {
      const { POST } = await import("./stripe/checkout/route");
      return POST(post("https://savings.bivelio.com/api/stripe/checkout", { seats: 2 }));
    },
  },
  {
    nombre: "POST /api/stripe/portal — cancelar, tarjeta, asientos",
    abren: ["owner", "admin", "billing"],
    cierran: ["member", undefined, "loquesea"],
    async llamar() {
      const { POST } = await import("./stripe/portal/route");
      return POST(post("https://savings.bivelio.com/api/stripe/portal"));
    },
  },
];

for (const puerta of PUERTAS) {
  describe(puerta.nombre, () => {
    for (const r of puerta.cierran) {
      it(`⛔ ${r ?? "sin rol"} recibe 403`, async () => {
        rol = r;
        const res = await puerta.llamar();
        expect(res.status).toBe(403);
        const texto = JSON.stringify(await res.json());
        // Y sobre todo: que no se escape el secreto en el cuerpo del error.
        expect(texto).not.toContain("EL.TOKEN.FIRMADO");
        // El mensaje no dice qué rol hace falta: a quien sondea no se le da un mapa.
        expect(texto).not.toContain("owner\"");
      });
    }
    for (const r of puerta.abren) {
      it(`${r} pasa`, async () => {
        rol = r;
        const res = await puerta.llamar();
        expect(res.status).not.toBe(403);
      });
    }
  });
}

describe("la vía de MÁQUINA no lleva rol", () => {
  it("una bvk_ sigue descargando la licencia: un rol es de personas, no de máquinas", async () => {
    // Es la comprobación que impide que esta fase apague la flota de un cliente.
    // El SDK se autentica con la clave de servicio, que no pertenece a ninguna
    // persona ni tiene rol: si el chequeo se hubiera puesto antes de bifurcar,
    // TODAS las máquinas en producción habrían dejado de renovar la licencia.
    rol = "member";
    const { GET } = await import("./license/current/route");
    const res = await GET(
      new Request("https://savings.bivelio.com/api/license/current", {
        headers: { authorization: "Bearer bvk_loquesea" },
      }),
    );
    expect(res.status).not.toBe(403);
  });
});
