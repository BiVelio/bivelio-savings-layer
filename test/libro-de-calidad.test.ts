import { describe, it, expect, beforeEach } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import { InMemorySemanticCache } from "../src/cache/semantic.js";
import { providerNativeBackend } from "../src/constraints/backends.js";
import { libroDeCalidad, libroDelSeguidor } from "../src/pipeline/libro-de-calidad.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";
import { comprobarCoherencia, clavesDeDinero, textosDelLibro } from "./helpers/libro-de-calidad.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import type { ExactCache } from "../src/cache/exact.js";
import type { SavingsLayerConfig } from "../src/pipeline/config.js";
import type { QualityLedger, SavingsRequest, SavingsResult, ToolDescriptor } from "../src/contracts/types.js";

/**
 * EL LIBRO DE CALIDAD: QUÉ SE COMPROBÓ EN CADA RESPUESTA, SIN DINERO Y SIN
 * SALIR DEL PROCESO.
 *
 * `qualityStatus` es el veredicto en una palabra; `qualityLedger` es la
 * evidencia. Este fichero fija cada bloque camino por camino, y en TODOS los
 * informes que produce comprueba tres cosas: que el libro es coherente con el
 * veredicto, que no lleva ninguna clave de dinero o de tokens y que no lleva
 * texto (solo un vocabulario cerrado).
 */

const MINI = "openai/gpt-4o-mini";
const FUERTE = "openai/gpt-4o";
const PRECIOS = {
  [MINI]: { inputPer1k: 0.00015, outputPer1k: 0.0006 },
  [FUERTE]: { inputPer1k: 0.0025, outputPer1k: 0.01 },
};

const CONTRATO = {
  contractId: "answer:v1",
  schema: {
    type: "object" as const,
    additionalProperties: false,
    required: ["answer"],
    properties: { answer: { type: "string" as const } },
  },
};

/** Contesta según un guion; la última respuesta se repite. */
class ProveedorGuion implements Provider {
  readonly id = "guion";
  llamadas = 0;
  readonly modelos: string[] = [];
  constructor(
    private readonly guion: Partial<ProviderResponse>[],
    private readonly retardoMs = 0,
  ) {}
  async generate(r: ProviderRequest): Promise<ProviderResponse> {
    this.modelos.push(r.model);
    const paso = this.guion[Math.min(this.llamadas, this.guion.length - 1)]!;
    this.llamadas++;
    if (this.retardoMs) await new Promise((res) => setTimeout(res, this.retardoMs));
    return {
      text: paso.text ?? "",
      usage: paso.usage ?? { inputTokens: 100, outputTokens: 10 },
      ...(paso.finishReason !== undefined ? { finishReason: paso.finishReason } : {}),
      ...(paso.toolCalls !== undefined ? { toolCalls: paso.toolCalls } : {}),
    };
  }
}

/** Contesta según el modelo (para la cascada). */
class ProveedorPorModelo implements Provider {
  readonly id = "por-modelo";
  constructor(private readonly porModelo: Record<string, string>) {}
  async generate(r: ProviderRequest): Promise<ProviderResponse> {
    return { text: this.porModelo[r.model] ?? '{"answer":"x"}', usage: { inputTokens: 1000, outputTokens: 200 } };
  }
}

const capa = (provider: Provider, extra: Partial<SavingsLayerConfig> = {}) =>
  createSavingsLayer({ provider, costModels: PRECIOS, silenceWarnings: true, ...extra });

// El vocabulario CERRADO del libro: todo valor de texto tiene que salir de aquí.
// Si aparece otra cadena, es contenido del cliente o un mensaje de error, y el
// libro promete no llevar ni lo uno ni lo otro.
const VOCABULARIO = new Set([
  "provider", "exact_cache", "semantic_cache", "coalesced", "deterministic", "fail_open",
  "passed", "failed", "not_applicable",
  "repaired", "still_invalid", "skipped",
  "output_truncated", "schema_defect", "would_cost_more_than_no_layer", "decode_time_constraint",
  "exact", "semantic", "built_in", "custom",
  // El segmento de la calibración de la caché semántica (opt-in).
  "single_shot", "agentic",
  "shadow", "on", "none", "structural", "value-constrained",
  "accepted", "escalated", "not_routed", "not_applied",
  // `finishReason`, tal cual lo nombra el proveedor.
  "stop", "length", "tool_calls",
]);

