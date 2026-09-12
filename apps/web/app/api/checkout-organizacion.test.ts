import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * EL CHECKOUT ACUÑA LA ORGANIZACIÓN (fase 6). El punto de no retorno.
 *
 * A partir de aquí una compra crea una organización con uuid PROPIO, y el id que
 * viaja a Stripe en la metadata es el que el webhook usará para casar el cobro
 * durante toda la vida de esa suscripción. Dos cosas tienen que ser ciertas y las
 * dos fallan en silencio:
 *
 *  · `org_id` y `user_id` son DATOS DISTINTOS. Escribir el org id donde va el user
 *    id revienta la clave ajena contra `auth.users` en `ensureOrg`; el webhook
 *    devuelve 503, Stripe reintenta 72 h y se rinde. El cliente se queda pagando
 *    sin licencia, para siempre, y en el panel de Stripe todo está en verde.
 *
 *  · La organización se resuelve ANTES de la guardia anti-doble-cobro. La guardia
 *    pregunta «¿esta ORGANIZACIÓN ya paga?»: con el id equivocado no protege de
 *    nada, y lo que deja pasar es un SEGUNDO cobro real.
 */

const USUARIO = "11111111-1111-1111-1111-111111111111";
const ORG_REAL = "99999999-9999-4999-8999-999999999999";
const ORG_NUEVA = "abcdabcd-abcd-4bcd-8bcd-abcdabcdabcd";

interface Estado {
  pertenencias: { org_id: string; role: string; created_at: string; user_id: string }[];
  subs: { org_id: string; status: string; id: string; stripe_subscription_id?: string }[];
  orgs: { id: string; stripe_customer_id: string | null }[];
  insertados: { tabla: string; fila: Record<string, unknown> }[];
  /** Lo que STRIPE sabe, que no es lo mismo que lo que sabe nuestra tabla. */
  stripeClientes: { id: string; email: string }[];
  stripeSubs: {
    id: string;
    customer: string;
    status: string;
    metadata?: Record<string, string>;
    items?: { data: { price: { id: string } }[] };
  }[];
  fallar?: string;
}
/** Alertas emitidas (mock de `alertar`). */
let alertas: { nivel: string; asunto: string }[] = [];
let e: Estado;
/** Lo que se le manda a Stripe. Es el contrato con el webhook. */
let sesion: Record<string, unknown> | null = null;

