import type { CachedAnswer } from "./exact.js";
import {
  candidatosDeSeleccion,
  etiquetasMinimas,
  Histograma,
  indiceEnRejilla,
  mulberry32,
  secuenciaFija,
  umbralDeIndice,
  validarCalibracion,
} from "./calibracion.js";

/**
 * Decides whether a stored answer would have been right for a new request,
 * given the answer your provider just produced for it. `true` = the stored
 * answer was reusable.
 *
 * It is the definition of "correct" behind every calibrated floor: the bound
 * holds for what your judge accepts, nothing more. A judge that calls a model
 * costs money this layer does not see and never subtracts from a saving.
 */
export type AnswerJudge = (stored: CachedAnswer, fresh: CachedAnswer) => boolean | Promise<boolean>;

/**
 * Opt-in calibration of the semantic cache: instead of a fixed acceptance floor,
 * the cache serves a reworded request only at or above a floor that labeled
 * traffic has certified, so that at most `maxErrorRate` of the reuses served
 * from that floor up are wrong, at the stated `confidence`.
 *
 * Until a floor is certified the cache serves nothing: every candidate goes to
 * your provider, exactly as it would without the cache, and the fresh answer is
 * compared with the stored one to produce a label. Calibration costs reuses,
 * never an extra provider call.
 *
 * Only candidates at or above `similarityThreshold` are labeled, so no floor
 * below it can be certified: lower it to let the calibration look further down.
 * Your verifier, if any, still scores every candidate, and the score that is
 * calibrated is the lower of similarity and its score.
 */
export interface SemanticCalibrationOptions {
  /** Highest share of wrong reuses you accept, in (0, 0.5]. E.g. 0.02. */
  maxErrorRate: number;
  /** Confidence of the bound, in (0.5, 1). Default 0.95. */
  confidence?: number;
  /**
   * How a label is produced. Default {@link sameAnswer}: identical structured
   * data, or identical text after trimming and collapsing whitespace. For free
   * text, pass your own: with the default, two differently worded correct
   * answers count as a wrong reuse, and the floor stays uncertified.
   */
  judge?: AnswerJudge;
  /**
   * Share of reuses that clear the floor but are sent to your provider anyway,
   * to keep labeling above it. In [0, 1). Default 0.05. Without these labels
   * the floor cannot be re-tested where it serves.
   */
  auditRate?: number;
  /**
   * Stop serving a stored answer at or below a score where it was already
   * judged wrong for another request. It only ever removes reuses. Default true.
   */
  perRecordFloors?: boolean;
  /** Source of randomness for audits, in [0, 1). Default `Math.random`. */
  random?: () => number;
}

/** One labeled reuse decision: the score the cache would have served on, and whether the stored answer was right. */
export interface CalibrationObservation {
  score: number;
  correct: boolean;
}

/** Where a calibration stands. */
export interface SemanticCalibrationStatus {
  maxErrorRate: number;
  confidence: number;
  /** Lowest certified score; null while the labels certify none. */
  floor: number | null;
  /** Labels collected. */
  labeled: number;
  /** Labels kept apart to test the floor (about half). */
  heldOut: number;
  /** Held-out labels at or above the floor, and how many of them were wrong reuses. 0 without a floor. */
  heldOutAtFloor: number;
  wrongHeldOutAtFloor: number;
  /**
   * Held-out labels at or above a floor, all correct, that the next test needs
   * to certify it: the shortest possible wait, not a promise.
   */
  minHeldOutToCertify: number;
  /** Online only: the label count at which the floor is re-tested next. Each test comes when the labels have grown by half. */
  nextTestAt?: number;
}

/** Default {@link AnswerJudge}: the stored answer counts as right only if it is the same answer. */
export function sameAnswer(stored: CachedAnswer, fresh: CachedAnswer): boolean {
  const estructurado = (d: unknown) => d !== null && typeof d === "object";
  if (estructurado(stored.data) && estructurado(fresh.data)) {
    return canonico(stored.data) === canonico(fresh.data);
  }
  const plano = (t: string) => t.trim().replace(/\s+/g, " ");
  return plano(stored.text) === plano(fresh.text);
}

// JSON con las claves ordenadas: `{a,b}` y `{b,a}` son el mismo dato.
function canonico(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonico).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonico(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/**
 * Certifies an acceptance floor from labels you already have (your own traffic,
 * or a labeled set scored with your embedder), with the same test the cache
 * runs online. Pass the result's `floor` as `acceptThreshold`, or `null` means
 * these labels do not support any floor at this bound.
 *
 * The labels are split at random (fixed seed, independent of their content):
 * one half proposes candidate floors, the other half tests them, most
 * conservative first, with an exact binomial test. With probability at least `confidence`, the share of wrong
 * reuses at or above the returned floor is at most `maxErrorRate`, provided new
 * requests come from the same distribution as these labels.
 */
export function calibrateSemanticFloor(
  observations: readonly CalibrationObservation[],
  options: { maxErrorRate: number; confidence?: number },
): SemanticCalibrationStatus {
  const { maxErrorRate, confidence } = validarCalibracion(options);
  const alfa = 1 - confidence;
  const seleccion = new Histograma();
  const retenida = new Histograma();
  // Moneda con semilla fija (mulberry32): el reparto no depende del orden en
  // que vengan las etiquetas, así que ordenarlas por acierto no lo sesga.
  const moneda = mulberry32(0x5eed_ca11);
  let etiquetas = 0;
  for (const o of observations) {
    const i = indiceEnRejilla(o.score);
    const aLaSeleccion = moneda() < 0.5;
    if (i < 0) continue;
    (aLaSeleccion ? seleccion : retenida).anotar(i, o.correct);
    etiquetas++;
  }
  const r = secuenciaFija(retenida, candidatosDeSeleccion(seleccion, maxErrorRate, alfa), maxErrorRate, alfa);
  return {
    maxErrorRate,
    confidence,
    floor: r ? umbralDeIndice(r.indice) : null,
    labeled: etiquetas,
    heldOut: retenida.n,
    heldOutAtFloor: r?.retenidas ?? 0,
    wrongHeldOutAtFloor: r?.erroneas ?? 0,
    minHeldOutToCertify: etiquetasMinimas(maxErrorRate, alfa),
  };
}