// «MEASURED» ES UNA PALABRA DE DINERO EN ESTE REPO: la base de lo leído del
// contador del proveedor (`cost.basis: "measured"`), sobre la que se cobra. El
// libro no lleva dinero, así que su vocabulario no puede usarla; y la sombra sin
// muestreo, que se llamaba `measured_only`, no midió nada del modelo barato.
it("el vocabulario del libro no dice «measured» en ningún valor", () => {
  for (const v of VOCABULARIO) expect(v, v).not.toMatch(/measur/i);
});

/**
 * Genera y comprueba las tres promesas del libro sobre el informe. Todo camino
 * de este fichero pasa por aquí: por eso cubre «en todas las formas».
 */
async function generar(c: ReturnType<typeof capa>, req: SavingsRequest): Promise<SavingsResult> {
  const r = await c.generate(req);
  comprobarCoherencia(r.report);
  expect(clavesDeDinero(r.report.qualityLedger)).toEqual([]);
  const textos = textosDelLibro(r.report.qualityLedger);
  for (const t of textos) expect(VOCABULARIO.has(t), `valor fuera del vocabulario: ${t}`).toBe(true);
  const contenidos = [r.text, ...req.messages.map((m) => m.content)].filter((t) => t.length > 0);
  for (const t of textos) expect(contenidos).not.toContain(t);
  return r;
}

const pide = (content: string, extra: Partial<SavingsRequest> = {}): SavingsRequest => ({
  model: MINI,
  messages: [{ role: "user", content }],
  ...extra,
});

beforeEach(() => reiniciarAvisos());

describe("libroDeCalidad / libroDelSeguidor — funciones puras", () => {
  it("proveedor sin esquema: solo origen y truncado", () => {
    expect(
      libroDeCalidad({ cacheResult: "miss", structurallyValid: true, backend: "none", hayEsquema: false }),
    ).toEqual({ source: "provider", truncation: { truncated: false, capSetByCaller: false } });
  });

  it("fail-open: el origen lo dicen los hechos", () => {
    const l = libroDeCalidad({
      cacheResult: "miss",
      structurallyValid: true,
      backend: "none",
      hayEsquema: false,
      hechos: { origen: "fail_open", final: { finishReason: "length", topeDelLlamante: 64 } },
    });
    expect(l).toEqual({
      source: "fail_open",
      truncation: { truncated: true, finishReason: "length", capSetByCaller: true, outputLimit: 64 },
    });
  });

  it("la cascada: los cuatro desenlaces", () => {
    const base = {
      requestedModel: FUERTE,
      servedModel: FUERTE,
      eligible: true,
      reason: "r",
      verifier: "structural" as const,
      creditedLedger: "none" as const,
    };
    const de = (c: Record<string, unknown>) =>
      libroDeCalidad({
        cacheResult: "miss",
        structurallyValid: true,
        backend: "none",
        hayEsquema: false,
        cascada: { ...base, ...c } as never,
      }).cascade;
    expect(de({ mode: "shadow", divergedOnSample: true })).toEqual({
      mode: "shadow", gate: "structural", outcome: "not_applied", sampleDiverged: true,
    });
    expect(de({ mode: "on", servedModel: MINI })!.outcome).toBe("accepted");
    expect(de({ mode: "on", escalated: true })!.outcome).toBe("escalated");
    expect(de({ mode: "on" })!.outcome).toBe("not_routed");
    expect(de({ mode: "off" })).toBeUndefined();
  });

  it("el seguidor: coalesced, sharedFrom del líder, bloques COPIADOS", () => {
    const lider: QualityLedger = {
      source: "semantic_cache",
      schema: { outcome: "passed", decodeTimeConstraint: false, errorCount: 0 },
      cacheMatch: {
        kind: "semantic", similarity: 0.9, similarityFloor: 0.72, acceptFloor: 0.85,
        embedder: "built_in", factGuard: "passed",
      },
    };
    const s = libroDelSeguidor(lider);
    expect(s).toEqual({ ...lider, source: "coalesced", sharedFrom: "semantic_cache" });
    expect(s.schema).not.toBe(lider.schema);
    expect(libroDelSeguidor(undefined)).toEqual({ source: "coalesced", sharedFrom: "provider" });
  });
});

