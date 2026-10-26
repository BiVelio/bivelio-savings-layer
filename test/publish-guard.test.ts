import { describe, it, expect } from "vitest";

import { babosaDeModelo, decidePublish, type ArtifactShape } from "../benchmarks/publish-guard.js";
import { resumirLatencias, type ModoDelBanco } from "../benchmarks/b2/latencia.js";

/**
 * La cifra que la landing enseña es la afirmación comercial del producto. Este
 * es el único sitio donde se decide si se publica, así que aquí es donde hay que
 * probar que no se puede publicar una mentira por descuido.
 */

const latenciaValida = (mode: ModoDelBanco) => resumirLatencias({
  A: [{ totalMs: 100, providerMs: 95 }],
  A1: [{ totalMs: 100, providerMs: 95 }],
  A2: [{ totalMs: 100, providerMs: 95 }],
  B: [{ totalMs: 110, providerMs: 95 }],
}, mode);

const escenarioValido = (name: string, mode: ModoDelBanco) => ({ name, latency: latenciaValida(mode) });

/**
 * Un artefacto LIVE completo: los tres controles, sus suelos y la latencia B2.
 */
const live = (over: Partial<ArtifactShape> = {}): ArtifactShape => ({
  mode: "LIVE",
  model: "gpt-4o-mini",
  modelStable: true,
  reconciliation: { reconciled: true, residual: 0 },
  latency: latenciaValida("LIVE"),
  scenarios: [escenarioValido("uno", "LIVE"), escenarioValido("dos", "LIVE")],
  scenariosNotApplicable: [{}],
  scenarioSet: { size: 3 },
  sdk: { version: "0.4.23", asShipped: true },
  aggregate: { savings: { point: 0.42, lower: 0.31, upper: 0.5 }, proven: true, qualityPassRate: 1 },
  aggregateB1: { savings: { point: 0.3, lower: 0.2, upper: 0.4 } },
  aggregateB2: { savings: { point: 0.25, lower: 0.15, upper: 0.35 } },
  floors: { vsB0: 0.31, vsB1: 0.2, vsB2: 0.15, min: 0.15, minAgainst: "B2" },
  native: { degradedByTransport: false, honored: { promptCacheMode: null } },
  transport: { kind: "openai-compatible", endpointHost: "api.openai.com" },
  cost: {},
  pricing: { listPriceKnown: true, cacheWrites: { premium: 1, metered: false } },
  ...over,
});

const mock = (over: Partial<ArtifactShape> = {}): ArtifactShape => ({
  mode: "MOCK",
  modelStable: true,
  reconciliation: { reconciled: true, residual: 0 },
  latency: latenciaValida("MOCK"),
  scenarios: [escenarioValido("mock", "MOCK")],
  scenarioSet: { size: 1 },
  sdk: { version: "0.4.23", asShipped: true },
  aggregate: { savings: { point: 0.6, lower: 0.6, upper: 0.6 }, proven: false, qualityPassRate: 1 },
  floors: { vsB0: 0.6, min: 0.6, minAgainst: "B0" },
  ...over,
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
      floors: { vsB0: -0.02, vsB1: 0.2, vsB2: 0.15, min: -0.02, minAgainst: "B0" },
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
    // Desde el 2026-09-27 medir lo que se instala es el defecto de `pnpm ab`.
    expect(d.blockers.join(" ")).toMatch(/`pnpm ab` \(asShipped es el modo por defecto/);
    expect(d.blockers.join(" ")).not.toMatch(/BVSALA_AB_SIN_COMPRESOR/);
  });

  it("⛔ un artefacto anterior al sello del SDK tampoco: hasta el sello, el banco medía CON el compresor", () => {
    // La forma exacta del artefacto del 2026-09-12: LIVE, sin `sdk` y con la
    // compresión entre las palancas ejercitadas.
    const d = decidePublish(null, {
      ...live({ sdk: undefined }),
      levers: { exercised: [{ palanca: "compression", escenario: "Forwarded support thread (compression)" }] },
    } as ArtifactShape);
    expect(d.ok).toBe(false);
    expect(d.blockers.join(" ")).toMatch(/falta sdk\.asShipped: true/);
    expect(d.blockers.join(" ")).toMatch(/`pnpm ab`/);
    // Y sin palancas declaradas, igual: lo que no está sellado no se sabe.
    expect(decidePublish(null, live({ sdk: undefined })).ok).toBe(false);
    expect(decidePublish(null, live({ sdk: { version: "0.4.23" } })).ok).toBe(false);
    expect(decidePublish(null, live({ sdk: { version: "0.4.23", asShipped: "true" } })).ok).toBe(false);
  });

  it("⛔ un MOCK sin sello TAMBIÉN se bloquea, ni con --allow-mock: el sello ya no es cosa solo de LIVE", () => {
    // Hasta el 2026-09-27 un MOCK sin sello pasaba con --allow-mock. Desde que
    // asShipped es el defecto de `pnpm ab`, no hay tirada legítima sin él.
    const d = decidePublish(null, mock({ sdk: undefined }), { allowMock: true });
    expect(d.ok).toBe(false);
    expect(d.blockers.join(" ")).toMatch(/sdk\.asShipped/);
    expect(decidePublish(null, mock({ sdk: { version: "0.4.23", asShipped: false } }), { allowMock: true }).ok).toBe(false);
  });
});

