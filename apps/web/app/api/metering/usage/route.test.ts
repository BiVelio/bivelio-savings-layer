import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * POST /api/metering/usage — la ruta que ingiere la facturación. No tenía NINGÚN
 * test directo; el canal de versión (0024) no es opcional aquí porque toca el
 * único punto por el que entra el dinero medido.
 *
 * Contrato del canal de versión:
 *  · con cabecera válida, CADA registro llega a la RPC con `clientVersion`;
 *  · sin cabecera (gateway anterior al canal), NINGUNO la lleva y el lote entra;
 *  · con cabecera inválida (repetida, texto libre) → «sin declarar», 202, jamás 400;
 *  · un cuerpo que traiga `clientVersion` → 400: solo el servidor escribe la versión.
 *
 * Y el candado de entitlement: una org sin NINGUNA licencia ni suscripción → 402
 * `no-license` (no hay free tier), sin llegar a la RPC. Una org con suscripción
 * activa y la fila de licencia aún sin escribir sigue entrando. El lote VACÍO es
 * la sonda «Test my key» del panel: 202 con derecho, 402 sin él (el panel lo
 * traduce a keyNoPlan; ver dashboard/prueba-de-clave.ts).
 */

const ORG = "99999999-9999-4999-8999-999999999999";

/** Lo que recibió la RPC en la última llamada. */
let rpc: { nombre: string; args: { p_org: string; records: Array<Record<string, unknown>> } } | null = null;

/** Una licencia viva: sin ninguna, la org se bloquea (no hay free tier). */
const LICENCIA_VIVA = [{ revoked: false, expires_at: "2099-01-01T00:00:00Z", grace_days: 14 }];

/** Filas que ve la ruta en `licenses`. Cada test parte de una licencia viva. */
let licencias: unknown[] = LICENCIA_VIVA;

/** Filas que ve la ruta en `subscriptions`. Por defecto ninguna: el derecho lo da la licencia. */
let suscripciones: unknown[] = [];

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabla: string) => ({
      select: () => ({
        eq: () => {
          if (tabla === "service_accounts") {
            return { maybeSingle: async () => ({ data: { org_id: ORG }, error: null }) };
          }
          if (tabla === "licenses") return Promise.resolve({ data: licencias, error: null });
          return Promise.resolve({ data: suscripciones, error: null });
        },
      }),
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
    rpc: async (nombre: string, args: { p_org: string; records: Array<Record<string, unknown>> }) => {
      rpc = { nombre, args };
      return { data: args.records.length, error: null };
    },
  }),
}));

// `after()` de next/server exige el contexto de una petición real; aquí no lo hay.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: () => {},
}));
vi.mock("@/lib/observabilidad/alerta", () => ({ alertar: async () => {} }));

import { POST } from "./route";

function registro(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    model: "claude-haiku-4-5",
    cacheResult: "miss",
    at: Date.now(),
    avoidedLlm: 0,
    actualLlm: 1,
    baselineInputTokens: 10,
    actualInputTokens: 10,
    eliminatedInputTokens: 0,
    compressedInputTokens: 0,
    baselineOutputTokens: 5,
    actualOutputTokens: 5,
    providerCachedInputTokens: 0,
    baselineCost: 0.01,
    actualCost: 0.01,
    netSavings: 0,
    basis: "measured",
    ...extra,
  };
}

function peticion(cuerpo: unknown, cabeceras: Record<string, string> = {}): Request {
  return new Request("https://savings.bivelio.com/api/metering/usage", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer bvk_test", ...cabeceras },
    body: JSON.stringify(cuerpo),
  });
}

beforeEach(() => {
  rpc = null;
  licencias = LICENCIA_VIVA;
  suscripciones = [];
});

