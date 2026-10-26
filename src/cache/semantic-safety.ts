import type { CachedAnswer } from "./exact.js";
import { cosine, keyTokensMatch } from "./semantic.js";
import { sameAnswer } from "./calibration.js";

/** Shared deterministic safety operations for semantic-cache backends. */
export class SemanticCacheSafety {
  static cosine(a: number[], b: number[]): number {
    return cosine(a, b);
  }

  static keyTokensMatch(query: string, candidateQuery: string): boolean {
    return keyTokensMatch(query, candidateQuery);
  }

  static sameAnswer(stored: CachedAnswer, fresh: CachedAnswer): boolean {
    return sameAnswer(stored, fresh);
  }
}
