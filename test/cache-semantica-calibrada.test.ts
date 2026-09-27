import { describe, it, expect } from "vitest";

import {
  alfaDeMirada,
  candidatoDeSeleccion,
  certifica,
  colaInferiorBinomial,
  EstadoDeCalibracion,
  etiquetasMinimas,
  Histograma,
  indiceEnRejilla,
  mulberry32,
  umbralDeIndice,
} from "../src/cache/calibracion.js";
import { calibrateSemanticFloor, sameAnswer, type CalibrationObservation } from "../src/cache/calibration.js";
import { InMemorySemanticCache, type SemanticCacheOptions } from "../src/cache/semantic.js";
import { canonicalize } from "../src/canonicalization/canonicalize.js";
import { createSavingsLayer } from "../src/pipeline/create.js";
import { libroDelSeguidor } from "../src/pipeline/libro-de-calidad.js";
import type { CachedAnswer } from "../src/cache/exact.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import type { QualityLedger, SavingsRequest } from "../src/contracts/types.js";

/**
 * LA CACHÉ SEMÁNTICA CALIBRADA: EL SUELO LO CERTIFICAN LAS ETIQUETAS.
 *
 * Opt-in (`calibration` en `InMemorySemanticCache`). Tres bloques:
 *   1. La estadística: el test binomial exacto, la rejilla, el reparto α.
 *   2. La GARANTÍA, comprobada por Monte Carlo con una verdad conocida: en qué
 *      fracción de tiradas el suelo certificado incumple la cota. Tiene que ser
 *      ≤ α (con margen de muestreo), fuera y dentro de línea.
 *   3. La caché y la capa: nada se sirve hasta que haya suelo, las sondas se
 *      etiquetan con la respuesta del proveedor, la cota viaja en el libro de
 *      calidad y el dinero no se entera.
 */

// ─── 1. Estadística ─────────────────────────────────────────────────────────

describe("la estadística de la calibración", () => {
  it("la cola binomial coincide con la suma directa y no se hunde con n grande", () => {
    const directa = (n: number, e: number, p: number) => {
      let s = 0;
      for (let k = 0; k <= e; k++) {
        let c = 1;
        for (let j = 0; j < k; j++) c = (c * (n - j)) / (j + 1);
        s += c * p ** k * (1 - p) ** (n - k);
      }
      return s;
    };
    for (const [n, e, p] of [[10, 2, 0.3], [59, 0, 0.05], [200, 7, 0.05], [30, 29, 0.5]] as const) {
      expect(colaInferiorBinomial(n, e, p)).toBeCloseTo(directa(n, e, p), 12);
    }
    // (1 − 0,001)^100000 ≈ e^-100: sin escala logarítmica sería 0 y el test mentiría.
    const grande = colaInferiorBinomial(100_000, 120, 0.001);
    expect(grande).toBeGreaterThan(0.9);
    expect(grande).toBeLessThanOrEqual(1);
    expect(colaInferiorBinomial(100_000, 10, 0.001)).toBeGreaterThan(0);
    expect(colaInferiorBinomial(5, 5, 0.2)).toBe(1);
  });

  it("las etiquetas mínimas son las de la cota de Clopper-Pearson con cero errores", () => {
    // ln(0,05)/ln(0,95) = 58,4 → 59; ln(0,05)/ln(0,98) = 148,3 → 149.
    expect(etiquetasMinimas(0.05, 0.05)).toBe(59);
    expect(etiquetasMinimas(0.02, 0.05)).toBe(149);
    expect(certifica(59, 0, 0.05, 0.05)).toBe(true);
    expect(certifica(58, 0, 0.05, 0.05)).toBe(false);
    // Con e ≥ nδ no se certifica nunca, aunque n sea enorme.
    expect(certifica(1_000_000, 50_000, 0.05, 0.05)).toBe(false);
    expect(certifica(0, 0, 0.05, 0.05)).toBe(false);
  });

  it("el reparto de α entre miradas suma α y nunca lo pasa", () => {
    let suma = 0;
    for (let k = 0; k < 100_000; k++) suma += alfaDeMirada(0.05, k);
    expect(suma).toBeLessThanOrEqual(0.05);
    expect(suma).toBeGreaterThan(0.0499);
  });

  it("la rejilla es fija y absorbe el ruido de coma flotante", () => {
    expect(indiceEnRejilla(0.85)).toBe(850);
    expect(indiceEnRejilla(1)).toBe(1000);
    expect(indiceEnRejilla(1.0000001)).toBe(1000);
    expect(indiceEnRejilla(-0.1)).toBe(-1);
    expect(indiceEnRejilla(Number.NaN)).toBe(-1);
    expect(umbralDeIndice(850)).toBe(0.85);
  });

  it("el candidato sube hasta la puntuación más baja observada (no publica 0,000)", () => {
    const h = new Histograma();
    for (let i = 0; i < 200; i++) h.anotar(indiceEnRejilla(0.9 + (i % 10) / 100), true);
    const c = candidatoDeSeleccion(h, 0.05, 0.05);
    expect(c).toBe(900);
  });
});

