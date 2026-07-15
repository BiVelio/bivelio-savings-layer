import { heuristicEstimator, type TokenEstimator } from "./estimator.js";

/**
 * Registry of token estimators keyed by tokenizer id, plus a mapping from model
 * ids to the tokenizer they use. All cost/format/compression decisions in the
 * pipeline resolve a tokenizer through this registry, so swapping in an exact
 * tokenizer is a one-line registration and never a code change in the pipeline.
 */
export class TokenizerRegistry {
  private readonly estimators = new Map<string, TokenEstimator>();
  private readonly modelToTokenizer = new Map<string, string>();
  private readonly fallbackId: string;

  constructor(fallback: TokenEstimator = heuristicEstimator) {
    this.fallbackId = fallback.id;
    this.estimators.set(fallback.id, fallback);
  }

  register(estimator: TokenEstimator): this {
    this.estimators.set(estimator.id, estimator);
    return this;
  }

  /** Associate a model id (e.g. "openai/gpt-4o-mini") with a tokenizer id. */
  mapModel(model: string, tokenizerId: string): this {
    this.modelToTokenizer.set(model, tokenizerId);
    return this;
  }

  /** Resolve an estimator by explicit tokenizer id, else by model, else fallback. */
  resolve(opts: { tokenizer?: string; model?: string }): TokenEstimator {
    const byId = opts.tokenizer
      ? this.estimators.get(opts.tokenizer)
      : undefined;
    if (byId) return byId;

    if (opts.model) {
      const mapped = this.modelToTokenizer.get(opts.model);
      if (mapped) {
        const est = this.estimators.get(mapped);
        if (est) return est;
      }
    }
    return this.estimators.get(this.fallbackId)!;
  }

  count(text: string, opts: { tokenizer?: string; model?: string }): number {
    return this.resolve(opts).count(text);
  }
}

export const defaultTokenizerRegistry = new TokenizerRegistry();
