import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { precioDelUso } from "@/lib/verificacion/wire";

/**
 * POST /api/metering/verification — el ingest de «tu propio banco». La org se
 * deriva de la clave (nunca del cuerpo), una org sin licencia ni suscripción
 * recibe 402, el interruptor de incidencias corta, y la función que falta (0030
 * sin aplicar) es un 503, nunca un 202 que se tragara los pares.
 */

const ORG = "99999999-9999-4999-8999-999999999999";

// Desde que no hay free tier (#314), una org sin licencia ni suscripción no ingiere
// nada: el caso por defecto es una org con licencia viva, como en el test de uso.
const LICENCIA_VIVA: unknown[] = [{ revoked: false, expires_at: "2099-01-01T00:00:00Z", grace_days: 14 }];

const estado: {
  rpc: { nombre: string; args: Record<string, unknown> } | null;
  rpcRespuesta: { data: unknown; error: { code?: string; message?: string } | null };
  claveConocida: boolean;
  licencias: unknown[];
  suscripciones: unknown[];
} = { rpc: null, rpcRespuesta: { data: 1, error: null }, claveConocida: true, licencias: LICENCIA_VIVA, suscripciones: [] };

const alertas: Array<{ nivel: string; asunto: string }> = [];

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabla: string) => ({
      select: () => ({
        eq: () => {
          if (tabla === "service_accounts") {
            return { maybeSingle: async () => ({ data: estado.claveConocida ? { org_id: ORG } : null, error: null }) };
          }
          if (tabla === "licenses") return Promise.resolve({ data: estado.licencias, error: null });
          return Promise.resolve({ data: estado.suscripciones, error: null });
        },
      }),
    }),
    rpc: async (nombre: string, args: Record<string, unknown>) => {
      estado.rpc = { nombre, args };
      return estado.rpcRespuesta;
    },
  }),
}));
vi.mock("@/lib/observabilidad/alerta", () => ({
  alertar: async (a: { nivel: string; asunto: string }) => {
    alertas.push(a);
  },
}));

import { POST } from "./route";

function muestra(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const m: Record<string, unknown> = {
    basis: "verification",
    requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
    at: Date.now() - 1000,
    stratum: "unchanged",
    outcome: "paired",
    requestedModel: "openai/gpt-4o-mini",
    servedModel: "openai/gpt-4o-mini",
    cacheResult: "miss",
    optimizedCost: 0.00002,
    optimizedInputTokens: 100,
    optimizedCachedInputTokens: 0,
    optimizedOutputTokens: 10,
    naiveInputTokens: 120,
    naiveCachedInputTokens: 0,
    naiveOutputTokens: 10,
    naiveContract: "none",
    inputPer1k: 0.00015,
    outputPer1k: 0.0006,
    ...extra,
  };
  m["naiveCost"] = precioDelUso({ inputTokens: 120, outputTokens: 10, cachedInputTokens: 0 }, { inputPer1k: 0.00015, outputPer1k: 0.0006 });
  return m;
}

const hoy = () => new Date().toISOString().slice(0, 10);
const sobre = (extra: Record<string, unknown> = {}) => ({
  batchId: "0f3c2a1e-aaaa-4bbb-8ccc-123456789abc",
  samples: [muestra()],
  counts: [{ day: hoy(), category: "unchanged", requests: 4 }],
  ...extra,
});

function peticion(cuerpo: unknown, auth: string | null = "Bearer bvk_test"): Request {
  return new Request("https://savings.bivelio.com/api/metering/verification", {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify(cuerpo),
  });
}

beforeEach(() => {
  estado.rpc = null;
  estado.rpcRespuesta = { data: 1, error: null };
  estado.claveConocida = true;
  estado.licencias = LICENCIA_VIVA;
  estado.suscripciones = [];
  alertas.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.BVSALA_INGEST_VERIFICATION_OFF;
  vi.restoreAllMocks();
});

