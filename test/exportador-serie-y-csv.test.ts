import { describe, it, expect } from "vitest";

import { toCsv, toFocusRows, toSavingsSeries, type SavingsRecord } from "../src/index.js";
import { informeSintetico, type ParcheDeInforme } from "./helpers/informe-sintetico.js";

/**
 * LA SERIE DIARIA Y EL CSV.
 *
 * La serie es lo que se sube como métrica (Vantage ignora las columnas `x_` de
 * FOCUS) y el CSV es el formato de todos los destinos. Del CSV se defiende lo
 * que rompe un importador sin avisar: comillas, saltos, CRLF, null frente a
 * cadena vacía y números en notación científica.
 */

const registro = (at: SavingsRecord["at"], p: ParcheDeInforme = {}): SavingsRecord => ({ at, report: informeSintetico(p) });

describe("toSavingsSeries", () => {
  it("date en YYYY-MM-DD, una columna de ahorro por basis y shadow fuera", () => {
    const at = "2026-09-27T18:30:00Z";
    const serie = toSavingsSeries([
      registro(at, { cost: { basis: "measured", baselineEstimate: 0.3, actual: 0.1 } }),
      registro(at, { cost: { basis: "measured", baselineEstimate: 0.2, actual: 0.1 } }),
      registro(at, { cost: { basis: "estimated", baselineEstimate: 1, actual: 0 } }),
      registro(at, { cost: { basis: "shadow", baselineEstimate: 9, actual: 0 } }),
    ]);
    expect(serie).toHaveLength(2);
    const [medida, estimada] = serie;
    expect(medida!.date).toBe("2026-09-27");
    expect(medida!.periodStart).toBe("2026-09-27T00:00:00Z");
    expect(medida!.periodEnd).toBe("2026-09-28T00:00:00Z");
    expect(medida!.basis).toBe("measured");
    expect(medida!.requests).toBe(2);
    expect(medida!.measuredSavings).toBeCloseTo(0.3, 12);
    expect([medida!.referenceSavings, medida!.estimatedSavings]).toEqual([null, null]);
    expect(estimada!.estimatedSavings).toBe(1);
    expect([estimada!.measuredSavings, estimada!.referenceSavings]).toEqual([null, null]);
    expect(medida!.currency).toBe("USD");
    expect(medida!.dimensions).toEqual({});
  });

  it("cuenta lo mismo que FOCUS: es el mismo agregado", () => {
    const registros = [0, 1, 2, 3, 4, 5].map((i) =>
      registro(Date.UTC(2026, 8, 20 + (i % 2)), {
        cost: { basis: i % 3 === 0 ? "reference" : "measured", baselineEstimate: 0.01 * (i + 1), actual: 0.004 * i },
      }),
    );
    const serie = toSavingsSeries(registros);
    const focus = toFocusRows(registros, { billingAccountId: "org" });
    expect(serie.map((s) => [s.periodStart, s.model, s.basis, s.measuredSavings, s.referenceSavings])).toEqual(
      focus.map((f) => [
        f.ChargePeriodStart,
        f.x_BiVelioModelId,
        f.x_BiVelioBasis,
        f.x_BiVelioMeasuredSavings,
        f.x_BiVelioReferenceSavings,
      ]),
    );
  });

  it("unmeasured sale con contadores y el dinero a null", () => {
    const [s] = toSavingsSeries([registro(0, { cost: { basis: "unmeasured", actual: 0.5 } })]);
    expect([s!.baselineCost, s!.actualCost, s!.measuredSavings, s!.eliminatedInputFloorCost]).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(s!.actualInputTokens).toBe(100);
  });

  it("las dimensiones separan filas; una que repite una columna fija es un TypeError", () => {
    const rs = [registro(0, { requestId: "a" }), registro(0, { requestId: "b" })];
    const serie = toSavingsSeries(rs, { dimensions: (r) => ({ team: r.report.requestId }) });
    expect(serie.map((s) => s.dimensions)).toEqual([{ team: "a" }, { team: "b" }]);
    expect(Object.isFrozen(serie[0]!.dimensions)).toBe(true);
    for (const choca of ["date", "model", "basis", "measuredSavings", "dimensions"]) {
      expect(() => toSavingsSeries(rs, { dimensions: () => ({ [choca]: "x" }) }), choca).toThrow(TypeError);
    }
    expect(() => toSavingsSeries(rs, { dimensions: () => ({ team: 3 as unknown as string }) })).toThrow(TypeError);
  });

  it("granularidad por hora y validación de moneda y granularidad", () => {
    const rs = [registro("2026-09-27T10:59:59Z"), registro("2026-09-27T11:00:00Z")];
    expect(toSavingsSeries(rs, { granularity: "hour" }).map((s) => s.periodStart)).toEqual([
      "2026-09-27T10:00:00Z",
      "2026-09-27T11:00:00Z",
    ]);
    expect(() => toSavingsSeries(rs, { currency: "EURO" })).toThrow(TypeError);
    expect(() => toSavingsSeries(rs, { granularity: "week" as "day" })).toThrow(TypeError);
  });
});

/** Un analizador CSV mínimo (RFC 4180) para la ida y vuelta. null = campo vacío sin comillas. */
function leerCsv(texto: string): (string | null)[][] {
  const filas: (string | null)[][] = [];
  let fila: (string | null)[] = [];
  let i = 0;
  while (i < texto.length) {
    let valor: string | null;
    if (texto[i] === '"') {
      let s = "";
      i++;
      for (;;) {
        if (texto[i] === '"' && texto[i + 1] === '"') {
          s += '"';
          i += 2;
        } else if (texto[i] === '"') {
          i++;
          break;
        } else {
          s += texto[i++];
        }
      }
      valor = s;
    } else {
      let s = "";
      while (i < texto.length && texto[i] !== "," && texto[i] !== "\r") s += texto[i++];
      valor = s === "" ? null : s;
    }
    fila.push(valor);
    if (texto[i] === ",") {
      i++;
    } else if (texto[i] === "\r" && texto[i + 1] === "\n") {
      filas.push(fila);
      fila = [];
      i += 2;
    } else if (i < texto.length) {
      throw new Error(`CSV mal formado en ${i}`);
    }
  }
  return filas;
}

