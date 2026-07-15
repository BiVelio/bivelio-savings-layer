import type { SerializationFormat } from "../contracts/types.js";
import type { TokenizerRegistry } from "../tokenizer/registry.js";
import type { Serializer } from "./types.js";
import { jsonCompactSerializer } from "./json-compact.js";
import { toonSerializer } from "./toon.js";
import { csvSerializer } from "./csv.js";

/**
 * Format selector.
 *
 * TOON is a candidate, never a default. For each request we count, USING THE
 * DESTINATION MODEL'S TOKENIZER:
 *
 *   tokens(encoded payload) + tokens(instruction to understand it)
 *
 * ...and pick the cheapest, subject to activation thresholds so we do not switch
 * formats to save a trivial amount (which risks quality for no real benefit).
 * JSON-compact is the baseline and the fallback; a format only wins if it beats
 * JSON by both an absolute and a relative margin.
 */
export interface FormatSelectorOptions {
  tokenizer: TokenizerRegistry;
  serializers?: Serializer[];
  /** Minimum absolute token saving vs JSON to switch away from JSON. */
  minimumSavingsTokens?: number;
  /** Minimum relative saving vs JSON (0..1) to switch away from JSON. */
  minimumSavingsRatio?: number;
  /**
   * Per-(model,format) quality penalty in tokens. Encodes "this model is worse
   * at reading TOON" as an additive cost, learned from production traces.
   */
  qualityPenalty?: (model: string, format: SerializationFormat) => number;
}

export interface FormatChoice {
  chosen: SerializationFormat;
  encoded: string;
  instruction: string;
  candidateTokens: Partial<Record<SerializationFormat, number>>;
  instructionOverheadTokens: number;
  reason: string;
}

interface Candidate {
  format: SerializationFormat;
  encoded: string;
  instruction: string;
  payloadTokens: number;
  instructionTokens: number;
  penalty: number;
  total: number;
}

export class FormatSelector {
  private readonly tokenizer: TokenizerRegistry;
  private readonly serializers: Serializer[];
  private readonly minSavingsTokens: number;
  private readonly minSavingsRatio: number;
  private readonly qualityPenalty: (m: string, f: SerializationFormat) => number;

  constructor(opts: FormatSelectorOptions) {
    this.tokenizer = opts.tokenizer;
    this.serializers = opts.serializers ?? [
      jsonCompactSerializer,
      toonSerializer,
      csvSerializer,
    ];
    this.minSavingsTokens = opts.minimumSavingsTokens ?? 64;
    this.minSavingsRatio = opts.minimumSavingsRatio ?? 0.08;
    this.qualityPenalty = opts.qualityPenalty ?? (() => 0);
  }

  choose(payload: unknown, opts: { model?: string; tokenizer?: string }): FormatChoice {
    const tokenizerOpts = { model: opts.model, tokenizer: opts.tokenizer };
    const candidates: Candidate[] = [];

    for (const serializer of this.serializers) {
      if (!serializer.supports(payload)) continue;
      const encoded = serializer.encode(payload);
      const instruction = serializer.instruction(payload);
      const payloadTokens = this.tokenizer.count(encoded, tokenizerOpts);
      const instructionTokens = instruction
        ? this.tokenizer.count(instruction, tokenizerOpts)
        : 0;
      const penalty = this.qualityPenalty(opts.model ?? "", serializer.format);
      candidates.push({
        format: serializer.format,
        encoded,
        instruction,
        payloadTokens,
        instructionTokens,
        penalty,
        total: payloadTokens + instructionTokens + penalty,
      });
    }

    const json = candidates.find((c) => c.format === "json-compact");
    const candidateTokens: Partial<Record<SerializationFormat, number>> = {};
    for (const c of candidates) candidateTokens[c.format] = c.total;

    // JSON is always the baseline/fallback.
    if (!json) {
      const only = candidates[0];
      if (!only) {
        return {
          chosen: "json-compact",
          encoded: JSON.stringify(payload),
          instruction: "",
          candidateTokens,
          instructionOverheadTokens: 0,
          reason: "no serializer supported payload; defaulted to JSON",
        };
      }
      return finalize(only, candidateTokens, "json baseline unavailable");
    }

    let best = json;
    let reason = "json baseline (no challenger cleared thresholds)";
    for (const c of candidates) {
      if (c.format === "json-compact") continue;
      const absSaving = json.total - c.total;
      const relSaving = json.total === 0 ? 0 : absSaving / json.total;
      if (
        absSaving >= this.minSavingsTokens &&
        relSaving >= this.minSavingsRatio &&
        c.total < best.total
      ) {
        best = c;
        reason = `${c.format} saved ${absSaving} tokens (${(relSaving * 100).toFixed(1)}%) vs json`;
      }
    }

    return finalize(best, candidateTokens, reason);
  }
}

function finalize(
  candidate: Candidate,
  candidateTokens: Partial<Record<SerializationFormat, number>>,
  reason: string,
): FormatChoice {
  return {
    chosen: candidate.format,
    encoded: candidate.encoded,
    instruction: candidate.instruction,
    candidateTokens,
    instructionOverheadTokens: candidate.instructionTokens,
    reason,
  };
}
