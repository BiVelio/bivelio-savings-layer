import { randomId } from "../util/id.js";
import { avisarUnaVez } from "../util/warn-once.js";

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
  private illustrativePriceWarned = false;
  /**
   * Contratos a los que un modelo YA les incumplió una restricción de valor.
   *
   * Avisar de esas restricciones cuesta tokens de entrada en cada petición, y
   * medido son 27 sobre prompts de 60-72: más de lo que cualquier palanca puede
   * quitar ahí. Peor aún, decirle a un modelo que dispone de 400 caracteres le
   * hace usarlos — en la FAQ la salida subió de 18 a 34 tokens, y la salida
   * cuesta 4x. Se pagaba por avisar de un límite que nadie iba a rozar.
   *
   * Así que se avisa solo donde está demostrado que hace falta: la primera
   * petición que incumpla paga su reparación, y a partir de ahí ese contrato
   * lleva el aviso. Vive en la instancia, no en el módulo.
   */
  private readonly contratosQueIncumplen: Set<string>;

  constructor(config: SavingsLayerConfig) {
    this.config = config;
    this.deps = resolveDependencies(config);
    this.now = config.now ?? (() => Date.now());
    this.generateId = config.generateId ?? (() => randomId());
    this.contratosQueIncumplen = config.constraintMemory ?? new Set<string>();
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

    // Restricciones de VALOR que ningún modo estructurado impone. `strict` de
    // OpenAI garantiza la FORMA (qué claves, de qué tipo), pero ignora
    // `maxLength`, `maxItems`, `pattern`, `minimum`… Nuestro validador SÍ las
    // exige, así que sin decírselas al modelo la petición está condenada: el
    // modelo no puede cumplir una regla que nadie le contó, el layer rechaza la
    // respuesta y se dispara una reparación igual de ciega.
    //
    // Medido: el escenario de la tabla pedía resumir 50 filas con
    // `answer.maxLength: 400` y fallaba su validación 10 de 12 veces.
    //
    // Cuesta unos pocos tokens de entrada y los cuenta el ledger como cualquier
    // otro: no se esconde en el baseline.
    const idContrato = contractKey(request);
    // El techo REAL de caracteres: el que impone el presupuesto de salida, que
    // suele ser más estricto que el `maxLength` del contrato. Anunciar 1200
    // caracteres cuando el tope de 600 tokens solo da para ~1600 —menos el
    // andamiaje del JSON— hace que el modelo escriba hasta el límite anunciado y
    // se corte a media cadena. Medido en el escenario de la tabla: con la pista,
    // nuestra salida válida cae a 27/40, mientras el brazo naive —con el MISMO
    // tope y SIN pista— cumple 39/40. La pista provocaba el fallo que pretende
    // evitar.
    const techoPorTokens = request.response?.maxOutputTokens != null
      ? Math.floor(request.response.maxOutputTokens * 3.2) // ~3,2 car/token en prosa, conservador
      : null;
    const reglasDeValor = this.contratosQueIncumplen.has(idContrato)
      ? describeValueConstraints(request.response?.schema, "", techoPorTokens)
      : "";
    if (reglasDeValor) {
      messages.push({
        role: "system",
        content: `JSON limits (not API-enforced): ${reglasDeValor}`,
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
        insertarAntesDeLaPregunta(messages, {
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
        insertarAntesDeLaPregunta(messages, { role: "system", content: jsonEncoded });
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

    // Calibración de la regla, medida en ESTA petición. `sentInputLocal` es la
    // cuenta local del prompt que de verdad salió; la diferencia contra el
    // baseline local es lo que la capa quitó. Ver la nota larga en SavingsLedger:
    // esa resta NO es neutra si los dos textos tienen densidades de símbolos
    // distintas, que es justo lo que pasa al cambiar JSON por un formato tabular.
    // Por eso se anota TAMBIÉN si el estimador cuenta con la regla del proveedor:
    // de ello depende que el resultado pueda llamarse medido o solo estimado.
    // El clamp a 0 importa: si el prompt enviado CRECIÓ (evidencia de retrieval,
    // instrucciones de formato) no se reclama nada, que es lo honesto — no un
    // ahorro negativo inventado.
    ledger.sentInputLocal = this.tokensFor(
      this.assemblePromptText(messages, toolSelection.tools),
      request,
    );
    ledger.removedInputLocal = Math.max(0, baselineInput - ledger.sentInputLocal);
    ledger.estimatorExact = this.estimatorEsExacto(request);

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

      // Aprender del fallo, pero SOLO de los que el aviso puede evitar. Un JSON
      // mal formado o una clave que falta no se arreglan contándole al modelo un
      // maxLength: el modo estructurado ya cubre la forma. Apuntar esos casos
      // haría pagar el aviso para siempre sin ganar nada.
      if (!validation.valid && esFalloDeValor(validation.errors)) {
        this.contratosQueIncumplen.add(contractKey(request));
      }

      // Un JSON cortado a media cadena por el tope de salida NO se arregla
      // reintentando con el mismo tope: vuelve a cortarse en el mismo sitio y se
      // paga una segunda llamada para obtener el mismo fallo. Medido contra el
      // proveedor con el escenario de la tabla: finish_reason "length",
      // exactamente 180 tokens (el tope), `Unterminated string in JSON`.
      //
      // Tampoco se sube el tope por nuestra cuenta: lo fijó quien llama, y puede
      // haberlo hecho para controlar el gasto. Lo honesto es no cobrarle una
      // llamada inútil y decirle exactamente qué pasa.
      const truncadoPorTope = response.finishReason === "length";
      if (!validation.valid && truncadoPorTope) {
        trace.record("validation", "repair-skipped", {
          reason: "output truncated by maxOutputTokens; a retry with the same cap would truncate again",
          maxOutputTokens: request.response?.maxOutputTokens ?? null,
          outputTokens: response.usage.outputTokens,
        });
        avisarUnaVez(
          "salida-truncada",
          "[bvsala] La respuesta se cortó al agotar `maxOutputTokens`" +
            (request.response?.maxOutputTokens != null ? ` (${request.response.maxOutputTokens})` : "") +
            ", así que no valida contra el contrato. NO se reintenta: con el mismo tope volvería a " +
            "cortarse y sería una llamada pagada para el mismo fallo. Sube `maxOutputTokens` o " +
            "reduce lo que pide el contrato.",
        );
      } else if (!validation.valid && backendPlan.backend === "none") {
        // Single deterministic repair attempt only when we had no constraint
        // backend to prevent the invalid output in the first place.
        ledger.retries = 1;
        trace.record("validation", "repair-attempt", { errors: validation.errors });

        // El reintento reenviaba `...messages` ENTERO — con los datos
        // estructurados dentro, que es donde está el volumen. En el escenario de
        // la tabla eso arrastraba ~780 tokens dos veces, y medido contra un
        // proveedor real este camino se llevaba entre el 40% y el 63% de todo el
        // gasto de la capa. Es coste que la capa se inflige a sí misma mientras
        // dice estar ahorrando.
        //
        // Y era CIEGO: `validation.errors` se calculaba, se metía en la traza y
        // NO se le decía al modelo; el mensaje era una constante. Se le pedía que
        // adivinara qué estaba mal. Experimento natural en la propia tirada:
        // "FAQ (first)" y "FAQ (repeat)" son la misma petición byte a byte; la
        // que reparó sacó 0/2 de calidad y la que no reparó, 2/2. El reintento
        // duplicaba el coste y empeoraba el resultado.
        //
        // Ahora se manda lo justo para arreglar: la salida inválida y QUÉ falla
        // exactamente. La respuesta previa ya contiene la sustancia, así que no
        // hace falta reenviar el material de origen.
        const detalle = validation.errors
          .slice(0, 5) // no convertir el propio informe de errores en el nuevo volumen
          .map((e) => `- ${e.path}: ${e.message}`)
          .join("\n");
        const mensajesReparacion: ChatMessage[] = [
          {
            role: "user",
            content:
              "Your previous reply did not satisfy the required JSON contract.\n\n" +
              `Previous reply:\n${response.text}\n\n` +
              `Problems found:\n${detalle}\n\n` +
              "Return ONLY the corrected JSON object. Keep the same content; fix only what is listed.",
          },
        ];
        response = await this.config.provider.generate({
          model: request.model,
          messages: mensajesReparacion,
          schema,
          ...(request.response?.maxOutputTokens != null
            ? { maxOutputTokens: request.response.maxOutputTokens }
            : {}),
        });
        ledger.actualLlm = 2;
        ledger.actualInput += response.usage.inputTokens;
        ledger.actualOutput += response.usage.outputTokens;
        // La reparación es coste NUESTRO, así que su salida se marca aparte para
        // que NO engorde el baseline. Antes solo se sumaba a actualOutput, y como
        // el baseline de una llamada ejecutada se deriva de actualOutput, el
        // reintento se pagaba a sí mismo: la pérdida se reportaba mucho menor de
        // lo que fue. La entrada del reintento también entra en sentInputLocal
        // para que la calibración no se descuadre (actualInput ya acumula las dos
        // llamadas; si la lectura local cubriera solo la primera, k saldría ~2x).
        ledger.repairOutput += response.usage.outputTokens;
        // SIN las herramientas: la llamada de reparación no las envía (mírala
        // arriba, no lleva `tools`). Contarlas aquí metía en la lectura local
        // tokens que el proveedor nunca facturó, y descuadraba la calibración en
        // el sentido de acreditar de más.
        ledger.sentInputLocal += this.tokensFor(
          this.assemblePromptText(mensajesReparacion),
          request,
        );
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
    structurallyValid?: boolean,
    backend = "none",
    providerMs = 0,
  ): SavingsResult<T> {
    // La validez estructural se COMPRUEBA aquí, no se hereda de un valor por
    // defecto. El parámetro tenía `= true`, y las cuatro rutas de atajo
    // (resolver determinista, caché exacta, caché semántica y seguidor de
    // singleflight) no lo pasaban: el informe afirmaba que la respuesta cumplía
    // el contrato de salida sin haberlo mirado nunca. Un resolver podía
    // devolver {value: 8} a quien pidió {answer: string} y el informe lo daba
    // por válido, con 100% de ahorro acreditado.
    //
    // Ahora se valida SIEMPRE lo que de verdad se sirve, venga de donde venga.
    // Las rutas que ya lo calcularon (la que llama al proveedor) lo pasan y su
    // valor manda; el resto se resuelve contra el esquema del contrato.
    const schema = request.response?.schema;
    const valid =
      structurallyValid ??
      (schema ? validateAgainstSchema(answer.data, schema).valid : true);

    const report = this.buildReport(
      request, canonical, cacheResult, ledger, costModel, trace, route,
      formatChoice, ageMs, confidence, valid, backend, providerMs,
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
        baselineOutput: ledger.publishedBaselineOutput,
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

    // Un id por seguidor, no dos. Antes se llamaba a generateId() por separado
    // para el resultado y para el informe, así que result.requestId nunca
    // coincidía con result.report.requestId y correlacionar una petición con su
    // registro de medición era imposible.
    const requestId = this.generateId();

    return {
      ...leader,
      requestId,
      report: {
        ...leader.report,
        requestId,
        calls: { ...leader.report.calls, actualLlm: 0, avoidedLlm: 1 },
        // El bloque `tokens` se construye desde el ledger DEL SEGUIDOR, no se
        // hereda del líder. Con `{...leader.report}` cada seguidor reemitía los
        // tokens que el proveedor facturó UNA vez: con N seguidores,
        // compressedInput y providerCachedInput se contaban N+1 veces en
        // usage_daily, y actualInput imputaba a los seguidores un gasto que
        // nunca hicieron (su llamada se coalesció: no tocaron el proveedor).
        tokens: {
          baselineInput: ledger.baselineInput,
          actualInput: ledger.actualInput,
          eliminatedInput: ledger.eliminatedInput,
          compressedInput: ledger.compressedInput,
          baselineOutput: ledger.publishedBaselineOutput,
          actualOutput: ledger.actualOutput,
          eliminatedOutput: ledger.eliminatedOutput,
          ...(ledger.providerCachedInput
            ? { providerCachedInput: ledger.providerCachedInput }
            : {}),
        },
        cache: { result: "singleflight" },
        cost,
      },
    };
  }

  private assembleBaselinePrompt(request: SavingsRequest): string {
    return this.assemblePromptText(
      request.messages,
      request.tools,
      request.structuredData,
    );
  }

  /**
   * Ensamblador ÚNICO del texto que se mide en local.
   *
   * El baseline y la lectura del prompt realmente enviado TIENEN que ensamblarse
   * igual, byte a byte. Si no, la calibración k = actualInput / sentInputLocal
   * sale sesgada y el sesgo vuelve a colarse como ahorro por la puerta de atrás
   * — que es exactamente el bug que la regla de una sola regla viene a cerrar.
   */
  private assemblePromptText(
    messages: ChatMessage[],
    tools?: SavingsRequest["tools"],
    structuredData?: unknown,
  ): string {
    const parts = messages.map((m) => m.content);
    if (structuredData !== undefined) {
      parts.push(JSON.stringify(structuredData));
    }
    for (const tool of tools ?? []) {
      // El envoltorio cuenta. Antes solo se contaban los `parameters`, pero el
      // proveedor factura la herramienta ENTERA — nombre, descripción y la
      // envoltura `{type:"function",function:{…}}` que arma el adaptador (ver
      // providers/openai-compatible.ts). Dejarlo fuera hacía que la cuenta local
      // del prompt enviado quedara POR DEBAJO de lo que midió el proveedor, y
      // entonces k = actualInput/sentInputLocal salía > 1 (medido: 1,31), o sea
      // que cada token quitado se acreditaba inflado. En el escenario tool-heavy
      // publicaba un baseline de 785 contra 262 reales: 3,00x.
      parts.push(
        JSON.stringify({
          type: "function",
          function: {
            name: tool.id,
            ...(tool.description ? { description: tool.description } : {}),
            parameters: tool.parameters ?? { type: "object", properties: {} },
          },
        }),
      );
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
   * ¿El tokenizador que se usará para ESTA petición cuenta con la regla del
   * proveedor? De ello depende que un baseline reconstruido pueda publicarse
   * como medido. Fail-closed: un registro que no sepa responder cuenta como
   * inexacto, porque la duda tiene que restar afirmación, no sumarla.
   */
  private estimatorEsExacto(request: SavingsRequest): boolean {
    const registro = this.config.tokenizer as {
      resolve?: (o: { tokenizer?: string; model?: string }) => { exact?: boolean };
    };
    if (typeof registro.resolve !== "function") return false;
    try {
      return (
        registro.resolve({
          ...(request.tokenizer ? { tokenizer: request.tokenizer } : {}),
          model: request.model,
        }).exact === true
      );
    } catch {
      return false;
    }
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

  /**
   * Precio del modelo. Se prueba el id COMPLETO y, si no está, el id sin el
   * prefijo de proveedor.
   *
   * Antes era un único lookup exacto, y el contrato del SDK pide ids
   * cualificados ("openai/gpt-4o-mini"): quien configuraba sus precios con la
   * clave desnuda —lo natural, y lo que hace la tabla de precios del propio
   * proveedor— fallaba el lookup y caía en DEFAULT_COST_MODEL, que el código
   * etiqueta como "Illustrative". El panel presentaba el resultado como "a tus
   * precios". Sin aviso, sin traza y con un desvío de varias veces el real.
   */
  private costModelFor(model: string): CostModel {
    const models = this.config.costModels;
    if (models) {
      const exacto = models[model];
      if (exacto) return exacto;
      const barra = model.indexOf("/");
      if (barra >= 0) {
        const desnudo = models[model.slice(barra + 1)];
        if (desnudo) return desnudo;
      }
    }
    if (this.config.defaultCostModel) return this.config.defaultCostModel;

    // Caer en el precio ilustrativo deja de ser silencioso: el ahorro en dólares
    // que se derive de aquí no es el del cliente. Una vez por instancia.
    if (!this.illustrativePriceWarned) {
      this.illustrativePriceWarned = true;
      console.warn(
        `[bv-sala] no cost model configured for "${model}"; falling back to the ` +
          `ILLUSTRATIVE default price. Dollar figures will not match your bill. ` +
          `Pass { costModels: { "${model}": { inputPer1k, outputPer1k } } }.`,
      );
    }
    return DEFAULT_COST_MODEL;
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

/**
 * Enumera las restricciones de VALOR de un esquema en lenguaje llano.
 *
 * Solo las que el proveedor NO impone: la forma (claves, tipos) ya la garantiza
 * el modo estructurado, repetirla sería gastar tokens en vano.
 */
function describeValueConstraints(schema: unknown, ruta = "", techoChars: number | null = null): string {
  if (schema == null || typeof schema !== "object") return "";
  const s = schema as Record<string, unknown>;
  const lineas: string[] = [];
  const nombre = ruta || "the value";

  const num = (k: string): number | null => (typeof s[k] === "number" ? (s[k] as number) : null);
  const maxLength = num("maxLength");
  const minLength = num("minLength");
  const maxItems = num("maxItems");
  const minItems = num("minItems");
  const maximum = num("maximum");
  const minimum = num("minimum");

  // Telegráfico a propósito: esto se paga en tokens de entrada en CADA petición
  // con contrato, así que cada palabra de más es dinero del cliente.
  // Se anuncia el límite VINCULANTE, no el del contrato: si el presupuesto de
  // salida es más estricto, prometerle al modelo el del contrato le hace escribir
  // hasta un tamaño que no cabe, y se corta.
  if (maxLength != null) {
    const efectivo = techoChars != null ? Math.min(maxLength, techoChars) : maxLength;
    lineas.push(`${nombre}<=${efectivo}ch`);
  }
  if (minLength != null) lineas.push(`${nombre}>=${minLength}ch`);
  if (maxItems != null) lineas.push(`${nombre}<=${maxItems} items`);
  if (minItems != null) lineas.push(`${nombre}>=${minItems} items`);
  if (maximum != null) lineas.push(`${nombre}<=${maximum}`);
  if (minimum != null) lineas.push(`${nombre}>=${minimum}`);
  if (typeof s["pattern"] === "string") lineas.push(`${nombre} matches /${s["pattern"]}/`);

  const props = s["properties"];
  if (props && typeof props === "object") {
    for (const [clave, sub] of Object.entries(props as Record<string, unknown>)) {
      const linea = describeValueConstraints(sub, ruta ? `${ruta}.${clave}` : clave, techoChars);
      if (linea) lineas.push(linea);
    }
  }
  if (s["items"] !== undefined) {
    const linea = describeValueConstraints(s["items"], `${nombre} entries`, techoChars);
    if (linea) lineas.push(linea);
  }
  return lineas.join("; ");
}

/** Identidad del contrato para la memoria de incumplimientos. */
function contractKey(request: SavingsRequest): string {
  const r = request.response;
  if (!r) return "";
  return r.contractId ?? r.version ?? JSON.stringify(r.schema ?? {}).slice(0, 200);
}

/**
 * ¿Alguno de estos fallos lo arreglaría avisar al modelo?
 *
 * Solo las restricciones de VALOR. La forma (claves, tipos, JSON bien formado)
 * ya la garantiza el modo estructurado del proveedor, así que un fallo de forma
 * no es motivo para empezar a pagar el aviso en cada petición.
 */
function esFalloDeValor(errores: readonly { message: string }[]): boolean {
  return errores.some((e) =>
    /exceeds maxItems|exceeds maxLength|match pattern|exceeds maximum|below minimum|below minLength|below minItems/.test(
      e.message,
    ),
  );
}

/**
 * Inserta un bloque de datos ANTES del último mensaje del usuario.
 *
 * El orden importa, y mucho más de lo que parece. Medido con 8 pares por
 * variante sobre la tabla de 50 filas, cambiando SOLO la posición:
 *
 *   pregunta primero, datos al final   403 tokens de salida · trunca 4/8 · válidas 4/8
 *   datos primero, pregunta al final   193 tokens          · trunca 0/8 · válidas 8/8
 *   petición naive (JSON)              279 tokens          · trunca 0/8 · válidas 8/8
 *
 * Mismo contenido, mismo rol, misma instrucción. Con la pregunta delante el
 * modelo divaga sobre los datos que acaba de leer y se estrella contra el tope
 * de salida; con la pregunta al final responde a lo que se le pide. Esos
 * truncados eran el 100% de los fallos de calidad del banco y lo único que
 * impedía publicar una cifra demostrada.
 *
 * Y coincide con lo que quiere la caché de prefijo del proveedor: lo estable
 * delante, lo variable al final. Las dos razones empujan en el mismo sentido.
 */
function insertarAntesDeLaPregunta(messages: ChatMessage[], bloque: ChatMessage): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      messages.splice(i, 0, bloque);
      return;
    }
  }
  messages.push(bloque);
}
