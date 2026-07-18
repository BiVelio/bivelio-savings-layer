import { randomId } from "../util/id.js";

import type {
  SavingsRequest,
  SavingsResult,
  SavingsReport,
  ChatMessage,
  CacheOutcome,
} from "../contracts/types.js";
import { canonicalize } from "../canonicalization/canonicalize.js";
import { buildExactKey, buildInflightKey } from "../canonicalization/keys.js";
import { evaluatePolicy } from "../policy/policy.js";
import { SavingsLedger, type CostModel } from "../tokenizer/accounting.js";
import { validateAgainstSchema } from "../constraints/validate.js";
import { resolveConstraintBackend } from "../constraints/backends.js";
import { executeRetrievalPlan } from "../retrieval/retrieval.js";
import { TraceCollector } from "../telemetry/traces.js";
import type { CachedAnswer } from "../cache/exact.js";
import type { RouteDecision } from "../router/router.js";
import type { FormatChoice } from "../serialization/format-selector.js";
import { DEFAULT_COST_MODEL, type SavingsLayerConfig } from "./config.js";
import { resolveDependencies, type ResolvedDeps } from "./defaults.js";

/**
 * The BV-SALA execution pipeline.
 *
 * Optimization order (cheapest first): avoid the call entirely -> avoid
 * auxiliary calls (retrieval/tools) -> eliminate unnecessary context ->
 * compress what remains -> constrain generation. Provider prefix/KV caching is
 * recorded as ledger 4 (cheaper tokens), never as eliminated tokens.
 */
export class SavingsPipeline {
  private readonly deps: ResolvedDeps;
  private readonly config: SavingsLayerConfig;
  private readonly now: () => number;
  private readonly generateId: () => string;

  constructor(config: SavingsLayerConfig) {
    this.config = config;
    this.deps = resolveDependencies(config);
    this.now = config.now ?? (() => Date.now());
    this.generateId = config.generateId ?? (() => randomId());
  }

  async generate<T = unknown>(request: SavingsRequest): Promise<SavingsResult<T>> {
    const trace = new TraceCollector(this.now);
    const ledger = new SavingsLedger();
    const canonical = canonicalize(request);
    const policy = evaluatePolicy(canonical);
    const toggles = request.savings ?? {};
    const costModel = this.costModelFor(request.model);

    trace.record("canonicalize", "done", {
      tenant: canonical.tenantId,
      contract: canonical.contractId,
    });
    trace.record("policy", policy.reasons.join("; ") || "no restrictions", {
      allowExactCache: policy.allowExactCache,
      allowSemanticCache: policy.allowSemanticCache,
    });

    // Baseline: the naive prompt cost if none of the layer ran.
    const baselineInput = this.tokensFor(this.assembleBaselinePrompt(request), request);
    const baselineOutput = request.response?.maxOutputTokens ?? 256;
    ledger.baselineInput = baselineInput;
    ledger.baselineOutput = baselineOutput;
    ledger.baselineTools = request.tools?.length ?? 0;

    // --- Stage 1: deterministic resolvers (avoid the call entirely). ---
    if (toggles.deterministicResolvers !== false) {
      const resolved = this.deps.resolvers.try(canonical);
      if (resolved) {
        ledger.avoidCall(baselineInput, baselineOutput);
        trace.record("resolver", resolved.resolver, { avoided: true });
        return this.finish<T>(
          request,
          canonical,
          { text: resolved.text, data: resolved.data as T, storedAtMs: this.now() },
          "deterministic",
          ledger,
          costModel,
          trace,
          defaultRoute(),
          jsonFallbackChoice(),
        );
      }
    }

    // --- Stage 2: exact cache (avoid the call entirely). ---
    const exactKey = buildExactKey(canonical);
    if (policy.allowExactCache && toggles.exactCache !== false) {
      const hit = await this.deps.exactCache.get<T>(exactKey);
      if (hit) {
        ledger.avoidCall(baselineInput, baselineOutput);
        trace.record("exact-cache", "hit", { ageMs: this.now() - hit.storedAtMs });
        return this.finish<T>(
          request, canonical, hit, "exact", ledger, costModel, trace,
          defaultRoute(), jsonFallbackChoice(), this.now() - hit.storedAtMs,
        );
      }
      trace.record("exact-cache", "miss");
    }

    // --- Stage 3: singleflight around the expensive path. ---
    const inflightKey = buildInflightKey(canonical);
    const runExpensive = () =>
      this.expensivePath<T>(
        request, canonical, policy, toggles, ledger, costModel, trace,
        exactKey, baselineInput, baselineOutput,
      );

    if (policy.allowSingleflight && toggles.singleflight !== false) {
      const { value, coalesced } = await this.deps.singleflight.run(inflightKey, runExpensive);
      if (coalesced) {
        trace.record("singleflight", "coalesced", { key: inflightKey });
        return this.asCoalescedFollower<T>(value, baselineInput, baselineOutput, costModel);
      }
      return value;
    }
    return runExpensive();
  }

