import { describe, it, expect, vi, beforeEach } from "vitest";

import { resolverOrgSiExiste, resolverOrgDelUsuario, orgParaElPanel } from "./resolver";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * El resolvedor de organización. Los dos errores posibles son caros y opuestos:
 * devolver la organización EQUIVOCADA (y entregar la licencia firmada de otro
 * cliente, o cobrarle a quien no toca) y devolver `null` o inventarse una cuando
 * sí había una (que acuña organizaciones fantasma: la clave `bvk_` queda atada a
 * una org vacía y la flota del cliente se apaga semanas después).
 *
 * El doble REGISTRA los filtros y las inserciones, para que quitar un `.eq()` o
 * colar un `id: user.id` haga fallar un test. Un doble que hiciera no-op de `eq`
 * no probaría nada — es el fallo que ya se coló una vez en este repositorio.
 */

const USUARIO = "11111111-1111-1111-1111-111111111111";

interface Estado {
  miembros: { org_id: string; role: string; created_at: string; user_id: string }[];
  subs: { org_id: string; status: string }[];
  insertados: { tabla: string; fila: Record<string, unknown> }[];
  filtros: [string, string, unknown][];
  fallar?: string;
}

function dobleAdmin(e: Estado): AdminClient {
  const consulta = (tabla: string) => {
    let filas: unknown[] =
      tabla === "org_members" ? e.miembros : tabla === "subscriptions" ? e.subs : [];
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (col: string, val: unknown) => {
        e.filtros.push([tabla, col, val]);
        filas = (filas as Record<string, unknown>[]).filter((f) => f[col] === val);
        return q;
      },
      in: (col: string, vals: unknown[]) => {
        e.filtros.push([tabla, col, vals]);
        filas = (filas as Record<string, unknown>[]).filter((f) => vals.includes(f[col]));
        return q;
      },
      insert: (fila: Record<string, unknown>) => {
        if (e.fallar === tabla) return Object.assign(Promise.resolve({ data: null, error: { message: "boom" } }), q);
        e.insertados.push({ tabla, fila });
        const creada = { id: "org-nueva-uuid", ...fila };
        return Object.assign(Promise.resolve({ data: null, error: null }), {
          select: () => ({ single: async () => ({ data: creada, error: null }) }),
        });
      },
      then: (res: (v: { data: unknown; error: null }) => unknown) => res({ data: filas, error: null }),
    };
    return q;
  };
  return { from: (t: string) => consulta(t) } as unknown as AdminClient;
}

const base = (): Estado => ({ miembros: [], subs: [], insertados: [], filtros: [] });

describe("resolverOrgSiExiste", () => {
  it("sin pertenencias devuelve null — NO se inventa una organización", () => {
    const e = base();
    return expect(resolverOrgSiExiste(dobleAdmin(e), USUARIO)).resolves.toBeNull();
  });

  it("con una pertenencia devuelve esa, con su rol", async () => {
    const e = base();
    e.miembros = [{ org_id: "org-a", role: "owner", created_at: "2026-01-01", user_id: USUARIO }];
    await expect(resolverOrgSiExiste(dobleAdmin(e), USUARIO)).resolves.toEqual({
      orgId: "org-a",
      role: "owner",
    });
  });

  it("filtra SIEMPRE por el usuario de la sesión", async () => {
    const e = base();
    e.miembros = [{ org_id: "org-a", role: "owner", created_at: "2026-01-01", user_id: USUARIO }];
    await resolverOrgSiExiste(dobleAdmin(e), USUARIO);
    expect(e.filtros).toContainEqual(["org_members", "user_id", USUARIO]);
  });

  it("la organización heredada (org_id == user_id) sigue resolviéndose igual", async () => {
    // Es el caso de las 2 organizaciones vivas: este cambio tiene que ser un no-op.
    const e = base();
    e.miembros = [{ org_id: USUARIO, role: "owner", created_at: "2026-01-01", user_id: USUARIO }];
    await expect(resolverOrgSiExiste(dobleAdmin(e), USUARIO)).resolves.toEqual({
      orgId: USUARIO,
      role: "owner",
    });
  });

  describe("el desempate, que hoy es un sorteo", () => {
    it("1º gana la que tiene el dinero", async () => {
      const e = base();
      e.miembros = [
        { org_id: "org-vieja", role: "owner", created_at: "2020-01-01", user_id: USUARIO },
        { org_id: "org-que-paga", role: "member", created_at: "2026-01-01", user_id: USUARIO },
      ];
      e.subs = [{ org_id: "org-que-paga", status: "active" }];
      await expect(resolverOrgSiExiste(dobleAdmin(e), USUARIO)).resolves.toMatchObject({
        orgId: "org-que-paga",
      });
    });

    it("una suscripción CANCELADA no gana el desempate", async () => {
      const e = base();
      e.miembros = [
        { org_id: "org-vieja", role: "owner", created_at: "2020-01-01", user_id: USUARIO },
        { org_id: "org-cancelada", role: "owner", created_at: "2026-01-01", user_id: USUARIO },
      ];
      e.subs = [{ org_id: "org-cancelada", status: "canceled" }];
      await expect(resolverOrgSiExiste(dobleAdmin(e), USUARIO)).resolves.toMatchObject({
        orgId: "org-vieja", // la más antigua, porque ninguna paga
      });
    });

    it("2º, sin dinero de por medio, gana la heredada", async () => {
      const e = base();
      e.miembros = [
        { org_id: "org-otra", role: "member", created_at: "2020-01-01", user_id: USUARIO },
        { org_id: USUARIO, role: "owner", created_at: "2026-01-01", user_id: USUARIO },
      ];
      await expect(resolverOrgSiExiste(dobleAdmin(e), USUARIO)).resolves.toMatchObject({
        orgId: USUARIO,
      });
    });

    it("3º, la más antigua — y el resultado NO depende del orden de llegada", async () => {
      const e = base();
      e.miembros = [
        { org_id: "org-nueva", role: "member", created_at: "2026-05-01", user_id: USUARIO },
        { org_id: "org-antigua", role: "member", created_at: "2020-01-01", user_id: USUARIO },
      ];
      const primero = await resolverOrgSiExiste(dobleAdmin(e), USUARIO);
      e.miembros.reverse();
      const segundo = await resolverOrgSiExiste(dobleAdmin(e), USUARIO);
      expect(primero).toEqual(segundo);
      expect(primero).toMatchObject({ orgId: "org-antigua" });
    });
  });
});

