import { describe, it, expect, vi, beforeEach } from "vitest";

import { hashDeToken } from "@/lib/org/invitaciones";

/**
 * EL EQUIPO: invitar, aceptar, cambiar roles, expulsar y transferir (fase 8).
 *
 * Aquí viven las dos cosas que este producto no se puede permitir:
 *
 *  1. Que entre en la organización de un cliente alguien que no debe. El enlace de
 *     invitación ES una credencial: quien lo tenga y no sea el destinatario no
 *     puede pasar, por muy válido que sea el token.
 *
 *  2. Que una organización se quede SIN DUEÑO. Sin dueño nadie puede cambiar la
 *     tarjeta ni cancelar, y la suscripción sigue cobrando todos los meses. Por eso
 *     al dueño no se le degrada ni se le expulsa: primero se transfiere.
 */

const YO = "11111111-1111-1111-1111-111111111111";
const OTRO = "22222222-2222-2222-2222-222222222222";
const ORG = "99999999-9999-4999-8999-999999999999";
const ORG_AJENA = "88888888-8888-4888-8888-888888888888";

interface Fila {
  org_id: string;
  user_id: string;
  role: string;
  created_at: string;
}
interface Inv {
  id: string;
  org_id: string;
  email: string;
  role: string;
  token_hash: string;
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
}

interface Estado {
  sinSesion?: boolean;
  miRol: string;
  miCorreo: string | null;
  miembros: Fila[];
  invitaciones: Inv[];
  orgs: { id: string; name: string }[];
  escrituras: { tabla: string; op: string; fila?: unknown; filtros: [string, unknown][] }[];
  rpc: { nombre: string; args: unknown }[];
  errorRpc?: { code?: string; message?: string };
}
let e: Estado;
/** Lo que se le pasa a Resend. `null` = no se mandó nada. */
let correo: { datos: Record<string, unknown>; destinatario: string } | null = null;
let correoFalla = false;

const TOKEN = "bvi_token_de_prueba";

function tablaDe(nombre: string): Record<string, unknown>[] {
  if (nombre === "org_members") return e.miembros as unknown as Record<string, unknown>[];
  if (nombre === "org_invitations") return e.invitaciones as unknown as Record<string, unknown>[];
  if (nombre === "organizations") return e.orgs as unknown as Record<string, unknown>[];
  return [];
}

/** Doble que APLICA los filtros de verdad: quitar un `.eq("org_id", …)` tiene que
 *  romper un test, no pasar desapercibido. */
const consulta = (nombre: string) => {
  const filtros: [string, unknown][] = [];
  let nulos: string[] = [];
  let op = "select";
  let payload: unknown;
  /** Las columnas pedidas. El doble PROYECTA de verdad: así "el listado no
   *  devuelve el hash" prueba el `.select(...)` de la ruta y no la suerte. */
  let columnas: string[] | null = null;
  const proyectar = (f: Record<string, unknown>) => {
    if (!columnas) return f;
    const out: Record<string, unknown> = {};
    for (const c of columnas) if (c in f) out[c] = f[c];
    return out;
  };
  const casan = () =>
    tablaDe(nombre).filter(
      (f) =>
        filtros.every(([c, v]) => f[c] === v) && nulos.every((c) => f[c] === null || f[c] === undefined),
    );
  const q: Record<string, unknown> = {
    select: (cols?: string) => {
      if (typeof cols === "string" && cols.trim() && cols !== "*") {
        columnas = cols.split(",").map((c) => c.trim());
      }
      return q;
    },
    order: () => q,
    limit: () => q,
    upsert: (fila: Record<string, unknown>) => {
      const t = tablaDe(nombre);
      const ya = t.find((f) => f.org_id === fila.org_id && f.user_id === fila.user_id);
      if (!ya) {
        t.push({ created_at: "2026-08-12T00:00:00Z", ...fila });
        e.escrituras.push({ tabla: nombre, op: "upsert", fila, filtros });
      }
      return Promise.resolve({ data: null, error: null });
    },
    eq: (c: string, v: unknown) => {
      filtros.push([c, v]);
      return q;
    },
    in: () => q,
    is: (c: string, v: unknown) => {
      if (v === null) nulos.push(c);
      return q;
    },
    update: (fila: unknown) => {
      op = "update";
      payload = fila;
      return q;
    },
    delete: () => {
      op = "delete";
      return q;
    },
    insert: (fila: Record<string, unknown>) => {
      op = "insert";
      payload = fila;
      e.escrituras.push({ tabla: nombre, op, fila, filtros });
      const creada = { id: `${nombre}-nueva`, created_at: "2026-08-12T00:00:00Z", ...fila };
      tablaDe(nombre).push(creada);
      return Object.assign(Promise.resolve({ data: null, error: null }), {
        select: () => ({ single: async () => ({ data: creada, error: null }) }),
      });
    },
    maybeSingle: async () => {
      const f = casan()[0];
      return { data: f ? proyectar(f) : null, error: null };
    },
    single: async () => {
      const f = casan()[0];
      return { data: f ? proyectar(f) : null, error: null };
    },
    then: (res: (v: { data: unknown; error: null }) => unknown) => {
      const afectadas = casan();
      if (op === "delete") {
        for (const f of afectadas) {
          const t = tablaDe(nombre);
          t.splice(t.indexOf(f), 1);
        }
        e.escrituras.push({ tabla: nombre, op, filtros });
      } else if (op === "update") {
        for (const f of afectadas) Object.assign(f, payload);
        e.escrituras.push({ tabla: nombre, op, fila: payload, filtros });
      }
      return res({ data: afectadas.map(proyectar), error: null });
    },
  };
  return q;
};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: consulta,
    auth: { admin: { getUserById: async (id: string) => ({ data: { user: { email: `${id}@x.com` } } }) } },
    rpc: async (nombre: string, args: unknown) => {
      e.rpc.push({ nombre, args });
      if (e.errorRpc) return { data: null, error: e.errorRpc };
      // Simula lo que hace la funcion en Postgres, para poder comprobar el efecto.
      const a = args as { p_org: string; p_nuevo: string; p_rol_viejo: string };
      const viejo = e.miembros.find((m) => m.org_id === a.p_org && m.role === "owner");
      const dest = e.miembros.find((m) => m.org_id === a.p_org && m.user_id === a.p_nuevo);
      if (!dest) return { data: null, error: { code: "P0002", message: "no es miembro" } };
      if (viejo) viejo.role = a.p_rol_viejo;
      dest.role = "owner";
      return { data: null, error: null };
    },
  }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: e.sinSesion ? null : { id: YO, email: e.miCorreo } } }),
    },
  }),
}));

