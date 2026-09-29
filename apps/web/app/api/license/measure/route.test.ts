import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// El verificador del SDK, cargado en ejecución: `next build` comprueba los tipos de
// todo apps/web y en Vercel no está @noble/curves (dependencia de la raíz), así que
// un import estático de ../src rompería el despliegue.
const VERIFICADOR_DEL_SDK = "../../../../../../src/license/verify.js";
type ResolverLicencia = (token: string, clave: string) => { status: string; payload?: unknown };
const cargarResolveLicense = async (): Promise<ResolverLicencia> =>
  ((await import(/* @vite-ignore */ VERIFICADOR_DEL_SDK)) as { resolveLicense: ResolverLicencia }).resolveLicense;

/**
 * POST /api/license/measure — el alta SIN TARJETA de la licencia Medir.
 *
 * alta → organización → licencia Medir, y los candados anti-abuso: correo
 * verificado, rol, una organización por cuenta, una Medir por organización, la
 * org que ya paga no la recibe y el bloqueo del operador no se reactiva.
 */

const par = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const USUARIO = "11111111-1111-4111-8111-111111111111";
const ORG_NUEVA = "abcdabcd-abcd-4bcd-8bcd-abcdabcdabcd";
const OTRA_ORG = "99999999-9999-4999-8999-999999999999";

type Fila = Record<string, unknown>;
let tablas: Record<string, Fila[]>;
let usuario: { id: string; email: string; email_confirmed_at: string | null } | null;

function consulta(tabla: string) {
  let filas = [...(tablas[tabla] ?? [])];
  const q: Record<string, unknown> = {};
  q["select"] = () => q;
  q["order"] = () => q;
  q["limit"] = () => q;
  q["eq"] = (c: string, v: unknown) => {
    filas = filas.filter((f) => f[c] === v);
    return q;
  };
  q["in"] = (c: string, vs: unknown[]) => {
    filas = filas.filter((f) => vs.includes(f[c]));
    return q;
  };
  q["maybeSingle"] = async () => ({ data: filas[0] ?? null, error: null });
  q["then"] = (res: (v: { data: unknown; error: null }) => unknown) => res({ data: filas, error: null });
  q["insert"] = (fila: Fila) => {
    const conId = tabla === "organizations" ? { id: ORG_NUEVA, ...fila } : { created_at: new Date().toISOString(), ...fila };
    (tablas[tabla] ??= []).push(conId);
    return Object.assign(Promise.resolve({ data: null, error: null }), {
      select: () => ({ single: async () => ({ data: conId, error: null }) }),
    });
  };
  return q;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: usuario } }) } }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: (t: string) => consulta(t) }) }));
vi.mock("@/lib/observabilidad/alerta", () => ({ alertar: async () => {} }));

import { POST } from "./route";

beforeEach(() => {
  process.env.LICENSE_PRIVATE_KEY = par.privateKey;
  tablas = { org_members: [], organizations: [], licenses: [], subscriptions: [], medir_altas: [] };
  usuario = { id: USUARIO, email: "Ana@Acme.io", email_confirmed_at: "2026-09-01T00:00:00Z" };
});

