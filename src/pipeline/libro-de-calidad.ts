import type { SemanticHit } from "../cache/semantic.js";
import type {
  AnswerSource,
  CacheOutcome,
  ModelCascadeReport,
  QualityCascadeCheck,
  QualityLedger,
  QualityRepairCheck,
} from "../contracts/types.js";

// ═══════════════════════════════════════════════════════════════════════════
// EL LIBRO DE CALIDAD: QUÉ SE COMPROBÓ EN LA RESPUESTA SERVIDA, SIN DINERO.
// ═══════════════════════════════════════════════════════════════════════════
//
// Recomendación n.º 10 del informe de competencia: nadie publica la calidad por
// petición. `qualityStatus` ya da el veredicto en una palabra; esto es la
// evidencia que lo sostiene, sacada de decisiones que hasta ahora vivían solo
// en `traces` (rescate del JSON envuelto, reparación y su motivo, truncado, la
// similitud del acierto semántico).
//
// TRES REGLAS, Y CADA UNA TIENE SU TEST:
//   1. Ni dinero ni tokens. Nada de aquí es sumable a los cuatro libros ni a
//      `cost`; los conteos (`calls.retries`) ya viven en el lado del dinero.
//   2. No viaja. El wire de metering no cambia: `cacheResult` ya distingue
//      exacta y semántica en el servidor, y lo demás se queda en el proceso.
//   3. Sin contenido. Solo enums, booleanos, similitudes y umbrales —ni rutas
//      ni mensajes de error ni texto—, para que se pueda exportar a
//      observabilidad sin riesgo. Los errores con detalle siguen en `traces`.
//
// Módulo INTERNO: no se reexporta (sus nombres son españoles y la verja de
// superficie lo prohíbe). Funciones puras, sin E/S. Se llama solo desde
// `buildReport()` y, para el seguidor coalescido, desde `asCoalescedFollower()`.

/**
 * Hechos de calidad que solo conoce el camino que sirvió la respuesta. Llegan
 * en UN parámetro opcional a `finish()`/`buildReport()` para no tocar
 * `TraceCollector` (público) ni `SavingsLedger` (dinero).
 */
export interface HechosDeCalidad {
  /** Solo el camino de último recurso: la petición salió por `failOpenDirect`. */
  origen?: "fail_open";
  /** La validación de LO SERVIDO (tras la reparación, si la hubo). */
  validacion?: { resultado: "passed" | "failed"; errores: number; desenvuelto: boolean };
  /** Qué pasó cuando la PRIMERA validación del proveedor falló. */
  reparacion?: QualityRepairCheck;
  /** La respuesta final del proveedor: por qué paró y qué tope puso el llamante. */
  final?: { finishReason?: string; topeDelLlamante?: number };
  /** El acierto semántico tal cual lo devolvió la caché. */
  semantico?: SemanticHit;
}

function origenDe(cacheResult: CacheOutcome, hechos: HechosDeCalidad | undefined): AnswerSource {
  switch (cacheResult) {
    case "deterministic":
      return "deterministic";
    case "exact":
      return "exact_cache";
    case "semantic":
      return "semantic_cache";
    // El seguidor no pasa por `buildReport` (hereda, ver `libroDelSeguidor`);
    // si algún día llegara aquí, lo honesto es decir que es compartida.
    case "singleflight":
      return "coalesced";
    default:
      return hechos?.origen === "fail_open" ? "fail_open" : "provider";
  }
}

function cascadaDe(c: ModelCascadeReport | undefined): QualityCascadeCheck | undefined {
  // `off` no publica bloque `modelCascade`, así que tampoco aquí.
  if (!c || (c.mode !== "shadow" && c.mode !== "on")) return undefined;
  if (c.mode === "shadow") {
    // `not_applied` y no «measured_*»: en este repo «measured» es la base del
    // dinero (el contador del proveedor), y una petición en sombra SIN muestreo
    // no midió nada del modelo barato. Lo único cierto en todas es que la
    // decisión de la cascada no se aplicó y contestó el modelo pedido.
    return {
      mode: "shadow",
      gate: c.verifier,
      outcome: "not_applied",
      ...(c.divergedOnSample !== undefined ? { sampleDiverged: c.divergedOnSample } : {}),
    };
  }
  // El mismo criterio que `estadoDeCalidad` usa para `bounded_degradation`: lo
  // que cuenta es QUIÉN contestó, no lo que se planeó.
  const outcome: QualityCascadeCheck["outcome"] =
    c.servedModel !== c.requestedModel ? "accepted" : c.escalated === true ? "escalated" : "not_routed";
  return { mode: "on", gate: c.verifier, outcome };
}