  private async expensivePath<T>(
    request: SavingsRequest,
    canonical: ReturnType<typeof canonicalize>,
    policy: ReturnType<typeof evaluatePolicy>,
    toggles: NonNullable<SavingsRequest["savings"]>,
    ledger: SavingsLedger,
    costModel: CostModel,
    trace: TraceCollector,
    exactKey: string,
    baselineInput: number,
    baselineOutput: number,
  ): Promise<SavingsResult<T>> {
    // --- Stage 4: safe semantic cache (managed feature — license-gated). ---
    const semanticLicensed = this.entitled("semantic_cache");
    if (
      policy.allowSemanticCache &&
      toggles.semanticCache &&
      this.deps.semanticCache &&
      !semanticLicensed
    ) {
      trace.record("semantic-cache", "degraded: feature not licensed (free tier)");
    }
    if (
      policy.allowSemanticCache &&
      toggles.semanticCache &&
      this.deps.semanticCache &&
      semanticLicensed
    ) {
      const hit = await this.deps.semanticCache.find(canonical);
      if (hit) {
        ledger.avoidCall(baselineInput, baselineOutput);
        trace.record("semantic-cache", "hit", {
          confidence: hit.confidence,
          similarity: hit.similarity,
        });
        return this.finish<T>(
          request, canonical, hit.record.answer as CachedAnswer<T>, "semantic",
          ledger, costModel, trace, defaultRoute(), jsonFallbackChoice(),
          hit.ageMs, hit.confidence,
        );
      }
      trace.record("semantic-cache", "miss");
    }

    // --- Stage 5: execution routing (avoid retrieval / tools). ---
    const route: RouteDecision =
      toggles.router === false
        ? defaultRoute()
        : this.deps.router.classify(canonical);
    trace.record("router", route.executionClass, {
      confidence: route.confidence,
      reason: route.reason,
    });

    // --- Stage 6: tool selection. ---
    const toolSelection = this.deps.toolSelector.select(
      canonical.normalizedText,
      request.tools,
      route.executionClass,
    );
    ledger.actualTools = toolSelection.tools.length;
    if (toolSelection.droppedIds.length) {
      trace.record("tool-selector", toolSelection.reason, {
        dropped: toolSelection.droppedIds,
      });
    }

    // --- Stage 7: retrieval plan. ---
    ledger.baselineRetrieval = route.rounds;
    const retrieval = await executeRetrievalPlan(
      {
        execution: route.executionClass,
        query: canonical.normalizedText,
        maxRounds: request.retrieval?.maxRounds ?? route.rounds,
        maxDocuments: request.retrieval?.maxDocuments ?? 5,
      },
      { ...(this.config.retriever ? { retriever: this.config.retriever } : {}),
        ...(this.config.reranker ? { reranker: this.config.reranker } : {}) },
    );
    ledger.actualRetrieval = retrieval.rounds;
    if (retrieval.retrievedCount > 0) {
      trace.record("retrieval", `kept ${retrieval.keptCount}/${retrieval.retrievedCount}`, {
        rounds: retrieval.rounds,
      });
    }

    // --- Stage 8: serialization (format selection) for structured payloads. ---
    // The payload is ALWAYS sent (the app needs its data). The serialization
    // toggle only chooses the ENCODING: on → pick the cheapest format for this
    // tokenizer; off → fall back to compact JSON (never drop the data).
    let formatChoice = jsonFallbackChoice();
    const messages: ChatMessage[] = [...request.messages];
    if (request.structuredData !== undefined) {
      const jsonEncoded = JSON.stringify(request.structuredData);
      const jsonTokens = this.tokensFor(jsonEncoded, request);
      if (toggles.serialization !== false) {
        formatChoice = this.deps.formatSelector.choose(request.structuredData, {
          model: request.model,
          ...(request.tokenizer ? { tokenizer: request.tokenizer } : {}),
        });
        const chosenTokens = this.tokensFor(
          formatChoice.encoded + formatChoice.instruction,
          request,
        );
        ledger.compress(jsonTokens, chosenTokens);
        messages.push({
          role: "system",
          content:
            (formatChoice.instruction ? formatChoice.instruction + "\n" : "") +
            formatChoice.encoded,
        });
        trace.record("serialization", formatChoice.chosen, {
          reason: formatChoice.reason,
          jsonTokens,
          chosenTokens,
        });
      } else {
        messages.push({ role: "system", content: jsonEncoded });
        trace.record("serialization", "json-compact", {
          reason: "format selector disabled; sent compact JSON",
        });
      }
    }

    // --- Stage 9: compression (managed feature — license-gated, net-positive only). ---
    if (
      (toggles.compression === true || toggles.compression === "auto") &&
      policy.allowCompression &&
      this.config.compressor &&
      this.entitled("long_context_compression")
    ) {
      const joined = messages.map((m) => m.content).join("\n");
      const before = this.tokensFor(joined, request);
      const result = await this.config.compressor.compress({ text: joined });
      if (!result.skipped && result.fidelityPassed) {
        const after = this.tokensFor(result.compressed, request);
        ledger.compress(before, after);
        trace.record("compression", "applied", { before, after });
      } else {
        trace.record("compression", result.reason);
      }
    }

    // --- Stage 10: constrained decoding + the single primary LLM call. ---
    const schema = request.response?.schema;
    const backendPlan = schema
      ? resolveConstraintBackend(request.model, schema, this.deps.constraintBackends)
      : { backend: "none" as const, reason: "no output contract" };
    trace.record("constraints", backendPlan.backend, { reason: backendPlan.reason });

    const providerStart = this.now();
    let response = await this.config.provider.generate({
      model: request.model,
      messages,
      ...(toolSelection.tools.length ? { tools: toolSelection.tools } : {}),
      ...(schema ? { schema } : {}),
      ...(request.response?.maxOutputTokens != null
        ? { maxOutputTokens: request.response.maxOutputTokens }
        : {}),
      ...(request.temperature != null ? { temperature: request.temperature } : {}),
      ...(request.seed != null ? { seed: request.seed } : {}),
      constraintBackend: backendPlan.backend,
    });
    ledger.actualLlm = 1;
    ledger.actualInput = response.usage.inputTokens;
    ledger.actualOutput = response.usage.outputTokens;
    if (response.usage.cachedInputTokens) {
      ledger.providerCached(response.usage.cachedInputTokens);
    }

    // --- Stage 11: structural validation (+ at most one repair). ---
    let data: unknown = response.text;
    let structurallyValid = true;
    if (schema) {
      const parsed = tryParse(response.text);
      let validation = parsed.ok
        ? validateAgainstSchema(parsed.value, schema)
        : { valid: false, errors: [{ path: "$", message: "not valid JSON" }] };

      if (!validation.valid && backendPlan.backend === "none") {
        // Single deterministic repair attempt only when we had no constraint
        // backend to prevent the invalid output in the first place.
        ledger.retries = 1;
        trace.record("validation", "repair-attempt", { errors: validation.errors });
        response = await this.config.provider.generate({
          model: request.model,
          messages: [
            ...messages,
            { role: "assistant", content: response.text },
            { role: "user", content: "Return only a JSON object matching the contract." },
          ],
          schema,
          ...(request.response?.maxOutputTokens != null
            ? { maxOutputTokens: request.response.maxOutputTokens }
            : {}),
        });
        ledger.actualLlm = 2;
        ledger.actualInput += response.usage.inputTokens;
        ledger.actualOutput += response.usage.outputTokens;
        const reparsed = tryParse(response.text);
        validation = reparsed.ok
          ? validateAgainstSchema(reparsed.value, schema)
          : { valid: false, errors: [{ path: "$", message: "not valid JSON" }] };
        if (reparsed.ok) data = reparsed.value;
      } else if (parsed.ok) {
        data = parsed.value;
      }
      structurallyValid = validation.valid;
      trace.record("validation", structurallyValid ? "valid" : "invalid");
    }

    const providerMs = this.now() - providerStart;

    // --- Stage 12: local render + approved cache writes. ---
    const rendered = renderLocally(data);
    const answer: CachedAnswer<T> = {
      text: response.text,
      data: data as T,
      rendered,
      storedAtMs: this.now(),
    };
    if (policy.allowExactCache && toggles.exactCache !== false) {
      await this.deps.exactCache.set(exactKey, answer, this.config.exactCacheTtlMs);
    }
    if (
      policy.allowSemanticCache &&
      toggles.semanticCache &&
      this.deps.semanticCache
    ) {
      await this.deps.semanticCache.store(canonical, answer as CachedAnswer);
    }

    return this.finish<T>(
      request, canonical, answer, "miss", ledger, costModel, trace,
      route, formatChoice, undefined, undefined, structurallyValid,
      backendPlan.backend, providerMs,
    );
  }

