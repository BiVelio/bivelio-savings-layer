/**
 * The four-ledger savings accounting.
 *
 * These ledgers are kept strictly separate on purpose (see contracts/types.ts).
 * The ledger is a pure accumulator: the pipeline records events into it, and it
 * produces the numbers that populate the SavingsReport. It never guesses — every
 * increment is driven by an explicit pipeline decision.
 */
export interface CostModel {
  /** Cost per 1K input tokens, in the caller's currency unit. */
  inputPer1k: number;
  /** Cost per 1K output tokens. */
  outputPer1k: number;
  /** Optional discounted rate for provider-cached (prefix) input tokens. */
  cachedInputPer1k?: number;
}

export class SavingsLedger {
  // Ledger 1: avoided calls.
  avoidedLlm = 0;
  baselineLlm = 1;
  actualLlm = 0;
  baselineRetrieval = 0;
  actualRetrieval = 0;
  baselineTools = 0;
  actualTools = 0;
  retries = 0;

  // Token ledgers.
  baselineInput = 0;
  actualInput = 0;
  eliminatedInput = 0; // Ledger 2
  compressedInput = 0; // Ledger 3
  baselineOutput = 0;
  actualOutput = 0;
  eliminatedOutput = 0;
  providerCachedInput = 0; // Ledger 4

  /** Ledger 2: tokens removed because they were not needed. */
  eliminate(tokens: number): void {
    this.eliminatedInput += Math.max(0, tokens);
  }

  /** Ledger 3: delta between an original encoding and a cheaper one. */
  compress(originalTokens: number, compressedTokens: number): void {
    this.compressedInput += Math.max(0, originalTokens - compressedTokens);
  }

  /** Ledger 4: tokens still present but billed/processed as provider-cached. */
  providerCached(tokens: number): void {
    this.providerCachedInput += Math.max(0, tokens);
  }

  /** Record that a whole primary LLM call was avoided (cache / resolver hit). */
  avoidCall(baselineInput: number, baselineOutput: number): void {
    this.avoidedLlm += 1;
    this.actualLlm = 0;
    this.baselineInput = baselineInput;
    this.baselineOutput = baselineOutput;
    this.eliminatedInput += baselineInput;
    this.eliminatedOutput += baselineOutput;
  }

  estimateCost(model: CostModel): {
    baselineEstimate: number;
    actual: number;
    netSavings: number;
  } {
    // Honesty rule (do not credit phantom output savings): a call that actually
    // RAN still generates its answer — the layer does not shrink a ran call's
    // output — so its honest baseline output equals the measured actual output.
    // Output-token savings are credited ONLY on AVOIDED calls, whose whole
    // generation was skipped. Booking (maxOutputTokens ?? 256) − actualOutput as
    // a saving on a ran call manufactures tokens that were never generated and
    // systematically overclaims. The true effect of output caps can only be
    // proven by an A/B measurement (see benchmarks/ab-live.ts), never asserted
    // per-request from a ceiling constant.
    const ranCall = this.avoidedLlm === 0;
    const effectiveBaselineOutput = ranCall ? this.actualOutput : this.baselineOutput;
    const baselineEstimate =
      (this.baselineInput / 1000) * model.inputPer1k +
      (effectiveBaselineOutput / 1000) * model.outputPer1k;

    const cachedRate = model.cachedInputPer1k ?? model.inputPer1k;
    const billedInput = Math.max(0, this.actualInput - this.providerCachedInput);
    const actual =
      (billedInput / 1000) * model.inputPer1k +
      (this.providerCachedInput / 1000) * cachedRate +
      (this.actualOutput / 1000) * model.outputPer1k;

    const netSavings =
      baselineEstimate === 0 ? 0 : 1 - actual / baselineEstimate;

    return {
      baselineEstimate: roundUsd(baselineEstimate),
      actual: roundUsd(actual),
      netSavings: roundRatio(netSavings),
    };
  }
}

/**
 * Redondeo de importes en dólares.
 *
 * Era a 1e-6 (microdólares) para los tres valores. Con gpt-4o-mini un token de
 * entrada cuesta ~1,5e-7 $, así que una petición corta cuesta menos que el
 * propio cuanto de redondeo: $0,00000195 se convertía en $0,000002 (+2,6%) y
 * cualquier coste por debajo de 5e-7 caía a CERO. Como cada petición se
 * redondea por separado y luego se SUMAN en usage_daily, el error no se
 * compensa: se acumula.
 *
 * 1e-10 mantiene el propósito original —quitar la basura binaria del tipo
 * 0.30000000000000004— sin tirar precisión que sí vale dinero.
 */
function roundUsd(n: number): number {
  return Math.round(n * 1e10) / 1e10;
}

/** netSavings es una proporción (0..1): seis decimales sobran. */
function roundRatio(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
