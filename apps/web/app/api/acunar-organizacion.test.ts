import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * LOS DOS CAMINOS QUE ACUÑAN ORGANIZACIONES (fase 5).
 *
 * Son los dos únicos sitios, fuera de Stripe, donde nace una organización: pedir
 * una clave de servicio `bvk_` y emitir una licencia interna. Los dos hacían
 * `upsert({ id: user.id })`, y el `upsert` es la parte engañosa: parecía
 * idempotente, pero solo lo era mientras el id de la organización FUESE el del
 * usuario. En cuanto una organización nace con uuid propio —lo que ya hace el
 * checkout— no hay conflicto que absorber, así que el upsert deja de encontrar
 * nada y CREA UNA SEGUNDA organización, vacía.
 *
 * El daño no se ve el día que ocurre. La clave `bvk_` queda colgando de una
 * organización sin suscripción ni licencia; el ingest empieza a devolver 402 y la
 * flota del cliente se apaga fail-closed SEMANAS DESPUÉS, sin un error visible.
 *
 * Y en la licencia hay algo peor todavía: el `org_id` va FIRMADO dentro del token
 * y el SDK descarta en silencio cualquier renovación cuyo org no case
 * (`src/license/refresher.ts:155`). Firmar con el org equivocado no da un error:
 * da una licencia que deja de renovarse.
 */

const USUARIO = "11111111-1111-1111-1111-111111111111";
const ORG_REAL = "99999999-9999-4999-8999-999999999999";
const ORG_NUEVA = "abcdabcd-abcd-4bcd-8bcd-abcdabcdabcd";

interface Estado {
  pertenencias: { org_id: string; role: string; created_at: string; user_id: string }[];
  subs: { org_id: string; status: string }[];
  insertados: { tabla: string; fila: Record<string, unknown> }[];
  fallar?: string;
}
let e: Estado;