describe("el contrato de salida: validación, rescate y reparación", () => {
  it("esquema válido: passed, 0 errores, del proveedor, sin truncar", async () => {
    const r = await generar(capa(new ProveedorGuion([{ text: '{"answer":"ok"}', finishReason: "stop" }])), pide("give me the summary as json", { response: CONTRATO }));
    const l = r.report.qualityLedger!;
    expect(l.source).toBe("provider");
    expect(l.schema).toEqual({ outcome: "passed", decodeTimeConstraint: false, errorCount: 0 });
    expect(l.truncation).toEqual({ truncated: false, finishReason: "stop", capSetByCaller: false });
    expect(l.repair).toBeUndefined();
  });

  it("JSON envuelto en prosa: unwrapped, y sin reparación", async () => {
    const p = new ProveedorGuion([{ text: 'Sure, here it is:\n```json\n{"answer":"ok"}\n```' }]);
    const r = await generar(capa(p), pide("give me the summary as json", { response: CONTRATO }));
    expect(p.llamadas).toBe(1);
    expect(r.report.qualityLedger!.schema).toEqual({
      outcome: "passed", decodeTimeConstraint: false, errorCount: 0, unwrapped: true,
    });
    expect(r.report.qualityLedger!.repair).toBeUndefined();
  });

  it("inválido → reparado → válido: repaired, y el reintento contado en calls.retries", async () => {
    const p = new ProveedorGuion([{ text: "{broken" }, { text: '{"answer":"fixed"}' }]);
    const r = await generar(capa(p), pide("give me the summary as json", { response: CONTRATO }));
    expect(r.report.qualityLedger!.repair).toEqual({ outcome: "repaired" });
    expect(r.report.qualityLedger!.schema!.outcome).toBe("passed");
    expect(r.report.calls.retries).toBe(1);
  });

  it("inválido → reparado → inválido: still_invalid y rejected", async () => {
    const p = new ProveedorGuion([{ text: "{broken" }, { text: '{"other":1}' }]);
    const r = await generar(capa(p), pide("give me the summary as json", { response: CONTRATO }));
    expect(r.report.qualityLedger!.repair).toEqual({ outcome: "still_invalid" });
    expect(r.report.qualityLedger!.schema).toMatchObject({ outcome: "failed" });
    expect(r.report.qualityLedger!.schema!.errorCount).toBeGreaterThan(0);
    expect(r.report.qualityStatus).toBe("rejected");
  });

  it("skip · schema_defect: un pattern que no compila", async () => {
    const roto = {
      contractId: "roto:v1",
      schema: { type: "object" as const, properties: { x: { type: "string" as const, pattern: "(sin-cerrar[" } } },
    };
    const p = new ProveedorGuion([{ text: '{"x":"hola"}' }]);
    const r = await generar(capa(p), pide("give me x", { response: roto }));
    expect(p.llamadas).toBe(1);
    expect(r.report.qualityLedger!.repair).toEqual({ outcome: "skipped", skipReason: "schema_defect" });
  });

  it("skip · output_truncated: finish_reason length con tope del llamante", async () => {
    const p = new ProveedorGuion([{ text: '{"answer":"cut in the midd', finishReason: "length" }]);
    const c = capa(p);
    const req = pide("give me the long summary as json", { response: { ...CONTRATO, maxOutputTokens: 50 } });
    const r = await generar(c, req);
    const l = r.report.qualityLedger!;
    expect(l.repair).toEqual({ outcome: "skipped", skipReason: "output_truncated" });
    expect(l.truncation).toEqual({ truncated: true, finishReason: "length", capSetByCaller: true, outputLimit: 50 });
    // Lo de siempre, y el libro no lo cambia: media respuesta NO se cachea, así
    // que la repetición idéntica vuelve a llamar al proveedor.
    const otra = await generar(c, req);
    expect(otra.report.cache.result).toBe("miss");
    expect(p.llamadas).toBe(2);
  });

  it("skip · would_cost_more_than_no_layer: la verja de dinero (opt-in)", async () => {
    const p = new ProveedorGuion([{ text: "{broken" }]);
    const r = await generar(capa(p, { skipRepairAboveBaseline: true }), pide("give me the summary as json", { response: CONTRATO }));
    expect(p.llamadas).toBe(1);
    expect(r.report.qualityLedger!.repair).toEqual({ outcome: "skipped", skipReason: "would_cost_more_than_no_layer" });
  });

  it("skip · decode_time_constraint: el backend ya restringía la generación", async () => {
    const p = new ProveedorGuion([{ text: '{"other":1}' }]);
    const r = await generar(
      capa(p, { constraintBackends: [providerNativeBackend()] }),
      pide("give me the summary as json", { response: CONTRATO }),
    );
    expect(p.llamadas).toBe(1);
    expect(r.report.constraints.backend).toBe("provider-native");
    expect(r.report.qualityLedger!.schema!.decodeTimeConstraint).toBe(true);
    expect(r.report.qualityLedger!.repair).toEqual({ outcome: "skipped", skipReason: "decode_time_constraint" });
  });

  it("truncado sin esquema: se declara igual (sin bloque schema)", async () => {
    const r = await generar(capa(new ProveedorGuion([{ text: "half an ans", finishReason: "length" }])), pide("write a long essay about rivers"));
    expect(r.report.qualityLedger!.schema).toBeUndefined();
    expect(r.report.qualityLedger!.truncation).toEqual({ truncated: true, finishReason: "length", capSetByCaller: false });
  });

  it("turno de herramientas: schema not_applicable", async () => {
    const buscar: ToolDescriptor = { id: "search_docs", intents: ["search"], risk: "read" };
    const p = new ProveedorGuion([
      { text: "", finishReason: "tool_calls", toolCalls: [{ id: "c1", name: "search_docs", arguments: "{}" }] },
    ]);
    const r = await generar(capa(p), pide("look it up in the docs", { response: CONTRATO, tools: [buscar] }));
    expect(r.report.qualityLedger!.schema).toEqual({ outcome: "not_applicable", decodeTimeConstraint: false, errorCount: 0 });
    expect(r.report.qualityLedger!.repair).toBeUndefined();
  });
});

