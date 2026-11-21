import { beforeEach, describe, expect, it, vi } from "vitest";

import { cerrarPeriodo } from "@/lib/billing/cierre";
import type { FilaDiaria } from "@/lib/billing/extracto";
import { orgsExentasPorMedir } from "@/lib/billing/plan-de-la-org";

/**
 * POST /api/metering/usage con una org que SOLO tiene la licencia Medir.
 *
 * POR QUÉ CAMBIÓ ESTE FICHERO (1.2.4). Hasta la 1.2.3 fijaba que TODO registro
 * de una org Medir llegaba a la RPC con baseline == actual: su ahorro se ponía a
 * cero, porque Medir corría en sombra y cualquier ahorro era de un SDK
 * parcheado. Desde la 1.2.4 Medir ahorra de verdad (decisión del dueño,
 * 21-11-2026) y el panel tiene que enseñar ese ahorro: la ingesta lo GUARDA.
 *
 * Lo que fija ahora:
 *  · el ahorro MEDIDO de una org Medir entra intacto;
 *  · NUNCA una referencia cobrable: `reference` → `estimated`, sin puntero;
 *  · NUNCA comisión: el extracto que sale de esos registros, cerrado con la
 *    exención de Medir (la que aplican el cierre y la facturación), cobra 0;
 *  · una org Medir CON historia de la modalidad con comisión se sigue
 *    neutralizando exactamente como antes (para ella nada cambia);
 *  · el hipotético (`basis: "shadow"`) de los clientes ≤ 1.2.3 y de la sombra
 *    opcional pasa intacto al carril sombra, como siempre;
 *  · los topes NO cambian: asientos por mes (402 `measure-seat-limit`) y volumen
 *    diario (429 `measure-volume-limit`), y fail-open si no se pueden leer;
 *  · una org de PAGO no se toca (el mismo lote conserva su ahorro y su referencia).
 */

const ORG = "99999999-9999-4999-8999-999999999999";
const MEDIR = [{ revoked: false, expires_at: "2099-01-01T00:00:00Z", grace_days: 30, plan: "measure" }];
const PRO = [{ revoked: false, expires_at: "2099-01-01T00:00:00Z", grace_days: 14, plan: "pro" }];

let licencias: unknown[] = MEDIR;
/** Las suscripciones de la org, en cualquier estado (por defecto, ninguna: una org Medir pura). */
let suscripciones: Array<{ status: string; current_period_end: string | null; price_id: string | null }> = [];
const PRECIOS = { pro: ["price_pro_m"], equipo: ["price_team_m"] };
/** Una suscripción CANCELADA de la modalidad con comisión: no cubre, pero es historia de comisión. */
const COMISION_CANCELADA = [{ status: "canceled", current_period_end: "2026-10-01T00:00:00Z", price_id: "price_comision_antiguo" }];
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
    if (tabla === "subscriptions") return Promise.resolve({ data: suscripciones, error: null });
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
vi.mock("@/lib/stripe/env", () => ({ preciosSinComision: () => PRECIOS }));

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
    headers: { "content-type": "application/json", authorization: "Bearer bvk_test", "x-bvsala-version": "sdk/0.4.35" },
    body: JSON.stringify(cuerpo),
  });

beforeEach(() => {
  licencias = MEDIR;
  suscripciones = [];
  asientosDelMes = [];
  peticionesHoy = 0;
  fallarLecturaDeTopes = false;
  rpc = null;
});

