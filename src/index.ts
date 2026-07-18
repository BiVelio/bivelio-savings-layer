/**
 * bivelio-savings-layer (BV-SALA)
 * ---------------------------------------------------------------------------
 * PROPRIETARY AND CONFIDENTIAL. Copyright (c) 2026 BiVelio Inc.
 * All Rights Reserved. Unauthorized copying, distribution, or use of this
 * software, in whole or in part, is strictly prohibited. See LICENSE.
 * ---------------------------------------------------------------------------
 *
 * A provider-neutral LLM execution optimizer. For every request it answers, in
 * order: Can I avoid this call? Can I avoid retrieval? Can I send fewer tools?
 * What context is actually needed? Should I compress it? Which format costs
 * least for this tokenizer? What is the minimal output contract? Is the saving
 * still positive after all infrastructure is counted?
 *
 * It keeps FOUR separate ledgers — avoided_calls, eliminated_tokens,
 * compressed_tokens, provider_cached_tokens — because mixing them produces
 * misleading metrics.
 */

export const BV_SALA_VERSION = "0.1.0";

export * from "./util/index.js";
export * from "./contracts/index.js";
export * from "./tokenizer/index.js";
export * from "./canonicalization/index.js";
export * from "./policy/index.js";
export * from "./cache/index.js";
export * from "./resolvers/index.js";
export * from "./router/index.js";
export * from "./retrieval/index.js";
export * from "./memory/index.js";
export * from "./serialization/index.js";
export * from "./constraints/index.js";
export * from "./compression/index.js";
export * from "./providers/index.js";
export * from "./telemetry/index.js";
export * from "./pipeline/index.js";
