import { describe, expect, it } from "vitest";

import {
  conVerjaDeLatencia,
  cronometrar,
  motivosBloqueoLatencia,
  percentilesLatencia,
  PRESUPUESTOS_LATENCIA_B2,
  resumirLatencias,
} from "../benchmarks/b2/latencia.js";

const muestrasValidas = {
  A: [{ totalMs: 100, providerMs: 95 }],
  A1: [{ totalMs: 100, providerMs: 95 }],
  A2: [{ totalMs: 100, providerMs: 95 }],
  B: [{ totalMs: 120, providerMs: 95 }],
};

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
