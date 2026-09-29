import { beforeEach, describe, expect, it, vi } from "vitest";

import { construirExtracto, type FilaDiaria } from "@/lib/billing/extracto";

/**
 * POST /api/metering/usage con una org que SOLO tiene la licencia Medir.
 *
 * Lo que fija, y es lo que el dueño pidió como test del servidor:
 *  · su uso SE INGIERE (el panel lo necesita), pero NUNCA genera comisión ni una
 *    referencia cobrable: todo registro no-sombra llega a la RPC con baseline ==
 *    actual y sin `reference`, aunque el cliente (un SDK parcheado) mande ahorro
 *    medido y repeticiones por referencia;
 *  · el hipotético (`basis: "shadow"`) pasa intacto al carril sombra;
 *  · el extracto que saldría de esos registros cobra 0;
 *  · los topes: asientos por mes (402 `measure-seat-limit`) y volumen diario
 *    (429 `measure-volume-limit`), y fail-open si no se pueden leer;
 *  · una org de PAGO no se toca (el mismo lote conserva su ahorro).
 */

const ORG = "99999999-9999-4999-8999-999999999999";
const MEDIR = [{ revoked: false, expires_at: "2099-01-01T00:00:00Z", grace_days: 30, plan: "measure" }];
const PRO = [{ revoked: false, expires_at: "2099-01-01T00:00:00Z", grace_days: 14, plan: "pro" }];

let licencias: unknown[] = MEDIR;
let asientosDelMes: { seat_id: string }[] = [];
let peticionesHoy = 0;
let fallarLecturaDeTopes = false;
let rpc: { args: { p_org: string; records: Array<Record<string, unknown>> } } | null = null;

function consulta(tabla: string) {
  const q: Record<string, unknown> = {};
  q["select"] = () => q;
  q["gte"] = () =>
    Promise.resolve(
      fallarLecturaDeTopes ? { data: null, error: { message: "boom" } } : { data: asientosDelMes, error: null },
    );
  q["eq"] = () => {
    if (tabla === "service_accounts") return { maybeSingle: async () => ({ data: { org_id: ORG }, error: null }) };
    if (tabla === "licenses") return Promise.resolve({ data: licencias, error: null });
    if (tabla === "subscriptions") return Promise.resolve({ data: [], error: null });
    return q;
  };
  q["maybeSingle"] = async () =>
    fallarLecturaDeTopes
      ? { data: null, error: { message: "boom" } }
      : { data: tabla === "usage_daily" ? { requests: peticionesHoy } : null, error: null };
  q["update"] = () => ({ eq: async () => ({ error: null }) });
  return q;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabla: string) => consulta(tabla),
    rpc: async (_n: string, args: { p_org: string; records: Array<Record<string, unknown>> }) => {
      rpc = { args };
      return { data: args.records.length, error: null };
    },
  }),
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: () => {},
}));
vi.mock("@/lib/observabilidad/alerta", () => ({ alertar: async () => {} }));

import { POST } from "./route";

let n = 0;
function registro(extra: Record<string, unknown> = {}): Record<string, unknown> {
  n += 1;
  return {
    requestId: `req-${n}`,
    seatId: "seat-a",
    model: "gpt-4o-mini",
    cacheResult: "miss",
    at: Date.now(),
    avoidedLlm: 0,
    actualLlm: 1,
    baselineInputTokens: 1000,
    actualInputTokens: 400,
    eliminatedInputTokens: 500,
    compressedInputTokens: 100,
    baselineOutputTokens: 50,
    actualOutputTokens: 50,
    providerCachedInputTokens: 0,
    baselineCost: 0.02,
    actualCost: 0.008,
    netSavings: 0.6,
    basis: "measured",
    ...extra,
  };
}

/** Una repetición «por referencia» coherente: lo que un SDK de pago mandaría por un acierto exacto. */
function referencia(): Record<string, unknown> {
  const at = Date.now();
  return registro({
    cacheResult: "exact",
    avoidedLlm: 1,
    actualLlm: 0,
    baselineInputTokens: 1000,
    actualInputTokens: 0,
    eliminatedInputTokens: 0,
    compressedInputTokens: 0,
    actualOutputTokens: 0,
    baselineCost: 0.0005,
    actualCost: 0,
    netSavings: 1,
    basis: "reference",
    referenceRequestId: "req-origen",
    referenceAt: at - 60_000,
  });
}

const peticion = (cuerpo: unknown) =>
  new Request("https://savings.bivelio.com/api/metering/usage", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer bvk_test", "x-bvsala-version": "sdk/0.4.33" },
    body: JSON.stringify(cuerpo),
  });

beforeEach(() => {
  licencias = MEDIR;
  asientosDelMes = [];
  peticionesHoy = 0;
  fallarLecturaDeTopes = false;
  rpc = null;
});

