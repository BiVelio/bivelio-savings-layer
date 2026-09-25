import type { CacheOutcome } from "./types.js";

// La verificacion A/B opcional ("tu propio banco"). Todo lo de este fichero es
// superficie PUBLICA: nombres y JSDoc en ingles y sin acentos (el trinquete de
// superficie-publica-limpia cuenta las lineas con acentos del .d.ts). Los
// comentarios internos, en `//`, que no viajan al .d.ts.
//
// DOCTRINA: instrumento, nunca base. Un par viaja por su propio canal
// (/api/metering/verification) a sus propias tablas y jamas entra en measured_*,
// en el extracto ni en la comision.

/** How the layer served a request that is eligible for a verification check. */
export type VerificationStratum =
  /** Answered without calling the provider (cache, resolver, identical request in flight). */
  | "avoided_call"
  /** Answered by a cheaper model than the one requested. */
  | "cheaper_model"
  /** Sent with parts removed. */
  | "tokens_removed"
  /** Sent re-encoded with fewer tokens. */
  | "tokens_compressed"
  /** Sent without removing or re-encoding anything. */
  | "unchanged";

/** Why a request is never checked. */
export type VerificationExclusion =
  | "fail_open"
  | "truncated"
  | "incomplete"
  | "contract_failed"
  | "unmeasured"
  | "no_price"
  | "over_cap"
  | "opted_out"
  | "retrieval";

/** How a check ended. */
export type VerificationOutcome = "paired" | "check_failed" | "check_unmeasured" | "abandoned" | "dropped";

/**
 * Opt-in A/B verification on your own traffic. Off unless `sampleRate` is above 0.
 *
 * For the sampled share of eligible requests, after the answer has been returned,
 * the layer sends the same request once more to your provider exactly as it would
 * go without the layer (the requested model, all your tools, your data inline, no
 * cache marks) and discards that second answer. Each pair (what the unoptimized
 * copy cost and what the optimized request cost, both from your provider's usage
 * counters) is reported to your dashboard and to `onCheck`.
 *
 * Every copy is a real provider call that you pay for: roughly `sampleRate` times
 * what the eligible traffic would cost without the layer. Pairs are informational:
 * they never enter measured savings, your statement or any commission.
 */
export interface VerificationSettings {
  /** Share of eligible requests to check, from 0 to 1. Any other value turns verification off. */
  sampleRate: number;
  /** Skip requests whose estimated unoptimized cost, in USD, is above this. An invalid value turns verification off. */
  maxCheckCostUsd?: number;
  /** Called once per sampled eligible request, when its check is settled. Errors thrown here are ignored. */
  onCheck?: (check: VerificationCheck) => void;
  /**
   * Keeps a serverless runtime alive until a check is settled and reported, for
   * example your platform's `waitUntil`. Receives one promise per check; it never rejects.
   */
  waitUntil?: (promise: Promise<void>) => void;
}

/** Token counts and cost of one side of a pair, from the provider's usage counters. */
export interface VerificationSide {
  cost: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/** One settled verification check. */
export interface VerificationCheck {
  /** Id of the served request (its report.requestId). */
  requestId: string;
  /** Epoch ms when the served request was decided. */
  at: number;
  stratum: VerificationStratum;
  /**
   * - `paired`: both sides metered; `naive` is present.
   * - `check_failed`: the provider returned an error for the copy, or it timed out.
   * - `check_unmeasured`: the provider returned no usage counter for the copy.
   * - `abandoned`: the copy was still running when `close()` was called.
   * - `dropped`: not sent, because too many checks were already running.
   */
  outcome: VerificationOutcome;
  requestedModel: string;
  servedModel: string;
  cacheResult: CacheOutcome;
  /** The served request, as its report measured it. Zero on an avoided call. */
  optimized: VerificationSide;
  /** The unoptimized copy. Present only when `outcome` is `paired`. */
  naive?: VerificationSide & {
    finishReason?: string;
    /** Whether the copy met your output contract: `none` without a contract or on a tool-call turn. */
    contract: "met" | "missed" | "none";
  };
  /** Rates used to price the copy, in USD per 1K tokens. */
  prices: { inputPer1k: number; cachedInputPer1k?: number; outputPer1k: number };
}

/**
 * Whether this request was drawn for verification sampling, and how it counts.
 * Present only when `verification` is enabled on the layer.
 */
export interface VerificationReport {
  /** Drawn for a check. A copy is sent only when the request is also eligible. */
  sampled: boolean;
  /** How the layer served this request, when it is eligible for a check. */
  stratum?: VerificationStratum;
  /** Why this request is never checked. Present exactly when `stratum` is absent. */
  excluded?: VerificationExclusion;
}
