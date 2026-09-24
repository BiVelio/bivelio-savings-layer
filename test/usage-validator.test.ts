import { describe, it, expect } from "vitest";

import { REGLA_REFERENCIA } from "../apps/web/lib/billing/tarifa.js";
import {
  DESFASE_RELOJ_REFERENCIA_MS,
  EDAD_MAXIMA_REFERENCIA_MS,
  parseUsageRecord,
  parseUsageRecords,
  UsageValidationError,
} from "../apps/web/lib/metering/usage.js";

/**
 * The metering ingest's content backstop. This is a privacy-critical invariant:
 * the control plane must accept ONLY counts/metadata, never a prompt/completion.
 */
const clean = {
  requestId: "req_123",
  model: "openai/gpt-4o-mini",
  cacheResult: "miss",
  seatId: "bvk_ab12:9f3c",
  ci: false,
  at: Date.now(),
  avoidedLlm: 0,
  actualLlm: 1,
  baselineInputTokens: 100,
  actualInputTokens: 40,
  eliminatedInputTokens: 60,
  compressedInputTokens: 0,
  baselineOutputTokens: 20,
  actualOutputTokens: 20,
  providerCachedInputTokens: 0,
  baselineCost: 0.001,
  actualCost: 0.0004,
  netSavings: 0.0006,
};

describe("usage ingest content backstop", () => {
  it("accepts a clean counts-only record and server-derives orgId", () => {
    const r = parseUsageRecord(clean, "org-server-derived");
    expect(r.orgId).toBe("org-server-derived");
    expect(r.seatId).toBe("bvk_ab12:9f3c");
    expect(r.ci).toBe(false);
  });

  it("REJECTS any content field (prompt/completion/messages) — the privacy invariant", () => {
    for (const bad of ["prompt", "completion", "messages", "text", "input"]) {
      expect(() => parseUsageRecord({ ...clean, [bad]: "secret user content" }, "o")).toThrow(UsageValidationError);
    }
  });

  it("ignores a client-supplied orgId — it is always server-derived", () => {
    const r = parseUsageRecord({ ...clean, orgId: "other-tenant" }, "my-org");
    expect(r.orgId).toBe("my-org");
  });

  it("constrains seatId/model/requestId to the identity charset (no free-text channel)", () => {
    expect(() => parseUsageRecord({ ...clean, seatId: "has spaces and 💬" }, "o")).toThrow(UsageValidationError);
    expect(() => parseUsageRecord({ ...clean, requestId: "a".repeat(200) }, "o")).toThrow(UsageValidationError);
  });

  it("rejects a non-finite number and a bad cacheResult enum", () => {
    expect(() => parseUsageRecord({ ...clean, actualCost: Number.NaN }, "o")).toThrow(UsageValidationError);
    expect(() => parseUsageRecord({ ...clean, cacheResult: "totally-made-up" }, "o")).toThrow(UsageValidationError);
  });

  it("rejects an oversized batch", () => {
    expect(() => parseUsageRecords(new Array(1001).fill(clean), "o")).toThrow(/batch too large/);
  });
});

/**
 * Dominio de los datos, no solo su tipo. El validador solo exigía
 * `Number.isFinite`, así que dejaba entrar dos clases de basura que luego
 * corrompen los agregados sin dejar rastro.
 */
describe("usage ingest — dominio de los números", () => {
  const base = () => ({ ...clean, at: Date.now() });

  it("rechaza `at` en SEGUNDOS (el desliz de unidad que fechaba todo en 1970)", () => {
    const enSegundos = Math.floor(Date.now() / 1000);
    expect(() => parseUsageRecord({ ...base(), at: enSegundos }, "org")).toThrow(/out of range|MILLISECONDS/i);
  });

  it("rechaza `at` muy en el futuro (reloj del cliente desbocado)", () => {
    expect(() => parseUsageRecord({ ...base(), at: Date.now() + 30 * 86_400_000 }, "org")).toThrow(/out of range/i);
  });

  it("acepta un desfase de reloj razonable", () => {
    expect(() => parseUsageRecord({ ...base(), at: Date.now() + 60_000 }, "org")).not.toThrow();
  });

  it("rechaza recuentos negativos (restaban de los agregados)", () => {
    for (const campo of ["actualInputTokens", "baselineCost", "avoidedLlm"]) {
      expect(() => parseUsageRecord({ ...base(), [campo]: -5 }, "org")).toThrow(/must be >= 0/i);
    }
  });

  it("rechaza un netSavings imposible (> 1) pero ACEPTA uno negativo", () => {
    // Una petición puede salir más cara que la ingenua: eso es una pérdida real
    // y tiene que poder registrarse. Lo que no existe es ahorrar más del 100%.
    expect(() => parseUsageRecord({ ...base(), netSavings: 1.5 }, "org")).toThrow(/ratio in/i);
    expect(() => parseUsageRecord({ ...base(), netSavings: -0.25 }, "org")).not.toThrow();
  });
});