vi.mock("@/lib/correo/invitacion", async (real) => ({
  ...(await real<Record<string, unknown>>()),
  enviarInvitacion: async (datos: Record<string, unknown>, destinatario: string) => {
    correo = { datos, destinatario };
    return correoFalla ? { ok: false, motivo: "resend_500" } : { ok: true };
  },
}));

beforeEach(() => {
  e = {
    miRol: "owner",
    miCorreo: "yo@empresa.com",
    miembros: [{ org_id: ORG, user_id: YO, role: "owner", created_at: "2026-01-01" }],
    invitaciones: [],
    orgs: [{ id: ORG, name: "Acme S.L." }],
    escrituras: [],
    rpc: [],
  };
  correo = null;
  correoFalla = false;
  vi.resetModules();
});

/** Cambia mi rol en la organización (el resolvedor lo lee de `org_members`). */
const conRol = (rol: string) => {
  e.miembros[0]!.role = rol;
};

const pet = (metodo: string, cuerpo: unknown = {}) =>
  new Request("https://savings.bivelio.com/api/org/x", {
    method: metodo,
    body: JSON.stringify(cuerpo),
    headers: { "content-type": "application/json" },
  });

const invViva = (extra: Partial<Inv> = {}): Inv => ({
  id: "inv-1",
  org_id: ORG,
  email: "nuevo@empresa.com",
  role: "member",
  token_hash: hashDeToken(TOKEN),
  expires_at: "2099-01-01T00:00:00Z",
  accepted_at: null,
  created_at: "2026-08-12T00:00:00Z",
  ...extra,
});

// ---------------------------------------------------------------- invitar ------