// ─── 2. La garantía, por Monte Carlo ────────────────────────────────────────

// Verdad conocida: puntuaciones uniformes en [0,6; 1] y una probabilidad de
// reutilización errónea que BAJA con la puntuación (el supuesto de monotonía).
const qVerdad = (s: number) => 0.5 / (1 + Math.exp(40 * (s - 0.85)));
/** La tasa VERDADERA de erróneas entre las reutilizaciones con puntuación ≥ t (integral numérica). */
function tasaVerdadera(t: number): number {
  const a = Math.max(0.6, t);
  const pasos = 2000;
  let s = 0;
  for (let i = 0; i < pasos; i++) s += qVerdad(a + ((i + 0.5) * (1 - a)) / pasos);
  return s / pasos;
}
function etiquetasSinteticas(n: number, rng: () => number): CalibrationObservation[] {
  const out: CalibrationObservation[] = [];
  for (let i = 0; i < n; i++) {
    const score = 0.6 + 0.4 * rng();
    out.push({ score, correct: rng() >= qVerdad(score) });
  }
  return out;
}

describe("la garantía se cumple (Monte Carlo con verdad conocida)", () => {
  // α = 0,10 para que un fallo del método se VEA en 300 tiradas: si la
  // garantía no se cumpliera, las violaciones rondarían o pasarían de 30.
  const DELTA = 0.05;
  const CONFIANZA = 0.9;
  const TIRADAS = 300;

  it("fuera de línea: el suelo certificado incumple δ en ≤ α de las tiradas, y certifica casi siempre", () => {
    let violaciones = 0;
    let certificadas = 0;
    for (let t = 0; t < TIRADAS; t++) {
      const r = calibrateSemanticFloor(etiquetasSinteticas(3000, mulberry32(1000 + t)), {
        maxErrorRate: DELTA,
        confidence: CONFIANZA,
      });
      if (r.floor == null) continue;
      certificadas++;
      if (tasaVerdadera(r.floor) > DELTA) violaciones++;
    }
    // Cota superior holgada: α·TIRADAS + 3 desviaciones de una binomial.
    const techo = CONFIANZA < 1 ? (1 - CONFIANZA) * TIRADAS + 3 * Math.sqrt(TIRADAS * 0.1 * 0.9) : 0;
    expect(violaciones).toBeLessThanOrEqual(techo);
    expect(certificadas).toBeGreaterThan(TIRADAS * 0.9);
  });

  it("en línea: ninguna mirada de la vida entera de la caché incumple δ en más de α de las tiradas", () => {
    let conViolacion = 0;
    let certificadas = 0;
    for (let t = 0; t < TIRADAS; t++) {
      const estado = new EstadoDeCalibracion(DELTA, 1 - CONFIANZA);
      const rng = mulberry32(5000 + t);
      let violo = false;
      let sueloPrevio: number | null = null;
      // En línea hacen falta más etiquetas que fuera: la mitad se retiene y α se
      // reparte entre miradas. Con esta curva, la mediana de la primera
      // certificación ronda las 2.800 etiquetas (medido con esta misma semilla).
      for (const o of etiquetasSinteticas(8000, rng)) {
        estado.anotar(o.score, o.correct);
        const suelo = estado.suelo;
        if (suelo != null && suelo !== sueloPrevio && tasaVerdadera(umbralDeIndice(suelo)) > DELTA) violo = true;
        sueloPrevio = suelo;
      }
      if (estado.suelo != null) certificadas++;
      if (violo) conViolacion++;
    }
    expect(conViolacion).toBeLessThanOrEqual(0.1 * TIRADAS + 3 * Math.sqrt(TIRADAS * 0.1 * 0.9));
    expect(certificadas).toBeGreaterThan(TIRADAS * 0.85);
  });

  it("si la cota es inalcanzable (δ por debajo del error de TODA puntuación), no certifica nunca", () => {
    // q ≥ 0,2 en todas partes: δ = 0,05 no la puede cumplir ningún suelo.
    const rng = mulberry32(7);
    const obs = Array.from({ length: 5000 }, () => {
      const score = 0.6 + 0.4 * rng();
      return { score, correct: rng() >= 0.2 };
    });
    expect(calibrateSemanticFloor(obs, { maxErrorRate: 0.05 }).floor).toBeNull();
    const estado = new EstadoDeCalibracion(0.05, 0.05);
    for (const o of obs) estado.anotar(o.score, o.correct);
    expect(estado.suelo).toBeNull();
  });
});