describe("POST /api/metering/verification", () => {
  it("sin Bearer o con una clave desconocida → 401", async () => {
    expect((await POST(peticion(sobre(), null))).status).toBe(401);
    estado.claveConocida = false;
    const res = await POST(peticion(sobre()));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(estado.rpc).toBeNull();
  });

  it("una org sin licencia vigente ni suscripción → 402, como el ingest de uso", async () => {
    estado.licencias = [{ revoked: true, expires_at: new Date(Date.now() + 86_400_000).toISOString(), grace_days: 0 }];
    const res = await POST(peticion(sobre()));
    expect(res.status).toBe(402);
    expect(estado.rpc).toBeNull();
  });

  it("sin NINGUNA licencia ni suscripción → 402 no-license, sin llamar a la función", async () => {
    estado.licencias = [];
    const res = await POST(peticion(sobre()));
    expect(res.status).toBe(402);
    expect(((await res.json()) as { reason: string }).reason).toBe("no-license");
    expect(estado.rpc).toBeNull();
  });

  it("un sobre malo → 400 con el mensaje del validador", async () => {
    const res = await POST(peticion(sobre({ samples: [muestra({ basis: "measured" })] })));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/field "basis" must be "verification"/);
    const res2 = await POST(peticion(sobre({ samples: [{ ...muestra(), prompt: "hola" }] })));
    expect(((await res2.json()) as { error: string }).error).toMatch(/unknown field "prompt" in sample 0/);
    expect(estado.rpc).toBeNull();
  });

  it("202: la función recibe la org de la CLAVE, el lote validado y su batchId", async () => {
    const res = await POST(peticion(sobre()));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ingested: 1, duplicate: false, dropped: 0 });
    expect(estado.rpc!.nombre).toBe("ingest_verification_batch");
    expect(estado.rpc!.args["p_org"]).toBe(ORG);
    expect(estado.rpc!.args["p_batch_id"]).toBe("0f3c2a1e-aaaa-4bbb-8ccc-123456789abc");
    expect(estado.rpc!.args["p_samples"]).toHaveLength(1);
    expect(estado.rpc!.args["p_counts"]).toEqual([{ day: hoy(), category: "unchanged", requests: 4 }]);
  });

  it("un orgId en el cuerpo no existe en el contrato → 400", async () => {
    const res = await POST(peticion(sobre({ orgId: "00000000-0000-4000-8000-000000000000" })));
    expect(res.status).toBe(400);
  });

  it("lote repetido (la función devuelve 0) → duplicate", async () => {
    estado.rpcRespuesta = { data: 0, error: null };
    const res = await POST(peticion(sobre()));
    expect(await res.json()).toEqual({ ingested: 0, duplicate: true, dropped: 0 });
  });

  it("sin muestras ni conteos → 202 sin llamar a la función", async () => {
    const res = await POST(peticion(sobre({ samples: [], counts: [] })));
    expect(res.status).toBe(202);
    expect(estado.rpc).toBeNull();
  });

  it("el interruptor BVSALA_INGEST_VERIFICATION_OFF corta: disabled, sin función", async () => {
    process.env.BVSALA_INGEST_VERIFICATION_OFF = "1";
    const res = await POST(peticion(sobre()));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ingested: 0, disabled: true });
    expect(estado.rpc).toBeNull();
    process.env.BVSALA_INGEST_VERIFICATION_OFF = "a medias";
    expect(await (await POST(peticion(sobre()))).json()).toEqual({ ingested: 0, disabled: true });
  });

  it("la función de 0030 no existe (PGRST202) → 503, sin alerta", async () => {
    estado.rpcRespuesta = { data: null, error: { code: "PGRST202", message: "Could not find the function bvsala.ingest_verification_batch" } };
    const res = await POST(peticion(sobre()));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "verification store unavailable" });
    expect(alertas).toEqual([]);
  });

  it("otro error de la función → 500 y alerta en nivel «aviso» (no son datos de facturación)", async () => {
    estado.rpcRespuesta = { data: null, error: { code: "23514", message: "check constraint" } };
    const res = await POST(peticion(sobre()));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "verification ingest failed" });
    expect(alertas.map((a) => a.nivel)).toEqual(["aviso"]);
  });
});