describe("verja de publicación: los bloqueos del banco de 2026 (recomendación n.º 3)", () => {
  const bloquea = (a: ArtifactShape, patron: RegExp, opts = {}): void => {
    const d = decidePublish(null, a, opts);
    expect(d.ok).toBe(false);
    expect(d.blockers.join(" ")).toMatch(patron);
  };

  it("sin un intervalo numérico frente a B2 no hay comparación contra lo que el proveedor da gratis", () => {
    bloquea(live({ aggregateB2: undefined, floors: { vsB0: 0.31, vsB1: 0.2, vsB2: null, min: 0.2 } }), /aggregateB2/);
    bloquea(live({ aggregateB2: { savings: { point: 0.2 } } }), /aggregateB2/);
  });

  it("un precio que no es de lista no se publica", () => {
    bloquea(live({ pricing: { listPriceKnown: false } }), /listPriceKnown = false/);
  });

  it("con prima de escritura > 1, las escrituras tienen que venir del contador del proveedor", () => {
    bloquea(live({ pricing: { listPriceKnown: true, cacheWrites: { premium: 1.25, metered: false } } }), /cacheWrites/);
    expect(decidePublish(null, live({ pricing: { listPriceKnown: true, cacheWrites: { premium: 1.25, metered: true } } })).ok).toBe(true);
    // Sin prima, el contador no cambia el coste: no bloquea.
    expect(decidePublish(null, live({ pricing: { listPriceKnown: true, cacheWrites: { premium: 1, metered: false } } })).ok).toBe(true);
  });

  it("un B2 degradado por el transporte, o cuyo modo de caché el proveedor no honró, no se publica", () => {
    bloquea(live({ native: { degradedByTransport: true } }), /degradedByTransport/);
    bloquea(live({ native: { degradedByTransport: false, honored: { promptCacheMode: false } } }), /promptCacheMode = false/);
    // `null` = no observable: no es un sí, pero tampoco un no.
    expect(decidePublish(null, live({ native: { honored: { promptCacheMode: null } } })).ok).toBe(true);
  });

  it("sin host del endpoint, o contra loopback / red privada, no se publica", () => {
    bloquea(live({ transport: { kind: "openai-compatible" } }), /endpointHost falta/);
    for (const host of ["localhost", "127.0.0.1", "10.0.0.8", "192.168.1.20", "172.16.0.1", "172.31.255.1", "169.254.1.1", "::1", "[::1]", "fd12:3456::1", "fe80::1"]) {
      bloquea(live({ transport: { endpointHost: host } }), /loopback o red privada/);
    }
    bloquea(live({ transport: { endpointHost: "api.openai.com,localhost" } }), /loopback o red privada/);
    expect(decidePublish(null, live({ transport: { endpointHost: "172.32.0.1" } })).ok).toBe(true);
    expect(decidePublish(null, live({ transport: { endpointHost: "api.anthropic.com,ai-gateway.vercel.sh" } })).ok).toBe(true);
  });

  it("una tirada cortada por el presupuesto no se publica", () => {
    bloquea(live({ cost: { aborted: "budget" } }), /cost\.aborted/);
    expect(decidePublish(null, live({ cost: { aborted: false } })).ok).toBe(true);
  });

  it("ninguna fila roja se cae en silencio: scenarioSet = medidos + no aplicables", () => {
    bloquea(live({ scenarioSet: { size: 4 } }), /falta alguna fila/);
    bloquea(live({ scenarioSet: undefined }), /no declara scenarioSet/);
    // En MOCK, sin scenarioSet no bloquea (no hay cifra), pero si lo declara tiene que cuadrar.
    bloquea(mock({ scenarioSet: { size: 2 } }), /falta alguna fila/, { allowMock: true });
  });

  it("los suelos cuadran con sus agregados y `min` es el menor", () => {
    bloquea(live({ floors: undefined }), /no trae floors/);
    bloquea(live({ floors: { vsB0: 0.31, vsB1: 0.2, vsB2: 0.15, min: 0.2 } }), /floors\.min/);
    bloquea(live({ floors: { vsB0: 0.3, vsB1: 0.2, vsB2: 0.15, min: 0.15 } }), /vsB0 ↔ aggregate/);
    bloquea(live({ floors: { vsB0: 0.31, vsB1: null, vsB2: 0.15, min: 0.15 } }), /falta vsB1/);
  });

  it("⚠ un suelo por debajo del 5 % frente al brazo más fuerte avisa: el informe pide girar el mensaje hacia la contabilidad", () => {
    const d = decidePublish(
      null,
      live({
        aggregateB2: { savings: { point: 0.06, lower: 0.03, upper: 0.09 } },
        floors: { vsB0: 0.31, vsB1: 0.2, vsB2: 0.03, min: 0.03, minAgainst: "B2" },
      }),
    );
    expect(d.ok).toBe(true);
    expect(d.warnings.join(" ")).toMatch(/floors\.min = 3\.0% \(frente a B2\).*contabilidad/);
    expect(decidePublish(null, live()).warnings.join(" ")).not.toMatch(/contabilidad/);
  });

  it("p95 > 3000ms impide publicar aunque el artefacto declare gate.approved", () => {
    const latency = resumirLatencias({
      A: [{ totalMs: 100, providerMs: 90 }],
      A1: [{ totalMs: 100, providerMs: 90 }],
      A2: [{ totalMs: 100, providerMs: 90 }],
      B: [{ totalMs: 100, providerMs: 90 }, { totalMs: 4000, providerMs: 3900 }],
    }, "LIVE");
    const d = decidePublish(null, live({ latency: { ...latency, gate: { approved: true, reasons: [] } } }));
    expect(d.ok).toBe(false);
    expect(d.blockers.join(" ")).toMatch(/p95=3805ms.*3000ms/);
  });

  it("max > 5000ms en un escenario impide publicar, y sin latencia tampoco hay aprobación", () => {
    const latency = latenciaValida("LIVE");
    const escenarioLento = {
      name: "lento",
      latency: resumirLatencias({
        A: [{ totalMs: 100, providerMs: 90 }],
        A1: [{ totalMs: 100, providerMs: 90 }],
        A2: [{ totalMs: 5001, providerMs: 4900 }],
        B: [{ totalMs: 100, providerMs: 90 }],
      }, "LIVE"),
    };
    const d = decidePublish(null, live({ latency, scenarios: [escenarioValido("uno", "LIVE"), escenarioLento] }));
    expect(d.ok).toBe(false);
    expect(d.blockers.join(" ")).toMatch(/scenario lento.*max=5001ms.*5000ms/);
    expect(decidePublish(null, live({ latency: undefined })).blockers.join(" ")).toMatch(/falta el informe agregado/);
  });

  it("la babosa del modelo es la misma para escribir el artefacto y para publicarlo", () => {
    expect(babosaDeModelo("openai/gpt-6-luna")).toBe("openai-gpt-6-luna");
    expect(babosaDeModelo("google/gemini-3.8-flash")).toBe("google-gemini-3-8-flash");
    expect(babosaDeModelo("Anthropic/Claude-Sonnet-5")).toBe("anthropic-claude-sonnet-5");
  });
});
