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
import { LicenseError } from "../license/errors.js";
import { DEFAULT_COST_MODEL, type SavingsLayerConfig } from "./config.js";
import { resolveDependencies, type ResolvedDeps } from "./defaults.js";

/**
 * Build-time flag: the published npm SDK sets this to `false` (tsup `define`) so the
 * dev escape hatch (`devUnlicensed` / `BVSALA_DEV_OPEN`) is DEAD and the paywall
 * cannot be bypassed by an installer. It is `true` in the web-demo bundle and
 * `undefined` from source (tsx/tests) — where ungated runs (CI, benchmarks, the free
 * in-browser demo) are intentional.
 */
declare const __BV_SALA_ALLOW_DEV_OPEN__: boolean | undefined;

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

  /**
   * Public entry point.
   *
   * FAIL-CLOSED LICENSING: the first thing we do is assert a valid, active
   * license — BV-SALA is a paid product, so an unlicensed caller is refused here.
   * `assertLicensed()` MUST run *above* the try/catch below: the reliability
   * fallback (`failOpenDirect`) would otherwise swallow a `LicenseError` and
   * still serve the request for free.
   *
   * Then the fail-open reliability contract: an internal optimizer error must
   * never take down the customer's request, so any error from the optimized path
   * falls back to a direct provider call. A genuine provider error propagates.
   */
  async generate<T = unknown>(request: SavingsRequest): Promise<SavingsResult<T>> {
    this.assertLicensed();
    try {
      return await this.generateOptimized<T>(request);
    } catch (err) {
      if (err instanceof LicenseError) throw err;
      if (this.config.failOpen === false) throw err;
      return await this.failOpenDirect<T>(request, err);
    }
  }

  /**
   * Ungated mode: an explicit `devUnlicensed` flag or `BVSALA_DEV_OPEN=1` in the
   * environment. For local dev, CI, benchmarks, and the free web demo only.
   */
  private devOpen(): boolean {
    // Hard-disabled in the published npm build: a public, paid package must not
    // honor a client-flippable bypass. `typeof` guards the undeclared-from-source case.
    const allowDevOpen =
      typeof __BV_SALA_ALLOW_DEV_OPEN__ === "undefined" ? true : __BV_SALA_ALLOW_DEV_OPEN__;
    if (!allowDevOpen) return false;
    if (this.config.devUnlicensed === true) return true;
    return typeof process !== "undefined" && process.env?.BVSALA_DEV_OPEN === "1";
  }

  /**
   * Fail-closed entry gate. Throws {@link LicenseError} unless the caller is in
   * dev-open mode or holds an active/grace license. Un gate sin `isActive()`
   * TAMBIÉN es rechazado: no puede demostrar que la licencia esté viva.
   */
  private assertLicensed(): void {
    if (this.devOpen()) return;
    const gate = this.config.licenseGate;
    if (gate && typeof gate.isActive === "function") {
      if (gate.isActive()) return;
      const st = typeof gate.status === "function" ? gate.status() : undefined;
      throw new LicenseError(
        `BiVelio license is not active${st ? ` (${st})` : ""}. Renew your subscription at https://savings.bivelio.com`,
        st,
      );
    }
    // Un gate SIN isActive() no es "auto-gestionado": es la puerta abierta. La
    // rama anterior avisaba por consola y hacía `return`, así que bastaba pasar
    // `licenseGate: { isEntitled: () => true }` —o cualquier objeto al que le
    // falte el método— para saltarse el pago entero en el paquete publicado en
    // npm. El escape legítimo para desarrollo local ya existe y es explícito:
    // `devUnlicensed: true` (ver devOpen()). Así que aquí se falla cerrado.
    if (gate) {
      throw new LicenseError(
        "licenseGate must implement isActive(). A gate without it cannot prove the " +
          "licence is live, so the pipeline refuses to run. Pass { licenseKey } for " +
          "enforced licensing, or { devUnlicensed: true } for local development.",
        "invalid",
      );
    }
    throw new LicenseError(
      "No BiVelio license configured. Pass { licenseKey } from your subscription (or { devUnlicensed: true } for local dev). Get a key at https://savings.bivelio.com",
    );
  }

  private async generateOptimized<T = unknown>(request: SavingsRequest): Promise<SavingsResult<T>> {
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
        // Honest avoided-output baseline: the answer we serve is exactly what a
        // real call would have produced, so measure ITS tokens instead of crediting
        // the maxOutputTokens ceiling (which overstates the absolute cost avoided).
        ledger.avoidCall(baselineInput, this.tokensFor(resolved.text, request));
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
        // Measured avoided-output baseline (the cached answer is the real output).
        ledger.avoidCall(baselineInput, this.tokensFor(hit.text, request));
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
        exactKey, baselineInput,
      );

    if (policy.allowSingleflight && toggles.singleflight !== false) {
      const { value, coalesced } = await this.deps.singleflight.run(inflightKey, runExpensive);
      if (coalesced) {
        trace.record("singleflight", "coalesced", { key: inflightKey });
        // The follower serves the leader's answer — measure that answer's output.
        return this.asCoalescedFollower<T>(
          value, baselineInput, this.tokensFor(value.text ?? "", request), costModel,
        );
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
        // Measured avoided-output baseline (the cached answer is the real output).
        ledger.avoidCall(
          baselineInput,
          this.tokensFor((hit.record.answer as CachedAnswer<T>).text, request),
        );
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
    let messages: ChatMessage[] = [...request.messages];

    // Ground the model on the retrieved evidence. adaptive-k (Stage 7) already
    // pruned the set to the kept docs; here we actually PROJECT them into the
    // prompt. Without this, retrieval runs and the report shows "kept N/M" but the
    // model answers ungrounded — the exact failure retrieval exists to prevent.
    if (retrieval.docs.length > 0) {
      const evidence = retrieval.docs
        .map((d, i) => `[${d.source ?? d.id ?? `doc${i + 1}`}]\n${d.text}`)
        .join("\n\n");
      messages.push({
        role: "system",
        content: `Retrieved context — answer using only this evidence and cite sources by [id]:\n\n${evidence}`,
      });
    }

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
      // Apply-or-drop-reporting: compress each message and REPLACE its content in
      // the prompt we actually send, crediting ONLY the tokens truly removed from
      // that outgoing request. (The prior version compressed a throwaway join and
      // credited savings the provider never saw — a phantom saving.) A message is
      // kept verbatim unless the compressor returns a shorter, fidelity-passed
      // rewrite, so a compressor that drops a protected span is a no-op, not a loss.
      let compressedBefore = 0;
      let compressedAfter = 0;
      const rewritten: ChatMessage[] = [];
      for (const m of messages) {
        const before = this.tokensFor(m.content, request);
        const result = await this.config.compressor.compress({ text: m.content });
        const applies = !result.skipped && result.fidelityPassed;
        const after = applies ? this.tokensFor(result.compressed, request) : before;
        if (applies && after < before) {
          rewritten.push({ ...m, content: result.compressed });
          compressedBefore += before;
          compressedAfter += after;
        } else {
          rewritten.push(m);
        }
      }
      if (compressedAfter < compressedBefore) {
        messages = rewritten; // the compressed prompt is what the provider receives
        ledger.compress(compressedBefore, compressedAfter);
        trace.record("compression", "applied", { before: compressedBefore, after: compressedAfter });
      } else {
        trace.record("compression", "skipped (no fidelity-passed net reduction)");
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
    // Cache writes are best-effort side effects AFTER the provider was already
    // billed. A failing cache backend must never fail this request — and must
    // never bubble to the fail-open handler, which would re-invoke (double-bill)
    // the provider. Swallow-and-trace instead.
    try {
      if (policy.allowExactCache && toggles.exactCache !== false) {
        // Default a finite 24h TTL (not "forever") so a query the freshness
        // heuristic missed can't serve a permanently-stale answer. Override via config.
        await this.deps.exactCache.set(
          exactKey,
          answer,
          this.config.exactCacheTtlMs ?? 24 * 60 * 60 * 1000,
        );
      }
      if (
        policy.allowSemanticCache &&
        toggles.semanticCache &&
        this.deps.semanticCache
      ) {
        await this.deps.semanticCache.store(canonical, answer as CachedAnswer);
      }
    } catch (err) {
      trace.record("cache-write", "failed (non-fatal; answer already served)", {
        error: err instanceof Error ? err.message : String(err),
      });
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

  /**
   * Last-resort direct provider call used when the optimized path throws. Runs
   * NO optimization: baseline equals actual, so it never claims a saving. The
   * report carries a `fail-open` trace so the degradation is observable.
   */
  private async failOpenDirect<T>(request: SavingsRequest, cause: unknown): Promise<SavingsResult<T>> {
    const trace = new TraceCollector(this.now);
    trace.record("fail-open", "internal optimizer error — bypassed to a direct provider call", {
      error: cause instanceof Error ? cause.message : String(cause),
    });
    const ledger = new SavingsLedger();
    const costModel = this.costModelFor(request.model);
    let canonical: ReturnType<typeof canonicalize>;
    try {
      canonical = canonicalize(request);
    } catch {
      canonical = {
        schemaVersion: request.response?.version ?? request.response?.contractId ?? "none",
      } as ReturnType<typeof canonicalize>;
    }

    const schema = request.response?.schema;
    const providerStart = this.now();
    const response = await this.config.provider.generate({
      model: request.model,
      messages: request.messages,
      ...(request.tools?.length ? { tools: request.tools } : {}),
      ...(schema ? { schema } : {}),
      ...(request.response?.maxOutputTokens != null
        ? { maxOutputTokens: request.response.maxOutputTokens }
        : {}),
      ...(request.temperature != null ? { temperature: request.temperature } : {}),
      ...(request.seed != null ? { seed: request.seed } : {}),
    });
    const providerMs = this.now() - providerStart;

    ledger.baselineLlm = 1;
    ledger.actualLlm = 1;
    // No optimization ran → baseline == actual (zero claimed savings).
    ledger.actualInput = response.usage.inputTokens;
    ledger.actualOutput = response.usage.outputTokens;
    ledger.baselineInput = response.usage.inputTokens;
    ledger.baselineOutput = response.usage.outputTokens;
    if (response.usage.cachedInputTokens) ledger.providerCached(response.usage.cachedInputTokens);

    let data: unknown = response.text;
    let structurallyValid = true;
    if (schema) {
      const parsed = tryParse(response.text);
      structurallyValid = parsed.ok ? validateAgainstSchema(parsed.value, schema).valid : false;
      if (parsed.ok) data = parsed.value;
    }

    const report = this.buildReport(
      request, canonical, "miss", ledger, costModel, trace, defaultRoute(),
      jsonFallbackChoice(), undefined, undefined, structurallyValid, "none", providerMs,
    );
    return { requestId: report.requestId, data: data as T, text: response.text, report };
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
   * Whether a managed feature is licensed. Fail-closed: with no gate the feature
   * is denied (the entry gate already blocks fully-unlicensed callers; this is
   * defense in depth). Dev-open mode grants everything.
   */
  private entitled(feature: string): boolean {
    if (this.devOpen()) return true;
    return !!this.config.licenseGate && this.config.licenseGate.isEntitled(feature);
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