/**
 * Construye el libro de una petición que pasó por `buildReport()`: atajos
 * (resolver, caché exacta, caché semántica), camino del proveedor y fail-open.
 */
export function libroDeCalidad(a: {
  cacheResult: CacheOutcome;
  /** `null` = no aplica (turno de herramientas). */
  structurallyValid: boolean | null;
  backend: string;
  hayEsquema: boolean;
  ageMs?: number | undefined;
  cascada?: ModelCascadeReport | undefined;
  hechos?: HechosDeCalidad | undefined;
}): QualityLedger {
  const hechos = a.hechos;
  const source = origenDe(a.cacheResult, hechos);
  const libro: QualityLedger = { source };

  if (a.hayEsquema) {
    if (a.structurallyValid === null) {
      libro.schema = { outcome: "not_applicable", decodeTimeConstraint: a.backend !== "none", errorCount: 0 };
    } else {
      const v = hechos?.validacion;
      // Todos los caminos que validan dejan `validacion`. Si faltara, el recuento
      // es la cota que sí se sabe: 0 si pasó, al menos 1 si no.
      const errorCount = v?.errores ?? (a.structurallyValid ? 0 : 1);
      libro.schema = {
        outcome: a.structurallyValid ? "passed" : "failed",
        decodeTimeConstraint: a.backend !== "none",
        errorCount,
        ...(v?.desenvuelto ? { unwrapped: true as const } : {}),
      };
    }
  }

  // Solo el camino del proveedor repara, y solo cuando la PRIMERA validación
  // falló: ahí la etapa 11 deja uno de sus cinco desenlaces.
  if (source === "provider" && hechos?.reparacion) libro.repair = { ...hechos.reparacion };

  // Un proveedor generó lo servido EN ESTA petición.
  if (source === "provider" || source === "fail_open") {
    const f = hechos?.final;
    const tope = f?.topeDelLlamante;
    libro.truncation = {
      truncated: f?.finishReason === "length",
      ...(f?.finishReason !== undefined ? { finishReason: f.finishReason } : {}),
      capSetByCaller: tope != null,
      ...(tope != null ? { outputLimit: tope } : {}),
    };
  }

  if (source === "exact_cache") {
    libro.cacheMatch = { kind: "exact", ...(a.ageMs !== undefined ? { ageMs: a.ageMs } : {}) };
  } else if (source === "semantic_cache" && hechos?.semantico) {
    const h = hechos.semantico;
    libro.cacheMatch = {
      kind: "semantic",
      ageMs: h.ageMs,
      similarity: h.similarity,
      similarityFloor: h.similarityFloor,
      acceptFloor: h.acceptFloor,
      // Sin verificador, `verifierScore` ES la similitud: publicarla como
      // puntuación de un verificador que no existe sería inventarse una prueba.
      ...(h.verifierRan ? { verifierScore: h.verifierScore } : {}),
      embedder: h.embedder,
      // `find()` no devuelve ningún candidato que no la pase.
      factGuard: "passed",
    };
  }

  const cascade = cascadaDe(a.cascada);
  if (cascade) libro.cascade = cascade;

  return libro;
}

/**
 * El libro del seguidor coalescido. Sirve EL TEXTO DEL LÍDER, así que los
 * bloques describen esa respuesta compartida —nada se volvió a ejecutar—, con
 * el mismo criterio que la herencia de `qualityStatus`. Lo único que cambia es
 * el origen: `coalesced`, y en `sharedFrom` de dónde le vino al líder.
 */
export function libroDelSeguidor(lider?: QualityLedger): QualityLedger {
  const sharedFrom: Exclude<AnswerSource, "coalesced"> =
    lider == null ? "provider" : lider.source === "coalesced" ? (lider.sharedFrom ?? "provider") : lider.source;
  // Copias de cada bloque (todos son planos): el seguidor no comparte objetos
  // con el informe del líder, que es de otro llamante.
  return {
    source: "coalesced",
    sharedFrom,
    ...(lider?.schema ? { schema: { ...lider.schema } } : {}),
    ...(lider?.repair ? { repair: { ...lider.repair } } : {}),
    ...(lider?.truncation ? { truncation: { ...lider.truncation } } : {}),
    ...(lider?.cacheMatch ? { cacheMatch: { ...lider.cacheMatch } } : {}),
    ...(lider?.cascade ? { cascade: { ...lider.cascade } } : {}),
  };
}