describe("POST /api/org/invitations — invitar", () => {
  it("crea la invitación y MANDA el correo, sin que nadie copie nada", async () => {
    const { POST } = await import("./org/invitations/route");
    const res = await POST(pet("POST", { email: "Nuevo@Empresa.com", role: "member", locale: "es" }));
    expect(res.status).toBe(201);
    expect((await res.json()).enviado).toBe(true);

    expect(correo!.destinatario).toBe("nuevo@empresa.com"); // normalizado
    expect(correo!.datos.org).toBe("Acme S.L.");
    // El enlace lleva el token EN CLARO —es el único momento en que existe— y en
    // la base solo queda el hash.
    const enlace = String(correo!.datos.enlace);
    expect(enlace).toContain("/es/invitacion/bvi_");
    const guardada = e.escrituras.find((x) => x.tabla === "org_invitations" && x.op === "insert")!;
    const fila = guardada.fila as Record<string, string>;
    expect(fila.token_hash).toBeTruthy();
    expect(enlace).not.toContain(fila.token_hash);
    expect(JSON.stringify(fila)).not.toContain(enlace.split("/").pop()!);
  });

  it("⛔ un member no puede invitar", async () => {
    conRol("member");
    const { POST } = await import("./org/invitations/route");
    const res = await POST(pet("POST", { email: "x@y.com", role: "member" }));
    expect(res.status).toBe(403);
    expect(correo).toBeNull();
    expect(e.escrituras).toHaveLength(0);
  });

  it("⛔ billing tampoco: lleva el dinero, no el equipo", async () => {
    conRol("billing");
    const { POST } = await import("./org/invitations/route");
    expect((await POST(pet("POST", { email: "x@y.com", role: "member" }))).status).toBe(403);
  });

  it("⛔ no se puede invitar como owner", async () => {
    // Se transfiere, no se invita. Dos dueños romperían la restricción de 0013.
    const { POST } = await import("./org/invitations/route");
    const res = await POST(pet("POST", { email: "x@y.com", role: "owner" }));
    expect(res.status).toBe(400);
    expect(correo).toBeNull();
  });

  it("una dirección que no lo es se rechaza antes de mandar nada", async () => {
    const { POST } = await import("./org/invitations/route");
    for (const email of ["", "sinarroba", "a@b", "a b@c.com", `${"x".repeat(250)}@y.com`]) {
      expect((await POST(pet("POST", { email, role: "member" }))).status).toBe(400);
    }
    expect(correo).toBeNull();
  });

  it("reinvitar REEMPLAZA la viva: el enlace viejo deja de valer", async () => {
    // Es lo que hace cualquiera cuando el correo se pierde. Si fallara por el
    // índice único de 0013, la única salida sería revocar a mano.
    e.invitaciones = [invViva()];
    const { POST } = await import("./org/invitations/route");
    const res = await POST(pet("POST", { email: "nuevo@empresa.com", role: "admin" }));
    expect(res.status).toBe(201);
    expect(e.invitaciones).toHaveLength(1);
    expect(e.invitaciones[0]!.token_hash).not.toBe(hashDeToken(TOKEN));
    expect(e.invitaciones[0]!.role).toBe("admin");
  });

  it("si el correo no sale, la invitación SIGUE creada y se dice", async () => {
    // Deshacerla dejaría rastro de invitaciones creadas y borradas en cada
    // reintento. La interfaz ofrece reenviar.
    correoFalla = true;
    const { POST } = await import("./org/invitations/route");
    const res = await POST(pet("POST", { email: "x@y.com", role: "member" }));
    expect(res.status).toBe(201);
    expect((await res.json()).enviado).toBe(false);
    expect(e.invitaciones).toHaveLength(1);
  });

  it("invitarse a uno mismo no crea nada", async () => {
    const { POST } = await import("./org/invitations/route");
    expect((await POST(pet("POST", { email: "YO@empresa.com", role: "member" }))).status).toBe(409);
    expect(correo).toBeNull();
  });

  it("⛔ el listado NUNCA devuelve el hash del token", async () => {
    e.invitaciones = [invViva()];
    const { GET } = await import("./org/invitations/route");
    const cuerpo = JSON.stringify(await (await GET()).json());
    expect(cuerpo).not.toContain(hashDeToken(TOKEN));
    expect(cuerpo).not.toContain("token_hash");
  });
});

// ---------------------------------------------------------------- aceptar ------