describe("calibrateSemanticFloor (fuera de línea)", () => {
  it("con pocas etiquetas no certifica, y dice cuántas harían falta como mínimo", () => {
    const r = calibrateSemanticFloor(
      Array.from({ length: 40 }, () => ({ score: 0.99, correct: true })),
      { maxErrorRate: 0.05 },
    );
    expect(r.floor).toBeNull();
    expect(r.labeled).toBe(40);
    expect(r.minHeldOutToCertify).toBe(59);
    expect(r.heldOutAtFloor).toBe(0);
  });

  it("es determinista y sus cifras cuadran", () => {
    const obs = etiquetasSinteticas(3000, mulberry32(42));
    const a = calibrateSemanticFloor(obs, { maxErrorRate: 0.05 });
    const b = calibrateSemanticFloor(obs, { maxErrorRate: 0.05 });
    expect(a).toEqual(b);
    expect(a.floor).not.toBeNull();
    expect(a.heldOut).toBeGreaterThan(1300);
    expect(a.heldOut).toBeLessThan(1700);
    expect(a.wrongHeldOutAtFloor / a.heldOutAtFloor).toBeLessThan(0.05);
  });

  it("rechaza números fuera de rango", () => {
    expect(() => calibrateSemanticFloor([], { maxErrorRate: 0 })).toThrow(RangeError);
    expect(() => calibrateSemanticFloor([], { maxErrorRate: 0.6 })).toThrow(RangeError);
    expect(() => calibrateSemanticFloor([], { maxErrorRate: 0.05, confidence: 0.5 })).toThrow(RangeError);
    expect(() => calibrateSemanticFloor([], { maxErrorRate: 0.05, confidence: 1 })).toThrow(RangeError);
  });
});

describe("sameAnswer, el juez por defecto", () => {
  const r = (text: string, data?: unknown): CachedAnswer => ({ text, data, storedAtMs: 0 });
  it("datos estructurados: iguales aunque cambie el orden de las claves", () => {
    expect(sameAnswer(r("x", { a: 1, b: [1, { c: 2, d: 3 }] }), r("y", { b: [1, { d: 3, c: 2 }], a: 1 }))).toBe(true);
    expect(sameAnswer(r("x", { a: 1 }), r("x", { a: 2 }))).toBe(false);
  });
  it("texto: igual salvo espacios; cualquier otra diferencia es otra respuesta", () => {
    expect(sameAnswer(r("  Paris\n"), r("Paris"))).toBe(true);
    expect(sameAnswer(r("positive"), r("negative"))).toBe(false);
    expect(sameAnswer(r("Paris."), r("Paris"))).toBe(false);
  });
});

