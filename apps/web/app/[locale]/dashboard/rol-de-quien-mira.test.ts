import { describe, it, expect } from "vitest";

import { getOrgContext } from "./data";

/**
 * EL PANEL ENSEÑA EL ROL DE QUIEN MIRA, NO EL DE OTRO.
 *
 * POR QUÉ EXISTE. La consulta filtraba por `org_id` y NADA MÁS, con `limit(1)` y
 * sin `order`: Postgres devolvía una fila arbitraria de la organización. Con un
 * solo miembro no se notaba nunca — y así estuvo hasta que hubo dos. Al primer
 * invitado real, un `member`, el panel le dijo **owner**.
 *
 * No era escalada de privilegios: el servidor decide con `lib/org/permisos` y su
 * propia resolución, así que ella seguía sin poder invitar ni descargar la
 * licencia. Pero era una mentira en pantalla, y se habría convertido en escalada
 * el día que alguien enseñara u ocultara un control mirando `ctx.role`.
 *
 * El doble APLICA los filtros: quitar el `.eq("user_id", …)` tiene que romper un
 * test, no pasar desapercibido.
 */

const ORG = "99999999-9999-4999-8999-999999999999";
const DUENO = "11111111-1111-4111-8111-111111111111";
const MIEMBRO = "22222222-2222-4222-8222-222222222222";

const FILAS = [
  // El dueño primero, que es como salía de la base y por eso ganaba siempre.
  { org_id: ORG, user_id: DUENO, role: "owner", organizations: { name: "TEAM TESTING1", plan: "pro" } },
  { org_id: ORG, user_id: MIEMBRO, role: "member", organizations: { name: "TEAM TESTING1", plan: "pro" } },
];

/** Doble mínimo de supabase-js que aplica de verdad los `.eq()`. */
function doble() {
  const consulta = (tabla: string) => {
    let filas: Record<string, unknown>[] = tabla === "org_members" ? [...FILAS] : [];
    const q: Record<string, unknown> = {
      select: () => q,
      order: () => q,
      limit: () => q,
      in: () => q,
      eq: (col: string, val: unknown) => {
        filas = filas.filter((f) => f[col] === val);
        return q;
      },
      maybeSingle: async () => ({ data: filas[0] ?? null, error: null }),
      then: (res: (v: { data: unknown; error: null }) => unknown) => res({ data: filas, error: null }),
    };
    return q;
  };
  return { schema: () => ({ from: consulta }), from: consulta } as never;
}

describe("getOrgContext", () => {
  it("⛔ a un MIEMBRO le dice member, no owner", async () => {
    // El caso exacto que se vio en producción con el primer invitado real.
    const ctx = await getOrgContext(doble(), ORG, MIEMBRO);
    expect(ctx.role).toBe("member");
    expect(ctx.org?.name).toBe("TEAM TESTING1");
  });

  it("al dueño le dice owner", async () => {
    const ctx = await getOrgContext(doble(), ORG, DUENO);
    expect(ctx.role).toBe("owner");
  });

  it("a quien NO pertenece no le da contexto", async () => {
    // Defensa en profundidad: la RLS ya lo impide, pero el filtro explícito no
    // depende de que la política esté bien puesta.
    const ctx = await getOrgContext(doble(), ORG, "33333333-3333-4333-8333-333333333333");
    expect(ctx.role).toBeNull();
    expect(ctx.org).toBeNull();
  });

  it("el resultado NO depende del orden en que vengan las filas", async () => {
    // Es la raíz del fallo: `limit(1)` sin `order` sobre un filtro que casaba con
    // varias filas. Con el filtro correcto solo casa una, y el orden da igual.
    FILAS.reverse();
    const ctx = await getOrgContext(doble(), ORG, MIEMBRO);
    FILAS.reverse();
    expect(ctx.role).toBe("member");
  });
});