describe("POST /api/metering/usage — el canal de versión", () => {
  it("con x-bvsala-version válida, cada registro llega a la RPC sellado con clientVersion", async () => {
    const res = await POST(peticion([registro(), registro()], { "x-bvsala-version": "gateway/0.4.17" }));
    expect(res.status).toBe(202);
    expect(rpc?.nombre).toBe("ingest_usage_batch");
    expect(rpc?.args.p_org).toBe(ORG);
    expect(rpc?.args.records).toHaveLength(2);
    for (const r of rpc!.args.records) expect(r["clientVersion"]).toBe("gateway/0.4.17");
  });

  it("sin cabecera (gateway anterior al canal), ningún registro la lleva y el lote entra igual", async () => {
    const res = await POST(peticion([registro()]));
    expect(res.status).toBe(202);
    expect(rpc?.args.records).toHaveLength(1);
    expect("clientVersion" in rpc!.args.records[0]!).toBe(false);
  });

  it("cabecera inválida (repetida «a, b», texto libre) = sin declarar: 202, nunca 400", async () => {
    for (const mala of ["gateway/0.4.16, gateway/0.4.16", "el usuario dijo: version 9", "cli/1.0.0"]) {
      rpc = null;
      const res = await POST(peticion([registro()], { "x-bvsala-version": mala }));
      expect(res.status, mala).toBe(202);
      expect("clientVersion" in rpc!.args.records[0]!, mala).toBe(false);
    }
  });

  it("un cuerpo que traiga clientVersion → 400 (solo el servidor escribe la versión)", async () => {
    const res = await POST(peticion([registro({ clientVersion: "gateway/0.4.17" })], { "x-bvsala-version": "gateway/0.4.17" }));
    expect(res.status).toBe(400);
    expect(rpc).toBeNull();
    const cuerpo = (await res.json()) as { error: string };
    expect(cuerpo.error).toMatch(/disallowed field "clientVersion"/);
  });

  it("el sellado también alcanza al registro sombra (inocuo: la RPC sale de ese carril antes de seat_activity)", async () => {
    const res = await POST(peticion([registro({ basis: "shadow" })], { "x-bvsala-version": "sdk/0.4.17" }));
    expect(res.status).toBe(202);
    expect(rpc!.args.records[0]!["clientVersion"]).toBe("sdk/0.4.17");
    expect(rpc!.args.records[0]!["basis"]).toBe("shadow");
  });

  it("sin Bearer → 401 antes de mirar nada más", async () => {
    const res = await POST(
      new Request("https://savings.bivelio.com/api/metering/usage", {
        method: "POST",
        headers: { "content-type": "application/json", "x-bvsala-version": "gateway/0.4.17" },
        body: JSON.stringify([registro()]),
      }),
    );
    expect(res.status).toBe(401);
    expect(rpc).toBeNull();
  });
});

describe("POST /api/metering/usage — el candado de entitlement", () => {
  it("sin NINGUNA licencia ni suscripción → 402 no-license, sin ingerir (no hay free tier)", async () => {
    licencias = [];
    const res = await POST(peticion([registro()], { "x-bvsala-version": "gateway/0.4.22" }));
    expect(res.status).toBe(402);
    expect(rpc).toBeNull();
    const cuerpo = (await res.json()) as { error: string; reason: string; detail: string };
    expect(cuerpo.reason).toBe("no-license");
    expect(cuerpo.detail).toContain("https://savings.bivelio.com/dashboard/account");
    // Lo lee el cliente: en inglés y ASCII, como todo lo que ve.
    expect(cuerpo.detail).toMatch(/^[\x20-\x7E]+$/);
  });

  it("con una licencia viva, el mismo lote entra (202)", async () => {
    const res = await POST(peticion([registro()], { "x-bvsala-version": "gateway/0.4.22" }));
    expect(res.status).toBe(202);
    expect(rpc?.args.records).toHaveLength(1);
  });

  it("sin fila de licencia pero con suscripción activa, el lote entra (202): el webhook aún no escribió la fila", async () => {
    licencias = [];
    suscripciones = [{ status: "active", current_period_end: "2099-01-01T00:00:00Z" }];
    const res = await POST(peticion([registro()], { "x-bvsala-version": "gateway/0.4.22" }));
    expect(res.status).toBe(202);
    expect(rpc?.args.records).toHaveLength(1);
  });

  it("una suscripción que no cubre ('incomplete', p. ej. SEPA sin liquidar) y sin licencia → 402 no-license", async () => {
    licencias = [];
    suscripciones = [{ status: "incomplete", current_period_end: null }];
    const res = await POST(peticion([registro()]));
    expect(res.status).toBe(402);
    expect(rpc).toBeNull();
    expect(((await res.json()) as { reason: string }).reason).toBe("no-license");
  });

  it("la sonda del panel (lote vacío): 202 {ingested:0} con derecho, 402 sin él; nunca un 202 que mienta", async () => {
    const vivo = await POST(peticion([]));
    expect(vivo.status).toBe(202);
    expect(await vivo.json()).toEqual({ ingested: 0 });

    licencias = [];
    const sinNada = await POST(peticion([]));
    expect(sinNada.status).toBe(402);
    expect(((await sinNada.json()) as { reason: string }).reason).toBe("no-license");
    expect(rpc).toBeNull();
  });
});