  // --- helpers -----------------------------------------------------------

  private finish<T>(
    request: SavingsRequest,
    canonical: ReturnType<typeof canonicalize>,
    answer: CachedAnswer<T>,
    cacheResult: CacheOutcome,
    ledger: SavingsLedger,
    costModel: CostModel,
    trace: TraceCollector,
    route: RouteDecision,
    formatChoice: FormatChoice,
    ageMs?: number,
    confidence?: number,
    structurallyValid = true,
    backend = "none",
    providerMs = 0,
  ): SavingsResult<T> {
    const report = this.buildReport(
      request, canonical, cacheResult, ledger, costModel, trace, route,
      formatChoice, ageMs, confidence, structurallyValid, backend, providerMs,
    );
    return {
      requestId: report.requestId,
      data: answer.data as T,
      text: answer.text,
      ...(answer.rendered !== undefined ? { rendered: answer.rendered } : {}),
      report,
    };
  }

  private buildReport(
    request: SavingsRequest,
    canonical: ReturnType<typeof canonicalize>,
    cacheResult: CacheOutcome,
    ledger: SavingsLedger,
    costModel: CostModel,
    trace: TraceCollector,
    route: RouteDecision,
    formatChoice: FormatChoice,
    ageMs: number | undefined,
    confidence: number | undefined,
    structurallyValid: boolean,
    backend: string,
    providerMs: number,
  ): SavingsReport {
    const cost = ledger.estimateCost(costModel);
    const total = trace.elapsed();
    return {
      requestId: this.generateId(),
      model: request.model,
      calls: {
        baselineLlm: ledger.baselineLlm,
        actualLlm: ledger.actualLlm,
        avoidedLlm: ledger.avoidedLlm,
        baselineRetrieval: ledger.baselineRetrieval,
        actualRetrieval: ledger.actualRetrieval,
        baselineTools: ledger.baselineTools,
        actualTools: ledger.actualTools,
        retries: ledger.retries,
      },
      tokens: {
        baselineInput: ledger.baselineInput,
        actualInput: ledger.actualInput,
        eliminatedInput: ledger.eliminatedInput,
        compressedInput: ledger.compressedInput,
        baselineOutput: ledger.baselineOutput,
        actualOutput: ledger.actualOutput,
        eliminatedOutput: ledger.eliminatedOutput,
        ...(ledger.providerCachedInput
          ? { providerCachedInput: ledger.providerCachedInput }
          : {}),
      },
      cache: {
        result: cacheResult,
        ...(confidence !== undefined ? { confidence } : {}),
        ...(ageMs !== undefined ? { ageMs } : {}),
      },
      routing: {
        executionClass: route.executionClass,
        confidence: route.confidence,
        rounds: ledger.actualRetrieval,
        reason: route.reason,
      },
      serialization: {
        chosen: formatChoice.chosen,
        candidateTokens: formatChoice.candidateTokens,
        instructionOverheadTokens: formatChoice.instructionOverheadTokens,
      },
      constraints: {
        backend,
        schemaVersion: canonical.schemaVersion,
        structurallyValid,
      },
      quality: {
        ...(cacheResult !== "miss" ? { freshnessPassed: !evaluatePolicy(canonical).requiresFreshData } : {}),
      },
      cost,
      latencyMs: {
        total,
        preprocessing: Math.max(0, total - providerMs),
        provider: providerMs,
      },
      traces: trace.all(),
    };
  }

