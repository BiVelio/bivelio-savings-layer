import { describe, it, expect } from "vitest";

import { decidePublish, type ArtifactShape } from "../benchmarks/publish-guard.js";

/**
 * La cifra que la landing enseña es la afirmación comercial del producto. Este
 * es el único sitio donde se decide si se publica, así que aquí es donde hay que
 * probar que no se puede publicar una mentira por descuido.
 */

const live = (over: Partial<ArtifactShape> = {}): ArtifactShape => ({
  mode: "LIVE",
  model: "gpt-4o-mini",
  modelStable: true,
  reconciliation: { reconciled: true, residual: 0 },
  scenarios: [{}, {}],
  sdk: { version: "0.4.23", asShipped: true },
  aggregate: { savings: { point: 0.42, lower: 0.31, upper: 0.5 }, proven: true, qualityPassRate: 1 },
  ...over,
});

const mock = (): ArtifactShape => ({
  mode: "MOCK",
  modelStable: true,
  reconciliation: { reconciled: true, residual: 0 },
  scenarios: [{}],
  aggregate: { savings: { point: 0.6, lower: 0.6, upper: 0.6 }, proven: false, qualityPassRate: 1 },
});

describe("verja de publicación del artefacto A/B", () => {
  it("una tirada LIVE limpia se publica", () => {
    const d = decidePublish(null, live());
    expect(d.ok).toBe(true);
    expect(d.blockers).toEqual([]);
    expect(d.warnings).toEqual([]);
  });

  it("un MOCK NO se publica por defecto — es como llegó el de hoy a la web", () => {
    const d = decidePublish(null, mock());
    expect(d.ok).toBe(false);
    expect(d.blockers.join(" ")).toMatch(/no está medido contra un proveedor real/);
  });

  it("un MOCK sí se publica si se pide explícitamente, y avisa", () => {
    const d = decidePublish(null, mock(), { allowMock: true });
    expect(d.ok).toBe(true);
    expect(d.warnings.join(" ")).toMatch(/NO es una afirmación de ahorro/);
  });

  it("un MOCK NUNCA sustituye a un LIVE, ni con --allow-mock", () => {
    // Degradar en silencio es cómo se pierde la única cifra defendible que hay.
    const d = decidePublish(live(), mock(), { allowMock: true });
    expect(d.ok).toBe(false);
    expect(d.blockers.join(" ")).toMatch(/degradar una medición real/);
  });

  it("dos brazos con modelos distintos invalidan la tirada", () => {
    // Es la garantía que hace comparable un A/B pareado. Antes se comprobaba
    // `system_fingerprint`, que a través de una pasarela es un id POR PETICIÓN:
    // la verja fallaba siempre y afirmaba, además, algo que el benchmark nunca
    // llegó a calcular (solo recogía el fingerprint del brazo A).
    const d = decidePublish(null, live({ modelStable: false }));
    expect(d.ok).toBe(false);
    expect(d.blockers.join(" ")).toMatch(/mismo modelo/);
  });

  it("unos libros que no cuadran bloquean: es doble conteo", () => {
    const d = decidePublish(null, live({ reconciliation: { reconciled: false, residual: 0.004 } }));
    expect(d.ok).toBe(false);
    expect(d.blockers.join(" ")).toMatch(/doble conteo/);
  });

  it("un ahorro > 100% se bloquea en vez de presumirse", () => {
    const d = decidePublish(null, live({
      aggregate: { savings: { point: 1.4, lower: 1.2, upper: 1.6 }, proven: true, qualityPassRate: 1 },
    }));
    expect(d.ok).toBe(false);
    expect(d.blockers.join(" ")).toMatch(/> 100%/);
  });

  it("un intervalo invertido o incoherente se bloquea", () => {
    expect(decidePublish(null, live({
      aggregate: { savings: { point: 0.4, lower: 0.5, upper: 0.3 }, proven: true, qualityPassRate: 1 },
    })).ok).toBe(false);

    // El punto fuera de su propio intervalo: el bootstrap se rompió.
    const fuera = decidePublish(null, live({
      aggregate: { savings: { point: 0.9, lower: 0.1, upper: 0.3 }, proven: true, qualityPassRate: 1 },
    }));
    expect(fuera.ok).toBe(false);
    expect(fuera.blockers.join(" ")).toMatch(/fuera de su propio intervalo/);
  });

  it("sin intervalo numérico no hay nada que publicar", () => {
    const d = decidePublish(null, live({ aggregate: { proven: true } }));
    expect(d.ok).toBe(false);
    expect(d.blockers.join(" ")).toMatch(/intervalo de confianza/);
  });

  it("proven:false se publica pero avisa de que no es ahorro demostrado", () => {
    // Publicar una medición floja es honesto; presentarla como victoria no.
    const d = decidePublish(null, live({
      aggregate: { savings: { point: 0.05, lower: -0.02, upper: 0.11 }, proven: false, qualityPassRate: 1 },
    }));
    expect(d.ok).toBe(true);
    expect(d.warnings.join(" ")).toMatch(/NO puede presentarlo como ahorro demostrado/);
  });

  it("una calidad por debajo del 100% se publica pero se dice", () => {
    const d = decidePublish(null, live({
      aggregate: { savings: { point: 0.42, lower: 0.31, upper: 0.5 }, proven: true, qualityPassRate: 0.9 },
    }));
    expect(d.ok).toBe(true);
    expect(d.warnings.join(" ")).toMatch(/90\.0%/);
  });

  it("un LIVE sí sustituye a otro LIVE (sin regresión)", () => {
    expect(decidePublish(live(), live({ model: "gpt-4.1-mini" })).ok).toBe(true);
  });

  it("⛔ una tirada con el compresor del banco NO se publica: npm no lo trae", () => {
    // El titular del 2026-09-12 se midió así: el escenario de compresión
    // ahorraba un 15 % que el SDK instalado no puede ahorrar.
    const d = decidePublish(null, live({ sdk: { version: "0.4.23", asShipped: false } }));
    expect(d.ok).toBe(false);
    expect(d.blockers.join(" ")).toMatch(/compresor del banco/);
    expect(d.blockers.join(" ")).toMatch(/BVSALA_AB_SIN_COMPRESOR=1/);
  });

  it("un artefacto anterior al sello del SDK se publica, pero avisa de que no se puede comprobar", () => {
    const d = decidePublish(null, live({ sdk: undefined }));
    expect(d.ok).toBe(true);
    expect(d.warnings.join(" ")).toMatch(/no declara qué SDK midió/);
  });
});