const consulta = (tabla: string) => {
  let filas: unknown[] =
    tabla === "org_members" ? e.pertenencias : tabla === "subscriptions" ? e.subs : [];
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

/** Se captura lo que se FIRMA, que es el dato que viaja al SDK del cliente. */
let firmado: Record<string, unknown> | null = null;
vi.mock("@/lib/license/sign", () => ({
  loadPrivateKey: () => "clave-de-mentira",
  signCompact: (_h: unknown, payload: Record<string, unknown>) => {
    firmado = payload;
    return "token.de.mentira";
  },
}));

const entorno = { ...process.env };
beforeEach(() => {
  e = { pertenencias: [], subs: [], insertados: [] };
  firmado = null;
  vi.resetModules();
});
afterEach(() => {
  process.env = { ...entorno };
});

const peticionClave = () =>
  new Request("https://savings.bivelio.com/api/service-accounts", {
    method: "POST",
    body: JSON.stringify({ label: "portatil" }),
    headers: { "content-type": "application/json" },
  });

describe("POST /api/service-accounts — la clave cuelga de la org RESUELTA", () => {
  it("con una organización de uuid propio, NO se crea una segunda", async () => {
    // El caso exacto que rompía: comprar por Stripe crea la org con uuid propio, y
    // el `upsert({id: user.id})` de después no encontraba conflicto.
    e.pertenencias = [{ org_id: ORG_REAL, role: "owner", created_at: "2026-01-01", user_id: USUARIO }];
    const { POST } = await import("./service-accounts/route");
    const res = await POST(peticionClave());
    expect(res.status).toBe(201);

    expect(e.insertados.filter((i) => i.tabla === "organizations")).toHaveLength(0);
    const clave = e.insertados.find((i) => i.tabla === "service_accounts");
    expect(clave!.fila.org_id).toBe(ORG_REAL);
    expect(clave!.fila.org_id).not.toBe(USUARIO);
  });

  it("sin organización se crea una, y su id NO es el del usuario", async () => {
    const { POST } = await import("./service-accounts/route");
    const res = await POST(peticionClave());
    expect(res.status).toBe(201);

    const org = e.insertados.find((i) => i.tabla === "organizations");
    expect(org!.fila).not.toHaveProperty("id"); // lo pone gen_random_uuid()
    const clave = e.insertados.find((i) => i.tabla === "service_accounts");
    expect(clave!.fila.org_id).toBe(ORG_NUEVA);
  });

  it("⛔ si la organización no se puede resolver, NO se acuña clave: 503", async () => {
    // Falla CERRADA. Devolver una `bvk_` colgada de una organización adivinada es
    // peor que no darla: el cliente se la lleva a producción y muere en semanas.
    e.fallar = "organizations";
    const { POST } = await import("./service-accounts/route");
    const res = await POST(peticionClave());
    expect(res.status).toBe(503);
    expect(e.insertados.filter((i) => i.tabla === "service_accounts")).toHaveLength(0);
  });

  it("el secreto se devuelve una vez y solo se guarda su hash", async () => {
    const { POST } = await import("./service-accounts/route");
    const res = await POST(peticionClave());
    const cuerpo = (await res.json()) as { key: string };
    const clave = e.insertados.find((i) => i.tabla === "service_accounts")!;
    expect(cuerpo.key).toMatch(/^bvk_/);
    expect(JSON.stringify(clave.fila)).not.toContain(cuerpo.key);
  });
});

describe("POST /api/license/trial — el org_id FIRMADO es el resuelto", () => {
  beforeEach(() => {
    process.env.LICENSE_ISSUER_EMAILS = "yo@example.com";
  });

  it("⛔ se firma la organización real, no el user id", async () => {
    // La regresión silenciosa: firmar con `user.id` no da error en ninguna parte.
    // Da una licencia que el refrescador del SDK descarta al renovar, meses después.
    e.pertenencias = [{ org_id: ORG_REAL, role: "owner", created_at: "2026-01-01", user_id: USUARIO }];
    const { POST } = await import("./license/trial/route");
    const res = await POST();
    expect(res.status).toBe(200);

    expect(firmado!.org_id).toBe(ORG_REAL);
    expect(firmado!.org_id).not.toBe(USUARIO);
  });

  it("lo firmado y lo persistido son la MISMA organización", async () => {
    // Si divergen, la licencia existe pero es irrevocable por organización: el
    // panel del cliente no la ve y `/api/license/revoke` no la encuentra.
    e.pertenencias = [{ org_id: ORG_REAL, role: "owner", created_at: "2026-01-01", user_id: USUARIO }];
    const { POST } = await import("./license/trial/route");
    await POST();
    const lic = e.insertados.find((i) => i.tabla === "licenses");
    expect(lic!.fila.org_id).toBe(firmado!.org_id);
    expect(lic!.fila.id).toBe(firmado!.jti); // el invariante id == jti
  });

  it("⛔ si la organización no se resuelve, NO se firma nada", async () => {
    // El orden es la mitad del arreglo: antes se firmaba PRIMERO y se creaba la
    // organización después, así que el org_id se decidía sin saber cuál era.
    e.fallar = "organizations";
    const { POST } = await import("./license/trial/route");
    const res = await POST();
    expect(res.status).toBe(503);
    expect(firmado).toBeNull();
    expect(e.insertados.filter((i) => i.tabla === "licenses")).toHaveLength(0);
  });

  it("quien no está en la allow-list no emite, y sin pertenencias se le dice que espere", async () => {
    // El hueco entre pagar y que el webhook escriba la organización. Decirle «no
    // tienes suscripción» a quien acaba de pagar le invita a pagar dos veces.
    process.env.LICENSE_ISSUER_EMAILS = "otro@example.com";
    const { POST } = await import("./license/trial/route");
    const res = await POST();
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ code: "pago_en_curso" });
    expect(e.insertados).toHaveLength(0); // ni siquiera se acuña organización
  });

  it("con organización y sin suscripción sí se dice que no hay suscripción", async () => {
    process.env.LICENSE_ISSUER_EMAILS = "otro@example.com";
    e.pertenencias = [{ org_id: ORG_REAL, role: "owner", created_at: "2026-01-01", user_id: USUARIO }];
    const { POST } = await import("./license/trial/route");
    const res = await POST();
    expect(await res.json()).toEqual({ code: "sin_suscripcion" });
  });
});