describe("de dónde vino la respuesta", () => {
  it("acierto exacto: cacheMatch exact, y sin restricción en decodificación (nadie generó)", async () => {
    const c = capa(new ProveedorGuion([{ text: '{"answer":"ok"}' }]), { constraintBackends: [providerNativeBackend()] });
    const req = pide("give me the summary as json", { response: CONTRATO });
    const primera = await generar(c, req);
    expect(primera.report.qualityLedger!.schema!.decodeTimeConstraint).toBe(true);
    const segunda = await generar(c, req);
    const l = segunda.report.qualityLedger!;
    expect(l.source).toBe("exact_cache");
    expect(l.cacheMatch).toEqual({ kind: "exact", ageMs: segunda.report.cache.ageMs });
    expect(l.schema).toEqual({ outcome: "passed", decodeTimeConstraint: false, errorCount: 0 });
    expect(l.truncation).toBeUndefined();
  });

  it("resolver determinista: deterministic, sin cacheMatch ni truncado", async () => {
    const p = new ProveedorGuion([{ text: "should not be called" }]);
    const r = await generar(capa(p), pide("What is (2 + 2) * 3?"));
    expect(p.llamadas).toBe(0);
    expect(r.report.qualityLedger).toEqual({ source: "deterministic" });
  });

  it("acierto semántico con el embebedor PROPIO: similitud, suelos y la verja", async () => {
    const semanticCache = new InMemorySemanticCache();
    const c = capa(new ProveedorGuion([{ text: "the water cycle is evaporation, condensation and rain" }]), { semanticCache });
    const base = { savings: { semanticCache: true as const, exactCache: false } };
    await generar(c, pide("describe the water cycle in simple terms", base));
    const r = await generar(c, pide("describe the water cycle in simple terms please", base));
    const m = r.report.qualityLedger!.cacheMatch!;
    expect(r.report.qualityLedger!.source).toBe("semantic_cache");
    if (m.kind !== "semantic") throw new Error("se esperaba un acierto semántico");
    expect(m.embedder).toBe("built_in");
    expect(m.factGuard).toBe("passed");
    expect(m.similarity).toBe(r.report.quality.semanticScore);
    expect(m.similarity).toBeGreaterThanOrEqual(m.similarityFloor);
    expect(m.verifierScore).toBeUndefined();
    expect(Math.min(m.similarity, m.verifierScore ?? m.similarity)).toBe(r.report.cache.confidence);
    expect(r.report.cache.confidence!).toBeGreaterThanOrEqual(m.acceptFloor);
    expect(m.ageMs).toBe(r.report.cache.ageMs);
    expect(r.report.qualityLedger!.truncation).toBeUndefined();
  });

  it("acierto semántico con embebedor y verificador del cliente: custom y verifierScore", async () => {
    const embed = async (t: string): Promise<number[]> =>
      [0, 1, 2, 3].map((i) => [...t].filter((ch) => ch.charCodeAt(0) % 4 === i).length);
    const semanticCache = new InMemorySemanticCache({
      embed, verify: () => 0.9, similarityThreshold: 0.3, acceptThreshold: 0.3,
    });
    const c = capa(new ProveedorGuion([{ text: "it merges identical requests" }]), { semanticCache });
    const base = { savings: { semanticCache: true as const, exactCache: false } };
    await generar(c, pide("explain the coalescing mechanism briefly", base));
    const r = await generar(c, pide("explain briefly the coalescing mechanism", base));
    const m = r.report.qualityLedger!.cacheMatch!;
    if (m.kind !== "semantic") throw new Error("se esperaba un acierto semántico");
    expect(m.embedder).toBe("custom");
    expect(m.verifierScore).toBe(0.9);
    expect(m.similarityFloor).toBe(0.3);
    expect(m.acceptFloor).toBe(0.3);
    expect(Math.min(m.similarity, m.verifierScore!)).toBe(r.report.cache.confidence);
    expect(r.report.quality.semanticScore).toBe(m.similarity);
  });

  it("acierto semántico CALIBRADO: la cota viaja en el libro, solo con números y el segmento", async () => {
    // δ = 0,5 con 90 % de confianza: la primera prueba llega con 10 etiquetas.
    const semanticCache = new InMemorySemanticCache({
      calibration: { maxErrorRate: 0.5, confidence: 0.9, auditRate: 0 },
    });
    const c = capa(new ProveedorGuion([{ text: "the water cycle is evaporation, condensation and rain" }]), { semanticCache });
    const base = { savings: { semanticCache: true as const, exactCache: false } };
    await generar(c, pide("describe the water cycle in simple terms", base));
    let r = await generar(c, pide("describe the water cycle in simple terms please", base));
    for (let i = 0; i < 40 && r.report.cache.result !== "semantic"; i++) {
      await semanticCache.settled();
      r = await generar(c, pide("describe the water cycle in simple terms please", base));
    }
    const m = r.report.qualityLedger!.cacheMatch!;
    if (m.kind !== "semantic") throw new Error("se esperaba un acierto semántico");
    expect(m.calibration).toBeDefined();
    expect(m.calibration!.segment).toBe("single_shot");
    expect(m.acceptFloor).toBe(m.calibration!.floor);
    expect(r.report.cache.confidence!).toBeGreaterThanOrEqual(m.calibration!.floor);
  });

  it("fail-open: fail_open, con su validación y su truncado", async () => {
    const cacheRota: ExactCache = {
      get() {
        throw new Error("boom: fallo interno del optimizador");
      },
      async set() {},
      async delete() {},
    };
    const r = await generar(
      capa(new ProveedorGuion([{ text: '{"answer":"direct"}', finishReason: "stop" }]), { exactCache: cacheRota }),
      pide("give me the summary as json", { response: CONTRATO }),
    );
    expect(r.report.traces.some((t) => t.stage === "fail-open")).toBe(true);
    expect(r.report.qualityLedger).toEqual({
      source: "fail_open",
      schema: { outcome: "passed", decodeTimeConstraint: false, errorCount: 0 },
      truncation: { truncated: false, finishReason: "stop", capSetByCaller: false },
    });
  });

  it("seguidor coalescido: coalesced, sharedFrom del líder y los bloques heredados", async () => {
    const c = capa(new ProveedorGuion([{ text: '{"answer":"shared"}', finishReason: "stop" }], 40));
    const req = pide("explain the coalescing mechanism in detail", { response: CONTRATO, context: { tenantId: "t1" } });
    const todos = await Promise.all([generar(c, req), generar(c, req), generar(c, req)]);
    const lider = todos.find((r) => r.report.cache.result === "miss")!;
    const seguidores = todos.filter((r) => r.report.cache.result === "singleflight");
    expect(seguidores).toHaveLength(2);
    for (const s of seguidores) {
      const { source, sharedFrom, ...bloques } = s.report.qualityLedger!;
      const { source: delLider, ...bloquesDelLider } = lider.report.qualityLedger!;
      expect(source).toBe("coalesced");
      expect(sharedFrom).toBe(delLider);
      expect(bloques).toEqual(bloquesDelLider);
    }
  });
});

