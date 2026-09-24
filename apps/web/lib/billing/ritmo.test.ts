import { describe, it, expect } from "vitest";

import type { UsageRollup } from "@/app/[locale]/dashboard/data";

import { calcularRitmo, diasDelPeriodo, DIAS_MINIMOS_PARA_PROYECTAR } from "./ritmo";
import { calcularComision } from "./tarifa";

/**
 * Las verjas de la proyección. Lo que se protege aquí no es la aritmética —es
 * trivial— sino las tres formas de mentir con ella: proyectar desde dos puntos,
 * dividir por los días que TIENEN filas (y así borrar los fines de semana a
 * cero), y arrastrar la jornada de hoy a medias dentro del divisor.
 */

const fila = (day: string, ahorroUsd: number, baseUsd = ahorroUsd * 3): UsageRollup => ({
  day,
  requests: 10,
  avoidedLlm: 0,
  actualLlm: 10,
  eliminatedInputTokens: 0,
  compressedInputTokens: 0,
  providerCachedInputTokens: 0,
  baselineCost: baseUsd,
  actualCost: baseUsd - ahorroUsd,
  measuredRequests: 10,
  measuredBaselineCost: baseUsd,
  measuredActualCost: baseUsd - ahorroUsd,
});

const base = { periodo: "2026-09", eurPorUsd: 0.9 };

describe("días del período", () => {
  it("cuenta los naturales, bisiestos incluidos", () => {
    expect(diasDelPeriodo("2026-09")).toBe(30);
    expect(diasDelPeriodo("2026-01")).toBe(31);
    expect(diasDelPeriodo("2026-02")).toBe(28);
    expect(diasDelPeriodo("2028-02")).toBe(29);
  });
});

describe("ritmo · cuándo NO se proyecta", () => {
  it("sin filas medidas: no hay nada que promediar", () => {
    const r = calcularRitmo({ ...base, rows: [], hoyIso: "2026-09-10" });
    expect(r.estado).toBe("sin_datos");
    expect(r.proyeccion).toBeNull();
  });

  it("una fila SIN peticiones medidas no cuenta: el estimado no se proyecta", () => {
    const soloEstimado = { ...fila("2026-09-02", 5), measuredRequests: 0, measuredBaselineCost: 0, measuredActualCost: 0 };
    const r = calcularRitmo({ ...base, rows: [soloEstimado], hoyIso: "2026-09-10" });
    expect(r.estado).toBe("sin_datos");
    expect(r.ahorroHastaLaFechaUsd).toBe(0);
  });

  it("con menos de tres días completos NO se traza la recta", () => {
    const r = calcularRitmo({ ...base, rows: [fila("2026-09-01", 10), fila("2026-09-02", 10)], hoyIso: "2026-09-03" });
    expect(r.diasDeRitmo).toBeLessThan(DIAS_MINIMOS_PARA_PROYECTAR);
    expect(r.estado).toBe("pocos_dias");
    expect(r.proyeccion).toBeNull();
    // Pero lo MEDIDO se enseña igual: eso no es una estimación.
    expect(r.ahorroHastaLaFechaUsd).toBe(20);
  });

  it("solo hay datos de HOY: medido sí, ritmo no", () => {
    const r = calcularRitmo({ ...base, rows: [fila("2026-09-04", 12)], hoyIso: "2026-09-04" });
    expect(r.estado).toBe("pocos_dias");
    expect(r.ahorroHastaLaFechaUsd).toBe(12);
    expect(r.proyeccion).toBeNull();
  });

  it("un período ya cerrado se cuenta, no se proyecta", () => {
    const rows = [fila("2026-08-01", 10), fila("2026-08-02", 10), fila("2026-08-03", 10)];
    const r = calcularRitmo({ ...base, periodo: "2026-08", rows, hoyIso: "2026-09-06" });
    expect(r.estado).toBe("cerrado");
    expect(r.proyeccion).toBeNull();
    expect(r.diasTranscurridos).toBe(31);
  });
});

describe("ritmo · el divisor honesto", () => {
  it("HOY entra en lo medido pero NO en el divisor del ritmo", () => {
    // 1,2,3 completos a 10 $; hoy es el 4 y lleva 2 $ a medias.
    const rows = [fila("2026-09-01", 10), fila("2026-09-02", 10), fila("2026-09-03", 10), fila("2026-09-04", 2)];
    const r = calcularRitmo({ ...base, rows, hoyIso: "2026-09-04" });
    expect(r.ahorroHastaLaFechaUsd).toBe(32);
    expect(r.diasDeRitmo).toBe(3);
    expect(r.ahorroPorDiaUsd).toBe(10); // 30/3, sin la jornada a medias
  });

  it("los días a CERO del medio tiran del ritmo hacia abajo", () => {
    // Trabaja el 1 y el 5; el 2,3,4 son fin de semana a cero. El mes que se
    // proyecta también los tiene: el divisor son 5 días, no 2.
    const rows = [fila("2026-09-01", 20), fila("2026-09-05", 20)];
    const r = calcularRitmo({ ...base, rows, hoyIso: "2026-09-06" });
    expect(r.diasDeRitmo).toBe(5);
    expect(r.ahorroPorDiaUsd).toBe(8); // 40/5, no 20
  });

  it("el ritmo RECIENTE mira los últimos siete días, no el mes entero", () => {
    // Una semana floja al principio y una fuerte al final: la proyección tiene
    // que ir con la reciente.
    const rows = [
      ...["01", "02", "03", "04", "05", "06", "07"].map((d) => fila(`2026-09-${d}`, 1)),
      ...["08", "09", "10", "11", "12", "13", "14"].map((d) => fila(`2026-09-${d}`, 10)),
    ];
    const r = calcularRitmo({ ...base, rows, hoyIso: "2026-09-15" });
    expect(r.ahorroPorDiaUsd).toBeCloseTo(77 / 14, 6);
    expect(r.ahorroPorDiaRecienteUsd).toBe(10);
    expect(r.proyeccion?.ritmoUsdDia).toBe(10);
  });
});