const consulta = (tabla: string) => {
  let filas: unknown[] =
    tabla === "org_members" ? e.pertenencias
    : tabla === "subscriptions" ? e.subs
    : tabla === "organizations" ? e.orgs
    : [];
  const q: Record<string, unknown> = {
    select: () => q,
    order: () => q,
    limit: () => q,
    eq: (col: string, val: unknown) => {
      filas = (filas as Record<string, unknown>[]).filter((f) => f[col] === val);
      return q;
    },
    in: (col: string, vals: unknown[]) => {
      filas = (filas as Record<string, unknown>[]).filter((f) => vals.includes(f[col]));
      return q;
    },
    maybeSingle: async () => ({ data: (filas as unknown[])[0] ?? null, error: null }),
    insert: (fila: Record<string, unknown>) => {
      if (e.fallar === tabla) {
        return Object.assign(Promise.resolve({ data: null, error: { message: "boom" } }), {
          select: () => ({ single: async () => ({ data: null, error: { message: "boom" } }) }),
        });
      }
      e.insertados.push({ tabla, fila });
      return Object.assign(Promise.resolve({ data: null, error: null }), {
        select: () => ({ single: async () => ({ data: { id: ORG_NUEVA, ...fila }, error: null }) }),
      });
    },
    then: (res: (v: { data: unknown; error: null }) => unknown) => res({ data: filas, error: null }),
  };
  return q;
};

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: consulta }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: USUARIO, email: "yo@example.com" } } }) },
  }),
}));
vi.mock("@/lib/stripe/env", () => ({
  billingFullyConfigured: true,
  priceIdFor: () => "price_mensual",
}));
vi.mock("@/lib/stripe/client", () => ({
  getStripe: () => ({
    checkout: {
      sessions: {
        create: async (args: Record<string, unknown>) => {
          sesion = args;
          return { url: "https://checkout.stripe.com/x" };
        },
      },
    },
    promotionCodes: {
      list: async ({ code, active }: { code: string; active?: boolean }) => ({
        data: code === "PROBADORES-SEPT" && active !== false ? [{ id: "promo_probadores", code, active: true }] : [],
      }),
    },
    customers: {
      list: async ({ email }: { email: string }) => {
        if (e.fallar === "stripe") throw new Error("stripe caído");
        return { data: e.stripeClientes.filter((c) => c.email === email) };
      },
    },
    subscriptions: {
      list: async ({ customer }: { customer: string }) => {
        if (e.fallar === "stripe") throw new Error("stripe caído");
        if (customer === "cus_fantasma") throw Object.assign(new Error("No such customer"), { code: "resource_missing" });
        // Como en Stripe: sin `items` declarados, la suscripción es de nuestro precio.
        return {
          data: e.stripeSubs
            .filter((s) => s.customer === customer)
            .map((s) => ({ metadata: {}, items: { data: [{ price: { id: "price_mensual" } }] }, ...s })),
        };
      },
    },
  }),
}));
vi.mock("@/lib/observabilidad/alerta", () => ({
  alertar: async (a: { nivel: string; asunto: string }) => {
    alertas.push(a);
  },
}));

beforeEach(() => {
  e = { pertenencias: [], subs: [], orgs: [], insertados: [], stripeClientes: [], stripeSubs: [] };
  sesion = null;
  alertas = [];
  vi.resetModules();
});

const peticion = (cuerpo: unknown = { seats: 3 }) =>
  new Request("https://savings.bivelio.com/api/stripe/checkout", {
    method: "POST",
    body: JSON.stringify(cuerpo),
    headers: { "content-type": "application/json" },
  });

