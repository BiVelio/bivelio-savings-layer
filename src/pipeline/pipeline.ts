import { randomId } from "../util/id.js";
import { avisarUnaVez } from "../util/warn-once.js";
import { isBuiltInDemoProvider } from "../providers/demo-brand.js";

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
import { resolveConstraintBackend, type ConstraintPlan } from "../constraints/backends.js";
import { executeRetrievalPlan } from "../retrieval/retrieval.js";
import { TraceCollector } from "../telemetry/traces.js";
import type { CachedAnswer } from "../cache/exact.js";
import type { Provider, ProviderResponse } from "../providers/types.js";
import type { RouteDecision } from "../router/router.js";
import type { FormatChoice } from "../serialization/format-selector.js";
import { LicenseError } from "../license/errors.js";
import type { LicenseStatus } from "../license/verify.js";
import { DEFAULT_COST_MODEL, type SavingsLayerConfig } from "./config.js";
import { precioDeLista } from "../pricing/catalogo.js";
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
 * Build-time flag: en el bundle WEB (la demo pública), correr sin licencia se
 * limita al proveedor de demo interno. Sin esto, cualquiera importaba
 * `savings.bivelio.com/vendor/bv-sala.js` y hacía
 * `createSavingsLayer({ provider: unProveedorReal, devUnlicensed: true })`
 * para tener el optimizador entero gratis — el producto de pago regalado. La
 * demo del landing usa un MockProvider, que no sirve valor real, así que sigue
 * funcionando. `undefined` desde el fuente (tests, benchmarks) → sin restricción.
 */
declare const __BV_SALA_DEMO_ONLY__: boolean | undefined;

/**
 * The BV-SALA execution pipeline.
 *
 * Optimization order (cheapest first): avoid the call entirely -> avoid
 * auxiliary calls (retrieval/tools) -> eliminate unnecessary context ->
 * compress what remains -> constrain generation. Provider prefix/KV caching is
 * recorded as ledger 4 (cheaper tokens), never as eliminated tokens.
 */
/** Rastro de lo que esta peticion ya ha gastado, para que el fail-open no
 *  rescate algo que ya costo dinero ni reintente un fallo del proveedor. */
interface TestigoDeFacturacion {
  llamadas: number;
  falloDelProveedor: boolean;
}

/**
 * Errores que YA costaron dinero, aunque el testigo de quien los recibe esté a
 * cero: los pagó el LÍDER del singleflight.
 *
 * El testigo es por petición —tiene que serlo: una misma capa sirve peticiones
 * concurrentes—, así que un seguidor coalescido hereda la excepción del líder
 * con `llamadas: 0` y `falloDelProveedor: false`. Para él es indistinguible de
 * un fallo interno del optimizador, y el fail-open hace justo lo que no debe:
 * abrir OTRA llamada completa contra el proveedor que acaba de devolver un 429.
 * Con N seguidores son N-1 llamadas extra sobre un proveedor caído, que es la
 * amplificación que el singleflight existe para evitar.
 *
 * La marca viaja con el objeto de error, que es lo único que cruza esa frontera.
 * WeakSet para no retener errores vivos.
 */
const erroresYaFacturados = new WeakSet<object>();

function marcarErrorFacturado(err: unknown): void {
  if (typeof err === "object" && err !== null) erroresYaFacturados.add(err);
}

function errorYaFacturado(err: unknown): boolean {
  return typeof err === "object" && err !== null && erroresYaFacturados.has(err);
}

/**
 * El mensaje que se lleva el cliente cuando la puerta está cerrada. Es, con
 * diferencia, el texto más importante del producto: es lo ÚNICO que ve alguien a
 * quien el SDK acaba de dejar de funcionar, y decide si va al sitio correcto o
 * pierde una tarde.
 *
 * Antes era uno solo para todos los casos: *"BiVelio license is not active (X).
 * Renew your subscription"*. O sea que a quien acababa de pagar y había pegado
 * mal la clave —o había pegado la `bvk_` donde va la licencia— se le decía que
 * renovara la suscripción que acababa de comprar; y a quien tenía la salida de
 * red cerrada, lo mismo. Mandarle a pagar es el peor consejo posible en los dos
 * casos, porque el problema está a un copiar-y-pegar de distancia.
 */
