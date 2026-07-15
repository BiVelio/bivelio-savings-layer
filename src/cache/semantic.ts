import type { CanonicalRequest } from "../canonicalization/canonicalize.js";
import type { CachedAnswer } from "./exact.js";

/**
 * Semantic cache (safe-by-construction).
 *
 * A semantic cache reuses a previous answer for a *similar* query. Its danger is
 * the false positive: confidently returning a valid answer to a nearby-but-wrong
 * question. Therefore the headline metric here is NOT hit ratio — it is the
 * PRECISION of hits. Every candidate must pass: tenant/permission filter,
 * knowledge-epoch filter, a similarity threshold, a stronger local verifier, a
 * freshness check, and an output-contract compatibility check.
 */
export interface EmbeddingFn {
  (text: string): Promise<number[]> | number[];
}

export interface SemanticVerifier {
  /**
   * Second-stage check (ideally a small cross-encoder). Returns a confidence in
   * [0,1] that the candidate answer genuinely answers the query. The pipeline
   * only accepts a hit above the configured acceptance threshold.
   */
  (query: string, candidateQuery: string): Promise<number> | number;
}

export interface SemanticRecord {
  embedding: number[];
  query: string;
  answer: CachedAnswer;
  tenantId: string;
  authorizationScope: string;
  knowledgeEpoch: string;
  contractId: string | null;
  storedAtMs: number;
}

export interface SemanticHit {
  record: SemanticRecord;
  similarity: number;
  verifierScore: number;
  confidence: number;
  ageMs: number;
}

export interface SemanticCacheOptions {
  embed: EmbeddingFn;
  verify?: SemanticVerifier;
  /** Cosine similarity floor for a candidate to be considered at all. */
  similarityThreshold?: number;
  /** Verifier score floor for acceptance. */
  acceptThreshold?: number;
  ttlMs?: number;
  maxRecords?: number;
  now?: () => number;
}

export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * In-memory reference implementation. A production build would back this with a
 * real vector store (pgvector, Qdrant, etc.) and metadata filters pushed down
 * to the store. The verification logic — the part that makes it *safe* — stays
 * identical regardless of the backend.
 */
export class InMemorySemanticCache {
  private readonly records: SemanticRecord[] = [];
  private readonly embed: EmbeddingFn;
  private readonly verify: SemanticVerifier | undefined;
  private readonly similarityThreshold: number;
  private readonly acceptThreshold: number;
  private readonly ttlMs: number | undefined;
  private readonly maxRecords: number;
  private readonly now: () => number;

  constructor(opts: SemanticCacheOptions) {
    this.embed = opts.embed;
    this.verify = opts.verify;
    this.similarityThreshold = opts.similarityThreshold ?? 0.9;
    this.acceptThreshold = opts.acceptThreshold ?? 0.85;
    this.ttlMs = opts.ttlMs;
    this.maxRecords = opts.maxRecords ?? 5_000;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Find a safe hit for a canonical request, or null. Metadata filters run
   * FIRST and hard — a candidate from another tenant, scope, or knowledge epoch
   * is never even scored.
   */
  async find(c: CanonicalRequest): Promise<SemanticHit | null> {
    if (this.records.length === 0) return null;
    const queryEmbedding = await this.embed(c.normalizedText);

    let best: SemanticHit | null = null;
    for (const record of this.records) {
      if (record.tenantId !== c.tenantId) continue;
      if (record.authorizationScope !== c.authorizationScope) continue;
      if (record.knowledgeEpoch !== c.knowledgeEpoch) continue;
      if (record.contractId !== c.contractId) continue;
      if (
        this.ttlMs != null &&
        this.now() - record.storedAtMs > this.ttlMs
      ) {
        continue;
      }

      const similarity = cosine(queryEmbedding, record.embedding);
      if (similarity < this.similarityThreshold) continue;

      const verifierScore = this.verify
        ? await this.verify(c.normalizedText, record.query)
        : similarity;
      const confidence = Math.min(similarity, verifierScore);
      if (confidence < this.acceptThreshold) continue;

      if (!best || confidence > best.confidence) {
        best = {
          record,
          similarity,
          verifierScore,
          confidence,
          ageMs: this.now() - record.storedAtMs,
        };
      }
    }
    return best;
  }

  async store(c: CanonicalRequest, answer: CachedAnswer): Promise<void> {
    const embedding = await this.embed(c.normalizedText);
    if (this.records.length >= this.maxRecords) this.records.shift();
    this.records.push({
      embedding,
      query: c.normalizedText,
      answer,
      tenantId: c.tenantId,
      authorizationScope: c.authorizationScope,
      knowledgeEpoch: c.knowledgeEpoch,
      contractId: c.contractId,
      storedAtMs: this.now(),
    });
  }

  /** Drop every record for a knowledge epoch (invalidation on re-index). */
  invalidateEpoch(knowledgeEpoch: string): number {
    let removed = 0;
    for (let i = this.records.length - 1; i >= 0; i--) {
      if (this.records[i]!.knowledgeEpoch === knowledgeEpoch) {
        this.records.splice(i, 1);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.records.length;
  }
}