describe("POST /api/stripe/checkout — la organización se acuña aquí", () => {
  it("⛔ org_id y user_id son distintos, y cada uno en su sitio", async () => {
    // El fallo que esto cierra no da error en el checkout: lo da el WEBHOOK, horas
    // después, como violación de clave ajena, y acaba con el cliente pagando sin
    // licencia porque Stripe se rinde a las 72 h.
    const { POST } = await import("./stripe/checkout/route");
    const res = await POST(peticion());
    expect(res.status).toBe(200);

    const meta = sesion!.metadata as Record<string, string>;
    expect(meta.org_id).toBe(ORG_NUEVA);
    expect(meta.user_id).toBe(USUARIO);
    expect(meta.org_id).not.toBe(meta.user_id);

    // Y lo mismo en la SUSCRIPCIÓN: es de donde salen los eventos de renovación,
    // que llegan durante años y no traen la sesión de checkout.
    const metaSub = (sesion!.subscription_data as { metadata: Record<string, string> }).metadata;
    expect(metaSub.org_id).toBe(ORG_NUEVA);
    expect(metaSub.user_id).toBe(USUARIO);
  });

  it("client_reference_id sigue siendo el USUARIO — es el respaldo del webhook", async () => {
    // `webhook:281` lo usa cuando falta `metadata.user_id`, y eso cubre las sesiones
    // creadas con el código viejo que sigan en vuelo: un adeudo SEPA tarda días.
    const { POST } = await import("./stripe/checkout/route");
    await POST(peticion());
    expect(sesion!.client_reference_id).toBe(USUARIO);
  });

  it("con organización ya existente se reutiliza, no se acuña otra", async () => {
    e.pertenencias = [{ org_id: ORG_REAL, role: "owner", created_at: "2026-01-01", user_id: USUARIO }];
    const { POST } = await import("./stripe/checkout/route");
    await POST(peticion());
    expect(e.insertados.filter((i) => i.tabla === "organizations")).toHaveLength(0);
    expect((sesion!.metadata as Record<string, string>).org_id).toBe(ORG_REAL);
  });

  it("⛔ la guardia anti-doble-cobro mira la ORGANIZACIÓN resuelta", async () => {
    // Si mirase `user.id` no encontraría la suscripción de una organización con
    // uuid propio, y dejaría abrir una SEGUNDA de verdad. Con dinero real.
    e.pertenencias = [{ org_id: ORG_REAL, role: "owner", created_at: "2026-01-01", user_id: USUARIO }];
    e.subs = [{ id: "sub_1", org_id: ORG_REAL, status: "active" }];
    const { POST } = await import("./stripe/checkout/route");
    const res = await POST(peticion());
    expect(res.status).toBe(409);
    expect(sesion).toBeNull(); // no se ha llegado a abrir nada en Stripe
  });

  it("un adeudo SEPA en vuelo sigue bloqueando, con su mensaje propio", async () => {
    e.pertenencias = [{ org_id: ORG_REAL, role: "owner", created_at: "2026-01-01", user_id: USUARIO }];
    e.subs = [{ id: "sub_1", org_id: ORG_REAL, status: "incomplete" }];
    const { POST } = await import("./stripe/checkout/route");
    const res = await POST(peticion());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("still being processed");
  });

  it("⛔ si la organización no se puede resolver, NO se abre checkout", async () => {
    // Falla CERRADA. Mandar a alguien a pagar sin saber a qué organización se le
    // imputa el cobro produce exactamente el caso irreparable: dinero cobrado que
    // no se puede casar con nadie.
    e.fallar = "organizations";
    const { POST } = await import("./stripe/checkout/route");
    const res = await POST(peticion());
    expect(res.status).toBe(503);
    expect(sesion).toBeNull();
  });

  it("el cliente de Stripe se busca por la ORGANIZACIÓN, para no duplicarlo", async () => {
    e.pertenencias = [{ org_id: ORG_REAL, role: "owner", created_at: "2026-01-01", user_id: USUARIO }];
    e.orgs = [{ id: ORG_REAL, stripe_customer_id: "cus_viejo" }];
    const { POST } = await import("./stripe/checkout/route");
    await POST(peticion());
    expect(sesion!.customer).toBe("cus_viejo");
    expect(sesion!.customer_email).toBeUndefined();
  });
});

describe("la factura tiene que servirle al contable del cliente", () => {
  it("⛔ se piden dirección fiscal y NIF-IVA", async () => {
    // Sin esto, Stripe emite una factura sin dirección ni NIF del comprador: en
    // España y en media Europa eso NO es deducible, así que el primer cliente
    // tiene que escribirnos para pedir una factura correcta. Es la diferencia
    // entre "esto lo pasamos a gastos" y "esto no me sirve".
    const { POST } = await import("./stripe/checkout/route");
    await POST(peticion());
    expect(sesion!.billing_address_collection).toBe("required");
    expect(sesion!.tax_id_collection).toEqual({ enabled: true });
  });

  it("⛔ con un cliente de Stripe YA existente, los datos se GUARDAN", async () => {
    // La trampa: sin `customer_update`, Stripe pide la dirección, la enseña en la
    // pantalla de pago… y no la escribe en el cliente existente. La primera
    // factura sale bien y la SEGUNDA vuelve a salir sin dirección, sin que nadie
    // entienda por qué.
    e.pertenencias = [{ org_id: ORG_REAL, role: "owner", created_at: "2026-01-01", user_id: USUARIO }];
    e.orgs = [{ id: ORG_REAL, stripe_customer_id: "cus_viejo" }];
    const { POST } = await import("./stripe/checkout/route");
    await POST(peticion());
    expect(sesion!.customer).toBe("cus_viejo");
    expect(sesion!.customer_update).toEqual({ address: "auto", name: "auto" });
  });

  it("no se pide tarjeta cuando no hay nada que cobrar: un probador con código del 100 % entra sin tarjeta", async () => {
    const { POST } = await import("./stripe/checkout/route");
    await POST(peticion());
    expect(sesion!.payment_method_collection).toBe("if_required");
    expect(sesion!.allow_promotion_codes).toBe(true);
  });

  it("con cliente NUEVO no se manda customer_update (Stripe lo rechaza)", async () => {
    // `customer_update` solo es válido junto a `customer`. Mandarlo con
    // `customer_email` es un 400 de Stripe: checkout roto para todo cliente nuevo,
    // que es exactamente el peor sitio donde tener un fallo.
    const { POST } = await import("./stripe/checkout/route");
    await POST(peticion());
    expect(sesion!.customer).toBeUndefined();
    expect(sesion!.customer_update).toBeUndefined();
  });
});