export function mensajeDeLicencia(st: LicenseStatus | string | undefined): string {
  switch (st) {
    case "invalid":
      // No verifica contra nuestra clave pública. Casi siempre es un problema de
      // copiar y pegar, y NUNCA se arregla pagando.
      return (
        "BiVelio license key is not valid (it does not verify). Check you pasted the WHOLE key, " +
        "and that it is the license key from your dashboard — not the `bvk_` service-account key, " +
        "which goes in `serviceAccountKey`. Keys: https://savings.bivelio.com/dashboard/install"
      );
    case "revoked":
      // Aquí sí hay algo que gestionar, pero no es "renovar": es entender por qué.
      return (
        "BiVelio license has been revoked. If this is unexpected, check your billing status " +
        "at https://savings.bivelio.com/dashboard/account or write to support@bivelio.com"
      );
    case "stale":
      // La licencia está PAGADA y VIGENTE. El problema es la red.
      return (
        "BiVelio could not confirm your license with the control plane in time — this is a " +
        "connectivity problem, not a billing one: your license is still valid. Allow outbound " +
        "HTTPS to your `licenseServerUrl` (https://savings.bivelio.com by default) and retry."
      );
    case "expired":
    case "grace":
      return `BiVelio license is not active (${st}). Renew your subscription at https://savings.bivelio.com`;
    default:
      return `BiVelio license is not active${st ? ` (${st})` : ""}. See https://savings.bivelio.com/dashboard/account`;
  }
}