describe("alta Medir sin tarjeta", () => {
  it("sin sesión → 401", async () => {
    usuario = null;
    expect((await POST()).status).toBe(401);
  });

  it("correo DESECHABLE → 403 disposable_email, y no se crea nada (tampoco con un subdominio)", async () => {
    for (const email of ["ana@mailinator.com", "Ana@X.Guerrillamail.com"]) {
      usuario!.email = email;
      const res = await POST();
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ code: "disposable_email" });
    }
    expect(tablas.licenses).toHaveLength(0);
    expect(tablas.organizations).toHaveLength(0);
    expect(tablas.medir_altas).toHaveLength(0);
  });

  it("correo SIN verificar → 403 email_not_verified, y no se crea nada", async () => {
    usuario!.email_confirmed_at = null;
    const res = await POST();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: "email_not_verified" });
    expect(tablas.licenses).toHaveLength(0);
    expect(tablas.organizations).toHaveLength(0);
  });

  it("alta → organización → licencia Medir firmada: plan measure, sin features, 5 asientos, que el SDK verifica", async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    const j = (await res.json()) as { token: string; plan: string; seats: number };
    expect(j.plan).toBe("measure");
    expect(j.seats).toBe(5);
    // La organización se creó con el usuario de dueño, y el alta guarda el DOMINIO, no el correo.
    expect(tablas.organizations[0]).toMatchObject({ owner_user_id: USUARIO });
    expect(tablas.medir_altas).toEqual([expect.objectContaining({ user_id: USUARIO, org_id: ORG_NUEVA, email_dominio: "acme.io" })]);
    expect(JSON.stringify(tablas.medir_altas)).not.toContain("ana@");
    // La fila persistida y el token dicen lo mismo.
    expect(tablas.licenses).toHaveLength(1);
    expect(tablas.licenses[0]).toMatchObject({ org_id: ORG_NUEVA, plan: "measure", seats: 5, features: [], revoked: false });
    const resolveLicense = await cargarResolveLicense();
    const r = resolveLicense(j.token, par.publicKey);
    expect(r.status).toBe("active");
    expect(r.payload).toMatchObject({ plan: "measure", features: [], seats: 5, org_id: ORG_NUEVA });
  });

  it("reclamar dos veces devuelve la MISMA licencia (idempotente, sin segunda fila)", async () => {
    const a = (await (await POST()).json()) as { token: string };
    const b = (await (await POST()).json()) as { token: string };
    expect(b.token).toBe(a.token);
    expect(tablas.licenses).toHaveLength(1);
  });

  it("la cuenta que ya reclamó Medir para OTRA organización → 409 one_org_per_account", async () => {
    tablas.org_members.push({ org_id: ORG_NUEVA, user_id: USUARIO, role: "owner", created_at: "2026-09-01T00:00:00Z" });
    tablas.medir_altas.push({ user_id: USUARIO, org_id: OTRA_ORG, bloqueada: false });
    const res = await POST();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: "one_org_per_account" });
    expect(tablas.licenses).toHaveLength(0);
  });

  it("la organización que ya PAGA no recibe una Medir → 409 already_licensed", async () => {
    tablas.org_members.push({ org_id: ORG_NUEVA, user_id: USUARIO, role: "owner", created_at: "2026-09-01T00:00:00Z" });
    tablas.licenses.push({ org_id: ORG_NUEVA, plan: "pro", revoked: false, expires_at: "2099-01-01T00:00:00Z", grace_days: 14 });
    const res = await POST();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: "already_licensed" });
  });

  it("una organización BLOQUEADA por el operador no se reactiva → 403 measure_blocked", async () => {
    tablas.org_members.push({ org_id: ORG_NUEVA, user_id: USUARIO, role: "owner", created_at: "2026-09-01T00:00:00Z" });
    tablas.medir_altas.push({ user_id: USUARIO, org_id: ORG_NUEVA, bloqueada: true });
    const res = await POST();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: "measure_blocked" });
    expect(tablas.licenses).toHaveLength(0);
  });

  it("un `member` no reclama la credencial de su organización → 403", async () => {
    tablas.org_members.push({ org_id: ORG_NUEVA, user_id: USUARIO, role: "member", created_at: "2026-09-01T00:00:00Z" });
    expect((await POST()).status).toBe(403);
  });

  it("sin clave de firma: 503 y ninguna licencia a medias", async () => {
    delete process.env.LICENSE_PRIVATE_KEY;
    delete process.env.LICENSE_PRIVATE_KEY_B64;
    expect((await POST()).status).toBe(503);
    expect(tablas.licenses).toHaveLength(0);
  });
});