describe("POST /api/org/invitations/accept — las DOS llaves", () => {
  beforeEach(() => {
    // El que acepta no es miembro de nada todavía.
    e.miembros = [{ org_id: ORG, user_id: OTRO, role: "owner", created_at: "2026-01-01" }];
    e.invitaciones = [invViva()];
    e.miCorreo = "nuevo@empresa.com";
  });

  it("con el token bueno Y el correo bueno, entra con su rol", async () => {
    const { POST } = await import("./org/invitations/accept/route");
    const res = await POST(pet("POST", { token: TOKEN }));
    expect(res.status).toBe(200);
    expect(e.miembros.find((m) => m.user_id === YO)).toMatchObject({ org_id: ORG, role: "member" });
    expect(e.invitaciones[0]!.accepted_at).toBeTruthy();
  });

  it("⛔ token bueno pero OTRO correo: no entra", async () => {
    // El enlace reenviado por error a una lista de distribución. Es la razón de
    // ser de la segunda llave.
    e.miCorreo = "curioso@otraempresa.com";
    const { POST } = await import("./org/invitations/accept/route");
    const res = await POST(pet("POST", { token: TOKEN }));
    expect(res.status).toBe(410);
    expect(e.miembros.find((m) => m.user_id === YO)).toBeUndefined();
  });

  it("⛔ sin correo en la sesión tampoco", async () => {
    e.miCorreo = null;
    const { POST } = await import("./org/invitations/accept/route");
    expect((await POST(pet("POST", { token: TOKEN }))).status).toBe(410);
    expect(e.miembros.find((m) => m.user_id === YO)).toBeUndefined();
  });

  it("⛔ un token inventado no entra y no distingue de uno caducado", async () => {
    const { POST } = await import("./org/invitations/accept/route");
    const res = await POST(pet("POST", { token: "bvi_lo_que_sea" }));
    expect(res.status).toBe(404);
    // El mensaje es el mismo para todo: la ruta no puede ser un oráculo.
    expect((await res.json()).error).toBe("This invitation isn't valid.");
  });

  it("caducada no entra", async () => {
    e.invitaciones = [invViva({ expires_at: "2020-01-01T00:00:00Z" })];
    const { POST } = await import("./org/invitations/accept/route");
    expect((await POST(pet("POST", { token: TOKEN }))).status).toBe(410);
    expect(e.miembros.find((m) => m.user_id === YO)).toBeUndefined();
  });

  it("⛔ una ya aceptada no vale dos veces", async () => {
    e.invitaciones = [invViva({ accepted_at: "2026-08-12T10:00:00Z" })];
    const { POST } = await import("./org/invitations/accept/route");
    expect((await POST(pet("POST", { token: TOKEN }))).status).toBe(410);
  });

  it("⛔ quien ya está en OTRA organización recibe un 409 explicado", async () => {
    // Sin selector (fase 9), aceptar no enseñaría la organización nueva: el
    // resolvedor prefiere la que paga. Un éxito que no hace nada visible es peor
    // que un error que explica por qué.
    e.miembros.push({ org_id: ORG_AJENA, user_id: YO, role: "owner", created_at: "2026-01-01" });
    const { POST } = await import("./org/invitations/accept/route");
    const res = await POST(pet("POST", { token: TOKEN }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("ya_en_otra");
    expect(e.miembros.filter((m) => m.user_id === YO)).toHaveLength(1);
  });

  it("reintentar el mismo enlace estando ya dentro no da error", async () => {
    // Doble clic, recarga de la página. Tiene que ser idempotente.
    e.miembros.push({ org_id: ORG, user_id: YO, role: "member", created_at: "2026-01-01" });
    const { POST } = await import("./org/invitations/accept/route");
    const res = await POST(pet("POST", { token: TOKEN }));
    expect(res.status).toBe(200);
    expect((await res.json()).yaEstaba).toBe(true);
    expect(e.miembros.filter((m) => m.user_id === YO)).toHaveLength(1);
  });

  it("sin sesión no se acepta nada", async () => {
    e.sinSesion = true;
    const { POST } = await import("./org/invitations/accept/route");
    expect((await POST(pet("POST", { token: TOKEN }))).status).toBe(401);
    expect(e.miembros.find((m) => m.user_id === YO)).toBeUndefined();
  });
});

// -------------------------------------------------------------- el dueño -------

describe("una organización NO se queda sin dueño", () => {
  beforeEach(() => {
    e.miembros = [
      { org_id: ORG, user_id: YO, role: "owner", created_at: "2026-01-01" },
      { org_id: ORG, user_id: OTRO, role: "member", created_at: "2026-02-01" },
    ];
  });

  it("⛔ al dueño no se le expulsa", async () => {
    const { DELETE } = await import("./org/members/route");
    const res = await DELETE(pet("DELETE", { userId: YO }));
    expect(res.status).toBe(409);
    expect(e.miembros.find((m) => m.user_id === YO)).toBeTruthy();
  });

  it("⛔ al dueño no se le degrada", async () => {
    const { PATCH } = await import("./org/members/route");
    const res = await PATCH(pet("PATCH", { userId: YO, role: "member" }));
    expect(res.status).toBe(409);
    expect(e.miembros.find((m) => m.user_id === YO)!.role).toBe("owner");
  });

  it("⛔ no se puede promover a owner por la puerta de atrás del PATCH", async () => {
    // Dejaría DOS dueños y la restricción de 0013 lo rechazaría con un error crudo.
    const { PATCH } = await import("./org/members/route");
    expect((await PATCH(pet("PATCH", { userId: OTRO, role: "owner" }))).status).toBe(400);
    expect(e.miembros.find((m) => m.user_id === OTRO)!.role).toBe("member");
  });

  it("a un miembro normal sí se le cambia el rol y se le expulsa", async () => {
    const rutas = await import("./org/members/route");
    expect((await rutas.PATCH(pet("PATCH", { userId: OTRO, role: "admin" }))).status).toBe(200);
    expect(e.miembros.find((m) => m.user_id === OTRO)!.role).toBe("admin");
    expect((await rutas.DELETE(pet("DELETE", { userId: OTRO }))).status).toBe(200);
    expect(e.miembros.find((m) => m.user_id === OTRO)).toBeUndefined();
  });

  it("⛔ no se puede tocar a un miembro de OTRA organización", async () => {
    // El `.eq("org_id", …)` es lo único que lo impide, y el id lo elige quien llama.
    e.miembros.push({ org_id: ORG_AJENA, user_id: "ajeno", role: "member", created_at: "2026-01-01" });
    const rutas = await import("./org/members/route");
    expect((await rutas.DELETE(pet("DELETE", { userId: "ajeno" }))).status).toBe(404);
    expect((await rutas.PATCH(pet("PATCH", { userId: "ajeno", role: "admin" }))).status).toBe(404);
    expect(e.miembros.find((m) => m.user_id === "ajeno")).toBeTruthy();
  });

  it("⛔ un admin no puede gestionar si no le toca... pero sí le toca", async () => {
    conRol("admin");
    const { GET } = await import("./org/members/route");
    expect((await GET()).status).toBe(200);
  });

  it("⛔ un member no ve la lista del equipo", async () => {
    conRol("member");
    const { GET } = await import("./org/members/route");
    expect((await GET()).status).toBe(403);
  });
});

// ------------------------------------------------------------ transferir ------

describe("POST /api/org/transfer — la transferencia", () => {
  beforeEach(() => {
    e.miembros = [
      { org_id: ORG, user_id: YO, role: "owner", created_at: "2026-01-01" },
      { org_id: ORG, user_id: OTRO, role: "admin", created_at: "2026-02-01" },
    ];
  });

  it("la hace POSTGRES en una sola llamada, no la aplicación en dos escrituras", async () => {
    // Es lo que garantiza que no exista una ventana con dos dueños o ninguno.
    const { POST } = await import("./org/transfer/route");
    const res = await POST(pet("POST", { userId: OTRO }));
    expect(res.status).toBe(200);
    expect(e.rpc).toHaveLength(1);
    expect(e.rpc[0]).toMatchObject({
      nombre: "transferir_propiedad",
      args: { p_org: ORG, p_nuevo: OTRO, p_rol_viejo: "admin" },
    });
    // Y NO se escribieron roles a mano desde la ruta.
    expect(e.escrituras.filter((x) => x.tabla === "org_members")).toHaveLength(0);
    expect(e.miembros.find((m) => m.user_id === OTRO)!.role).toBe("owner");
    expect(e.miembros.find((m) => m.user_id === YO)!.role).toBe("admin");
  });

  it("⛔ un admin NO puede quedarse con la organización de su empresa", async () => {
    conRol("admin");
    const { POST } = await import("./org/transfer/route");
    expect((await POST(pet("POST", { userId: YO }))).status).toBe(403);
    expect(e.rpc).toHaveLength(0);
  });

  it("⛔ ni un member ni un billing", async () => {
    const { POST } = await import("./org/transfer/route");
    for (const r of ["member", "billing"]) {
      conRol(r);
      vi.resetModules();
      const { POST: P } = await import("./org/transfer/route");
      expect((await P(pet("POST", { userId: OTRO }))).status).toBe(403);
    }
    expect(e.rpc).toHaveLength(0);
    expect(POST).toBeTruthy();
  });

  it("a alguien que no es miembro todavía: 404 con instrucción, no 500", async () => {
    const { POST } = await import("./org/transfer/route");
    const res = await POST(pet("POST", { userId: "desconocido" }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain("Invite them first");
  });

  it("un rol de salida raro cae a admin en vez de reventar la función", async () => {
    const { POST } = await import("./org/transfer/route");
    await POST(pet("POST", { userId: OTRO, miRolDespues: "owner" }));
    expect((e.rpc[0]!.args as { p_rol_viejo: string }).p_rol_viejo).toBe("admin");
  });

  it("transferirse a uno mismo no llama a nada", async () => {
    const { POST } = await import("./org/transfer/route");
    expect((await POST(pet("POST", { userId: YO }))).status).toBe(409);
    expect(e.rpc).toHaveLength(0);
  });
});
