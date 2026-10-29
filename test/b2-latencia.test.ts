import { describe, expect, it } from "vitest";

import {
  conVerjaDeLatencia,
  cronometrar,
  evaluarLatencia,
  motivosBloqueoLatencia,
  percentilesLatencia,
  PRESUPUESTOS_LATENCIA_B2,
  PRESUPUESTOS_TRABAJO_CAPA_B2,
  PROTOCOLO_LATENCIA_B2,
  PROTOCOLO_LATENCIA_B2_F0,
  resumirLatencias,
  type EstadoDeMuestra,
  type MuestraLatenciaF1,
} from "../benchmarks/b2/latencia.js";

const muestrasValidas = {
  A: [{ totalMs: 100, providerMs: 95 }],
  A1: [{ totalMs: 100, providerMs: 95 }],
  A2: [{ totalMs: 100, providerMs: 95 }],
  B: [{ totalMs: 120, providerMs: 95 }],
};

const f1 = (totalMs: number, providerWaitMs: number, layerWorkMs: number, harnessMs: number, estado: EstadoDeMuestra = "completed"): MuestraLatenciaF1 => ({
  totalMs,
  providerWaitMs,
  layerWorkMs,
  harnessMs,
  estado,
});
const muestrasF1Validas = () => ({
  A: [f1(100, 90, 0, 10)],
  A1: [f1(100, 90, 0, 10)],
  A2: [f1(100, 90, 0, 10)],
  B: [f1(120, 90, 20, 10)],
});

describe("protocolo B2-F0: presupuesto y cronometría", () => {
  it("fija p95 en 3000ms y el techo absoluto en 5000ms", () => {
    expect(PRESUPUESTOS_LATENCIA_B2).toEqual({ p95Ms: 3000, maxMs: 5000 });
  });

  it("cronometra con el reloj monótono inyectado, no con Date.now", async () => {
    const instantes = [100, 112.5];
    const medida = await cronometrar(async () => {
      await Promise.resolve();
      return "respuesta";
    }, () => instantes.shift()!);
    expect(medida).toEqual({ value: "respuesta", durationMs: 12.5 });
    expect(instantes).toEqual([]);
  });

  it("agrega p50/p95/max con el percentil tipo 7 del banco", () => {
    expect(percentilesLatencia([400, 100, 300, 200])).toEqual({ n: 4, p50: 250, p95: 385, max: 400 });
  });

  it("conserva proveedor, total y overhead por brazo y distingue MOCK de LIVE", () => {
    const mock = resumirLatencias(muestrasValidas, "MOCK");
    expect(mock).toMatchObject({ status: "estimated", instrumental: true, productionSla: "not-applicable" });
    expect(mock.arms.B?.provider).toMatchObject({ p50: 95, p95: 95, max: 95 });
    expect(mock.arms.B?.total).toMatchObject({ p50: 120, p95: 120, max: 120 });
    expect(mock.arms.B?.layerOverhead).toMatchObject({ p50: 25, p95: 25, max: 25 });
    expect(resumirLatencias(muestrasValidas, "LIVE")).toMatchObject({
      status: "measured",
      instrumental: false,
      productionSla: "assessed",
    });
  });
});

describe("protocolo B2-F0: verja de latencia", () => {
  it("acepta los límites exactos p95=3000 y max=5000", () => {
    const limite = Array.from({ length: 96 }, () => ({ totalMs: 3000, providerMs: 2900 }));
    limite.push(...Array.from({ length: 4 }, () => ({ totalMs: 5000, providerMs: 4900 })));
    const informe = resumirLatencias({ ...muestrasValidas, B: limite }, "LIVE");
    expect(informe.arms.B?.total).toMatchObject({ p95: 3000, max: 5000 });
    expect(motivosBloqueoLatencia(informe, [], "LIVE")).toEqual([]);
  });

  it("bloquea p95 aunque max todavía no llegue a 5000", () => {
    const informe = resumirLatencias({
      ...muestrasValidas,
      B: [{ totalMs: 100, providerMs: 90 }, { totalMs: 4000, providerMs: 3900 }],
    }, "LIVE");
    const motivos = motivosBloqueoLatencia(informe, [], "LIVE");
    expect(motivos.join(" ")).toMatch(/p95=3805ms.*3000ms/);
    expect(motivos.join(" ")).not.toMatch(/techo absoluto/);
  });

  it("bloquea cualquier request por encima de 5000 y deja el motivo en el artefacto", () => {
    const informe = resumirLatencias({ ...muestrasValidas, B: [{ totalMs: 5001, providerMs: 4900 }] }, "LIVE");
    const conVerja = conVerjaDeLatencia(informe, [], "LIVE");
    expect(conVerja.gate?.approved).toBe(false);
    expect(conVerja.gate?.reasons.join(" ")).toMatch(/max=5001ms.*5000ms/);
  });

  it("aplica la verja también a cada escenario, no solo al agregado", () => {
    const informe = resumirLatencias(muestrasValidas, "LIVE");
    const lento = resumirLatencias({ ...muestrasValidas, A2: [{ totalMs: 5001, providerMs: 5000 }] }, "LIVE");
    const motivos = motivosBloqueoLatencia(informe, [{ name: "lento", latency: lento }], "LIVE");
    expect(motivos.join(" ")).toMatch(/scenario lento arms\.A2\.total max=5001ms/);
  });

  it("LIVE no puede ocultar un brazo activo en activeArms", () => {
    const informe = resumirLatencias(muestrasValidas, "LIVE");
    informe.activeArms = informe.activeArms.filter((b) => b !== "A1");
    expect(motivosBloqueoLatencia(informe, [], "LIVE").join(" ")).toMatch(/no incluye el brazo A1/);
  });

  it("MOCK nunca puede presentarse como medición de SLA de producción", () => {
    const informe = resumirLatencias(muestrasValidas, "LIVE");
    expect(motivosBloqueoLatencia(informe, [], "MOCK").join(" ")).toMatch(/productionSla.*not-applicable/);
  });
});