// ─── 3. La caché y la capa ──────────────────────────────────────────────────

const canon = (texto: string, tenantId = "t") =>
  canonicalize({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: texto }], context: { tenantId } });
const resp = (text: string): CachedAnswer => ({ text, data: text, storedAtMs: 0 });

// δ = 0,5 y 90 % de confianza: la primera mirada llega con 10 etiquetas, así
// que se puede certificar en un test sin miles de peticiones.
const CAL_RAPIDA = { maxErrorRate: 0.5, confidence: 0.9, auditRate: 0 } as const;

async function certificar(cache: InMemorySemanticCache, n = 40, agentic = false): Promise<void> {
  const guardada = canon("summarize the quarterly report for the board", `cert-${agentic}`);
  await cache.store(guardada, resp("the summary"));
  for (let i = 0; i < n; i++) {
    const { probe } = await cache.lookup(canon("summarize the quarterly report for the board", `cert-${agentic}`), { agentic });
    if (!probe) break;
    await cache.observe(probe, resp("the summary"));
  }
  await cache.settled();
}

describe("InMemorySemanticCache con calibración", () => {
  it("sin calibración, nada cambia: lookup = find y no hay sondas ni estado", async () => {
    const cache = new InMemorySemanticCache();
    await cache.store(canon("describe the water cycle in simple terms"), resp("rain"));
    const q = canon("describe the water cycle in simple terms please");
    const hit = await cache.find(q);
    const l = await cache.lookup(q);
    expect(hit).not.toBeNull();
    // Dos lecturas en dos instantes: todo igual salvo la edad, que en la segunda
    // solo puede ser mayor o igual. Compararla entera fallaba con la máquina cargada.
    const { ageMs: edadFind, ...restoFind } = hit!;
    const { ageMs: edadLookup, ...restoLookup } = l.hit!;
    expect(restoLookup).toEqual(restoFind);
    expect(edadLookup).toBeGreaterThanOrEqual(edadFind);
    expect(l.probe).toBeNull();
    expect(cache.calibrated).toBe(false);
    expect(cache.calibrationStatus()).toBeNull();
    expect(hit!.calibration).toBeUndefined();
  });

  it("hasta que hay suelo NO sirve nada: la candidata sale como sonda «calibrating»", async () => {
    const cache = new InMemorySemanticCache({ calibration: { maxErrorRate: 0.05 } });
    await cache.store(canon("describe the water cycle in simple terms"), resp("rain"));
    const q = canon("describe the water cycle in simple terms please");
    expect(await cache.find(q)).toBeNull();
    const { hit, probe } = await cache.lookup(q);
    expect(hit).toBeNull();
    expect(probe!.reason).toBe("calibrating");
    expect(probe!.segment).toBe("single_shot");
    expect(probe!.score).toBeGreaterThan(0.72);
    expect(await cache.observe(probe!, resp("rain"))).toBe(true);
    expect(await cache.observe(probe!, resp("snow"))).toBe(false);
    const s = cache.calibrationStatus()!;
    expect(s.labeled).toBe(2);
    expect(s.floor).toBeNull();
    expect(s.minHeldOutToCertify).toBe(etiquetasMinimas(0.05, alfaDeMirada(0.05, 0)));
    expect(s.nextTestAt).toBe(2 * s.minHeldOutToCertify);
  });

  it("con etiquetas suficientes certifica, y el acierto lleva la cota y las etiquetas que la sostienen", async () => {
    const cache = new InMemorySemanticCache({ calibration: CAL_RAPIDA });
    await certificar(cache);
    const s = cache.calibrationStatus()!;
    expect(s.floor).not.toBeNull();
    const { hit, probe } = await cache.lookup(canon("summarize the quarterly report for the board", "cert-false"));
    expect(probe).toBeNull();
    expect(hit!.acceptFloor).toBe(s.floor);
    expect(hit!.calibration).toEqual({
      maxErrorRate: 0.5,
      confidence: 0.9,
      floor: s.floor,
      heldOutAtFloor: s.heldOutAtFloor,
      wrongHeldOutAtFloor: 0,
      labeled: s.labeled,
      segment: "single_shot",
    });
  });

  it("auditoría: una reutilización que pasa el suelo se manda al proveedor si toca", async () => {
    let tiradas = 0;
    let dado = 0.99;
    const cache = new InMemorySemanticCache({
      calibration: { ...CAL_RAPIDA, auditRate: 0.05, random: () => (tiradas++, dado) },
    });
    await certificar(cache);
    // Mientras calibraba no se tiró el dado (la sonda ya era obligatoria): solo
    // en la consulta que, ya con suelo, salió acierto.
    expect(tiradas).toBe(1);
    const q = canon("summarize the quarterly report for the board", "cert-false");
    dado = 0.01;
    expect((await cache.lookup(q)).probe!.reason).toBe("audit");
    dado = 0.99;
    expect((await cache.lookup(q)).hit).not.toBeNull();
  });

  it("suelo por registro: una respuesta ya juzgada errónea a una puntuación no se sirve por debajo de ella", async () => {
    for (const perRecordFloors of [true, false]) {
      const cache = new InMemorySemanticCache({ calibration: { ...CAL_RAPIDA, perRecordFloors } });
      await certificar(cache);
      const q = canon("summarize the quarterly report for the board", "cert-false");
      const hit = (await cache.lookup(q)).hit!;
      // Una auditoría manual de esa misma candidata: el juez dice que NO valía.
      await cache.observe({ reason: "audit", score: hit.confidence, segment: "single_shot", record: hit.record }, resp("other"));
      const despues = await cache.lookup(q);
      if (perRecordFloors) {
        expect(hit.record.failedAtScore).toBe(hit.confidence);
        expect(despues.probe!.reason).toBe("record_floor");
      } else {
        expect(hit.record.failedAtScore).toBeUndefined();
        expect(despues.hit).not.toBeNull();
      }
    }
  });

  it("un acceptThreshold EXPLÍCITO sigue contando como suelo adicional", async () => {
    const cache = new InMemorySemanticCache({ calibration: CAL_RAPIDA, acceptThreshold: 0.999 });
    await cache.store(canon("describe the water cycle in simple terms", "x"), resp("rain"));
    await certificar(cache);
    const { hit, probe } = await cache.lookup(canon("describe the water cycle in simple terms please", "x"));
    expect(hit).toBeNull();
    expect(probe!.reason).toBe("below_floor");
  });

  it("un juez que falla no deja etiqueta; uno que no devuelve `true` cuenta como errónea", async () => {
    let modo: "lanza" | "si" = "lanza";
    const cache = new InMemorySemanticCache({
      calibration: {
        maxErrorRate: 0.05,
        judge: () => {
          if (modo === "lanza") throw new Error("judge down");
          return "yes" as unknown as boolean;
        },
      },
    });
    await cache.store(canon("describe the water cycle in simple terms"), resp("rain"));
    const { probe } = await cache.lookup(canon("describe the water cycle in simple terms please"));
    expect(await cache.observe(probe!, resp("rain"))).toBeNull();
    expect(cache.calibrationStatus()!.labeled).toBe(0);
    modo = "si";
    expect(await cache.observe(probe!, resp("rain"))).toBe(false);
    expect(cache.calibrationStatus()!.labeled).toBe(1);
  });

  it("lo agéntico y lo de un turno no se certifican el uno al otro", async () => {
    const cache = new InMemorySemanticCache({ calibration: CAL_RAPIDA });
    await certificar(cache, 40, true);
    expect(cache.calibrationStatus("agentic")!.floor).not.toBeNull();
    expect(cache.calibrationStatus("single_shot")!.floor).toBeNull();
    const q = canon("summarize the quarterly report for the board", "cert-true");
    expect((await cache.lookup(q)).probe!.reason).toBe("calibrating");
    expect((await cache.lookup(q, { agentic: true })).hit!.calibration!.segment).toBe("agentic");
  });

  it("valida los números al construir, no en la primera petición", () => {
    const mal: SemanticCacheOptions["calibration"][] = [
      { maxErrorRate: 0 },
      { maxErrorRate: 0.05, confidence: 0.4 },
      { maxErrorRate: 0.05, auditRate: 1 },
      { maxErrorRate: 0.05, auditRate: -0.1 },
    ];
    for (const calibration of mal) expect(() => new InMemorySemanticCache({ calibration })).toThrow(RangeError);
  });
});