describe("la cascada de modelos", () => {
  const conContrato = (savings: SavingsRequest["savings"]) =>
    ({ model: FUERTE, messages: [{ role: "user", content: "summarize the attached report in one line" }], response: CONTRATO, savings }) as SavingsRequest;

  it("on, aceptada: accepted y bounded_degradation", async () => {
    const r = await generar(capa(new ProveedorPorModelo({})), conContrato({ modelCascade: "on" }));
    expect(r.report.qualityLedger!.cascade).toMatchObject({ mode: "on", outcome: "accepted" });
    expect(r.report.qualityLedger!.cascade!.gate).toBe(r.report.modelCascade!.verifier);
    expect(r.report.qualityStatus).toBe("bounded_degradation");
  });

  it("on, escalada: escalated", async () => {
    const p = new ProveedorPorModelo({ [MINI]: "not json at all", [FUERTE]: '{"answer":"strong"}' });
    const r = await generar(capa(p), conContrato({ modelCascade: "on" }));
    expect(r.report.modelCascade!.escalated).toBe(true);
    expect(r.report.qualityLedger!.cascade).toMatchObject({ mode: "on", outcome: "escalated" });
  });

  it("on, sin enrutar: not_routed (sin contrato no es elegible)", async () => {
    const r = await generar(
      capa(new ProveedorPorModelo({ [FUERTE]: "plain text" })),
      { model: FUERTE, messages: [{ role: "user", content: "write a haiku about rivers" }], savings: { modelCascade: "on" } },
    );
    expect(r.report.modelCascade!.eligible).toBe(false);
    expect(r.report.qualityLedger!.cascade).toMatchObject({ mode: "on", outcome: "not_routed" });
  });

  it("shadow con muestreo: not_applied y la pista de divergencia tal cual", async () => {
    const p = new ProveedorPorModelo({ [FUERTE]: '{"answer":"strong one"}', [MINI]: '{"answer":"cheap one"}' });
    const r = await generar(capa(p, { modelCascade: { shadowSampleRate: 1 } }), conContrato({ modelCascade: "shadow" }));
    const cascade = r.report.qualityLedger!.cascade!;
    expect(r.report.modelCascade!.sampled).toBe(true);
    expect(cascade.mode).toBe("shadow");
    expect(cascade.outcome).toBe("not_applied");
    expect(cascade.sampleDiverged).toBe(r.report.modelCascade!.divergedOnSample);
  });

  it("shadow SIN muestreo: el mismo not_applied, sin pista, y nada que diga que se midió", async () => {
    // El caso que el nombre viejo contaba mal: aquí el modelo barato ni se llamó.
    const p = new ProveedorPorModelo({ [FUERTE]: '{"answer":"strong one"}', [MINI]: '{"answer":"cheap one"}' });
    const r = await generar(capa(p, { modelCascade: { shadowSampleRate: 0 } }), conContrato({ modelCascade: "shadow" }));
    expect(r.report.modelCascade!.sampled).not.toBe(true);
    expect(r.report.qualityLedger!.cascade).toEqual({
      mode: "shadow",
      gate: r.report.modelCascade!.verifier,
      outcome: "not_applied",
    });
  });
});