describe("ingesta de una org Medir · nunca comisión, nunca referencia cobrable", () => {
  it("el uso entra, pero cada registro medido llega con baseline == actual y sin ahorro", async () => {
    const res = await POST(peticion([registro(), registro({ eliminatedInputFloorCost: 0.0001 })]));
    expect(res.status).toBe(202);
    expect(rpc?.args.records).toHaveLength(2);
    for (const r of rpc!.args.records) {
      expect(r["basis"]).toBe("measured");
      expect(r["baselineCost"]).toBe(r["actualCost"]);
      expect(r["baselineInputTokens"]).toBe(r["actualInputTokens"]);
      expect(r["baselineOutputTokens"]).toBe(r["actualOutputTokens"]);
      expect(r["eliminatedInputTokens"]).toBe(0);
      expect(r["compressedInputTokens"]).toBe(0);
      expect(r["netSavings"]).toBe(0);
      expect("eliminatedInputFloorCost" in r).toBe(false);
    }
  });

  it("una repetición por referencia entra como estimated, sin puntero: ninguna fila de reference_hits", async () => {
    const res = await POST(peticion([referencia()]));
    expect(res.status).toBe(202);
    const r = rpc!.args.records[0]!;
    expect(r["basis"]).toBe("estimated");
    expect("referenceRequestId" in r).toBe(false);
    expect("referenceAt" in r).toBe(false);
    expect(r["baselineCost"]).toBe(r["actualCost"]);
    expect(r["avoidedLlm"]).toBe(0);
  });

  it("el registro sombra (lo que HABRÍA ahorrado) pasa intacto", async () => {
    const sombra = registro({ requestId: "req-x:shadow", basis: "shadow", baselineCost: 0.01, actualCost: 0, netSavings: 1 });
    await POST(peticion([registro({ requestId: "req-x" }), sombra]));
    const s = rpc!.args.records.find((r) => r["basis"] === "shadow")!;
    expect(s["baselineCost"]).toBe(0.01);
    expect(s["actualCost"]).toBe(0);
  });

  it("el extracto que sale de esos registros cobra CERO (base medida = actual medido)", async () => {
    await POST(peticion([registro(), registro(), referencia()]));
    const fila: FilaDiaria = {
      day: "2026-09-15",
      requests: 0,
      baseline_cost: 0,
      actual_cost: 0,
      measured_requests: 0,
      measured_baseline_cost: 0,
      measured_actual_cost: 0,
    };
    for (const r of rpc!.args.records) {
      fila.requests += 1;
      fila.baseline_cost += Number(r["baselineCost"]);
      fila.actual_cost += Number(r["actualCost"]);
      if (r["basis"] === "measured") {
        fila.measured_requests += 1;
        fila.measured_baseline_cost += Number(r["baselineCost"]);
        fila.measured_actual_cost += Number(r["actualCost"]);
      }
    }
    const e = construirExtracto({
      orgId: ORG,
      periodo: "2026-09",
      filas: [fila],
      esCalibracion: false,
      versionPrecios: "test",
      fx: { eurPorUsd: 0.9, fuente: "test" },
    });
    expect(e.comision.ahorroMedidoEur).toBe(0);
    expect(e.cargoEur).toBe(0);
  });

  it("CONTRASTE: la misma carga en una org de PAGO conserva su ahorro y su referencia", async () => {
    licencias = PRO;
    await POST(peticion([registro(), referencia()]));
    const [medido, ref] = rpc!.args.records;
    expect(medido!["baselineCost"]).toBe(0.02);
    expect(medido!["netSavings"]).toBe(0.6);
    expect(ref!["basis"]).toBe("reference");
  });
});

describe("ingesta de una org Medir · los topes", () => {
  it("un asiento nuevo con el mes lleno: 402 measure-seat-limit y nada a la RPC", async () => {
    asientosDelMes = ["s1", "s2", "s3", "s4", "s5"].map((seat_id) => ({ seat_id }));
    const res = await POST(peticion([registro({ seatId: "s6" })]));
    expect(res.status).toBe(402);
    expect(((await res.json()) as { reason: string }).reason).toBe("measure-seat-limit");
    expect(rpc).toBeNull();
  });

  it("un asiento YA conocido sigue entrando con el mes lleno; en un lote mixto solo cae el nuevo", async () => {
    asientosDelMes = ["s1", "s2", "s3", "s4", "s5"].map((seat_id) => ({ seat_id }));
    const res = await POST(peticion([registro({ seatId: "s1" }), registro({ seatId: "s9" })]));
    expect(res.status).toBe(202);
    expect(rpc!.args.records.map((r) => r["seatId"])).toEqual(["s1"]);
    expect(((await res.json()) as { rejectedOverSeatLimit?: number }).rejectedOverSeatLimit).toBe(1);
  });

  it("CI también cuenta como asiento (si no, `ci: true` se saltaría el tope)", async () => {
    asientosDelMes = ["s1", "s2", "s3", "s4", "s5"].map((seat_id) => ({ seat_id }));
    const res = await POST(peticion([registro({ seatId: "runner-1", ci: true })]));
    expect(res.status).toBe(402);
  });

  it("el día lleno: 429 measure-volume-limit", async () => {
    peticionesHoy = 20_000;
    const res = await POST(peticion([registro()]));
    expect(res.status).toBe(429);
    expect(((await res.json()) as { reason: string }).reason).toBe("measure-volume-limit");
    expect(rpc).toBeNull();
  });

  it("con hueco para uno, entra uno (y su registro sombra con él); el resto cae", async () => {
    peticionesHoy = 19_999;
    await POST(
      peticion([
        registro({ requestId: "a" }),
        registro({ requestId: "a:shadow", basis: "shadow", actualCost: 0 }),
        registro({ requestId: "b" }),
        registro({ requestId: "b:shadow", basis: "shadow", actualCost: 0 }),
      ]),
    );
    expect(rpc!.args.records.map((r) => r["requestId"])).toEqual(["a", "a:shadow"]);
  });

  it("si los topes no se pueden leer, fail-open: el lote entra (neutralizado igual)", async () => {
    fallarLecturaDeTopes = true;
    const res = await POST(peticion([registro()]));
    expect(res.status).toBe(202);
    expect(rpc!.args.records[0]!["baselineCost"]).toBe(rpc!.args.records[0]!["actualCost"]);
  });

  it("el lote vacío (la sonda «Test my key») sigue siendo 202 para una org Medir", async () => {
    const res = await POST(peticion([]));
    expect(res.status).toBe(202);
  });
});
