import type { ExecutionClass } from "../contracts/types.js";

/**
 * Retrieval planning: retrieve -> dedupe -> rerank -> adaptive-k.
 *
 * Eliminating irrelevant context is cheaper and safer than compressing it, so
 * retrieval prunes aggressively BEFORE anything reaches the prompt. Documents
 * are kept out of the prompt where possible and passed as references/hashes;
 * only the selected, trimmed evidence is projected in.
 */
export interface EvidenceDoc {
  id: string;
  text: string;
  /** Optional pre-computed relevance score from the retriever. */
  score?: number;
  source?: string;
  /** Content hash, so large docs can be referenced instead of inlined. */
  hash?: string;
}

export interface Retriever {
  retrieve(query: string, k: number): Promise<EvidenceDoc[]>;
}

export interface Reranker {
  rerank(query: string, docs: EvidenceDoc[]): Promise<EvidenceDoc[]>;
}

export interface RetrievalPlan {
  execution: ExecutionClass;
  query: string;
  maxRounds: number;
  maxDocuments: number;
}

export interface RetrievalOutcome {
  docs: EvidenceDoc[];
  rounds: number;
  retrievedCount: number;
  keptCount: number;
}

/** Remove exact and near-duplicate docs by normalized text / hash. */
export function dedupe(docs: EvidenceDoc[]): EvidenceDoc[] {
  const seen = new Set<string>();
  const out: EvidenceDoc[] = [];
  for (const doc of docs) {
    const key = doc.hash ?? normalize(doc.text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(doc);
  }
  return out;
}

/**
 * Adaptive-k: choose how many documents to keep based on the score distribution
 * rather than a fixed cutoff. When the top document dominates, keep fewer; when
 * scores are flat, keep up to the cap. This directly trims input tokens.
 */
export function adaptiveK(
  docs: EvidenceDoc[],
  opts: { maxDocuments: number; minDocuments?: number } = { maxDocuments: 5 },
): EvidenceDoc[] {
  const min = opts.minDocuments ?? 1;
  const sorted = [...docs].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  if (sorted.length <= min) return sorted;

  const top = sorted[0]?.score ?? 0;
  if (top <= 0) return sorted.slice(0, opts.maxDocuments);

  const kept: EvidenceDoc[] = [];
  for (const doc of sorted) {
    const relative = (doc.score ?? 0) / top;
    // Keep while the document retains at least ~40% of the top relevance.
    if (kept.length < min || (relative >= 0.4 && kept.length < opts.maxDocuments)) {
      kept.push(doc);
    } else {
      break;
    }
  }
  return kept;
}

/**
 * Execute a retrieval plan. NO_RETRIEVAL / TOOL_ACTION classes retrieve nothing.
 * Otherwise: retrieve -> dedupe -> rerank -> adaptive-k, bounded by maxRounds.
 * The optional guard runs before and after each external dependency call.
 */
export async function executeRetrievalPlan(
  plan: RetrievalPlan,
  deps: { retriever?: Retriever; reranker?: Reranker },
  antesDeLlamada: () => void = () => {},
): Promise<RetrievalOutcome> {
  if (
    plan.execution === "NO_RETRIEVAL" ||
    plan.execution === "TOOL_ACTION" ||
    plan.execution === "NON_CACHEABLE" ||
    !deps.retriever
  ) {
    return { docs: [], rounds: 0, retrievedCount: 0, keptCount: 0 };
  }

  const rounds = plan.execution === "MULTI_HOP_RETRIEVAL"
    ? Math.min(plan.maxRounds, 2)
    : 1;

  let all: EvidenceDoc[] = [];
  for (let r = 0; r < rounds; r++) {
    antesDeLlamada();
    const fetched = await deps.retriever.retrieve(plan.query, plan.maxDocuments * 2);
    antesDeLlamada();
    all.push(...fetched);
  }
  const retrievedCount = all.length;

  all = dedupe(all);
  if (deps.reranker) {
    antesDeLlamada();
    all = await deps.reranker.rerank(plan.query, all);
    antesDeLlamada();
  }
  const kept = adaptiveK(all, { maxDocuments: plan.maxDocuments });

  return {
    docs: kept,
    rounds,
    retrievedCount,
    keptCount: kept.length,
  };
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}