/** Las filas de usage_daily que la RPC acumularía con estos registros (sus mismos carriles). */
function filaDiariaDe(registros: Array<Record<string, unknown>>): FilaDiaria {
  const fila: FilaDiaria & { reference_requests: number; reference_baseline_cost: number; reference_actual_cost: number } = {
    day: "2026-11-15",
    requests: 0,
    baseline_cost: 0,
    actual_cost: 0,
    measured_requests: 0,
    measured_baseline_cost: 0,
    measured_actual_cost: 0,
    reference_requests: 0,
    reference_baseline_cost: 0,
    reference_actual_cost: 0,
  };
  for (const r of registros) {
    if (r["basis"] === "shadow") continue;
    fila.requests += 1;
    fila.baseline_cost += Number(r["baselineCost"]);
    fila.actual_cost += Number(r["actualCost"]);
    if (r["basis"] === "measured") {
      fila.measured_requests += 1;
      fila.measured_baseline_cost += Number(r["baselineCost"]);
      fila.measured_actual_cost += Number(r["actualCost"]);
    }
    if (r["basis"] === "reference") {
      fila.reference_requests += 1;
      fila.reference_baseline_cost += Number(r["baselineCost"]);
      fila.reference_actual_cost += Number(r["actualCost"]);
    }
  }
  return fila;
}

describe("ingesta de una org Medir · guarda el ahorro REAL", () => {
  it("el ahorro medido entra INTACTO: baseline, tokens eliminados y netSavings como los mandó el cliente", async () => {
    const res = await POST(peticion([registro(), registro({ eliminatedInputFloorCost: 0.0001 })]));
    expect(res.status).toBe(202);
    expect(rpc?.args.records).toHaveLength(2);
    for (const r of rpc!.args.records) {
      expect(r["basis"]).toBe("measured");
      expect(r["baselineCost"]).toBe(0.02);
      expect(r["actualCost"]).toBe(0.008);
      expect(r["baselineInputTokens"]).toBe(1000);
      expect(r["eliminatedInputTokens"]).toBe(500);
      expect(r["compressedInputTokens"]).toBe(100);
      expect(r["netSavings"]).toBe(0.6);
    }
    expect(rpc!.args.records[1]!["eliminatedInputFloorCost"]).toBe(0.0001);
  });

  it("una llamada EVITADA (caché exacta, estimated) conserva su ahorro: es lo que el panel no enseñaba", async () => {
    const evitada = registro({ cacheResult: "exact", avoidedLlm: 1, actualLlm: 0, actualInputTokens: 0, actualOutputTokens: 0, eliminatedInputTokens: 0, compressedInputTokens: 0, baselineCost: 0.00016695, actualCost: 0, netSavings: 1, basis: "estimated" });
    await POST(peticion([evitada]));
    const r = rpc!.args.records[0]!;
    expect(r["baselineCost"]).toBe(0.00016695);
    expect(r["actualCost"]).toBe(0);
    expect(r["avoidedLlm"]).toBe(1);
    expect(r["netSavings"]).toBe(1);
  });
});