// La capa entera con un proveedor que contesta lo que se le diga.
class Guion implements Provider {
  readonly id = "guion";
  llamadas = 0;
  constructor(
    public texto = "the summary",
    public finishReason: ProviderResponse["finishReason"] = "stop",
  ) {}
  async generate(_r: ProviderRequest): Promise<ProviderResponse> {
    this.llamadas++;
    return { text: this.texto, usage: { inputTokens: 100, outputTokens: 10 }, finishReason: this.finishReason };
  }
}
const PRECIOS = { "openai/gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 } };
const pide = (content: string, extra: Partial<SavingsRequest> = {}): SavingsRequest => ({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content }],
  savings: { semanticCache: true, exactCache: false, singleflight: false },
  context: { tenantId: "acme" },
  ...extra,
});

describe("la capa con la caché calibrada", () => {
  it("antes del suelo: cada candidata va al proveedor, se etiqueta, y la traza lo dice", async () => {
    const p = new Guion();
    const semanticCache = new InMemorySemanticCache({ calibration: { maxErrorRate: 0.05 } });
    const capa = createSavingsLayer({ provider: p, semanticCache, costModels: PRECIOS, silenceWarnings: true });
    await capa.generate(pide("summarize the quarterly report for the board"));
    const r = await capa.generate(pide("please summarize the quarterly report for the board"));
    await semanticCache.settled();
    expect(p.llamadas).toBe(2);
    expect(r.report.cache.result).toBe("miss");
    const miss = r.report.traces.find((t) => t.stage === "semantic-cache");
    expect(miss?.outcome).toBe("miss");
    expect(miss?.detail?.["calibration"]).toBe("calibrating");
    expect(r.report.traces.some((t) => t.stage === "semantic-calibration" && t.outcome === "label requested")).toBe(true);
    expect(semanticCache.calibrationStatus()!.labeled).toBe(1);
    // Una sonda es una llamada normal: el dinero no cambia por calibrar.
    expect(r.report.calls.avoidedLlm).toBe(0);
    expect(r.report.calls.actualLlm).toBe(1);
    await capa.close();
  });

  it("tras el suelo: el acierto publica la cota en el libro de calidad, con la misma base de dinero que sin calibrar", async () => {
    const p = new Guion();
    const semanticCache = new InMemorySemanticCache({ calibration: CAL_RAPIDA });
    const capa = createSavingsLayer({ provider: p, semanticCache, costModels: PRECIOS, silenceWarnings: true });
    await capa.generate(pide("summarize the quarterly report for the board"));
    let r = await capa.generate(pide("please summarize the quarterly report for the board"));
    for (let i = 0; i < 40 && r.report.cache.result !== "semantic"; i++) {
      await semanticCache.settled();
      r = await capa.generate(pide("please summarize the quarterly report for the board"));
    }
    expect(r.report.cache.result).toBe("semantic");
    expect(r.report.qualityStatus).toBe("task_equivalent");
    const m = r.report.qualityLedger!.cacheMatch!;
    if (m.kind !== "semantic") throw new Error("se esperaba un acierto semántico");
    const s = semanticCache.calibrationStatus()!;
    expect(m.calibration).toEqual({
      maxErrorRate: 0.5,
      confidence: 0.9,
      floor: s.floor,
      heldOutAtFloor: s.heldOutAtFloor,
      wrongHeldOutAtFloor: s.wrongHeldOutAtFloor,
      labeled: s.labeled,
      segment: "single_shot",
    });
    expect(m.acceptFloor).toBe(s.floor);

    // La base del dinero de un acierto calibrado es la de uno sin calibrar.
    const sinCalibrar = new InMemorySemanticCache();
    const otra = createSavingsLayer({ provider: new Guion(), semanticCache: sinCalibrar, costModels: PRECIOS, silenceWarnings: true });
    await otra.generate(pide("summarize the quarterly report for the board"));
    const r2 = await otra.generate(pide("please summarize the quarterly report for the board"));
    expect(r2.report.cache.result).toBe("semantic");
    expect(r.report.cost.basis).toBe(r2.report.cost.basis);
    expect(r.report.cost.basis).not.toBe("reference");
    await capa.close();
    await otra.close();
  });

  it("una respuesta que la caché no guardaría no se usa de etiqueta", async () => {
    const p = new Guion();
    const semanticCache = new InMemorySemanticCache({ calibration: { maxErrorRate: 0.05 } });
    const capa = createSavingsLayer({ provider: p, semanticCache, costModels: PRECIOS, silenceWarnings: true });
    await capa.generate(pide("summarize the quarterly report for the board"));
    p.finishReason = "length";
    const r = await capa.generate(pide("please summarize the quarterly report for the board"));
    await semanticCache.settled();
    expect(r.report.traces.some((t) => t.stage === "semantic-calibration" && t.outcome.startsWith("no label"))).toBe(true);
    expect(semanticCache.calibrationStatus()!.labeled).toBe(0);
    await capa.close();
  });

  it("el tráfico agéntico sigue fuera por defecto; con include-agentic calibra en SU segmento", async () => {
    const p = new Guion();
    const semanticCache = new InMemorySemanticCache({ calibration: { maxErrorRate: 0.05 } });
    const capa = createSavingsLayer({ provider: p, semanticCache, costModels: PRECIOS, silenceWarnings: true });
    const historia = (ultimo: string) => [
      { role: "user" as const, content: "we are reviewing the quarterly report" },
      { role: "assistant" as const, content: "ok" },
      { role: "user" as const, content: ultimo },
    ];
    const agentico = (ultimo: string, incluir: boolean) =>
      pide("", {
        messages: historia(ultimo),
        savings: { semanticCache: incluir ? "include-agentic" : true, exactCache: false, singleflight: false },
      });
    await capa.generate(agentico("summarize it for the board", false));
    const fuera = await capa.generate(agentico("please summarize it for the board", false));
    expect(fuera.report.traces.some((t) => t.stage === "semantic-calibration")).toBe(false);
    await capa.generate(agentico("summarize it for the board", true));
    await capa.generate(agentico("please summarize it for the board", true));
    await semanticCache.settled();
    expect(semanticCache.calibrationStatus("agentic")!.labeled).toBe(1);
    expect(semanticCache.calibrationStatus("single_shot")!.labeled).toBe(0);
    await capa.close();
  });

  it("el seguidor coalescido copia la cota, no la comparte", () => {
    const lider: QualityLedger = {
      source: "semantic_cache",
      cacheMatch: {
        kind: "semantic", similarity: 0.95, similarityFloor: 0.72, acceptFloor: 0.9, embedder: "built_in",
        factGuard: "passed",
        calibration: {
          maxErrorRate: 0.02, confidence: 0.95, floor: 0.9, heldOutAtFloor: 400, wrongHeldOutAtFloor: 2,
          labeled: 900, segment: "single_shot",
        },
      },
    };
    const s = libroDelSeguidor(lider);
    expect(s.cacheMatch).toEqual(lider.cacheMatch);
    const a = lider.cacheMatch!;
    const b = s.cacheMatch!;
    if (a.kind !== "semantic" || b.kind !== "semantic") throw new Error("semántico");
    expect(b.calibration).not.toBe(a.calibration);
  });
});

