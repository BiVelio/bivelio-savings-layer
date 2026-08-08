import { describe, it, expect, vi } from "vitest";
import { createSavingsLayer } from "../src/pipeline/create.js";
import { createMockProvider } from "../src/providers/mock.js";

/** El SDK documenta ids cualificados ("openai/gpt-4o-mini"), pero la tabla de
 *  precios del proveedor usa la clave desnuda. costModelFor hacía un único
 *  lookup exacto: quien configuraba lo natural fallaba y caía en el precio que
 *  el propio código llama "Illustrative", con desvío de varias veces el real. */
describe("costModelFor: resuelve el id con prefijo de proveedor", () => {
  const barato = { inputPer1k: 0.00015, outputPer1k: 0.0006 };

  it("encuentra el precio configurado con la clave DESNUDA", async () => {
    const layer = createSavingsLayer({
      provider: createMockProvider({ answer: "hola" }),
      devUnlicensed: true,
      costModels: { "gpt-4o-mini": barato },
    });
    const res = await layer.generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "una pregunta cualquiera de prueba" }],
    });
    // Con el precio ilustrativo (0.0005/1k) el coste saldría ~3,3x más alto.
    const esperado = (res.report.tokens.actualInput / 1000) * barato.inputPer1k
                   + (res.report.tokens.actualOutput / 1000) * barato.outputPer1k;
    expect(res.report.cost.actual).toBeCloseTo(esperado, 10);
  });

  it("el id COMPLETO sigue teniendo prioridad sobre el desnudo", async () => {
    const caro = { inputPer1k: 1, outputPer1k: 1 };
    const layer = createSavingsLayer({
      provider: createMockProvider({ answer: "hola" }),
      devUnlicensed: true,
      costModels: { "openai/gpt-4o-mini": caro, "gpt-4o-mini": barato },
    });
    const res = await layer.generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "otra pregunta de prueba" }],
    });
    const esperado = (res.report.tokens.actualInput / 1000) * caro.inputPer1k
                   + (res.report.tokens.actualOutput / 1000) * caro.outputPer1k;
    expect(res.report.cost.actual).toBeCloseTo(esperado, 10);
  });

  it("avisa (una vez) cuando cae en el precio ilustrativo", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const layer = createSavingsLayer({
      provider: createMockProvider({ answer: "hola" }),
      devUnlicensed: true,
    });
    await layer.generate({ model: "anthropic/desconocido", messages: [{ role: "user", content: "x y z" }] });
    await layer.generate({ model: "anthropic/desconocido", messages: [{ role: "user", content: "a b c" }] });
    const avisos = warn.mock.calls.filter((c) => String(c[0]).includes("ILLUSTRATIVE"));
    expect(avisos.length).toBe(1);
    warn.mockRestore();
  });
});

/** El coste se redondeaba a 1e-6 (microdólares) por petición. Con gpt-4o-mini un
 *  token de entrada cuesta ~1,5e-7 $, así que peticiones cortas costaban menos
 *  que el propio cuanto: se inflaban o desaparecían. Y como cada petición se
 *  redondea por separado y luego se suman en usage_daily, el error se acumula. */
describe("precisión del coste por debajo del microdólar", () => {
  it("no redondea a cero un coste real menor que 1e-6", async () => {
    const layer = createSavingsLayer({
      provider: createMockProvider({ answer: "ok" }),
      devUnlicensed: true,
      costModels: { "gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 } },
    });
    const res = await layer.generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "hola" }],
    });
    const esperado = (res.report.tokens.actualInput / 1000) * 0.00015
                   + (res.report.tokens.actualOutput / 1000) * 0.0006;
    expect(esperado).toBeLessThan(1e-6);            // el caso que se perdía
    expect(res.report.cost.actual).toBeGreaterThan(0);
    expect(res.report.cost.actual).toBeCloseTo(esperado, 10);
  });
});