describe("ingesta de una org Medir · nunca comisión, nunca referencia cobrable", () => {
  it("una repetición por referencia entra como estimated, sin puntero: ninguna fila de reference_hits", async () => {
    const res = await POST(peticion([referencia()]));
    expect(res.status).toBe(202);
    const r = rpc!.args.records[0]!;
    expect(r["basis"]).toBe("estimated");
    expect("referenceRequestId" in r).toBe(false);
    expect("referenceAt" in r).toBe(false);
    // Su ahorro sigue contando en los totales del panel, como estimado.
    expect(r["baselineCost"]).toBe(0.0005);
    expect(r["avoidedLlm"]).toBe(1);
  });

  it("el registro sombra (lo que HABRÍA ahorrado, clientes ≤ 1.2.3 y sombra opcional) pasa intacto", async () => {
    const sombra = registro({ requestId: "req-x:shadow", basis: "shadow", baselineCost: 0.01, actualCost: 0, netSavings: 1 });
    await POST(peticion([registro({ requestId: "req-x" }), sombra]));
    const s = rpc!.args.records.find((r) => r["basis"] === "shadow")!;
    expect(s["baselineCost"]).toBe(0.01);
    expect(s["actualCost"]).toBe(0);
  });

  it("el extracto que sale de esos registros cobra CERO, aunque el ahorro medido sea real y grande", async () => {
    // Un mes de ahorro serio (1 200 $ de ahorro medido), para que la comisión NO sea cero por pequeña.
    await POST(peticion([registro({ baselineCost: 2000, actualCost: 800 }), registro({ baselineCost: 0.02, actualCost: 0.008 }), referencia()]));
    const fila = filaDiariaDe(rpc!.args.records);
    expect(fila.measured_baseline_cost - fila.measured_actual_cost).toBeGreaterThan(1000);
    expect(fila.reference_requests).toBe(0);

    // Lo que hacen el cierre (cargo) y la facturación (segunda verja) con esta org:
    const exentas = orgsExentasPorMedir([{ org_id: ORG, issued_at: "2026-11-01T00:00:00Z" }], suscripciones.map((s) => ({ org_id: ORG, ...s })), PRECIOS, "2026-12-01");
    expect(exentas.has(ORG)).toBe(true);
    const [cierre] = cerrarPeriodo(
      [{ orgId: ORG, filas: [fila], primerPeriodoConUso: "2026-10", comisionExenta: exentas.has(ORG) }],
      "2026-11",
      { eurPorUsd: 0.9, fuente: "test" },
    );
    expect(cierre!.ahorro_medido_usd).toBeGreaterThan(1000);
    expect(cierre!.es_exento).toBe(true);
    expect(cierre!.cargo_eur).toBe(0);
  });

  it("CON HISTORIA DE COMISIÓN (canceló esa modalidad y volvió a Medir): se neutraliza EXACTAMENTE como antes", async () => {
    suscripciones = COMISION_CANCELADA;
    const res = await POST(peticion([registro(), registro({ eliminatedInputFloorCost: 0.0001 }), referencia()]));
    expect(res.status).toBe(202);
    for (const r of rpc!.args.records) {
      expect(r["basis"]).not.toBe("reference");
      expect(r["baselineCost"]).toBe(r["actualCost"]);
      expect(r["baselineInputTokens"]).toBe(r["actualInputTokens"]);
      expect(r["baselineOutputTokens"]).toBe(r["actualOutputTokens"]);
      expect(r["eliminatedInputTokens"]).toBe(0);
      expect(r["compressedInputTokens"]).toBe(0);
      expect(r["avoidedLlm"]).toBe(0);
      expect(r["netSavings"]).toBe(0);
      expect("eliminatedInputFloorCost" in r).toBe(false);
    }
    // Y como no está exenta por Medir, su extracto sigue cobrando 0 por lo mismo que antes: no hay ahorro en la base.
    const fila = filaDiariaDe(rpc!.args.records);
    expect(fila.measured_baseline_cost).toBe(fila.measured_actual_cost);
    const exentas = orgsExentasPorMedir([{ org_id: ORG, issued_at: "2026-11-01T00:00:00Z" }], suscripciones.map((s) => ({ org_id: ORG, ...s })), PRECIOS, "2026-12-01");
    expect(exentas.has(ORG)).toBe(false);
    const [cierre] = cerrarPeriodo([{ orgId: ORG, filas: [fila], primerPeriodoConUso: "2026-10" }], "2026-11", { eurPorUsd: 0.9, fuente: "test" });
    expect(cierre!.cargo_eur).toBe(0);
  });

  it("una suscripción Pro cancelada NO es historia de comisión: su ahorro real se guarda", async () => {
    suscripciones = [{ status: "canceled", current_period_end: "2026-10-01T00:00:00Z", price_id: "price_pro_m" }];
    await POST(peticion([registro()]));
    expect(rpc!.args.records[0]!["baselineCost"]).toBe(0.02);
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

  it("si los topes no se pueden leer, fail-open: el lote entra (y las referencias siguen degradadas)", async () => {
    fallarLecturaDeTopes = true;
    const res = await POST(peticion([registro(), referencia()]));
    expect(res.status).toBe(202);
    expect(rpc!.args.records).toHaveLength(2);
    expect(rpc!.args.records.some((r) => r["basis"] === "reference")).toBe(false);
  });

  it("el lote vacío (la sonda «Test my key») sigue siendo 202 para una org Medir", async () => {
    const res = await POST(peticion([]));
    expect(res.status).toBe(202);
  });
});
