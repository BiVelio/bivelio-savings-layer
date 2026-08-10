import type { CanonicalRequest } from "../canonicalization/canonicalize.js";
import type { ExecutionClass } from "../contracts/types.js";

/**
 * Execution router (inspired by Adaptive-RAG).
 *
 * The single most impactful decision is often not "how do I compress this
 * prompt" but "does this request need retrieval / tools at all". We do NOT use
 * a large LLM to decide whether to call a large LLM. The router is:
 *   deterministic rules  +  a small local classifier hook  +  confidence.
 *
 * It is designed to be deployed in SHADOW MODE first: it produces a decision
 * and a confidence, and you compare its choices against realized cost/quality
 * before letting it gate execution.
 *
 * Robustness note: small paraphrases can flip retrieval decisions. The router
 * classifies over the *normalized* text and exposes its reasoning so a
 * paraphrase-stability suite can measure decision drift.
 */
export interface RouteDecision {
  executionClass: ExecutionClass;
  confidence: number;
  reason: string;
  /** Suggested number of retrieval rounds (0 for NO_RETRIEVAL). */
  rounds: number;
}

/** Optional local classifier that can override/augment the rules. */
export interface LocalClassifier {
  classify(text: string): { executionClass: ExecutionClass; confidence: number } | null;
}

const MULTI_HOP =
  /\b(compare|versus|\bvs\b|difference between|both|and then|after that|which is (?:better|cheaper|faster)|compar[ae]|diferencia entre)\b/i;
const SINGLE_LOOKUP =
  /\b(who|what|when|where|which|how many|how much|define|definition|qui[eé]n|qu[eé]|cu[aá]ndo|d[oó]nde|cu[aá]nto)\b/i;
const SELF_CONTAINED =
  /\b(summarize|rewrite|translate|classify|extract|reformat|fix|convert|the following|below|above|this text|resume|reescribe|traduce|clasifica)\b/i;

export class ExecutionRouter {
  private readonly classifier: LocalClassifier | undefined;
  private readonly maxRounds: number;

  constructor(opts: { classifier?: LocalClassifier; maxRounds?: number } = {}) {
    this.classifier = opts.classifier;
    this.maxRounds = opts.maxRounds ?? 2;
  }

  classify(c: CanonicalRequest): RouteDecision {
    const requested = c.original.retrieval?.mode;
    const text = c.normalizedText;

    // Tool actions: presence of write/destructive tools + imperative intent.
    //
    // ESTA REGLA VA ANTES QUE `retrieval:"off"`, y el orden importa. Estaba
    // después, así que apagar el retrieval —una decisión de AHORRO— desactivaba
    // de paso TODAS las herramientas de escritura, porque el selector solo las
    // deja pasar con execution === "TOOL_ACTION". Reproducido: «send the invoice»
    // con `retrieval:{mode:"off"}` salía con `tools: []`, y como el prompt solo
    // adjunta herramientas si la lista no está vacía, el proveedor ni siquiera
    // veía la capacidad: respondía «claro, la reenvío» y la factura no se
    // reenviaba. El informe lo presentaba como éxito económico
    // (`baselineTools: 1`, `actualTools: 0`). Son dos palancas independientes y
    // ahora no se pisan.
    const hasWriteTools = (c.original.tools ?? []).some(
      (t) => t.risk === "write" || t.risk === "destructive",
    );
    if (hasWriteTools && /\b(create|update|delete|send|pay|book|cancel|crea|actualiza|elimina|env[ií]a|paga)\b/i.test(text)) {
      return decide("TOOL_ACTION", 0.9, "imperative + write tool available", 0);
    }

    // Explicit caller intent wins, but is still bounded.
    if (requested === "off") {
      return decide("NO_RETRIEVAL", 1, "retrieval disabled by caller", 0);
    }

    // Self-contained transformations need no external knowledge.
    if (SELF_CONTAINED.test(text) && !SINGLE_LOOKUP.test(text)) {
      return decide("NO_RETRIEVAL", 0.8, "self-contained transformation", 0);
    }

    // Optional local classifier can refine before the coarse rules.
    const local = this.classifier?.classify(text);
    if (local && local.confidence >= 0.75) {
      return decide(
        local.executionClass,
        local.confidence,
        "local classifier",
        roundsFor(local.executionClass, this.maxRounds),
      );
    }

    // Explicit caller intent (single/multi) wins over the coarse keyword regexes:
    // an operator who set mode:"multi" must never be silently downgraded to a single
    // lookup just because the text happens to contain a word like "which" or "how
    // much". Previously these ran AFTER the regexes, so the hint was dead when a
    // keyword matched — a silent quality loss on exactly the queries a caller cared
    // enough about to annotate.
    if (requested === "single") return decide("SINGLE_RETRIEVAL", 0.7, "caller hint: single", 1);
    if (requested === "multi") {
      return decide("MULTI_HOP_RETRIEVAL", 0.7, "caller hint: multi", Math.min(this.maxRounds, 2));
    }

    if (MULTI_HOP.test(text)) {
      return decide(
        "MULTI_HOP_RETRIEVAL",
        0.7,
        "comparison/compound question",
        Math.min(this.maxRounds, 2),
      );
    }
    if (SINGLE_LOOKUP.test(text)) {
      return decide("SINGLE_RETRIEVAL", 0.65, "single factual lookup", 1);
    }

    // Conservative default: when unsure, do not spend on retrieval, but flag
    // low confidence so shadow-mode evaluation can catch false negatives.
    return decide("NO_RETRIEVAL", 0.5, "no retrieval signal (conservative default)", 0);
  }
}

function roundsFor(cls: ExecutionClass, maxRounds: number): number {
  if (cls === "SINGLE_RETRIEVAL") return 1;
  if (cls === "MULTI_HOP_RETRIEVAL") return Math.min(maxRounds, 2);
  return 0;
}

function decide(
  executionClass: ExecutionClass,
  confidence: number,
  reason: string,
  rounds: number,
): RouteDecision {
  return { executionClass, confidence, reason, rounds };
}