describe("la guardia contra el webhook muerto: se le pregunta también a Stripe", () => {
  // La cadena de cobro no se ha ejercitado nunca en producción. Si el webhook
  // no aterriza, nuestra tabla `subscriptions` está vacía, el panel dice «Sin
  // plan activo», y el comprador —que ya pagó— tiene los botones delante.
  const CLIENTE = { id: "cus_stripe", email: "yo@example.com" };

  it("⛔ Stripe tiene una suscripción activa para ese correo y la tabla no: 409, sin sesión nueva, y alerta crítica", async () => {
    e.stripeClientes = [CLIENTE];
    e.stripeSubs = [{ id: "sub_viva", customer: CLIENTE.id, status: "active" }];
    const { POST } = await import("./stripe/checkout/route");
    const res = await POST(peticion());
    expect(res.status).toBe(409);
    const cuerpo = (await res.json()) as { error: string };
    expect(cuerpo.error).toMatch(/support@bivelio\.com/);
    expect(cuerpo.error).toMatch(/don't buy again/i);
    expect(sesion).toBeNull();
    expect(alertas).toHaveLength(1);
    expect(alertas[0].nivel).toBe("critico");
  });

  it("un adeudo en vuelo (incomplete) en Stripe bloquea igual", async () => {
    e.stripeClientes = [CLIENTE];
    e.stripeSubs = [{ id: "sub_sepa", customer: CLIENTE.id, status: "incomplete" }];
    const { POST } = await import("./stripe/checkout/route");
    expect((await POST(peticion())).status).toBe(409);
    expect(sesion).toBeNull();
  });

  it("una suscripción cancelada en Stripe NO bloquea: el cliente puede volver", async () => {
    e.stripeClientes = [CLIENTE];
    e.stripeSubs = [{ id: "sub_vieja", customer: CLIENTE.id, status: "canceled" }];
    const { POST } = await import("./stripe/checkout/route");
    expect((await POST(peticion())).status).toBe(200);
    expect(sesion).not.toBeNull();
    expect(alertas).toHaveLength(0);
  });

  it("también se mira el cliente que tenemos apuntado en la organización, no solo el correo", async () => {
    e.pertenencias = [{ org_id: ORG_REAL, role: "owner", created_at: "2026-01-01", user_id: USUARIO }];
    e.orgs = [{ id: ORG_REAL, stripe_customer_id: "cus_viejo" }];
    e.stripeSubs = [{ id: "sub_viva", customer: "cus_viejo", status: "trialing" }];
    const { POST } = await import("./stripe/checkout/route");
    expect((await POST(peticion())).status).toBe(409);
    expect(sesion).toBeNull();
  });

  it("⛔ si Stripe no contesta, NO se abre checkout (falla cerrada, 503)", async () => {
    e.fallar = "stripe";
    const { POST } = await import("./stripe/checkout/route");
    expect((await POST(peticion())).status).toBe(503);
    expect(sesion).toBeNull();
  });

  it("sin nada en Stripe, el checkout se abre como siempre", async () => {
    const { POST } = await import("./stripe/checkout/route");
    expect((await POST(peticion())).status).toBe(200);
    expect(sesion).not.toBeNull();
  });

  it("una suscripción viva de OTRO producto (otro precio, sin org_id) no bloquea ni alerta", async () => {
    e.stripeClientes = [CLIENTE];
    e.stripeSubs = [{ id: "sub_otro", customer: CLIENTE.id, status: "active", items: { data: [{ price: { id: "price_de_otro_producto" } }] } }];
    const { POST } = await import("./stripe/checkout/route");
    expect((await POST(peticion())).status).toBe(200);
    expect(alertas).toHaveLength(0);
  });

  it("si nuestra tabla YA conoce esa suscripción (bajo otra organización), es «ya suscrito», sin alerta crítica", async () => {
    e.stripeClientes = [CLIENTE];
    e.stripeSubs = [{ id: "sub_conocida", customer: CLIENTE.id, status: "active" }];
    e.subs = [{ org_id: "otra-org", status: "active", id: "fila-1", stripe_subscription_id: "sub_conocida" }];
    const { POST } = await import("./stripe/checkout/route");
    const res = await POST(peticion());
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("ya_suscrito");
    expect(alertas).toHaveLength(0);
  });

  it("un cliente apuntado que Stripe ya no conoce (resource_missing) se salta y se sigue por el correo", async () => {
    e.pertenencias = [{ org_id: ORG_REAL, role: "owner", created_at: "2026-01-01", user_id: USUARIO }];
    e.orgs = [{ id: ORG_REAL, stripe_customer_id: "cus_fantasma" }];
    const { POST } = await import("./stripe/checkout/route");
    expect((await POST(peticion())).status).toBe(200);
  });

  it("los 409 llevan un `code` que el panel traduce", async () => {
    e.stripeClientes = [CLIENTE];
    e.stripeSubs = [{ id: "sub_sepa", customer: CLIENTE.id, status: "incomplete" }];
    const { POST } = await import("./stripe/checkout/route");
    const res = await POST(peticion());
    expect(((await res.json()) as { code: string }).code).toBe("pago_en_curso");
  });

});

describe("el enlace de los probadores: código PRE-APLICADO en la sesión", () => {
  it("con `codigo` válido la sesión lleva el descuento y NO `allow_promotion_codes` (son excluyentes)", async () => {
    const { POST } = await import("./stripe/checkout/route");
    const res = await POST(peticion({ seats: 1, codigo: "probadores-sept" }));
    expect(res.status).toBe(200);
    expect(sesion!.discounts).toEqual([{ promotion_code: "promo_probadores" }]);
    expect(sesion!.allow_promotion_codes).toBeUndefined();
    expect(sesion!.payment_method_collection).toBe("if_required");
  });

  it("un código que no existe o está apagado es un 400 con `code: codigo_invalido`, sin sesión", async () => {
    const { POST } = await import("./stripe/checkout/route");
    const res = await POST(peticion({ seats: 1, codigo: "NO-EXISTE" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("codigo_invalido");
    expect(sesion).toBeNull();
  });

  it("un `codigo` con forma rara se ignora en vez de mandarse a Stripe", async () => {
    const { POST } = await import("./stripe/checkout/route");
    const res = await POST(peticion({ seats: 1, codigo: "<script>alert(1)</script>" }));
    expect(res.status).toBe(200);
    expect(sesion!.allow_promotion_codes).toBe(true);
    expect(sesion!.discounts).toBeUndefined();
  });

  it("sin `codigo`, todo sigue igual: el cliente puede teclear uno en Stripe", async () => {
    const { POST } = await import("./stripe/checkout/route");
    await POST(peticion());
    expect(sesion!.allow_promotion_codes).toBe(true);
    expect(sesion!.discounts).toBeUndefined();
  });
});