describe("ritmo · la proyección", () => {
  const rows = ["01", "02", "03", "04", "05"].map((d) => fila(`2026-09-${d}`, 10));

  it("suma a lo medido el ritmo reciente por los días que QUEDAN", () => {
    const r = calcularRitmo({ ...base, rows, hoyIso: "2026-09-06" });
    expect(r.estado).toBe("ok");
    expect(r.diasTranscurridos).toBe(6);
    expect(r.diasRestantes).toBe(24); // septiembre tiene 30
    // 50 medidos + 10 $/día × 24 días que quedan.
    expect(r.proyeccion?.ahorroUsd).toBeCloseTo(290, 6);
    expect(r.proyeccion?.ahorroEur).toBeCloseTo(261, 6);
  });

  it("la comisión proyectada sale de la MISMA máquina que la del extracto", () => {
    const r = calcularRitmo({ ...base, rows, hoyIso: "2026-09-06" });
    const p = r.proyeccion!;
    expect(p.comision).toEqual(calcularComision(p.baseUsd * 0.9, p.ahorroEur));
  });

  it("el último día del mes ya no proyecta nada hacia delante", () => {
    const r = calcularRitmo({ ...base, rows, hoyIso: "2026-09-30" });
    expect(r.diasRestantes).toBe(0);
    expect(r.proyeccion?.ahorroUsd).toBeCloseTo(r.ahorroHastaLaFechaUsd, 6);
  });

  it("un ahorro medido NEGATIVO se proyecta tal cual, sin maquillar", () => {
    const malos = ["01", "02", "03", "04", "05"].map((d) => fila(`2026-09-${d}`, -2, 30));
    const r = calcularRitmo({ ...base, rows: malos, hoyIso: "2026-09-06" });
    expect(r.ahorroPorDiaRecienteUsd).toBe(-2);
    expect(r.proyeccion!.ahorroUsd).toBeLessThan(0);
    expect(r.proyeccion!.comision.comisionEur).toBe(0);
  });

  it("filas de OTROS períodos no se cuelan", () => {
    const r = calcularRitmo({ ...base, rows: [...rows, fila("2026-08-15", 1000)], hoyIso: "2026-09-06" });
    expect(r.ahorroHastaLaFechaUsd).toBe(50);
  });
});

describe("ritmo · el carril medido por referencia (0029)", () => {
  /** Un día SOLO con repeticiones por referencia: nada medido por su propio contador. */
  const soloReferencia = (day: string, ahorroUsd: number): UsageRollup => ({
    ...fila(day, 0, 0),
    measuredRequests: 0,
    measuredBaselineCost: 0,
    measuredActualCost: 0,
    baselineCost: ahorroUsd,
    actualCost: 0,
    referenceRequests: 5,
    referenceBaselineCost: ahorroUsd,
    referenceActualCost: 0,
  });

  it("un día solo con referencia CUENTA en el ritmo (es medido, como en el extracto)", () => {
    const r = calcularRitmo({ ...base, rows: [soloReferencia("2026-09-02", 4)], hoyIso: "2026-09-10" });
    expect(r.estado).not.toBe("sin_datos");
    expect(r.ahorroHastaLaFechaUsd).toBeCloseTo(4, 10);
    expect(r.baseHastaLaFechaUsd).toBeCloseTo(4, 10);
  });

  it("medido + referencia se suman en el mismo día", () => {
    const dia: UsageRollup = { ...fila("2026-09-02", 10), referenceRequests: 5, referenceBaselineCost: 4, referenceActualCost: 0 };
    const r = calcularRitmo({ ...base, rows: [dia], hoyIso: "2026-09-10" });
    expect(r.ahorroHastaLaFechaUsd).toBeCloseTo(14, 10);
    expect(r.baseHastaLaFechaUsd).toBeCloseTo(34, 10);
  });

  it("sin las columnas de 0029, el ritmo es el de antes", () => {
    const r = calcularRitmo({ ...base, rows: [fila("2026-09-02", 10)], hoyIso: "2026-09-10" });
    expect(r.ahorroHastaLaFechaUsd).toBeCloseTo(10, 10);
  });
});