/**
 * 0029 · el carril MEDIDO POR REFERENCIA en la verja del ingest. Todo es
 * RECORTE, no rechazo: un 400 aquí tira el lote entero del cliente sin
 * reintento (y npm es inmutable). Lo incoherente baja a "estimated" y los dos
 * campos opcionales se descartan si no tienen la forma exacta.
 */
describe("usage ingest — basis reference (0029)", () => {
  /** Un acierto exacto de gpt-4o-mini valorado por referencia: 1736/267 a 0,000075 y 0,0006. */
  const referencia = (extra: Record<string, unknown> = {}) => ({
    ...clean,
    at: Date.now(),
    cacheResult: "exact",
    avoidedLlm: 1,
    actualLlm: 0,
    baselineInputTokens: 1736,
    actualInputTokens: 0,
    eliminatedInputTokens: 0,
    compressedInputTokens: 0,
    baselineOutputTokens: 267,
    actualOutputTokens: 0,
    providerCachedInputTokens: 0,
    baselineCost: 0.0002904,
    actualCost: 0,
    netSavings: 1,
    basis: "reference",
    referenceRequestId: "req_poblada-01",
    referenceAt: Date.now() - 60_000,
    ...extra,
  });

  it("un reference coherente pasa y conserva referenceRequestId y referenceAt", () => {
    const r = parseUsageRecord(referencia(), "org");
    expect(r["basis"]).toBe("reference");
    expect(r.referenceRequestId).toBe("req_poblada-01");
    expect(typeof r.referenceAt).toBe("number");
  });

  it("el seguidor coalescido (singleflight) también puede ser referencia", () => {
    expect(parseUsageRecord(referencia({ cacheResult: "singleflight" }), "org")["basis"]).toBe("reference");
  });

  it("incoherente → estimated, SIN excepción y sin los dos campos", () => {
    for (const [motivo, extra] of [
      ["con coste propio", { actualCost: 0.0001 }],
      ["no es un acierto", { cacheResult: "miss" }],
      ["acierto semántico (no es la misma petición)", { cacheResult: "semantic" }],
      ["la llamada corrió", { avoidedLlm: 0, actualLlm: 1 }],
      ["tokens reales", { actualInputTokens: 10 }],
      ["netSavings distinto de 1", { netSavings: 0.5 }],
      ["baseline cero", { baselineCost: 0 }],
      ["sin entrada acreditada", { baselineInputTokens: 0 }],
      // 1736 tokens × 0,002/1K + 267 × 0,08/1K = 0,024832: por encima, ni el mayor precio del catálogo lo justifica.
      ["baseline por encima del techo", { baselineCost: 0.03 }],
    ] as const) {
      let r: ReturnType<typeof parseUsageRecord> | undefined;
      expect(() => (r = parseUsageRecord(referencia(extra), "org")), motivo).not.toThrow();
      expect(r!["basis"], motivo).toBe("estimated");
      expect("referenceRequestId" in r!, motivo).toBe(false);
      expect("referenceAt" in r!, motivo).toBe(false);
    }
  });

  it("justo en el techo sigue siendo referencia (el techo es una cota, no un precio)", () => {
    const techo = (1736 / 1000) * 0.002 + (267 / 1000) * 0.08;
    expect(parseUsageRecord(referencia({ baselineCost: techo }), "org")["basis"]).toBe("reference");
  });

  it("referenceAt en SEGUNDOS o referenceRequestId con espacios se descartan sin 400 — y sin puntero no hay referencia", () => {
    // Revisión adversaria de PR-A: un acierto sin puntero a la petición que
    // corrió es una fila del CSV que el cliente no puede contrastar. Se
    // descarta el campo (recorte, nunca 400) y el registro baja a estimated.
    const enSegundos = parseUsageRecord(referencia({ referenceAt: Math.floor(Date.now() / 1000) }), "org");
    expect(enSegundos["basis"]).toBe("estimated");
    expect("referenceAt" in enSegundos).toBe(false);
    expect("referenceRequestId" in enSegundos).toBe(false);

    const conEspacios = parseUsageRecord(referencia({ referenceRequestId: "the user asked about" }), "org");
    expect(conEspacios["basis"]).toBe("estimated");
    expect("referenceRequestId" in conEspacios).toBe(false);

    for (const malo of [1.5e12 + 0.5, "1758000000000", Date.now() + 30 * 86_400_000]) {
      let r: ReturnType<typeof parseUsageRecord> | undefined;
      expect(() => (r = parseUsageRecord(referencia({ referenceAt: malo }), "org")), String(malo)).not.toThrow();
      expect("referenceAt" in r!).toBe(false);
      expect(r!["basis"]).toBe("estimated");
    }
  });

  it("sin referenceRequestId o sin referenceAt → estimated, jamás 400", () => {
    const { referenceRequestId: _id, ...sinId } = referencia();
    const { referenceAt: _at, ...sinAt } = referencia();
    for (const [motivo, cuerpo] of [["sin referenceRequestId", sinId], ["sin referenceAt", sinAt]] as const) {
      let r: ReturnType<typeof parseUsageRecord> | undefined;
      expect(() => (r = parseUsageRecord(cuerpo, "org")), motivo).not.toThrow();
      expect(r!["basis"], motivo).toBe("estimated");
      expect("referenceRequestId" in r!, motivo).toBe(false);
      expect("referenceAt" in r!, motivo).toBe(false);
    }
  });

  it("la EDAD que publica el extracto se comprueba en el servidor: at − referenceAt ≤ 30 días (± 5 min de reloj)", () => {
    expect(EDAD_MAXIMA_REFERENCIA_MS).toBe(REGLA_REFERENCIA.edadMaximaDias * 86_400_000);
    expect(DESFASE_RELOJ_REFERENCIA_MS).toBe(5 * 60_000);
    const at = Date.now();
    const con = (edadMs: number) => parseUsageRecord(referencia({ at, referenceAt: at - edadMs }), "org")["basis"];
    expect(con(0)).toBe("reference");
    expect(con(EDAD_MAXIMA_REFERENCIA_MS)).toBe("reference");
    // Un acierto leído justo en el límite y sellado un poco después sigue valiendo.
    expect(con(EDAD_MAXIMA_REFERENCIA_MS + 4 * 60_000)).toBe("reference");
    expect(con(EDAD_MAXIMA_REFERENCIA_MS + DESFASE_RELOJ_REFERENCIA_MS + 1)).toBe("estimated");
    expect(con(31 * 86_400_000)).toBe("estimated");
    // Un contador «del futuro» respecto al acierto: tolerado solo el desfase de reloj.
    expect(con(-4 * 60_000)).toBe("reference");
    expect(con(-DESFASE_RELOJ_REFERENCIA_MS - 1)).toBe("estimated");
  });

  it("una llamada evitada no tiene tokens quitados, comprimidos ni cacheados: si los trae, estimated", () => {
    for (const extra of [{ eliminatedInputTokens: 5 }, { compressedInputTokens: 5 }, { providerCachedInputTokens: 5 }]) {
      const r = parseUsageRecord(referencia(extra), "org");
      expect(r["basis"], JSON.stringify(extra)).toBe("estimated");
      expect("referenceRequestId" in r, JSON.stringify(extra)).toBe(false);
    }
    // Un suelo de elisión a 0 (o recortado a 0 por falta de conteo) no molesta.
    expect(parseUsageRecord(referencia({ eliminatedInputFloorCost: 0 }), "org")["basis"]).toBe("reference");
    expect(parseUsageRecord(referencia({ eliminatedInputFloorCost: 0.001 }), "org")["basis"]).toBe("reference");
  });

  it("los dos campos con basis estimated (o sin basis) se eliminan", () => {
    const est = parseUsageRecord(referencia({ basis: "estimated" }), "org");
    expect(est["basis"]).toBe("estimated");
    expect("referenceRequestId" in est).toBe(false);
    expect("referenceAt" in est).toBe(false);
    const { basis: _b, ...sinBasis } = referencia();
    const r = parseUsageRecord(sinBasis, "org");
    expect("referenceRequestId" in r).toBe(false);
  });

  it('"verified" (el vocabulario del A/B) sigue siendo un 400', () => {
    expect(() => parseUsageRecord(referencia({ basis: "verified" }), "org")).toThrow(/basis/);
  });

  it("un aviso POR LOTE con los degradados y los campos descartados, nunca uno por registro", () => {
    const avisos: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void avisos.push(args);
    try {
      parseUsageRecords(
        [referencia(), referencia({ actualCost: 1 }), referencia({ referenceAt: 5 }), referencia({ cacheResult: "miss" })],
        "org",
      );
    } finally {
      console.warn = original;
    }
    const deReferencia = avisos.filter((a) => String(a[0]).includes("basis reference degradado"));
    expect(deReferencia).toHaveLength(1);
    // referenceAt: 5 se descarta Y deja al registro sin puntero: también se degrada.
    expect(deReferencia[0]![1]).toEqual({ registros: 4, degradados: 3, camposDescartados: 1 });
  });
});