// ─── 4. El banco de la calibración, en seco ─────────────────────────────────

describe("el banco de la calibración (en seco)", () => {
  it("cada veredicto va con la puntuación de SU candidata, no con la de la anterior", async () => {
    const { etiquetasDelStream } = await import("../benchmarks/cache-semantica/calibrada.js");
    // Dos parejas: la primera, reformulación de la MISMA clase (correcta); la
    // segunda, de OTRA clase (errónea). Sus puntuaciones son distintas, así que
    // un desfase de una etiqueta se ve.
    const filas = [
      { id: 1, prompt: "describe the water cycle in simple terms", idSet: 10 },
      { id: 2, prompt: "describe the water cycle in simple terms please", idSet: 10 },
      { id: 3, prompt: "summarize the quarterly report for the board of directors briefly", idSet: 20 },
      { id: 4, prompt: "summarize the quarterly report for the board of directors", idSet: 30 },
    ];
    const obs = await etiquetasDelStream(filas, {});
    expect(obs.map((o) => o.correct)).toEqual([true, false]);
    expect(obs.map((o) => [o.consulta, o.guardada])).toEqual([[2, 1], [4, 3]]);
    const esperada = async (guardada: string, actual: string) => {
      const cache = new InMemorySemanticCache({ calibration: { maxErrorRate: 0.5 } });
      await cache.store(canon(guardada, "stream"), resp("x"));
      return (await cache.lookup(canon(actual, "stream"))).probe!.score;
    };
    expect(obs[0]!.score).toBe(await esperada(filas[0]!.prompt, filas[1]!.prompt));
    expect(obs[1]!.score).toBe(await esperada(filas[2]!.prompt, filas[3]!.prompt));
    expect(obs[0]!.score).not.toBe(obs[1]!.score);
  });

  it("el ruido de etiqueta cuenta las erróneas con el MISMO texto guardado y consultado", async () => {
    const { ruidoDeEtiqueta } = await import("../benchmarks/cache-semantica/calibrada.js");
    const filas = [
      { id: 1, prompt: "same text", idSet: 1 },
      { id: 2, prompt: "same text", idSet: 2 },
      { id: 3, prompt: "other text", idSet: 3 },
    ];
    expect(
      ruidoDeEtiqueta(
        [
          { score: 1, correct: false, consulta: 2, guardada: 1 },
          { score: 0.9, correct: false, consulta: 3, guardada: 1 },
          { score: 1, correct: true, consulta: 3, guardada: 3 },
        ],
        filas,
      ),
    ).toEqual({ erroneas: 2, conPromptIdentico: 1, aPuntuacionUno: { erroneas: 1, conPromptIdentico: 1 } });
  });

  it("la tabla por tramos acumula desde arriba", async () => {
    const { tablaPorTramos } = await import("../benchmarks/cache-semantica/calibrada.js");
    const t = tablaPorTramos([
      { score: 1, correct: true },
      { score: 0.97, correct: false },
      { score: 0.96, correct: true },
      { score: 0.81, correct: false },
    ]);
    expect(t).toEqual([
      { desde: 1, n: 1, erroneas: 0, nAcumulado: 1, errorAcumulado: 0 },
      { desde: 0.95, n: 2, erroneas: 1, nAcumulado: 3, errorAcumulado: 1 / 3 },
      { desde: 0.8, n: 1, erroneas: 1, nAcumulado: 4, errorAcumulado: 0.5 },
    ]);
  });

  it("los vectores del dataset llegan como TEXTO JSON y se leen; lo demás rompe", async () => {
    const { vectorDeCelda } = await import("../benchmarks/cache-semantica/datos.js");
    expect(vectorDeCelda("[-0.44, 0.5, 1e-3]", "emb_x")).toEqual([-0.44, 0.5, 0.001]);
    expect(vectorDeCelda(new Float32Array([1, 2]), "emb_x")).toEqual([1, 2]);
    expect(vectorDeCelda([3, 4], "emb_x")).toEqual([3, 4]);
    expect(() => vectorDeCelda('{"a":1}', "emb_x")).toThrow(/not a JSON array/);
    expect(() => vectorDeCelda(7, "emb_x")).toThrow(/not a vector column/);
  });
});
