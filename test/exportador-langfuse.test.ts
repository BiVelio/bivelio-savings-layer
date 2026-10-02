import { describe, it, expect } from "vitest";

import { toLangfuseGeneration } from "../src/index.js";
import { informeSintetico } from "./helpers/informe-sintetico.js";

/**
 * `toLangfuseGeneration`: lo que se le pasa a `generation.update()` de
 * @langfuse/tracing. Langfuse normaliza el uso en CUBOS EXCLUSIVOS («Cache reads
 * and writes are subtracted from `input`»), así que `input` no puede llevar las
 * lecturas de caché dentro: se contarían dos veces.
 */
describe("toLangfuseGeneration", () => {
  it("cubos exclusivos: input sin las lecturas de caché, y el modelo sin prefijo conocido", () => {
    const g = toLangfuseGeneration(
      informeSintetico({ tokens: { actualInput: 1000, providerCachedInput: 600, actualOutput: 50 } }),
    );
    expect(g.model).toBe("gpt-4o-mini");
    expect(g.usageDetails).toEqual({ input: 400, output: 50, cache_read_input_tokens: 600 });
  });

  it("sin lecturas de caché no inventa la clave, y el input nunca es negativo", () => {
    expect(toLangfuseGeneration(informeSintetico({ tokens: { actualInput: 10, actualOutput: 2 } })).usageDetails).toEqual({
      input: 10,
      output: 2,
    });
    const raro = toLangfuseGeneration(informeSintetico({ tokens: { actualInput: 5, providerCachedInput: 9 } }));
    expect(raro.usageDetails?.input).toBe(0);
  });

  it("sin usageDetails cuando el proveedor no dio uso (unmeasured), ni con shadow", () => {
    expect(toLangfuseGeneration(informeSintetico({ cost: { basis: "unmeasured" } })).usageDetails).toBeUndefined();
    expect(toLangfuseGeneration(informeSintetico({ cost: { basis: "shadow" } })).usageDetails).toBeUndefined();
  });

  it("una llamada evitada sale con ceros: no se facturó ningún token", () => {
    const g = toLangfuseGeneration(
      informeSintetico({
        calls: { actualLlm: 0, avoidedLlm: 1 },
        tokens: { actualInput: 0, actualOutput: 0 },
        cache: { result: "exact" },
        cost: { basis: "estimated", baselineEstimate: 0.00003, actual: 0, netSavingsRatio: 1 },
      }),
    );
    expect(g.usageDetails).toEqual({ input: 0, output: 0 });
    expect(g.metadata.bivelio_avoided_calls).toBe(1);
    expect(g.metadata.bivelio_saved_estimated).toBe(0.00003);
  });

  it("costDetails solo con includeCost, en USD y con un basis que tiene dinero", () => {
    const r = informeSintetico({ cost: { basis: "measured", baselineEstimate: 0.004, actual: 0.003 } });
    expect(toLangfuseGeneration(r).costDetails).toBeUndefined();
    expect(toLangfuseGeneration(r, { includeCost: true }).costDetails).toEqual({ total: 0.003 });
    expect(toLangfuseGeneration(r, { includeCost: true, currency: "EUR" }).costDetails).toBeUndefined();
    const sinMedida = informeSintetico({ cost: { basis: "unmeasured" } });
    expect(toLangfuseGeneration(sinMedida, { includeCost: true }).costDetails).toBeUndefined();
  });

  it("la metadata separa el ahorro por basis y lo da en números, con el signo", () => {
    for (const basis of ["measured", "reference", "estimated"] as const) {
      const m = toLangfuseGeneration(informeSintetico({ cost: { basis, baselineEstimate: 1, actual: 1.25 } })).metadata;
      const ahorros = Object.keys(m).filter((k) => k.startsWith("bivelio_saved_"));
      expect(ahorros).toEqual([`bivelio_saved_${basis}`]);
      expect(m[`bivelio_saved_${basis}`]).toBe(-0.25);
      expect(m.bivelio_basis).toBe(basis);
    }
    const m = toLangfuseGeneration(informeSintetico({ cost: { basis: "unmeasured" } })).metadata;
    expect(Object.keys(m).filter((k) => /saved|cost|ratio/.test(k))).toEqual([]);
    expect(m.bivelio_currency).toBe("USD");
  });

  it("un prefijo desconocido se queda en el id: es el nombre del modelo", () => {
    expect(toLangfuseGeneration(informeSintetico({ model: "meta-llama/Llama-4" })).model).toBe("meta-llama/Llama-4");
    // Las claves que un objeto hereda no son proveedores.
    for (const m of ["constructor/x", "__proto__/x", "toString/x"]) {
      expect(toLangfuseGeneration(informeSintetico({ model: m })).model, m).toBe(m);
    }
    expect(toLangfuseGeneration(informeSintetico({ model: "anthropic/claude-sonnet-4-5" })).model).toBe(
      "claude-sonnet-4-5",
    );
  });
});