describe("protocolo B2-F1: evidencia separada y fallos visibles", () => {
  it("conserva los cuatro componentes y publica el resultado de ambos presupuestos por brazo", () => {
    const informe = resumirLatencias(muestrasF1Validas(), "LIVE");
    expect(informe.protocol).toBe(PROTOCOLO_LATENCIA_B2);
    expect(PRESUPUESTOS_TRABAJO_CAPA_B2).toEqual({ p95Ms: 250, maxMs: 500 });
    expect(informe.arms.B).toMatchObject({
      total: { n: 1, p95: 120, max: 120 },
      providerWait: { n: 1, p95: 90, max: 90 },
      layerWork: { n: 1, p95: 20, max: 20 },
      harness: { n: 1, p95: 10, max: 10 },
      outcomes: { completed: 1, deadline_exceeded: 0, provider_error: 0 },
      interactiveSlo: { ok: true },
      layerWorkBudget: { ok: true },
    });
    expect(evaluarLatencia(informe, [], "LIVE")).toMatchObject({ interactiveSloOk: true, layerOk: true, releaseOk: true });
  });

  it("A lenta y B lenta quedan visibles aunque el proveedor explique el total y la capa pase aparte", () => {
    const informe = resumirLatencias({
      ...muestrasF1Validas(),
      A: [f1(4000, 3950, 0, 50)],
      B: [f1(4200, 4100, 50, 50)],
    }, "LIVE");
    const v = evaluarLatencia(informe, [], "LIVE");
    expect(v.interactiveSloOk).toBe(false);
    expect(v.layerOk).toBe(true);
    expect(v.releaseOk).toBe(true);
    expect(v.interactiveSloReasons.join(" ")).toMatch(/arms\.A\.total p95=4000ms/);
    expect(v.interactiveSloReasons.join(" ")).toMatch(/arms\.B\.total p95=4200ms/);
  });

  it("el trabajo de capa decide aparte aunque el total interactivo esté dentro de presupuesto", () => {
    const informe = resumirLatencias({ ...muestrasF1Validas(), B: [f1(400, 50, 300, 50)] }, "LIVE");
    const v = evaluarLatencia(informe, [], "LIVE");
    expect(v.interactiveSloOk).toBe(true);
    expect(v.layerOk).toBe(false);
    expect(v.layerReasons.join(" ")).toMatch(/layerWork p95=300ms.*250ms/);
  });

  it("un timeout conserva duración y muestra, falla el SLO incluso por debajo de 5 s y no borra otros errores", () => {
    const informe = resumirLatencias({
      ...muestrasF1Validas(),
      B: [f1(100, 90, 5, 5, "deadline_exceeded"), f1(110, 90, 10, 10, "provider_error")],
    }, "LIVE");
    expect(informe.arms.B).toMatchObject({
      total: { n: 2, max: 110 },
      providerWait: { n: 2 },
      layerWork: { n: 2 },
      harness: { n: 2 },
      outcomes: { completed: 0, deadline_exceeded: 1, provider_error: 1 },
    });
    const v = evaluarLatencia(informe, [], "LIVE");
    expect(v.interactiveSloOk).toBe(false);
    expect(v.layerOk).toBe(true);
    expect(v.interactiveSloReasons.join(" ")).toMatch(/deadline_exceeded/);
    expect(conVerjaDeLatencia(informe, [], "LIVE").gate?.approved).toBe(false);
  });

  it("no pierde brazos y recalcula también el trabajo de capa por escenario", () => {
    const conExtra = resumirLatencias({ ...muestrasF1Validas(), S: [f1(100, 80, 10, 10)], E: [f1(100, 80, 10, 10)] }, "LIVE");
    expect(conExtra.activeArms).toEqual(expect.arrayContaining(["A", "A1", "A2", "B", "S", "E"]));
    const escenario = resumirLatencias({ ...muestrasF1Validas(), B: [f1(400, 50, 300, 50)] }, "LIVE");
    const v = evaluarLatencia(resumirLatencias(muestrasF1Validas(), "LIVE"), [{ name: "celda", latency: escenario }], "LIVE");
    expect(v.interactiveSloOk).toBe(true);
    expect(v.layerOk).toBe(false);
    expect(v.layerReasons.join(" ")).toMatch(/scenario celda arms\.B\.layerWork/);
    const sinB = { name: "incompleta", latency: { ...escenario, arms: Object.fromEntries(Object.entries(escenario.arms).filter(([b]) => b !== "B")) } };
    expect(evaluarLatencia(resumirLatencias(muestrasF1Validas(), "LIVE"), [sinB], "LIVE").reasons.join(" ")).toMatch(/scenario incompleta arms\.B falta/);
  });

  it("B2-F0-v1 sigue siendo legible sin inventar evidencia de capa F1", () => {
    const legacy = resumirLatencias(muestrasValidas, "LIVE");
    expect(legacy.protocol).toBe(PROTOCOLO_LATENCIA_B2_F0);
    expect(legacy.arms.B?.layerOverhead.p95).toBe(25);
    expect(evaluarLatencia(legacy, [], "LIVE")).toMatchObject({ interactiveSloOk: true, layerOk: null, releaseOk: true });
    const escenarioSoloTotal = {
      name: "f0",
      latency: { arms: Object.fromEntries(legacy.activeArms.map((b) => [b, { total: legacy.arms[b]!.total }])) },
    };
    expect(evaluarLatencia(legacy, [escenarioSoloTotal], "LIVE").releaseOk).toBe(true);
  });
});