describe("toCsv", () => {
  it("comillas RFC 4180 (comas, comillas y saltos), CRLF y null vacío sin comillas", () => {
    const csv = toCsv([{ a: 'dice "hola", y\nsigue', b: null, c: "", d: true, e: undefined }]);
    expect(csv).toBe('a,b,c,d,e\r\n"dice ""hola"", y\nsigue",,"",true,\r\n');
  });

  it("números: 5e-7 se escribe 0.0000005, −0 se escribe 0 y el signo negativo se conserva", () => {
    const csv = toCsv([{ a: 5e-7, b: -0, c: -0.5, d: 1e21, e: 123456789.123456789, f: 1e-11, g: 2 }]);
    // 123456789.123456789 no existe en coma flotante: el double más cercano, a 10 decimales.
    expect(csv.split("\r\n")[1]).toBe("0.0000005,0,-0.5,1000000000000000000000,123456789.123456791,0,2");
    expect(() => toCsv([{ a: Number.NaN }])).toThrow(TypeError);
    expect(() => toCsv([{ a: Number.POSITIVE_INFINITY }])).toThrow(TypeError);
  });

  it("un objeto en una celda es un TypeError, nunca «[object Object]»: la serie se aplana antes", () => {
    expect(() => toCsv([{ a: {} as unknown as string }])).toThrow(TypeError);
    expect(() => toCsv([{ a: ["x"] as unknown as string }])).toThrow(TypeError);
    const serie = toSavingsSeries([registro("2026-09-27T00:00:00Z")], { dimensions: () => ({ team: "a" }) });
    expect(() => toCsv(serie as never)).toThrow(/dimensions/);
    const plana = serie.map(({ dimensions, ...resto }) => ({ ...resto, ...dimensions }));
    expect(toCsv(plana).split("\r\n")[0]).toContain(",team");
  });

  it("toCsv([]) es la cadena vacía, y con columns es solo la cabecera", () => {
    expect(toCsv([])).toBe("");
    expect(toCsv([], { columns: ["date", "amount"] })).toBe("date,amount\r\n");
    expect(toCsv([{ a: 1, b: 2 }], { columns: ["b"] })).toBe("b\r\n2\r\n");
  });

  it("la cabecera de las filas FOCUS sigue el orden fijado: primero FOCUS, luego x_BiVelio*", () => {
    const filas = toFocusRows([registro("2026-09-27T00:00:00Z")], { billingAccountId: "org" });
    const cabecera = toCsv(filas).split("\r\n")[0]!.split(",");
    expect(cabecera).toEqual([
      "BilledCost", "EffectiveCost", "ListCost", "ContractedCost", "BillingCurrency", "BillingAccountId",
      "BillingAccountName", "BillingPeriodStart", "BillingPeriodEnd", "ChargePeriodStart", "ChargePeriodEnd",
      "ChargeCategory", "ChargeClass", "ChargeDescription", "ChargeFrequency", "InvoiceIssuerName",
      "ServiceProviderName", "HostProviderName", "ServiceName", "ServiceCategory", "ServiceSubcategory",
      "PricingQuantity", "PricingUnit", "SubAccountId", "SubAccountName", "Tags",
      "x_BiVelioBasis", "x_BiVelioModelId", "x_BiVelioRequestCount", "x_BiVelioProviderCallCount",
      "x_BiVelioAvoidedCallCount", "x_BiVelioBaselineCost", "x_BiVelioActualCost", "x_BiVelioMeasuredSavings",
      "x_BiVelioReferenceSavings", "x_BiVelioEstimatedSavings", "x_BiVelioEliminatedInputFloorCost",
      "x_BiVelioBaselineInputTokens", "x_BiVelioActualInputTokens", "x_BiVelioEliminatedInputTokens",
      "x_BiVelioCompressedInputTokens", "x_BiVelioProviderCachedInputTokens", "x_BiVelioBaselineOutputTokens",
      "x_BiVelioActualOutputTokens", "x_BiVelioEliminatedOutputTokens",
    ]);
  });

  it("ida y vuelta: lo que se escribe se lee igual, con null donde había null", () => {
    const filas = toFocusRows(
      [
        registro("2026-09-27T00:00:00Z", { cost: { basis: "measured", baselineEstimate: 0.0000051, actual: 0.0000036 } }),
        registro("2026-09-27T00:00:00Z", { model: "anthropic/claude-sonnet-4-5", cost: { basis: "unmeasured" } }),
      ],
      { billingAccountId: "org, \"quoted\"", tags: () => ({ note: "a,b\nc" }) },
    );
    const leido = leerCsv(toCsv(filas));
    const [cabecera, ...cuerpo] = leido;
    expect(cuerpo).toHaveLength(2);
    cuerpo.forEach((valores, i) => {
      const fila = filas[i] as Record<string, unknown>;
      cabecera!.forEach((col, j) => {
        const original = fila[col!];
        const v = valores[j];
        if (original === null) expect(v, col!).toBeNull();
        else if (typeof original === "number") expect(Number(v), col!).toBe(original);
        else expect(v, col!).toBe(String(original));
      });
    });
    expect(JSON.parse(cuerpo[0]![cabecera!.indexOf("Tags")]!)).toMatchObject({ note: "a,b\nc" });
  });
});
