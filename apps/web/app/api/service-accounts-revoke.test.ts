import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * El AISLAMIENTO del DELETE de claves de servicio.
 *
 * `.eq("org_id", user.id)` es el ÚNICO control que impide que un cliente revoque
 * la clave de otro: el `id` lo elige quien llama. Sin ese filtro, un uuid ajeno
 * —que se puede obtener, o simplemente probar— desactivaría la credencial de
 * máquina de otra empresa, es decir: le tiraríamos la medición y la renovación
 * de licencia a un tercero desde una sesión cualquiera.
 *
 * Se prueba con un doble de supabase-js que REGISTRA los filtros aplicados, para
 * que quitar el `.eq("org_id", …)` haga fallar el test. Un doble que hiciera
 * no-op de `eq` no probaría nada — es exactamente el fallo que ya se coló una vez
 * en este repositorio.
 */

const filtros: Array<[string, string, unknown]> = [];
let filasBorradas: Array<{ id: string; key_prefix: string }> = [];
const insertados: unknown[] = [];
/** La pertenencia del usuario. El DELETE ya no se acota por `user.id` sino por la
 *  ORGANIZACIÓN resuelta a partir de ella. */
let pertenencias: Array<{ org_id: string; role: string; created_at: string }> = [];

const ORG = "99999999-9999-4999-8999-999999999999";

function constructorDeConsulta(tabla: string) {
  // El doble es "thenable" y encadenable a la vez: el resolvedor hace
  // `.select().eq()` y luego await, mientras el DELETE hace `.delete().eq().eq().select()`.
  const filasDe = () => (tabla === "org_members" ? pertenencias : filasBorradas);
  const q: Record<string, unknown> = {
    delete: () => q,
    select: () => q,
    order: () => q,
    in: () => q,
    eq: (col: string, val: unknown) => {
      filtros.push([tabla, col, val]);
      return q;
    },
    insert: (fila: unknown) => {
      insertados.push(fila);
      return Promise.resolve({ error: null });
    },
    then: (res: (v: { data: unknown; error: null }) => unknown) => res({ data: filasDe(), error: null }),
  };
  return q;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: (t: string) => constructorDeConsulta(t) }),
}));

const USUARIO = "11111111-1111-1111-1111-111111111111";
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: USUARIO, email: "yo@example.com" } } }) },
  }),
}));

const peticion = (cuerpo: unknown) =>
  new Request("https://savings.bivelio.com/api/service-accounts", {
    method: "DELETE",
    body: JSON.stringify(cuerpo),
    headers: { "content-type": "application/json" },
  });

describe("DELETE /api/service-accounts — no se puede revocar la clave de otro", () => {
  beforeEach(() => {
    filtros.length = 0;
    insertados.length = 0;
    filasBorradas = [{ id: "clave-1", key_prefix: "bvk_abcd1234" }];
    // El usuario pertenece a una organización cuyo id NO es el suyo: es el caso
    // que este cambio habilita, y el que antes rompía todo.
    pertenencias = [{ org_id: ORG, role: "owner", created_at: "2026-01-01" }];
  });

  it("el borrado se acota SIEMPRE por la org de la sesión", async () => {
    const { DELETE } = await import("./service-accounts/route");
    const res = await DELETE(peticion({ id: "clave-1" }));
    expect(res.status).toBe(200);

    // Los dos filtros tienen que estar: el id que pide el cliente Y la org que
    // sale de la sesión. Quitar el segundo es la fuga.
    expect(filtros).toContainEqual(["service_accounts", "id", "clave-1"]);
    // El filtro lleva la ORGANIZACIÓN resuelta, no el user id.
    expect(filtros).toContainEqual(["service_accounts", "org_id", ORG]);
    expect(filtros).not.toContainEqual(["service_accounts", "org_id", USUARIO]);
  });

  it("la org del filtro NO puede venir del cuerpo de la petición", async () => {
    const { DELETE } = await import("./service-accounts/route");
    await DELETE(peticion({ id: "clave-1", org_id: "22222222-2222-2222-2222-222222222222" }));
    const orgs = filtros.filter(([t, c]) => t === "service_accounts" && c === "org_id").map(([, , v]) => v);
    expect(orgs).toEqual([ORG]);
  });

  it("un id que no es de esta org devuelve 404, no un 200 vacío", async () => {
    // Un 200 sin filas le haría creer al cliente que la clave está muerta cuando
    // sigue viva. Y un 404 tampoco confirma que ese id exista en otra parte.
    filasBorradas = [];
    const { DELETE } = await import("./service-accounts/route");
    const res = await DELETE(peticion({ id: "clave-de-otro" }));
    expect(res.status).toBe(404);
  });

  it("sin id no se borra nada", async () => {
    const { DELETE } = await import("./service-accounts/route");
    const res = await DELETE(peticion({}));
    expect(res.status).toBe(400);
    expect(filtros.filter(([t]) => t === "service_accounts")).toHaveLength(0);
  });

  it("sin organización NO se borra por id a secas: 404", async () => {
    // Es la regresión más peligrosa posible de esta fase: si al no resolver la
    // organización se dejara caer el `.eq("org_id", …)`, un id ajeno borraría la
    // clave de otro cliente.
    pertenencias = [];
    const { DELETE } = await import("./service-accounts/route");
    const res = await DELETE(peticion({ id: "clave-1" }));
    expect(res.status).toBe(404);
    expect(filtros.filter(([t]) => t === "service_accounts")).toHaveLength(0);
  });

  it("una revocación con éxito deja rastro en el libro de facturación", async () => {
    const { DELETE } = await import("./service-accounts/route");
    await DELETE(peticion({ id: "clave-1" }));
    expect(insertados).toHaveLength(1);
    expect(insertados[0]).toMatchObject({ org_id: ORG, kind: "service_account_revoked" });
  });
});
