import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * EL BARRIDO DE IMPAGO DEVUELVE LA ORG A MEDIR (decisión del dueño, 2026-09-29).
 *
 * Una org en impago que ha pasado la gracia y ya no tiene licencia de pago viva
 * se degrada a `free` y, en la misma pasada, recibe una licencia Medir: sigue
 * viendo lo que habría ahorrado. Salvo que el operador la haya bloqueado, o que
 * ya tenga una Medir viva. Con licencia de pago viva, ni se degrada ni se emite.
 */

const par = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const ORG = "abcdabcd-abcd-4bcd-8bcd-abcdabcdabcd";
const DIA = 86_400_000;

type Fila = Record<string, unknown>;
let tablas: Record<string, Fila[]>;
const alertas: unknown[] = [];

function consulta(tabla: string) {
  let filas = [...(tablas[tabla] ?? [])];
  const q: Record<string, unknown> = {};
  for (const m of ["select", "order", "limit"]) q[m] = () => q;
  q["range"] = () => q;
  q["eq"] = (c: string, v: unknown) => {
    filas = filas.filter((f) => f[c] === v);
    return q;
  };
  q["maybeSingle"] = async () => ({ data: filas[0] ?? null, error: null });
  q["then"] = (res: (v: { data: unknown; error: null }) => unknown) => res({ data: filas, error: null });
  q["update"] = (cambio: Fila) => {
    const u: Record<string, unknown> = {};
    u["eq"] = (c: string, v: unknown) => {
      for (const f of tablas[tabla] ?? []) if (f[c] === v) Object.assign(f, cambio);
      return Promise.resolve({ data: null, error: null });
    };
    return u;
  };
  q["insert"] = (fila: Fila) => {
    (tablas[tabla] ??= []).push({ created_at: new Date().toISOString(), ...fila });
    return Promise.resolve({ data: null, error: null });
  };
  return q;
}

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: (t: string) => consulta(t) }) }));
vi.mock("@/lib/observabilidad/alerta", () => ({ alertar: async (a: unknown) => void alertas.push(a) }));

import { GET } from "./route";

const pedir = () => GET(new Request("https://savings.bivelio.com/api/cron/dunning", { headers: { authorization: "Bearer s3" } }));
const medirDe = (org: string) => (tablas.licenses ?? []).filter((l) => l["org_id"] === org && l["plan"] === "measure");

beforeEach(() => {
  process.env.CRON_SECRET = "s3";
  process.env.LICENSE_PRIVATE_KEY = par.privateKey;
  alertas.length = 0;
  const hace = (d: number) => new Date(Date.now() - d * DIA).toISOString();
  tablas = {
    subscriptions: [
      { id: "sub-row", org_id: ORG, status: "past_due", past_due_since: hace(40), current_period_start: hace(45), stripe_subscription_id: "sub_1" },
    ],
    // La de pago CADUCADA (período + gracia firmada, ya pasados): nada que la salve.
    licenses: [{ id: "jti-pago", org_id: ORG, plan: "pro", revoked: false, expires_at: hace(20), grace_days: 7, token: "t" }],
    organizations: [{ id: ORG, plan: "pro" }],
    medir_altas: [],
    billing_audit: [],
  };
});

describe("/api/cron/dunning — la vuelta a Medir", () => {
  it("degrada a free y emite una licencia Medir en la misma pasada", async () => {
    const res = await pedir();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ degradados: 1, fallos: 0 });
    expect(tablas.organizations![0]!["plan"]).toBe("free");
    const medir = medirDe(ORG);
    expect(medir).toHaveLength(1);
    expect(medir[0]).toMatchObject({ revoked: false, seats: 5, features: [] });
    const auditoria = tablas.billing_audit!.find((a) => a["kind"] === "dunning_degradado");
    expect((auditoria?.["detail"] as { medir?: { resultado?: string } }).medir?.resultado).toBe("emitida");
  });

  it("org BLOQUEADA por el operador: se degrada, pero NO vuelve a Medir", async () => {
    tablas.medir_altas = [{ user_id: "u", org_id: ORG, bloqueada: true }];
    await pedir();
    expect(tablas.organizations![0]!["plan"]).toBe("free");
    expect(medirDe(ORG)).toHaveLength(0);
  });

  it("org que ya tiene una Medir viva: no se emite otra", async () => {
    tablas.licenses!.push({
      id: "jti-medir", org_id: ORG, plan: "measure", revoked: false, token: "m",
      expires_at: new Date(Date.now() + 3000 * DIA).toISOString(), grace_days: 30, issued_at: new Date().toISOString(),
    });
    await pedir();
    expect(medirDe(ORG).map((l) => l["id"])).toEqual(["jti-medir"]);
  });

  it("con licencia de PAGO viva no se degrada ni se emite nada", async () => {
    tablas.licenses![0]!["expires_at"] = new Date(Date.now() + 10 * DIA).toISOString();
    await pedir();
    expect(tablas.organizations![0]!["plan"]).toBe("pro");
    expect(medirDe(ORG)).toHaveLength(0);
  });

  it("si la Medir no se puede emitir, la degradación se mantiene y se alerta", async () => {
    delete process.env.LICENSE_PRIVATE_KEY;
    const res = await pedir();
    expect(await res.json()).toMatchObject({ degradados: 1, fallos: 0 });
    expect(tablas.organizations![0]!["plan"]).toBe("free");
    expect(medirDe(ORG)).toHaveLength(0);
    expect(alertas).toHaveLength(1);
  });
});