describe("resolverOrgDelUsuario", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("si ya tiene organización, NO crea otra", async () => {
    const e = base();
    e.miembros = [{ org_id: "org-a", role: "owner", created_at: "2026-01-01", user_id: USUARIO }];
    await expect(resolverOrgDelUsuario(dobleAdmin(e), USUARIO)).resolves.toMatchObject({ orgId: "org-a" });
    expect(e.insertados).toHaveLength(0);
  });

  it("la organización nueva NO lleva el user id como id — ese era el defecto", async () => {
    const e = base();
    const r = await resolverOrgDelUsuario(dobleAdmin(e), USUARIO, "Acme");
    const org = e.insertados.find((i) => i.tabla === "organizations");
    expect(org).toBeTruthy();
    // El `id` no se pasa: lo pone `gen_random_uuid()`. El user id SOLO puede
    // aparecer como `owner_user_id` — que es un dato de la fila, no su identidad.
    expect(org!.fila).not.toHaveProperty("id");
    expect(r.orgId).not.toBe(USUARIO);
    const { owner_user_id, ...resto } = org!.fila as Record<string, unknown>;
    expect(owner_user_id).toBe(USUARIO);
    expect(JSON.stringify(resto)).not.toContain(USUARIO);
  });

  it("la organización nueva nace CON dueño", async () => {
    // Sin esto quedaría a null hasta que pasara el webhook, y con un adeudo SEPA
    // eso son días en los que nadie puede gestionar lo que se está cobrando.
    const e = base();
    await resolverOrgDelUsuario(dobleAdmin(e), USUARIO);
    expect(e.insertados.find((i) => i.tabla === "organizations")!.fila).toMatchObject({
      owner_user_id: USUARIO,
    });
  });

  it("la pertenencia se escribe con el USER id, no con el org id", async () => {
    // `webhook/route.ts:120` escribe hoy `user_id: orgId`. Con un org id aleatorio
    // eso revienta la clave ajena contra auth.users.
    const e = base();
    await resolverOrgDelUsuario(dobleAdmin(e), USUARIO);
    const mem = e.insertados.find((i) => i.tabla === "org_members");
    expect(mem!.fila).toMatchObject({ user_id: USUARIO, role: "owner" });
    expect(mem!.fila.org_id).not.toBe(USUARIO);
  });

  it("si la pertenencia falla, LANZA — no deja una organización huérfana en silencio", async () => {
    const e = base();
    e.fallar = "org_members";
    await expect(resolverOrgDelUsuario(dobleAdmin(e), USUARIO)).rejects.toBeTruthy();
  });

  it("sin userId lanza: nunca se resuelve una organización sin sesión", async () => {
    await expect(resolverOrgDelUsuario(dobleAdmin(base()), "")).rejects.toThrow();
  });
});

describe("orgParaElPanel", () => {
  it("devuelve la organización resuelta", () => {
    expect(orgParaElPanel({ orgId: "org-a", role: "owner" })).toBe("org-a");
  });

  it("⛔ sin organización devuelve null, JAMÁS el user id", () => {
    // El respaldo a `user.id` es la forma mas facil de reabrir el defecto por la
    // puerta de atras: un panel que "casi siempre funciona" y que a un miembro
    // invitado le enseña los datos de otra organizacion — o ninguno, en silencio.
    // Sin organizacion, el panel se pinta VACIO. Peor experiencia, respuesta
    // correcta: enseñar datos de quien no eres no es una alternativa.
    expect(orgParaElPanel(null)).toBeNull();
  });
});