export class SavingsPipeline {
  private readonly deps: ResolvedDeps;
  private readonly config: SavingsLayerConfig;
  private readonly now: () => number;
  private readonly generateId: () => string;
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
    // Testigo de facturación de ESTA petición. No puede ser un campo de la
    // instancia: una misma capa sirve peticiones concurrentes.
    const testigo: TestigoDeFacturacion = { llamadas: 0, falloDelProveedor: false };
    try {
      return await this.generateOptimized<T>(request, testigo);
    } catch (err) {
      if (err instanceof LicenseError) throw err;
      if (this.config.failOpen === false) throw err;

      // El fail-open existe para que un fallo INTERNO del optimizador no tumbe la
      // petición del cliente. Se le habían colado dos casos que no son eso, y los
      // dos cuestan dinero de verdad:
      //
      //  1. UN FALLO DEL PROVEEDOR. El docstring dice desde el principio que «a
      //     genuine provider error propagates», pero el catch solo excluía
      //     LicenseError: un 429 o un 5xx del proveedor provocaba OTRA llamada
      //     completa contra el mismo proveedor que acababa de fallar. No arregla
      //     nada y duplica el gasto.
      //  2. CUALQUIER EXCEPCIÓN POSTERIOR A UNA LLAMADA YA FACTURADA. failOpenDirect
      //     construye un ledger NUEVO desde cero (actualLlm = 1), así que las
      //     llamadas anteriores desaparecían del informe. Reproducido por la
      //     auditoría con TRES llamadas facturadas y un informe que decía
      //     `actualLlm: 1`, `retries: 0`, el coste de un solo intento y encima
      //     `basis: "measured"` — justo el campo que el panel presenta como
      //     contrastable con la factura. El cliente no tenía forma de verlo.
      //
      // Regla: el fail-open solo puede rescatar lo que aún no ha costado nada.
      if (testigo.falloDelProveedor) throw err;
      if (testigo.llamadas > 0) throw err;
      // El mismo criterio cuando quien pagó fue el líder del singleflight: su
      // testigo no es el nuestro, así que la deuda viaja marcada en el error.
      if (errorYaFacturado(err)) throw err;

      return await this.failOpenDirect<T>(request, err);
    }
  }

  /**
   * Llama al proveedor dejando constancia. Todo punto que gaste dinero pasa por
   * aquí para que el fail-open sepa si la petición ya ha costado algo y para
   * distinguir un fallo DEL PROVEEDOR de un fallo del optimizador.
   */
  private async llamarProveedor(
    req: Parameters<Provider["generate"]>[0],
    testigo: TestigoDeFacturacion,
  ): Promise<ProviderResponse> {
    testigo.llamadas += 1;
    try {
      return await this.config.provider.generate(req);
    } catch (err) {
      testigo.falloDelProveedor = true;
      throw err;
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

    // En el bundle WEB (demo pública) el modo abierto se limita al proveedor de
    // demo interno. Así la demo del landing —que usa un MockProvider— funciona,
    // pero quien importe el bundle con un proveedor REAL no tiene barra libre.
    // Desde el fuente (tests/benchmarks) la bandera es undefined → sin límite,
    // que es lo que necesitan `pnpm ab` y los tests con proveedores reales.
    const soloDemo =
      typeof __BV_SALA_DEMO_ONLY__ === "undefined" ? false : __BV_SALA_DEMO_ONLY__;
    if (soloDemo && !isBuiltInDemoProvider(this.config.provider)) return false;

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
      throw new LicenseError(mensajeDeLicencia(st), st);
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

  /**
   * PEDIR UNA PALANCA QUE NO ESTÁ ENCHUFADA NO PUEDE SER GRATIS Y MUDO.
   *
   * Ni el compresor ni la caché semántica tienen valor por defecto, y ese
   * defecto es correcto: un compresor y un embebedor son gasto y proveedor
   * ajenos, y elegirlos por el cliente le mete latencia y factura que no pidió.
   * Lo que no es correcto es que `savings: { compression: "auto" }` no haga
   * nada y tampoco diga nada: el informe sale SIN la clave `compression` y con
   * `eliminatedInput: 0`, que es EXACTAMENTE lo que se ve cuando el compresor sí
   * corrió y no encontró nada que quitar. Medido contra el paquete publicado con
   * 51.956 tokens de contexto redundante: 16 modelos de 16 sin comprimir, sin
   * una señal. Y el fragmento de instalación del README no configura ninguna de
   * las dos, así que quien lo copia cree que las tiene.
   *
   * SOLO CON PETICIÓN EXPLÍCITA, nunca por "el contexto era grande". Un aviso
   * disparado por tamaño le hablaría de una palanca a quien no la pidió —puede
   * haber decidido a conciencia no pagar un compresor— y encima se dispararía a
   * veces por los bloques `system` que inyecta la propia capa (evidencia de
   * retrieval, payload serializado): culparíamos al cliente de nuestro volumen.
   * Un aviso que salta cuando no toca deja de leerse, y entonces tampoco se lee
   * el que sí importa.
   *
   * No se mira la política ni la licencia a propósito: la dependencia ausente lo
   * está para TODA la capa, así que el aviso es cierto y accionable en cualquier
   * petición, y es de los que se emiten una vez por proceso.
   */
  /**
   * EL ÚNICO PORTERO DE LOS AVISOS DEL PIPELINE.
   *
   * `silenceWarnings` se consultaba en UN solo sitio mientras su documentación
   * —publicada en npm, y npm es inmutable— prometía que callaba el pipeline
   * entero. Un interruptor que apaga una de las fuentes y deja las otras
   * hablando es la peor clase de interruptor: la que hay que descubrir probando.
   *
   * Todo aviso del pipeline pasa por aquí. Si mañana se añade otro y alguien
   * llama a `console.warn` directamente, la promesa vuelve a romperse — por eso
   * hay un test que recorre este fichero y falla si aparece un `console.warn`
   * suelto.
   */
  private avisar(clave: string, mensaje: string): void {
    if (this.config.silenceWarnings) return;
    avisarUnaVez(clave, mensaje);
  }

  private avisarDePalancasSinConfigurar(toggles: NonNullable<SavingsRequest["savings"]>): void {
    if (this.config.silenceWarnings) return;

    if ((toggles.compression === true || toggles.compression === "auto") && !this.config.compressor) {
      this.avisar(
        "palanca-sin-compresor",
        "[bv-sala] se pidió `savings.compression` pero esta capa no tiene compresor, así que NO se " +
          "comprime nada: el contexto largo viaja y se paga entero. En el informe, " +
          "`report.compression` sale AUSENTE y `tokens.eliminatedInput` a 0 — lo mismo que se ve " +
          "cuando no había nada que comprimir. El compresor es un sidecar  " +
          "porque añade latencia y cómputo que solo usted debe decidir pagar: enchúfelo con " +
          "`createSavingsLayer({ compressor })`, cualquier objeto con `compress({ text })`. " +
          "Si su plan no incluye `long_context_compression`, hará falta además esa función. " +
          "El resto de la capa sigue ahorrando igual.",
      );
    }

    if (toggles.semanticCache && !this.deps.semanticCache) {
      this.avisar(
        "palanca-sin-cache-semantica",
        "[bv-sala] se pidió `savings.semanticCache` pero esta capa no tiene caché semántica, así que " +
          "toda pregunta reformulada saldrá `cache: \"miss\"` y se pagará al proveedor otra vez. " +
          "No viene por defecto porque necesita un embebedor, que es coste y proveedor suyos: " +
          "enchúfela con `createSavingsLayer({ semanticCache: new InMemorySemanticCache({ embed }) })`. " +
          "La caché exacta y el resto de la capa siguen funcionando.",
      );
    }
  }

  private async generateOptimized<T = unknown>(
    request: SavingsRequest,
    // Con valor por defecto para que invocarlo directamente (tests de superficie,
    // benchmarks) siga funcionando. En el camino real siempre llega el de generate().
    testigo: TestigoDeFacturacion = { llamadas: 0, falloDelProveedor: false },
  ): Promise<SavingsResult<T>> {
    // Defensa en profundidad: el gate también aquí, no solo en generate(). El
    // `private` de TypeScript se borra al compilar, así que si alguien alcanzara
    // una instancia del pipeline (hoy ya no se expone `layer.pipeline` ni se
    // reexporta la clase) no debe poder correr el optimizador sin licencia. Es
    // idempotente con la llamada de generate().
    this.assertLicensed();
    const trace = new TraceCollector(this.now);
    const ledger = new SavingsLedger();
    const canonical = canonicalize(request);
    const policy = evaluatePolicy(canonical);
    const toggles = request.savings ?? {};
    this.avisarDePalancasSinConfigurar(toggles);
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
    const runExpensive = async (): Promise<SavingsResult<T>> => {
      try {
        return await this.expensivePath<T>(
          testigo, request, canonical, policy, toggles, ledger, costModel, trace,
          exactKey, baselineInput,
        );
      } catch (err) {
        // Aquí, y no en el catch de generate(), porque este es el ÚNICO punto
        // donde coinciden el error y el testigo del que lo pagó: cuando la
        // excepción llegue a un seguidor coalescido, su testigo ya será otro.
        if (testigo.falloDelProveedor || testigo.llamadas > 0) marcarErrorFacturado(err);
        throw err;
      }
    };

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
    testigo: TestigoDeFacturacion,
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
    const routerApagado = toggles.router === false;
    const route: RouteDecision = routerApagado
      ? defaultRoute()
      : this.deps.router.classify(canonical);
    trace.record("router", route.executionClass, {
      confidence: route.confidence,
      reason: route.reason,
    });

    // --- Stage 6: tool selection. ---
    // Con el router APAGADO no hay clasificación de la que derivar el riesgo, y el
    // selector solo deja pasar write/destructive con TOOL_ACTION: filtrar sobre el
    // defaultRoute() (NO_RETRIEVAL) tiraba las herramientas de escritura en
    // silencio — el mismo fallo que se cerró para `retrieval:"off"`, reabierto por
    // la palanca hermana, y justo en el "shadow mode" que el docstring del router
    // recomienda como primer paso. Apagar el router significa "no optimices por
    // esta vía", así que las herramientas del llamante pasan ÍNTEGRAS.
    const toolSelection = routerApagado
      ? this.deps.toolSelector.passthrough(request.tools)
      : this.deps.toolSelector.select(
          canonical.normalizedText,
          request.tools,
          route.executionClass,
        );
    ledger.actualTools = toolSelection.tools.length;
    if (toolSelection.droppedIds.length) {
      // LIBRO 2. Hasta ahora `SavingsLedger.eliminate()` no tenía NI UN llamante
      // en todo `src/` —solo dos tests—, así que `tokens.eliminatedInput` salía 0
      // en TODA petición, el metering enviaba 0 al panel y el README anunciaba
      // `eliminated_tokens` como uno de los cuatro libros. El ahorro existía y se
      // veía en el total (el baseline SÍ cuenta las herramientas, ver
      // `assemblePromptText`), pero no estaba atribuido a nada.
      //
      // Una herramienta descartada es el caso de libro 2 más limpio que hay: el
      // llamante la declaró, el baseline la cuenta entera, y no se envía. No es
      // que ocupe menos —eso sería el libro 3—, es que no va.
      //
      // Se cuenta con el MISMO ensamblador que el baseline, byte a byte. Contarla
      // de otra forma reintroduciría por la puerta de atrás el sesgo que
      // `assemblePromptText` documenta: medir el envoltorio distinto en los dos
      // lados publicaba 785 tokens de baseline contra 262 reales.
      const descartadas = new Set(toolSelection.droppedIds);
      const tokensDescartados = (request.tools ?? [])
        .filter((t) => descartadas.has(t.id))
        .reduce((n, t) => n + this.tokensFor(textoDeHerramienta(t), request), 0);
      ledger.eliminate(tokensDescartados);
      trace.record("tool-selector", toolSelection.reason, {
        dropped: toolSelection.droppedIds,
        eliminatedTokens: tokensDescartados,
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
      let protegidos = 0;
      const rewritten: ChatMessage[] = [];
      for (const m of messages) {
        // NUNCA se comprime un `system`. Dos razones, y las dos eran defectos
        // reales:
        //
        //  1. SEGURIDAD. El bucle recorría TODOS los mensajes, incluidas las
        //     instrucciones de sistema del cliente, y llamaba a compress() sin
        //     `protectedSpans`. Con la lista vacía, `withProtectedSpans` no itera
        //     y devuelve `fidelityPassed: true` INCONDICIONALMENTE, así que el
        //     único filtro que quedaba era "¿es más corto?". Reproducido: «Never
        //     reveal internal pricing rules to the user» salía como «Never
        //     internal rules the under circumstance» — con el sentido invertido.
        //  2. CONTABILIDAD. Los tres bloques que inyecta la propia capa (evidencia
        //     de retrieval, aviso de límites JSON y payload serializado) son
        //     `system`. Comprimirlos acreditaba en el libro 3 tokens que NUNCA
        //     estuvieron en el baseline del cliente: ahorro sobre texto propio.
        //
        // La compresión de contexto largo es para la prosa del usuario, que es
        // donde tiene sentido y donde no hay nada que romper.
        if (m.role === "system") {
          protegidos += 1;
          rewritten.push(m);
          continue;
        }
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
        trace.record("compression", "applied", {
          before: compressedBefore,
          after: compressedAfter,
          protectedSystemMessages: protegidos,
        });
      } else {
        trace.record("compression", "skipped (no fidelity-passed net reduction)", {
          protectedSystemMessages: protegidos,
        });
      }
      // `SavingsReport.compression` se declaraba en el contrato y no lo rellenaba
      // NADIE: era `undefined` aunque la compresión hubiera corrido, y
      // `fidelityPassed` se calculaba sin publicarse. Un campo del contrato sin
      // productor es una promesa que el cliente no puede verificar.
      ledger.compressionReport = {
        originalTokens: compressedBefore,
        compressedTokens: compressedAfter,
        protectedSpans: protegidos,
        fidelityPassed: true, // solo se aplica lo que pasó la comprobación
      };
    }

    // --- Stage 10: constrained decoding + the single primary LLM call. ---
    const schema = request.response?.schema;
    let backendPlan: ConstraintPlan = schema
      ? resolveConstraintBackend(request.model, schema, this.deps.constraintBackends)
      : { backend: "none", reason: "no output contract" };
    trace.record("constraints", backendPlan.backend, { reason: backendPlan.reason });

    const providerStart = this.now();
    let response = await this.llamarProveedor({
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
    }, testigo);
    ledger.actualLlm = 1;
    ledger.actualInput = response.usage.inputTokens;
    ledger.actualOutput = response.usage.outputTokens;

    // EL PLAN SE DECIDE ANTES DE LLAMAR; LO QUE SE PUBLICA TIENE QUE SER LO QUE
    // PASÓ. `provider-native` se resolvía por lo que el backend DECLARA soportar y
    // viajaba al informe sin mirar la respuesta, así que un modelo anterior a los
    // structured outputs —que rechaza `response_format` y obliga al adaptador a
    // pedir el JSON por prompt— seguía publicándose como garantía del proveedor.
    // `structuredNatively` existe en ProviderResponse desde el principio y no lo
    // leía nadie; leerlo aquí es lo que impide certificar una garantía que no se
    // obtuvo.
    //
    // Solo se degrada con un `false` EXPLÍCITO: un adaptador que no informa no
    // afirma nada, y no vamos a inventarle una degradación.
    //
    // Bajar a "none" no es solo cosmético: habilita la reparación única de abajo,
    // que es exactamente la red que corresponde cuando la forma no la impone
    // nadie más que nuestro validador.
    if (schema && backendPlan.backend === "provider-native" && response.structuredNatively === false) {
      backendPlan = {
        backend: "none",
        reason:
          "provider did not enforce the contract natively; the schema travelled in the prompt " +
          "and the layer is the only validator",
      };
      trace.record("constraints", "none", {
        downgradedFrom: "provider-native",
        reason: backendPlan.reason,
      });
    }

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
    // `null` = NO APLICA (turno de herramientas: no hay respuesta final que
    // validar). Antes se inicializaba a `true` y ese `true` viajaba hasta el
    // informe, que certificaba el cumplimiento de un contrato que nadie había
    // mirado — justo la mentira en positivo que `finish()` dice haber cerrado
    // para el resolver y las cachés, reabierta por la rama nueva.
    let structurallyValid: boolean | null = true;
    // El modelo PIDIÓ ejecutar herramientas: `text` viene vacío a propósito y la
    // respuesta final no existe todavía (llegará cuando el llamante ejecute la
    // acción y continúe el turno). Validar "" contra el contrato aquí disparaba
    // una reparación PAGADA condenada a fallar — el modelo no puede dar la
    // respuesta final antes de conocer el resultado de la herramienta —, así que
    // el contrato de salida se aplica SOLO a respuestas finales.
    const pidioHerramientas = (response.toolCalls?.length ?? 0) > 0;
    if (pidioHerramientas) {
      // No aplica: la respuesta final llegara en el turno siguiente, cuando el
      // llamante ejecute la herramienta y continue la conversacion.
      structurallyValid = null;
      if (schema) {
        trace.record("validation", "n/a: model requested tool calls (the output contract applies to the final answer)");
      }
    }
    if (schema && !pidioHerramientas) {
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
      // Un fallo cuya causa es el ESQUEMA del cliente (un `pattern` que no
      // compila) no se puede reparar: ningún texto cumple un regex invalido, asi
      // que el reintento fallaria igual y seria otra llamada pagada — la segunda
      // fuente de doble cobro por el mismo error de configuracion. Como el
      // truncado: se detecta y NO se reintenta.
      const esquemaRoto =
        !validation.valid &&
        validation.errors.some((e) => /not a valid regular expression/.test(e.message));
      if (!validation.valid && esquemaRoto) {
        trace.record("validation", "repair-skipped", {
          reason: "schema defect (uncompilable pattern); no output can satisfy it, a retry is a wasted call",
          errors: validation.errors,
        });
        this.avisar(
          "esquema-roto",
          "[bvsala] El contrato de respuesta tiene un `pattern` que no es un regex valido, asi que " +
            "ninguna respuesta puede cumplirlo. NO se reintenta (seria una llamada pagada para el mismo " +
            "fallo). Corrige el `pattern` del esquema.",
        );
      } else if (!validation.valid && truncadoPorTope) {
        trace.record("validation", "repair-skipped", {
          reason: "output truncated by maxOutputTokens; a retry with the same cap would truncate again",
          maxOutputTokens: request.response?.maxOutputTokens ?? null,
          outputTokens: response.usage.outputTokens,
        });
        this.avisar(
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
        response = await this.llamarProveedor({
          model: request.model,
          messages: mensajesReparacion,
          schema,
          ...(request.response?.maxOutputTokens != null
            ? { maxOutputTokens: request.response.maxOutputTokens }
            : {}),
        }, testigo);
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
        // Y la ENTRADA del reintento, que faltaba. Sin esto el baseline se
        // reconstruía desde un `actualInput` que ya incluía las dos llamadas, así
        // que el reintento se pagaba a sí mismo: una petición que costó el doble
        // que el camino naive se publicaba con ahorro POSITIVO.
        ledger.repairInput += response.usage.inputTokens;
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
      // NO se cachea una respuesta que YA sabemos que incumple su contrato.
      // `structurallyValid` se calculaba arriba y solo se usaba para el informe:
      // un `{oops not json` con `response.schema` se pagaba dos veces (original +
      // reparación) y encima se guardaba 24 h, de modo que un fallo puntual del
      // modelo se convertía en una caída de 24 h para esa consulta — contabilizada
      // como el mayor ahorro del día, porque cada relectura acreditaba una llamada
      // evitada al 100 %.
      // Tampoco se cachea una PETICIÓN DE HERRAMIENTA. No es una respuesta: es
      // la orden de ejecutar una acción. Reproducirla desde caché servía "" como
      // texto durante 24 h y acreditaba una llamada 100 % evitada sobre una
      // acción que nunca se ejecutó — ahorro inventado sobre trabajo no hecho.
      const cacheable = structurallyValid !== false && !pidioHerramientas;
      if (!cacheable) {
        trace.record(
          "cache-write",
          pidioHerramientas
            ? "skipped: tool-call turn (an action request must not be replayed from cache)"
            : "skipped: response fails its output contract",
        );
      }

      if (cacheable && policy.allowExactCache && toggles.exactCache !== false) {
        // TTL finito (no "para siempre") para que una consulta que la heurística
        // de frescura no detectó no sirva una respuesta rancia indefinidamente.
        // El techo del `freshnessBucket` manda sobre el TTL configurado: es lo
        // único que hace que "hour" y "day" signifiquen algo, porque el bucket va
        // crudo al hash de la clave y NO la rota.
        const ttlBase = this.config.exactCacheTtlMs ?? 24 * 60 * 60 * 1000;
        const ttl = policy.maxCacheAgeMs == null ? ttlBase : Math.min(ttlBase, policy.maxCacheAgeMs);
        await this.deps.exactCache.set(exactKey, answer, ttl);
      }
      if (
        cacheable &&
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

    const result = this.finish<T>(
      request, canonical, answer, "miss", ledger, costModel, trace,
      route, formatChoice, undefined, undefined, structurallyValid,
      backendPlan.backend, providerMs,
    );
    // Las tool calls y el finishReason viajan HASTA EL LLAMANTE. Se quedaban en
    // ProviderResponse: el arreglo del adaptador (content:null + tool_calls)
    // moría una capa más arriba porque aquí solo se copiaba `text`, y el cliente
    // recibía cadena vacía como si fuera la respuesta buena.
    if (pidioHerramientas) result.toolCalls = response.toolCalls!;
    if (response.finishReason !== undefined) result.finishReason = response.finishReason;
    return result;
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
    structurallyValid?: boolean | null,
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
    // `null` = no aplica (turno de herramientas) y se propaga tal cual para que el
    // informe OMITA el campo. `undefined` = nadie lo calculo aun, asi que se valida
    // aqui lo que de verdad se sirve (resolver, caches, seguidor de singleflight).
    const valid =
      structurallyValid === null
        ? null
        : (structurallyValid ??
          (schema ? validateAgainstSchema(answer.data, schema).valid : true));

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
    structurallyValid: boolean | null,
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
      // Campo declarado en el contrato desde el principio y que no rellenaba
      // nadie: `report.compression` salía `undefined` aunque la compresión
      // hubiera corrido. Solo se publica cuando de verdad se aplicó.
      ...(ledger.compressionReport ? { compression: ledger.compressionReport } : {}),
      constraints: {
        backend,
        schemaVersion: canonical.schemaVersion,
        ...(structurallyValid === null ? {} : { structurallyValid }),
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
    let structurallyValid: boolean | null = true;
    // Igual que en el camino optimizado: un turno de tool calls no es la
    // respuesta final, así que ni se valida contra el contrato ni se pierde, y el
    // informe omite structurallyValid en vez de certificar un contrato no mirado.
    const pidioHerramientas = (response.toolCalls?.length ?? 0) > 0;
    if (pidioHerramientas) structurallyValid = null;
    if (schema && !pidioHerramientas) {
      const parsed = tryParse(response.text);
      structurallyValid = parsed.ok ? validateAgainstSchema(parsed.value, schema).valid : false;
      if (parsed.ok) data = parsed.value;
    }

    const report = this.buildReport(
      request, canonical, "miss", ledger, costModel, trace, defaultRoute(),
      jsonFallbackChoice(), undefined, undefined, structurallyValid, "none", providerMs,
    );
    return {
      requestId: report.requestId,
      data: data as T,
      text: response.text,
      ...(pidioHerramientas ? { toolCalls: response.toolCalls! } : {}),
      ...(response.finishReason !== undefined ? { finishReason: response.finishReason } : {}),
      report,
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
      parts.push(textoDeHerramienta(tool));
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
    // EL CATÁLOGO DE PRECIOS DE LISTA, antes del defecto del cliente. Un
    // `defaultCostModel` significa "para lo que yo no conozca"; con el catálogo,
    // muchos menos modelos son desconocidos, y el precio real de gpt-4o sirve
    // mejor al cliente que su propio precio genérico.
    const deLista = precioDeLista(model);
    if (deLista) return deLista;

    if (this.config.defaultCostModel) return this.config.defaultCostModel;

    // Caer en el precio ilustrativo deja de ser silencioso: el ahorro en dólares
    // que se derive de aquí no es el del cliente. Una vez por causa y proceso, y
    // por el portero, que es lo que hace cierta la promesa de `silenceWarnings`.
    this.avisar(
      `precio-ilustrativo:${model}`,
      `[bv-sala] no cost model configured for "${model}"; falling back to the ` +
        `ILLUSTRATIVE default price. Dollar figures will not match your bill. ` +
        `Pass { costModels: { "${model}": { inputPer1k, outputPer1k } } }.`,
    );
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
 * El texto de UNA herramienta tal y como se cuenta.
 *
 * Vive fuera de la clase y lo usan los dos sitios que necesitan contar
 * herramientas —el ensamblador del baseline y el libro 2 de las descartadas—
 * precisamente para que no puedan divergir. Es la misma regla de una sola regla
 * que documenta `assemblePromptText`: si el baseline y el conteo de lo quitado
 * ensamblan distinto, la diferencia se cuela como ahorro.
 *
 * El envoltorio cuenta: el proveedor factura la herramienta entera, no solo sus
 * `parameters`.
 */
function textoDeHerramienta(tool: NonNullable<SavingsRequest["tools"]>[number]): string {
  return JSON.stringify({
    type: "function",
    function: {
      name: tool.id,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.parameters ?? { type: "object", properties: {} },
    },
  });
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