  private asCoalescedFollower<T>(
    leader: SavingsResult<T>,
    baselineInput: number,
    baselineOutput: number,
    costModel: CostModel,
  ): SavingsResult<T> {
    const ledger = new SavingsLedger();
    ledger.avoidCall(baselineInput, baselineOutput);
    const cost = ledger.estimateCost(costModel);
    return {
      ...leader,
      requestId: this.generateId(),
      report: {
        ...leader.report,
        requestId: this.generateId(),
        calls: { ...leader.report.calls, actualLlm: 0, avoidedLlm: 1 },
        cache: { result: "singleflight" },
        cost,
      },
    };
  }

  private assembleBaselinePrompt(request: SavingsRequest): string {
    const parts = request.messages.map((m) => m.content);
    if (request.structuredData !== undefined) {
      parts.push(JSON.stringify(request.structuredData));
    }
    for (const tool of request.tools ?? []) {
      parts.push(JSON.stringify(tool.parameters ?? {}));
    }
    return parts.join("\n");
  }

  private tokensFor(text: string, request: SavingsRequest): number {
    return this.config.tokenizer.count(text, {
      ...(request.tokenizer ? { tokenizer: request.tokenizer } : {}),
      model: request.model,
    });
  }

  /**
   * Whether a managed feature is licensed. With no license gate configured the
   * pipeline is ungated (self-managed / dev mode) and everything is available.
   */
  private entitled(feature: string): boolean {
    return !this.config.licenseGate || this.config.licenseGate.isEntitled(feature);
  }

  private costModelFor(model: string): CostModel {
    return (
      this.config.costModels?.[model] ??
      this.config.defaultCostModel ??
      DEFAULT_COST_MODEL
    );
  }
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function renderLocally(data: unknown): string {
  if (typeof data === "string") return data;
  return JSON.stringify(data, null, 2);
}

function defaultRoute(): RouteDecision {
  return {
    executionClass: "NO_RETRIEVAL",
    confidence: 1,
    reason: "n/a (short-circuited)",
    rounds: 0,
  };
}

function jsonFallbackChoice(): FormatChoice {
  return {
    chosen: "json-compact",
    encoded: "",
    instruction: "",
    candidateTokens: {},
    instructionOverheadTokens: 0,
    reason: "no structured payload",
  };
}
