import { randomId } from "../util/id.js";
import { avisarUnaVez } from "../util/warn-once.js";
import { isBuiltInDemoProvider } from "../providers/demo-brand.js";

import type {
  SavingsRequest,
  SavingsResult,
  SavingsReport,
  ChatMessage,
  CacheOutcome,
  DeferredExecutionReport,
  ModelCascadeMode,
  ModelCascadeReport,
  QualityStatus,
  ToolDescriptor,
} from "../contracts/types.js";
import { canonicalize, sha256, stableStringify } from "../canonicalization/canonicalize.js";
import { buildExactKey, buildInflightKey } from "../canonicalization/keys.js";
import type { CacheTier } from "../economics/cache-tier.js";
import { VerjaDeCacheDePrefijo } from "../economics/prefix-cache-gate.js";
import {
  SIN_TIER_DIFERIBLE,
  ahorroDelTier,
  latenciaDelTier,
  veredictoDelTier,
} from "../economics/tier-diferido.js";
import {
  VerjaDeCascada,
  economiaDelPar,
  modeloBarato,
  PARES_POR_DEFECTO,
  type EconomiaDelPar,
} from "../economics/cascada-de-modelos.js";
import {
  elegibilidadDeLaCascada,
  hechosDivergentes,
  verificarRespuesta,
  type FuerzaDelVerificador,
} from "../constraints/verificador-de-cascada.js";
import { evaluatePolicy } from "../policy/policy.js";
import { SavingsLedger, type CostModel } from "../tokenizer/accounting.js";
import { validateAgainstSchema } from "../constraints/validate.js";
import { tokensDeLaMayorRespuesta } from "../constraints/techo-de-salida.js";
import { resolveConstraintBackend, type ConstraintPlan } from "../constraints/backends.js";
import { planOutputCodebook } from "../constraints/codebook.js";
import { MemoriaDelCodebook } from "../constraints/codebook-evidencia.js";
import { executeRetrievalPlan } from "../retrieval/retrieval.js";
import { shouldCompress } from "../compression/compression.js";
import { politicaDeCompresion, tramoDeCache } from "../economics/politica-compresion.js";
import { TraceCollector } from "../telemetry/traces.js";
import type { CachedAnswer } from "../cache/exact.js";
import type { Provider, ProviderResponse } from "../providers/types.js";
import type { RouteDecision } from "../router/router.js";
import {
  decidirDescubrimiento,
  descriptorLigero,
  herramientasDeLaSegunda,
  peorCasoDeEsquemas,
  MAX_LECTURAS_DE_LA_SEGUNDA,
  SALIDA_DEL_SONDEO_TOKENS,
} from "../router/schema-on-demand.js";
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
 * Lo que la cascada de modelos decidió para ESTA petición, tomado antes de
 * tocar la caché porque la clave de caché depende de ello.
 */
interface DecisionDeCascada {
  modo: ModelCascadeMode;
  /** El que pidió el llamante. El hecho de partida, y nunca se reescribe. */
  modeloPedido: string;
  /** El modelo al que se va a llamar. Igual al pedido salvo que `enruta`. */
  modeloServido: string;
  /** El modelo barato del par, exista o no la intención de usarlo. */
  candidato: string | null;
  /** Solo cierto en modo `on` y con la verja a favor. */
  enruta: boolean;
  /** Si la petición admitiría cascada: hay contrato y no hay escritura. */
  elegible: boolean;
  razon: string;
  fuerza: FuerzaDelVerificador;
  /** Identificador del workload sobre el que se mide P(escalar). */
  bucket: string;
  economia: EconomiaDelPar | null;
  observada: number | null;
  muestras: number;
  precioBarato: CostModel | null;
  /** Fracción de peticiones de sombra que pagan una llamada extra para medir. */
  tasaDeMuestreo: number;
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
 *
 * TODOS terminan con el estado —`(license status: X)`— porque es el único asidero
 * con el que se puede buscar: el texto se reescribe, el estado no. Y todos
 * apuntan a la página que RESUELVE ese estado, nunca a la raíz del sitio: la
 * raíz es la portada de venta, y a quien ya pagó le manda a buscar otra vez.
 */
export function mensajeDeLicencia(st: LicenseStatus | string | undefined): string {
  switch (st) {
    case "none":
      // NADA configurado. Es el primer contacto de CUALQUIERA que instale el
      // paquete y pegue el fragmento del README, así que es el mensaje más leído
      // del producto — y es donde el consejo tiene que ser ejecutable palabra por
      // palabra. Se separa de `undefined` a propósito: `undefined` es "un gate
      // devolvió un estado que no conozco", y son dos arreglos distintos.
      return mensajeSinLicencia();
    case "invalid":
      // No verifica contra nuestra clave pública. Casi siempre es un problema de
      // copiar y pegar, y NUNCA se arregla pagando.
      return (
        "BiVelio license key is not valid (it does not verify). Check you pasted the WHOLE key, " +
        "and that it is the license key from your dashboard — not the `bvk_` service-account key, " +
        "which goes in `serviceAccountKey`. Keys: https://savings.bivelio.com/dashboard/install " +
        "(license status: invalid)"
      );
    case "revoked":
      // Aquí sí hay algo que gestionar, pero no es "renovar": es entender por qué.
      return (
        "BiVelio license has been revoked. If this is unexpected, check your billing status " +
        "at https://savings.bivelio.com/dashboard/account or write to support@bivelio.com " +
        "(license status: revoked)"
      );
    case "stale":
      // La licencia está PAGADA y VIGENTE. El problema es la red.
      return (
        "BiVelio could not confirm your license with the control plane in time — this is a " +
        "connectivity problem, not a billing one: your license is still valid. Allow outbound " +
        "HTTPS to your `licenseServerUrl` (https://savings.bivelio.com by default) and retry. " +
        "(license status: stale)"
      );
    case "expired":
    case "grace":
      return (
        "BiVelio license is not active. Renew your subscription at " +
        `https://savings.bivelio.com/dashboard/account (license status: ${st})`
      );
    default:
      return (
        "BiVelio license is not active. See " +
        `https://savings.bivelio.com/dashboard/account${st ? ` (license status: ${st})` : ""}`
      );
  }
}

/**
 * EL MENSAJE QUE MÁS SE LEE, Y EL QUE MANDABA A UNA PUERTA TAPIADA.
 *
 * Decía: *"Pass { licenseKey } … (or { devUnlicensed: true } for local dev). Get
 * a key at https://savings.bivelio.com"*. Las dos mitades estaban rotas en el
 * paquete PUBLICADO, que es el único que toca un cliente:
 *
 *   · `devUnlicensed` —y la variable de entorno— se compilan FUERA del build de
 *     npm (`__BV_SALA_ALLOW_DEV_OPEN__: "false"` en tsup.config.ts), así que
 *     seguir ese consejo devolvía EL MISMO ERROR, con el mismo consejo dentro.
 *     Un bucle cerrado en la primera pantalla del producto. Recomendar una
 *     puerta tapiada es peor que no decir nada: gasta la confianza y la tarde de
 *     quien acaba de instalar.
 *   · el enlace iba a la raíz del sitio, que es la portada de venta. La página
 *     que resuelve ESTE error —la clave ya emitida, con su fragmento para
 *     pegar— es `/dashboard/install`.
 *
 * Y tiene que ser cierto en CADA build, no solo en el de npm: desde el fuente
 * (tests, banco, ejemplos del repo) `devUnlicensed` sí funciona y tiene que
 * seguir funcionando. Lo deciden las MISMAS constantes de build que deciden si
 * la puerta abre, no una copia de la intención: así no pueden divergir.
 *
 * La forma `const …; if (!…) return …;` no es estilo: es lo que mantiene el
 * texto del fuente FUERA del bundle publicado. esbuild sustituye la constante
 * por `false` y elimina la rama muerta. Es la misma forma que usa `devOpen()`,
 * y allí por una razón que además es una verja: si el literal del nombre de la
 * variable de entorno sobrevive en `dist/index.js`, publish.yml aborta la
 * Release. El test de sala limpia comprueba lo mismo en cada PR.
 */
function mensajeSinLicencia(): string {
  const hayPuertaDeDesarrollo =
    typeof __BV_SALA_ALLOW_DEV_OPEN__ === "undefined" ? true : __BV_SALA_ALLOW_DEV_OPEN__;
  if (!hayPuertaDeDesarrollo) {
    return (
      "BiVelio license required: none was configured. Pass { licenseKey } — the signed token " +
      "from your subscription, verified offline. This published package has no unlicensed mode. " +
      "Copy your key and a ready-to-paste snippet at " +
      "https://savings.bivelio.com/dashboard/install (license status: none)"
    );
  }
  // TRES builds, no dos. El bundle del navegador (`__BV_SALA_DEMO_ONLY__`) SÍ
  // tiene puerta, pero solo para el proveedor de demo interno: a quien lo importe
  // con un proveedor real, recomendarle `devUnlicensed` le devuelve el mismo
  // error otra vez — exactamente el bucle que este arreglo cierra, en otro
  // envoltorio. Se comprueba aquí y no con `isBuiltInDemoProvider` porque solo
  // una condición de constantes de BUILD se pliega: pasada como argumento, el
  // texto del fuente viajaría dentro del tarball de npm y tumbaría la verja de
  // publish.yml.
  const soloDemo = typeof __BV_SALA_DEMO_ONLY__ === "undefined" ? false : __BV_SALA_DEMO_ONLY__;
  if (soloDemo) {
    return (
      "BiVelio license required: none was configured. This in-browser demo build runs ungated " +
      "only with BiVelio's built-in demo provider; against a real provider it needs " +
      "{ licenseKey } — the signed token from your subscription. Get one at " +
      "https://savings.bivelio.com/dashboard/install (license status: none)"
    );
  }
  return (
    "BiVelio license required: none was configured. Pass { licenseKey } — the signed token " +
    "from your subscription, verified offline — or { devUnlicensed: true }, honored ONLY in " +
    "this from-source build and never in the published npm package. Get a key at " +
    "https://savings.bivelio.com/dashboard/install (license status: none)"
  );
}

/**
 * Gate inyectado al que le falta `isActive()`. Mismo defecto que el anterior y
 * por eso mismo criterio: el texto solo puede nombrar palancas que EXISTAN en
 * este build. En el paquete publicado no solo está tapiada la puerta de
 * desarrollo — es que un `licenseGate` inyectado se descarta entero
 * (`createSavingsLayer`), así que el único camino es `licenseKey`. Decirle otra
 * cosa a quien ya está atascado le cuesta otra vuelta.
 */
function mensajeDeGateIncompleto(): string {
  const hayPuertaDeDesarrollo =
    typeof __BV_SALA_ALLOW_DEV_OPEN__ === "undefined" ? true : __BV_SALA_ALLOW_DEV_OPEN__;
  if (!hayPuertaDeDesarrollo) {
    return (
      "licenseGate must implement isActive(): a gate that cannot prove the license is live " +
      "is refused. In this published package an injected gate is not a licensing path at " +
      "all — pass { licenseKey } instead, from " +
      "https://savings.bivelio.com/dashboard/install (license status: invalid)"
    );
  }
  return (
    "licenseGate must implement isActive(): a gate that cannot prove the license is live " +
    "is refused. Pass { licenseKey } for enforced licensing, or { devUnlicensed: true } for " +
    "local development from source. (license status: invalid)"
  );
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

  /**
   * Verja de la caché de prefijo del proveedor.
   *
   * Vive en la instancia por la misma razón que `contratosQueIncumplen`: lo que
   * aprende es una MEDICIÓN (la tasa de aciertos real de un prefijo), y una
   * medición hay que acumularla entre peticiones o no se llega a tener nunca.
   */
  private readonly verjaDeCache = new VerjaDeCacheDePrefijo();

  /**
   * Verja de la cascada de modelos. Vive en la instancia por lo mismo que las
   * otras dos: lo que aprende —la P(escalar) real de cada workload— es una
   * MEDICIÓN, y una medición hay que acumularla entre peticiones o no se llega a
   * tener nunca.
   */
  private readonly verjaDeCascada: VerjaDeCascada;

  /**
   * Delta de salida del codebook, POR MODELO Y POR CONTRATO.
   *
   * Vive en la instancia como las otras tres memorias, pero con una diferencia
   * que conviene no perder de vista: aquéllas APRENDEN de lo que devuelve cada
   * petición, y ésta no puede —lo que decide es un contrafactual—, así que solo
   * recuerda lo que el llamante ya midió, sobre el catálogo de lo que midió
   * BiVelio. El razonamiento entero está en `codebook-evidencia.ts`.
   *
   * LA CLAVE LLEVA EL MODELO. El mismo contrato da +8,0% en `gpt-4o` y −8,2% en
   * `gpt-4o-mini`: una memoria indexada solo por contrato aplicaría el dato de
   * uno al otro, y perdería exactamente ese 8% en el sentido malo.
   */
  private readonly memoriaDelCodebook = new MemoriaDelCodebook();

  constructor(config: SavingsLayerConfig) {
    this.config = config;
    this.deps = resolveDependencies(config);
    this.now = config.now ?? (() => Date.now());
    this.generateId = config.generateId ?? (() => randomId());
    this.contratosQueIncumplen = config.constraintMemory ?? new Set<string>();
    this.verjaDeCascada = new VerjaDeCascada(
      config.modelCascade?.exploration != null
        ? { exploracion: config.modelCascade.exploration }
        : {},
    );
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
   * ¿Se marca el prefijo de esta petición para la caché del proveedor?
   *
   * Cuatro razones para NO marcar, y ninguna es opcional:
   *
   *  1. NO SE RECONOCE EL PROVEEDOR. Sin tramo no se puede poner precio a la
   *     escritura, y marcar a ciegas es apostar.
   *  2. EL CONJUNTO DE HERRAMIENTAS DEPENDE DE LA PREGUNTA. `tools` se renderiza
   *     lo PRIMERO, así que un conjunto que cambia con la consulta mueve el
   *     principio del prompt e invalida todo lo que va detrás. El prefijo no
   *     podría acertar aunque lo marcáramos: se pagaría la prima de escritura a
   *     cambio de nada. Aquí está el choque real entre dos palancas —la poda de
   *     herramientas alimenta el libro 2— y se resuelve así: la poda GANA (es un
   *     ahorro medido y ya publicado), y la caché se reclama sólo cuando no hay
   *     poda. El selector ya estabiliza el ORDEN, que es la mitad del problema
   *     que sí sale gratis.
   *  3. SCHEMA-ON-DEMAND ESTÁ PUESTO. Es la razón 2 otra vez, pero peor, y por eso
   *     tiene entrada propia: con `toolDiscovery` el conjunto que viaja no lo
   *     elige el selector sino la RESPUESTA DEL SONDEO, que no es determinista.
   *     Dos peticiones idénticas pueden mandar catálogos distintos, así que el
   *     bloque `tools` —lo primero del prompt— cambia entre peticiones que la
   *     huella agruparía como el mismo prefijo. Y no se arregla metiendo las
   *     herramientas ENVIADAS en la huella: eso parte el tráfico en un prefijo
   *     por subconjunto, y cada uno paga sus 8 peticiones de exploración a 1,25x
   *     para medir h = 0. O sea, la exploración se multiplica por el número de
   *     subconjuntos y ninguno vuelve a repetirse.
   *
   *     Se renuncia a marcar en TODA petición con la palanca puesta, no sólo en
   *     las que el sondeo llegó a recortar. Es a propósito y es conservador: la
   *     caché de prefijo es una propiedad del TRÁFICO, no de una petición, y una
   *     huella que mezcla peticiones con catálogo entero y con catálogo recortado
   *     no mide ningún prefijo. Además, saber si el sondeo se aplicó exige
   *     haberlo lanzado ya, y para entonces esta decisión llegaría tarde o se
   *     tomaría dentro del cronómetro del proveedor. El error que se comete así
   *     es ahorro no capturado; el otro es factura de más. No cuestan lo mismo.
   *  4. LA VERJA ECONÓMICA. Con la escritura a 1,25x y la lectura a 0,10x,
   *     marcar sólo compensa por encima de ~21,7% de aciertos.
   */
  private decidirMarcadoDeCache(
    request: SavingsRequest,
    modeloServido: string,
    messages: ChatMessage[],
    toolSelection: { tools: SavingsRequest["tools"] & object; setIsStable: boolean },
    descubrimientoActivo: boolean,
    mensajesDePrefijo: number,
    trace: TraceCollector,
  ): { marcar: boolean; huella: string; mensajesDePrefijo: number } {
    const nada = { marcar: false as const, huella: "", mensajesDePrefijo: 0 };

    const tier = tramoDelModelo(modeloServido, this.config.compressionEconomics);
    if (!tier) {
      trace.record("prefix-cache", "skipped", {
        reason:
          `no cache read discount for model "${modeloServido}" (unrecognised provider, ` +
          `or a declared tier that does not discount reads): not claiming a cacheable prefix`,
      });
      return nada;
    }
    if (!toolSelection.setIsStable) {
      trace.record("prefix-cache", "skipped", {
        reason:
          "the tool SET is selected per request; tools render first, so the prefix cannot hit. " +
          "Pruning wins here (it is a measured saving); pass the tools you want fixed.",
      });
      return nada;
    }
    if (descubrimientoActivo) {
      trace.record("prefix-cache", "skipped", {
        reason:
          "savings.toolDiscovery is on: which schemas travel is decided by a non-deterministic " +
          "probe, so the tool block — which renders first — varies across requests that would " +
          "share a prefix fingerprint. Marking would pay the 1.25x write premium for a prefix " +
          "that cannot hit. Turn tool discovery off to reclaim the prefix cache.",
      });
      return nada;
    }
    if (mensajesDePrefijo <= 0) return nada;

    const prefijo = messages.slice(0, mensajesDePrefijo);
    const stablePrefixTokens = this.tokensFor(
      this.assemblePromptText(prefijo, toolSelection.tools),
      request,
    );
    const totalTokens = this.tokensFor(
      this.assemblePromptText(messages, toolSelection.tools),
      request,
    );

    // La huella identifica EL PREFIJO, no la petición: dos preguntas distintas
    // sobre el mismo sistema y el mismo historial comparten huella, que es
    // justamente lo que permite acumular la medición. Va hasheada porque también
    // viaja como `prompt_cache_key` de OpenAI, y ahí no puede salir texto del
    // cliente. No lleva tenant ni usuario: es una pista de enrutado, no una
    // frontera de aislamiento, y fingir lo contrario sería peor que no tenerla.
    const huella = sha256(
      stableStringify({
        model: modeloServido,
        tools: (toolSelection.tools ?? []).map((t) => t.id),
        prefijo: prefijo.map((m) => `${m.role}:${m.content}`),
      }),
    );

    const decision = this.verjaDeCache.decidir(huella, {
      totalTokens,
      stablePrefixTokens,
      tier,
    });
    trace.record("prefix-cache", decision.marcar ? "marked" : "skipped", {
      reason: decision.razon,
      stablePrefixTokens,
      breakEvenHitRate: decision.umbral,
      observedHitRate: decision.observada,
    });
    return decision.marcar
      ? { marcar: true, huella, mensajesDePrefijo }
      : nada;
  }

  /**
   * LA CASCADA DE MODELOS: ¿a qué modelo va esta petición, y qué se mide?
   *
   * SE DECIDE AQUÍ, ANTES DE LA ETAPA 2, y la posición es la mitad del diseño.
   * La clave de la caché exacta se construye con el modelo que va a CONTESTAR
   * (ver `buildExactKey`), así que la decisión tiene que estar tomada antes de
   * tocar la caché o se guardaría la respuesta del barato bajo la clave del
   * fuerte — un cambio de modelo silencioso y diferido, que es la peor versión
   * del cambio de modelo silencioso. Y puede decidirse tan pronto porque no
   * necesita nada del prompt: le bastan el modelo, el contrato, las herramientas
   * y el precio.
   *
   * TRES MODOS, y solo uno toca algo:
   *  · `off` (defecto)  ni mide ni decide. Ni siquiera se construye el informe.
   *  · `shadow`         mide y publica; el modelo NO cambia. Es gratis salvo que
   *                     se pida muestreo, que es un opt-in aparte y con precio.
   *  · `on`             enruta de verdad, con la verja de apagado automático.
   *
   * LA ELEGIBILIDAD MANDA SOBRE EL DINERO, y por eso se comprueba primero: sin
   * contrato de salida o con herramientas de escritura no hay verificador que
   * valga, y un par estupendamente barato no compra el derecho a servir sin
   * comprobar nada.
   */
  private decidirCascada(
    request: SavingsRequest,
    canonical: ReturnType<typeof canonicalize>,
    toggles: NonNullable<SavingsRequest["savings"]>,
    trace: TraceCollector,
  ): DecisionDeCascada {
    const modo: ModelCascadeMode = toggles.modelCascade ?? "off";
    const apagada: DecisionDeCascada = {
      modo: "off",
      modeloPedido: request.model,
      modeloServido: request.model,
      candidato: null,
      enruta: false,
      elegible: false,
      razon: "the model cascade is off",
      fuerza: "none",
      bucket: "",
      economia: null,
      observada: null,
      muestras: 0,
      precioBarato: null,
      tasaDeMuestreo: 0,
    };
    if (modo === "off") return apagada;

    const elegibilidad = elegibilidadDeLaCascada({
      schema: request.response?.schema,
      tools: request.tools,
    });

    const candidato = modeloBarato(request.model, this.config.modelCascade?.pairs ?? PARES_POR_DEFECTO);
    // CON EL PRECIO CONOCIDO, NO CON EL DE TARIFAR. `costModelFor` nunca devuelve
    // `undefined` —cae en el ilustrativo— así que preguntándole a él la rama de
    // «sin precio no hay aritmética» de más abajo era código muerto y un par sin
    // precio se aprobaba con una cuenta inventada. Ver `precioConocido`.
    const precioFuerte = this.precioConocido(request.model);
    const precioBarato = candidato ? this.precioConocido(candidato) : undefined;
    const economia = economiaDelPar(precioBarato, precioFuerte);

    // El bucket: MISMO trabajo, no misma petición. Lleva el tenant (dos clientes
    // no comparten medición), el contrato y su versión (lo que de verdad define
    // "tipo de petición"), el par de modelos y las herramientas. NO lleva el
    // texto del usuario, ni siquiera hasheado: es un identificador de workload
    // que sale en el informe, y ahí no puede viajar contenido de nadie.
    const bucket = sha256(
      stableStringify({
        tenant: canonical.tenantId,
        scope: canonical.authorizationScope,
        contract: canonical.contractId,
        schema: canonical.schemaVersion,
        fuerte: request.model,
        barato: candidato,
        tools: canonical.toolsetHash,
      }),
    );

    const medido = this.verjaDeCascada.estado(bucket);
    const base = {
      modo,
      modeloPedido: request.model,
      modeloServido: request.model,
      candidato,
      enruta: false,
      elegible: false,
      razon: elegibilidad.razon,
      fuerza: elegibilidad.fuerza,
      bucket,
      economia,
      // `null` mientras no haya NADA medido, nunca 0: un cero optimista sobre
      // cero muestras diría «este workload no escala jamás» a quien lea el
      // informe de su primera petición.
      observada: medido && medido.enrutadas > 0 ? medido.escaladas / medido.enrutadas : null,
      muestras: medido?.enrutadas ?? 0,
      precioBarato: precioBarato ?? null,
      tasaDeMuestreo: 0,
    } satisfies DecisionDeCascada;

    const rechazar = (razon: string): DecisionDeCascada => {
      trace.record("model-cascade", modo === "on" ? "not routed" : "not eligible", { reason: razon });
      return { ...base, razon };
    };

    if (!elegibilidad.elegible) return rechazar(elegibilidad.razon);
    if (!candidato) {
      return rechazar(
        `no cheaper model is paired with "${request.model}"; declare one in ` +
          `createSavingsLayer({ modelCascade: { pairs } }) if your provider has one`,
      );
    }
    if (!economia) {
      const sinPrecio = [
        ...(this.precioConocido(request.model) ? [] : [request.model]),
        ...(precioBarato ? [] : [candidato]),
      ];
      return rechazar(
        `no known price for ${sinPrecio.map((m) => `"${m}"`).join(" or ") || "this pair"}, so the ` +
          `arithmetic that decides whether routing pays cannot be run. The illustrative default ` +
          `price is deliberately NOT used here: it would approve a pair nobody has priced. Pass ` +
          `\`costModels\` for both models to enable the cascade for them`,
      );
    }
    if (!economia.viable) return rechazar(economia.razon);

    // A partir de aquí el par vale la pena. En SOMBRA se queda en eso: se publica
    // lo que se habría hecho y no se toca el modelo.
    const tasaDeMuestreo = Math.min(1, Math.max(0, this.config.modelCascade?.shadowSampleRate ?? 0));
    if (modo === "shadow") {
      trace.record("model-cascade", "shadow", {
        candidateModel: candidato,
        costRatio: economia.r,
        breakEvenEscalationRate: economia.equilibrio,
        verifier: elegibilidad.fuerza,
        workload: bucket,
        note:
          "measuring only: the request goes to the model you asked for. The escalation rate is not " +
          "a quality score — a well-formed answer with wrong content passes the verifier.",
      });
      return { ...base, elegible: true, razon: elegibilidad.razon, tasaDeMuestreo };
    }

    const verja = this.verjaDeCascada.decidir(bucket, economia);
    if (!verja.enrutar) {
      trace.record("model-cascade", "off (gate)", {
        reason: verja.razon,
        observedEscalationRate: verja.observada,
        breakEvenEscalationRate: economia.equilibrio,
      });
      return { ...base, elegible: true, razon: verja.razon, observada: verja.observada, muestras: verja.muestras };
    }

    // ENRUTAR NUNCA ES SILENCIOSO. Un aviso por proceso y por par, además de la
    // traza y del informe: cambiar el modelo de un cliente es exactamente el tipo
    // de cosa de la que uno se entera tarde si solo está en un campo JSON.
    this.avisar(
      `cascada:${request.model}->${candidato}`,
      `[bv-sala] model cascade ON: requests for "${request.model}" may be answered by ` +
        `"${candidato}" when a deterministic gate accepts the answer. The gate checks the SHAPE of ` +
        `the answer against your output contract, never its meaning, so a well-formed answer with ` +
        `wrong content is served and counted as a success. report.model always names the model that ` +
        `answered, and report.qualityStatus reads "bounded_degradation".`,
    );
    trace.record("model-cascade", "routed", {
      candidateModel: candidato,
      costRatio: economia.r,
      breakEvenEscalationRate: economia.equilibrio,
      observedEscalationRate: verja.observada,
      verifier: elegibilidad.fuerza,
      workload: bucket,
      reason: verja.razon,
    });
    return {
      ...base,
      modeloServido: candidato,
      enruta: true,
      elegible: true,
      razon: verja.razon,
      observada: verja.observada,
      muestras: verja.muestras,
      tasaDeMuestreo: 0,
    };
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
      throw new LicenseError(mensajeDeGateIncompleto(), "invalid");
    }
    // `"none"` y no `undefined`. El estado ya se documentaba como
    // «expired | invalid | revoked | none» en LicenseError y NUNCA se ponía: quien
    // capturaba el error para ramificar recibía `undefined` —indistinguible de un
    // gate que no sabe responder— y solo le quedaba parsear el texto, que es lo
    // que se reescribe cada vez que se mejora el mensaje.
    throw new LicenseError(mensajeDeLicencia("none"), "none");
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

  /**
   * EL AVISO DE TRUNCADO LLEVA EL CONTRATO Y EL MODELO EN LA CLAVE, Y NO ES UN
   * DETALLE DE FORMATO: SIN ESO, LA MAYORÍA DE LOS TRUNCADOS NO SE CUENTAN.
   *
   * La clave era la constante `"salida-truncada"`, y `avisarUnaVez` dedup por
   * clave y por PROCESO. O sea: el primer contrato que se cortara consumía el
   * aviso para todos los demás y para todos los modelos. El caso que lo destapó
   * es exactamente el que más importa —cambiar de modelo sin recalibrar el
   * contrato—: si otro contrato ya se había cortado antes en la misma tirada, el
   * cambio de modelo pasaba en SILENCIO. Un aviso que solo se emite una vez por
   * proceso tiene que estar keyado por la cosa de la que avisa.
   *
   * Y el texto dice CUÁL de las dos cosas cambiar, que es lo que a la tirada del
   * 2026-08-16 le costó leer números a mano de un CSV. La aritmética la tiene la
   * capa: `maxLength` acota CARACTERES —iguales para todo modelo— y el tope
   * acota TOKENS —distintos en cada tokenizador—, así que compara lo que el
   * esquema autoriza, ya contado con el tokenizador de ESTE modelo, contra el
   * tope. Son dos diagnósticos opuestos y el arreglo no es el mismo:
   *
   *   · el esquema autoriza MÁS de lo que el tope permite → el contrato se
   *     contradice a sí mismo y ninguna respuesta conforme cabe: es el tope (o el
   *     esquema) lo que hay que mover, y da igual el modelo;
   *   · el esquema cabe en el tope → el tope no es el problema: este modelo está
   *     escribiendo más de lo que el propio esquema autoriza.
   *
   * NO SE SUBE EL TOPE POR NUESTRA CUENTA, ni aquí ni en la rama de reparación:
   * lo fijó quien llama y puede haberlo puesto para controlar el gasto.
   *
   * `aprendido` dice si la capa ADEMÁS va a hacer algo la próxima vez. Sale del
   * mismo cálculo que el diagnóstico y se recibe hecho, en vez de rehacerlo aquí:
   * dos copias de la misma condición divergen, y entonces el aviso prometería una
   * pista que la memoria no guardó.
   */
  private avisarDeTruncado(
    request: SavingsRequest,
    modeloServido: string,
    tokensDeSalida: number,
    techoDelEsquema: number | null,
    aprendido: boolean,
  ): void {
    const tope = request.response?.maxOutputTokens;
    const contrato = contractKey(request) || "(sin contractId)";
    // Lo que la capa hará por su cuenta a partir de ahora, dicho solo cuando de
    // verdad lo va a hacer. Un aviso que anuncia una corrección que no ocurre es
    // peor que no decir nada: manda al lector a esperar en vez de a arreglarlo.
    const loQueHaraLaCapa = aprendido
      ? " La capa lo ha APUNTADO: las siguientes peticiones de este contrato llevarán sus límites de " +
        "valor escritos en el prompt, que es lo único que puede corregirlo sin tocarte el tope. Si aun " +
        "así se corta, es que la tarea no cabe en el contrato: ensancha el esquema y sube el tope con él."
      : "";
    const diagnostico =
      techoDelEsquema === null
        ? " El esquema no acota la respuesta (falta `maxLength`/`maxItems`), así que no hay forma de " +
          "saber de antemano cuánto necesita: acótalo y el tope deja de ser una apuesta."
        : tope == null
          ? ` El contrato autoriza ~${techoDelEsquema} tokens y esta petición no declara tope, así que ` +
            "quien cortó fue un tope del PROVEEDOR (la API de Anthropic exige `max_tokens` y el " +
            "adaptador manda 4096 por defecto). Declara `maxOutputTokens` y el corte deja de ser una " +
            "sorpresa."
          : techoDelEsquema > tope
            ? ` El contrato autoriza respuestas de hasta ~${techoDelEsquema} tokens con este modelo ` +
              `(lo que permiten sus \`maxLength\`/\`maxItems\`) y el tope son ${tope}: ninguna respuesta ` +
              "que use lo que el propio esquema permite cabe. Un tope calibrado con otro modelo NO se " +
              "hereda — el esquema acota CARACTERES, que son iguales en todas partes, y el tope acota " +
              "TOKENS, que son distintos en cada tokenizador."
            : ` El contrato autoriza ~${techoDelEsquema} tokens y el tope son ${tope}, así que el tope ` +
              "no es el problema: este modelo está escribiendo más de lo que su propio esquema permite " +
              `(ningún modo estructurado impone \`maxLength\`).${loQueHaraLaCapa}`;
    this.avisar(
      `salida-truncada:${contrato}:${modeloServido}`,
      `[bvsala] La respuesta se cortó al agotar \`maxOutputTokens\`${tope != null ? ` (${tope})` : ""} ` +
        `con el modelo ${modeloServido} y el contrato «${contrato}»: el proveedor devolvió ` +
        `finish_reason "length" y ${tokensDeSalida} tokens de salida, así que el JSON no valida. NO se ` +
        "reintenta: con el mismo tope volvería a cortarse y sería una llamada pagada para el mismo " +
        `fallo.${diagnostico}`,
    );
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

    // --- Etapa 0: la cascada de modelos. ---
    //
    // VA ANTES QUE TODO LO DEMÁS porque decide QUIÉN contesta, y de eso depende
    // la clave de la caché exacta (etapa 2). Ver `decidirCascada`.
    const cascada = this.decidirCascada(request, canonical, toggles, trace);
    // El precio con el que se tarifa TODA la petición es el del modelo que va a
    // contestar. Si sirve el barato y se tarifara con el fuerte, `cost.actual`
    // —la única cifra del informe que se contrasta contra la factura— saldría
    // hasta veinte veces por encima de lo que el cliente va a pagar.
    const costModel = this.costModelFor(cascada.modeloServido);

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
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          // Aquí NO ha contestado ningún modelo: lo calculó un resolver. Aunque la
          // cascada hubiera decidido enrutar, el modelo servido es el que pidió el
          // llamante — porque no se sirvió modelo ninguno, y decir "gpt-4o-mini"
          // sería atribuirle una respuesta que no escribió.
          this.informeDeCascada(cascada, { servedModel: request.model }),
        );
      }
    }

    // --- Stage 2: exact cache (avoid the call entirely). ---
    // LA CLAVE LLEVA EL MODELO QUE VA A CONTESTAR. Con la cascada enrutando, una
    // respuesta del barato se guarda bajo SU clave y solo se le sirve a quien
    // vuelva a enrutar; quien pida el fuerte no la ve nunca, ni desde este
    // proceso ni desde otro que comparta el Redis.
    const exactKey = buildExactKey(canonical, { servedModel: cascada.modeloServido });
    if (policy.allowExactCache && toggles.exactCache !== false) {
      const hit = await this.deps.exactCache.get<T>(exactKey);
      if (hit) {
        // Measured avoided-output baseline (the cached answer is the real output).
        ledger.avoidCall(baselineInput, this.tokensFor(hit.text, request));
        trace.record("exact-cache", "hit", { ageMs: this.now() - hit.storedAtMs });
        return this.finish<T>(
          request, canonical, hit, "exact", ledger, costModel, trace,
          defaultRoute(), jsonFallbackChoice(), this.now() - hit.storedAtMs,
          undefined, undefined, undefined, undefined,
          // Se repite una respuesta que escribió el modelo de la clave. Si la
          // clave era la del barato, lo honesto es decir que la sirvió el barato:
          // un acierto de caché no asciende a una respuesta de categoría.
          this.informeDeCascada(cascada),
        );
      }
      trace.record("exact-cache", "miss");
    }

    // --- Stage 3: singleflight around the expensive path. ---
    // CON EL MODELO SERVIDO, igual que la clave exacta. Es la TERCERA puerta por
    // la que una respuesta del barato llega a quien pidió el fuerte, y es la que
    // se abre primero: el seguidor no vuelve a ejecutar nada, se le entrega el
    // texto del líder tal cual. Sin esto, dos peticiones concurrentes idénticas
    // en las que solo una traía `modelCascade: "on"` se coalescían, y la que
    // tenía la cascada APAGADA recibía la respuesta del modelo barato.
    //
    // Y CON LA MARCA DE DIFERIBLE, por el mismo motivo en el otro eje. El tier no
    // parte la clave EXACTA a propósito —ahí la respuesta ya está escrita y el
    // tier sólo eligió la cola—, pero esta puerta ata al seguidor a una llamada
    // que aún no ha vuelto. Sin separar, un llamante que NO declaró la palanca se
    // coalescía con un líder que sí, y pagaba la latencia de `flex` (10 min de
    // timeout por defecto, con dos reintentos del SDK) por una decisión que no
    // era suya, sin nada en el informe que se lo dijera: `report.deferred` sólo
    // se le publica a quien declaró la palanca.
    const inflightKey = buildInflightKey(canonical, {
      servedModel: cascada.modeloServido,
      deferrable: toggles.deferrable === true,
    });
    const runExpensive = async (): Promise<SavingsResult<T>> => {
      try {
        return await this.expensivePath<T>(
          testigo, request, canonical, policy, toggles, ledger, costModel, trace,
          exactKey, baselineInput, cascada,
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
          value, baselineInput, this.tokensFor(value.text ?? "", request), costModel, request,
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
    cascada: DecisionDeCascada,
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
          hit.ageMs, hit.confidence, undefined, undefined, undefined,
          // La caché semántica NUNCA guarda una respuesta enrutada (ver la
          // escritura de la etapa 12: su identidad la fija `canonical.model`, el
          // que PIDIÓ el llamante, así que una respuesta del barato guardada ahí
          // se le serviría a quien pidió el fuerte). O sea que un acierto
          // semántico viene siempre del modelo pedido.
          this.informeDeCascada(cascada, { servedModel: request.model }),
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

    // --- MONTAJE SEGMENTADO DEL PROMPT ---------------------------------------
    //
    // El prompt que sale de aquí tiene tres tramos, y el orden entre ellos es lo
    // que decide si el proveedor puede reutilizar algo:
    //
    //   [PREFIJO ESTATICO]   herramientas, instrucciones, esquemas, política
    //   [ESTADO APPEND-ONLY] historial y resultados de herramientas
    //   [COLA DE LA CONSULTA] límites JSON · payload · evidencia · pregunta
    //
    // Los dos primeros son el PREFIJO: lo que un proveedor con caché de prefijo
    // puede servir a 0,10x. El tercero cambia en cada petición por definición y
    // se paga entero siempre.
    //
    // La frontera se calcula AQUÍ, sobre `request.messages`, y no después:
    // todos los bloques que inyecta la capa entran por delante de la última
    // pregunta del usuario (los tres pasan por `insertarAntesDeLaPregunta`), así
    // que empujan la pregunta a la derecha y dejan intactos los `q` mensajes
    // anteriores. Calcularla luego, sobre el array ya montado, contaría los
    // bloques de la capa como prefijo — y son justo lo más variable que hay.
    //
    // LA COLA DE ARRIBA ES LA MISMA QUE FIJA `insertarAntesDeLaPregunta`, y no es
    // casualidad: las dos palancas piden lo mismo —lo estable delante, lo
    // variable pegado a la pregunta—, así que el orden medido de los tres
    // bloques (límites · payload · evidencia) cae ENTERO fuera del prefijo. La
    // evidencia, que es el bloque más grande y el más variable, es la última en
    // insertarse y por tanto la más lejos de la frontera. Lo fija
    // `test/cache-de-prefijo-en-el-pipeline.test.ts`.
    const finDelPrefijo = limiteDelPrefijoEstable(request.messages);
    // La compresión reescribe mensajes que NO son `system`, o sea que puede
    // tocar el historial que acabamos de meter en el prefijo. Se anota y, si
    // ocurre, el prefijo se recorta al tramo de `system` inicial — lo único que
    // la etapa 9 tiene prohibido tocar.
    let comprimioElPrefijo = false;

    // El historial cuenta como prefijo porque es APPEND-ONLY: un turno viejo no
    // se reescribe, así que los bytes de ayer siguen siendo los bytes de hoy. Si
    // el llamante reescribe un turno anterior, el prefijo se invalida y la verja
    // de más abajo lo VE (la tasa de aciertos se hunde) y deja de marcar. No hay
    // que confiar en la promesa: se mide.

    // La evidencia recuperada se PROYECTA en el prompt más abajo, después del
    // payload serializado. El orden importa y está medido: ver
    // `insertarAntesDeLaPregunta`. Aquí solo se construye el bloque; adaptive-k
    // (etapa 7) ya podó el conjunto a los documentos que se quedan.
    //
    // Sin esta proyección, el retrieval corre y el informe dice "kept N/M" pero
    // el modelo responde sin fundamento — justo el fallo que el retrieval existe
    // para evitar.
    const bloqueEvidencia: ChatMessage | null =
      retrieval.docs.length > 0
        ? {
            role: "system",
            content:
              "Retrieved context — answer using only this evidence and cite sources by [id]:\n\n" +
              retrieval.docs
                .map((d, i) => `[${d.source ?? d.id ?? `doc${i + 1}`}]\n${d.text}`)
                .join("\n\n"),
          }
        : null;

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
      // Va DELANTE de la pregunta, y el primero de los tres bloques de la capa:
      // es el más estable de los tres (depende solo del contrato, no de esta
      // petición), así que es el que más partido saca del prefijo cacheable.
      insertarAntesDeLaPregunta(messages, {
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

    // La evidencia va la ÚLTIMA de los tres bloques de la capa —pegada a la
    // pregunta y por detrás del payload— porque es la más variable: cambia con
    // cada consulta. Lo estable delante, lo variable al final es justo lo que
    // quiere la caché de prefijo del proveedor.
    if (bloqueEvidencia) insertarAntesDeLaPregunta(messages, bloqueEvidencia);

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
      //
      // LAS TRES VERJAS ECONÓMICAS. Hasta aquí, "la palanca está encendida" era
      // toda la decisión: se comprimía cada mensaje no-system incondicionalmente.
      // `shouldCompress()` y `decidirCompresion()` estaban escritas y probadas y
      // no las llamaba NADIE, mientras el README prometía "context reduction that
      // must pay for itself". Comprimir sin esta cuenta cuesta dinero de verdad
      // en el caso medido en `economics/cache-tier.ts`: el payload naive de 1212
      // tokens entra en el tramo cacheable de 1024 y el nuestro, comprimido a
      // 780, no — quitamos el 35,6% de los tokens y capturamos el 18,5% del
      // dinero. El libro 3 seguía acreditando el 35,6%.
      //
      //   1. TAMAÑO (antes de pagar el compresor). Un contexto corto no merece la
      //      latencia ni el cómputo local, se ahorre lo que se ahorre.
      //   2. AHORRO NETO (después, con la reducción REAL).
      //   3. DINERO (después, contando el tramo de caché del proveedor).
      //
      // La 1 corta antes de gastar; las otras dos necesitan saber cuánto quitó de
      // verdad el compresor, y medirlo es más honesto que proyectarlo.
      const econ = this.config.compressionEconomics ?? {};
      const tramo = tramoDeCache(request.model, econ);
      const politica = {
        compressorCostTokens: econ.compressorCostTokens ?? 0,
        ...(econ.minimumContextTokens != null
          ? { minimumContextTokens: econ.minimumContextTokens }
          : {}),
        ...(econ.minimumNetTokens != null
          ? { minimumNetTokens: econ.minimumNetTokens }
          : {}),
      };

      // El "contexto" de la verja de tamaño es lo ÚNICO que el bucle puede
      // tocar: los mensajes no-system. Contar también los system (que en parte
      // los inyecta esta misma capa) haría pasar la verja a fuerza de texto
      // propio e intocable.
      let protegidos = 0;
      let contextoComprimible = 0;
      for (const m of messages) {
        if (m.role === "system") protegidos += 1;
        else contextoComprimible += this.tokensFor(m.content, request);
      }
      // CON TODAS LAS CANDIDATAS, aunque `toolDiscovery` pueda esconder algunas
      // más abajo (etapa 10a-bis). No es un descuido: el sondeo aún no ha
      // ocurrido y su resultado NO es determinista, así que aquí no hay forma
      // honesta de saber qué esquemas viajarán. La verja de dinero compara este
      // prompt contra el comprimido, y el error que introduce esa incertidumbre
      // es acotado y va en el sentido bueno en el caso normal: los esquemas que
      // el sondeo esconda se restan a los DOS lados, así que la reducción que se
      // acredita no cambia; lo único que puede desplazarse es de qué lado del
      // tramo de caché del proveedor cae cada cifra. Queda anotado como riesgo
      // conocido en lugar de resolverse adivinando el sondeo.
      const promptSinComprimir = this.tokensFor(
        this.assemblePromptText(messages, toolSelection.tools),
        request,
      );

      const previa = shouldCompress({
        ...politica,
        contextTokens: contextoComprimible,
        // Antes de correr el compresor NO se sabe cuánto va a quitar, y aquí no
        // se inventa: lo único afirmable es la cota superior —no puede quitar
        // más de lo que hay—, así que esta llamada solo puede cortar por TAMAÑO,
        // que es lo medible sin pagar. La regla del ahorro neto se aplica abajo
        // con lo que quitó de verdad.
        projectedEliminable: contextoComprimible,
      });

      let compressedBefore = 0;
      let compressedAfter = 0;
      let aplicada = false;
      let motivo = previa.reason;

      if (previa.compress) {
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

        // El prompt comprimido se vuelve a contar ENTERO en vez de restarle la
        // reducción al original: el tramo de caché se aplica sobre lo que recibe
        // el proveedor —system inyectados y herramientas incluidos—, y esa resta
        // supondría que ensamblar no cuesta tokens.
        const promptComprimido = this.tokensFor(
          this.assemblePromptText(rewritten, toolSelection.tools),
          request,
        );
        const neto = shouldCompress({
          ...politica,
          contextTokens: contextoComprimible,
          projectedEliminable: compressedBefore - compressedAfter,
        });
        const dinero = politicaDeCompresion({
          originalTokens: promptSinComprimir,
          compressedTokens: promptComprimido,
          tier: tramo,
          ...(econ.prefix ? { prefix: econ.prefix } : {}),
          compressorCostTokens: politica.compressorCostTokens,
        });

        if (compressedAfter >= compressedBefore) {
          motivo = "no fidelity-passed net reduction";
        } else if (!neto.compress) {
          motivo = neto.reason;
        } else if (!dinero.comprimir) {
          motivo = dinero.razon;
        } else {
          aplicada = true;
          motivo = dinero.razon;
          // ¿Se reescribió algo que estaba DENTRO del prefijo? Comparar por
          // contenido y no por «corrió la compresión»: si el compresor no cambió
          // ningún mensaje del prefijo, el prefijo sigue siendo el mismo byte a
          // byte y no hay por qué renunciar a la caché.
          //
          // VA AQUÍ, PEGADO AL `messages = rewritten`, Y NO DONDE ESTABA. Desde
          // que la compresión pasa por la caja (verjas de tamaño, ahorro neto y
          // dinero), `rewritten` puede calcularse y NO aplicarse: el compresor
          // quitó tokens pero la cuenta salió negativa. Anotar el recorte por
          // haber comprimido —en vez de por haber SUSTITUIDO el prompt— tiraría
          // el prefijo por una reescritura que el proveedor no llega a ver, y la
          // pérdida sería muda: menos aciertos de caché sin que nada falle.
          comprimioElPrefijo = rewritten
            .slice(0, finDelPrefijo)
            .some((m, i) => m.content !== messages[i]?.content);
          messages = rewritten; // the compressed prompt is what the provider receives
          ledger.compress(compressedBefore, compressedAfter);
        }
      }

      if (!aplicada) {
        // Sin aplicar no hay nada que acreditar: los contadores vuelven a cero
        // para que el informe no publique una reducción que el proveedor no vio.
        compressedBefore = 0;
        compressedAfter = 0;
      }
      trace.record("compression", aplicada ? "applied" : "skipped", {
        // El motivo es la mitad del valor de esta etapa: un cliente que pidió
        // compresión y ve `compressedInput: 0` necesita saber si es que no había
        // nada que quitar, si su contexto es corto, o si la capa se abstuvo para
        // no romperle la caché del proveedor. Las tres se arreglan distinto.
        reason: motivo,
        before: compressedBefore,
        after: compressedAfter,
        contextTokens: contextoComprimible,
        promptTokens: promptSinComprimir,
        cacheTierMinimum: tramo.minimumCacheTokens,
        protectedSystemMessages: protegidos,
        // Que la compresión haya tocado el prefijo se PUBLICA: es lo que explica
        // que la caché de prefijo se recorte en esta petición, y sin el dato las
        // dos palancas parecerían no hablarse.
        prefixRewritten: comprimioElPrefijo,
      });
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

    // --- Etapa 10a: codebook de salida (opt-in, y solo con medición) ---
    //
    // Cambia el contrato que ve el PROVEEDOR por una forma equivalente y más
    // barata de escribir, y deshace el cambio antes de que lo vea nadie más. Es
    // opt-in porque el ahorro es demostrable (ver las verjas de codebook.ts) pero
    // el efecto sobre la CALIDAD de lo que el modelo decide no lo es: esta capa ya
    // se quemó una vez dando por bueno un cambio plausible en la salida —el techo
    // de `maxOutputTokens`, medido en −2,8% neto— y no va a repetirlo por defecto
    // sobre despliegues que ya están en producción.
    //
    // Y NO SE APLICA SIN UN DELTA DE SALIDA MEDIDO PARA ESTE MODELO. Medido en
    // vivo sobre el mismo contrato: `gpt-4o` escribe 3 tokens MENOS (+8,0% neto) y
    // `gpt-4o-mini` escribe 16 MÁS (−8,2% neto). El signo es del MODELO, no del
    // esquema, así que no hay nada que deducir aquí — ver `codebook-evidencia.ts`.
    //
    // EL PRECIO Y EL DELTA VAN DEL MODELO QUE VA A CONTESTAR (`modeloServido`), no
    // del que se pidió. Con la cascada enrutando son distintos, y las dos cifras
    // son propiedades del que de verdad escribe: la tarifa relativa salida/entrada
    // y la verbosidad. Decidir con el precio del fuerte una llamada que hace el
    // barato es decidir con la aritmética de otro.
    //
    // El esquema del llamante NUNCA estuvo en el baseline (`assembleBaselinePrompt`
    // solo ensambla mensajes, herramientas y datos estructurados), así que un
    // esquema más pequeño no acredita ni descuenta nada en ningún libro. Lo único
    // que se mueve es `actualInput`, que sí lo mide el proveedor, y eso baja el
    // `k` de la calibración: la reconstrucción del baseline sale MÁS pequeña, o
    // sea que la palanca se reclama a la baja. Ese es el lado correcto.
    const codebook =
      schema && toggles.outputCodebook === true
        ? planOutputCodebook(schema, (t) => this.tokensFor(t, request), costModel, {
            evidencia: this.memoriaDelCodebook.resolver(
              cascada.modeloServido,
              contractKey(request),
              toggles.outputCodebookMeasuredOutputDeltaTokens,
            ),
          })
        : null;
    if (codebook) {
      trace.record("output-codebook", codebook.applied ? "applied" : "skipped", {
        reason: codebook.reason,
        ...(codebook.applied
          ? {
              renamedKeys: codebook.plan.renamedKeys,
              codedEnumValues: codebook.plan.codedEnumValues,
              schemaTokensOriginal: codebook.plan.schemaTokensOriginal,
              schemaTokensCompact: codebook.plan.schemaTokensCompact,
              // El ahorro de FORMA ya no decide y por eso cambia de nombre: se
              // llamaba `modelledOutputSavingTokens` y sí decidía, que es el
              // error que costó la jornada. Quien lea la traza tiene que ver que
              // esto es un modelo sobre un testigo, y que lo que decidió fue
              // `measuredOutputDeltaTokens` con su procedencia al lado.
              modelledShapeSavingTokens: codebook.plan.modelledShapeSavingTokens,
              measuredOutputDeltaTokens: codebook.plan.measuredOutputDeltaTokens,
              outputDeltaProvenance: codebook.plan.outputDeltaProvenance,
              breakEvenOutputDeltaTokens: codebook.plan.breakEvenOutputDeltaTokens,
              netSavingUsd: codebook.plan.netSavingUsd,
              pricedForModel: cascada.modeloServido,
            }
          : {}),
      });
    }
    // Lo que de verdad viaja en `response_format`. El backend de restricciones se
    // resuelve sobre ESTE esquema y no sobre el original: lo que decide si un
    // backend puede imponer el contrato es el contrato que va a recibir.
    const esquemaAlProveedor = codebook?.applied ? codebook.plan.compactSchema : schema;

    // Se resuelve para el modelo que VA A CONTESTAR, no para el que se pidió.
    // Qué backend puede imponer el contrato es una propiedad del modelo concreto
    // —`gpt-4` no acepta `response_format` y `gpt-4o` sí—, así que con la cascada
    // enrutando, preguntarle al modelo pedido daría una garantía que el que
    // contesta no puede dar.
    let backendPlan: ConstraintPlan = esquemaAlProveedor
      ? resolveConstraintBackend(
          cascada.modeloServido,
          esquemaAlProveedor,
          this.deps.constraintBackends,
        )
      : { backend: "none", reason: "no output contract" };
    trace.record("constraints", backendPlan.backend, { reason: backendPlan.reason });

    // --- La verja que impide que marcar la caché de prefijo pierda dinero. ---
    //
    // SIGUE AQUÍ, POR DELANTE DEL SONDEO, y no es inercia: contar los tokens del
    // prefijo es trabajo de la capa, y con `providerStart` ya arrancado se
    // publicaría como latencia del proveedor. Que la decisión no necesite
    // esperar al sondeo es justamente lo que permite dejarla donde estaba: la
    // palanca `toolDiscovery` basta para decidir, sin su resultado.
    // Con el MODELO SERVIDO, y esta es la composición con #71 que hay que tener
    // presente antes de encender la cascada: LAS CACHÉS DE PREFIJO SON POR
    // MODELO. Enrutar parte el tráfico de un prefijo en dos poblaciones —la del
    // fuerte y la del barato— y cada una tiene que pagar su propia exploración
    // para descubrir su tasa de aciertos. Si la huella llevara el modelo pedido,
    // las dos poblaciones se mezclarían en una sola medición y la verja decidiría
    // sobre un promedio de dos cachés distintas, que no es la tasa de ninguna.
    const marcado = this.decidirMarcadoDeCache(
      request,
      cascada.modeloServido,
      messages,
      toolSelection,
      toggles.toolDiscovery === true,
      comprimioElPrefijo ? limiteDelPrefijoEstable(messages, true) : finDelPrefijo,
      trace,
    );

    // El cronómetro del proveedor arranca ANTES del sondeo: si el patrón parte la
    // petición en dos llamadas, las dos son tiempo de proveedor y las dos las
    // espera el cliente. Dejarlas fuera vendería como "preprocesamiento" la mitad
    // de una latencia que se duplicó.
    const providerStart = this.now();

    // --- Etapa 10a-bis: schema-on-demand (opt-in, y cambia el contrato de latencia). ---
    //
    // VA AQUÍ, entre 10a (planificar el codebook) y la llamada, y no antes, por
    // dos razones que se leen mal desde el número de etapa:
    //
    //  · El sondeo manda los mensajes YA comprimidos y con los tres bloques que
    //    inyecta la capa en su sitio (etapas 8 y 9). Adelantarlo pagaría el prompt
    //    largo en la llamada que precisamente viene a ser barata.
    //  · El codebook (10a) toca el CONTRATO DE SALIDA y esto toca las
    //    HERRAMIENTAS DE ENTRADA: son ortogonales, y por eso la segunda llamada
    //    lleva las dos cosas a la vez (`esquemaAlProveedor` + las elegidas). El
    //    sondeo, en cambio, no lleva ninguna de las dos — ver `descubrirHerramientas`.
    //
    // `actualTools` se REESCRIBE aquí. La etapa 6 lo dejó en las candidatas que
    // sobrevivieron al selector; lo que se publica tiene que ser lo que salió, y
    // con el patrón aplicado salieron menos. Las descartadas por el SELECTOR ya
    // están acreditadas en el libro 2 (etapa 6) y las escondidas por el SONDEO no
    // lo están ni pueden estarlo: no salieron gratis, las pagó una llamada extra.
    // Los dos conjuntos son disjuntos —el sondeo solo mira lo que el selector
    // dejó pasar—, así que ningún token se cuenta dos veces.
    const descubrimiento = await this.descubrirHerramientas(
      testigo, request, toggles, toolSelection.tools, messages, ledger, costModel, trace,
    );
    const herramientasAEnviar = descubrimiento.tools;
    ledger.actualTools = herramientasAEnviar.length;

    // Los argumentos de la llamada, en una constante, porque una ESCALADA de la
    // cascada tiene que repetirlos idénticos cambiando solo el modelo. Si los dos
    // brazos difirieran en algo más, la P(escalar) que se mide sería la de otra
    // petición y no serviría para decidir sobre ésta.
    const peticionAlProveedor = {
      messages,
      // Lo que viaja es lo que SALIÓ del descubrimiento, no las candidatas. Los
      // dos coinciden siempre que `marcado.marcar` es cierto —la verja no marca
      // con `toolDiscovery` puesto—, así que el bloque `tools` que se cachea es
      // el mismo que la huella describe. Si un día se marcara con la palanca
      // puesta, aquí es donde la contradicción se volvería factura.
      ...(herramientasAEnviar.length ? { tools: herramientasAEnviar } : {}),
      // El esquema que viaja es el que eligió la etapa 10a (compacto si el
      // codebook se aplicó, el del llamante si no). La caché de prefijo no opina
      // sobre CUÁL es: el esquema no está en `messages`, así que no entra en el
      // prefijo que se marca ni mueve su frontera.
      ...(esquemaAlProveedor ? { schema: esquemaAlProveedor } : {}),
      ...(request.response?.maxOutputTokens != null
        ? { maxOutputTokens: request.response.maxOutputTokens }
        : {}),
      ...(request.temperature != null ? { temperature: request.temperature } : {}),
      ...(request.seed != null ? { seed: request.seed } : {}),
      // LO DECLARA EL CLIENTE Y VIAJA TAL CUAL. Que una peticion sea diferible es
      // una propiedad del negocio, no del texto, asi que no hay heuristica que
      // pueda deducirlo: el mismo prompt es diferible en un backfill nocturno y no
      // lo es detras del cursor de un usuario.
      //
      // Va dentro de `peticionAlProveedor`, que es lo que una ESCALADA de la
      // cascada repite identico, y eso es deliberado: enrutar y diferir son
      // ortogonales -- una elige el modelo, la otra la cola en la que se sirve --,
      // y si la escalada saliera sin la marca, la segunda llamada de una peticion
      // que el cliente declaro diferible se pagaria a precio entero sin que nadie
      // se lo hubiera pedido.
      ...(toggles.deferrable ? { deferrable: true } : {}),
      constraintBackend: backendPlan.backend,
    };

    let response = await this.llamarProveedor({
      model: cascada.modeloServido,
      ...peticionAlProveedor,
      ...(marcado.marcar
        ? {
            stablePrefixMessages: marcado.mensajesDePrefijo,
            promptCacheKey: marcado.huella,
          }
        : {}),
    }, testigo);
    // Acumulativo, no asignado: con schema-on-demand esta ya es la SEGUNDA llamada
    // de la petición y el sondeo anterior también costó dinero. Asignar borraba su
    // rastro del informe, que es como el fail-open llegó a publicar `actualLlm: 1`
    // sobre tres llamadas facturadas.
    ledger.actualLlm += 1;

    // --- Etapa 10b: deshacer el codebook ---
    //
    // A partir de aquí NADIE vuelve a mirar `response.text`: se sirve, se valida,
    // se repara y se cachea `textoServido`, que está en la forma DEL LLAMANTE. Si
    // la forma compacta se colara en la caché, una petición futura con la palanca
    // apagada recibiría claves que su contrato no declara, y el ahorro de hoy
    // sería una avería mañana.
    //
    // POR QUÉ ESTO NO ACREDITA NINGÚN LIBRO, y es deliberado:
    //  · Libro 1 (llamadas evitadas): no se evitó ninguna llamada.
    //  · Libro 2 (tokens eliminados): no se ha quitado información, está entera.
    //  · Libro 3 (tokens comprimidos): es el libro de la ENTRADA. Apuntar aquí un
    //    ahorro de SALIDA mezclaría dos cosas que el informe promete separadas.
    //  · Libro 4: esto no es caché de prefijo del proveedor.
    // Y el baseline de salida de una llamada EJECUTADA es, por doctrina de esta
    // capa, su salida medida: no se sabe —sin un A/B— cuántos tokens habría
    // gastado el modelo escribiendo la forma larga. La diferencia local entre las
    // dos formas de ESTA respuesta sí se puede contar, y se anota en la traza,
    // pero se anota como lo que es: una cuenta local, no facturable, sin libro.
    //
    // ES UNA FUNCIÓN Y NO UN BLOQUE porque la cascada puede tener DOS respuestas
    // que expandir (la del barato, para juzgarla, y la del fuerte si se escala), y
    // el verificador tiene que juzgar la forma DEL LLAMANTE — juzgar la compacta
    // contra el esquema original rechazaría todas y escalaría siempre.
    const expandirDelCodebook = (texto: string): string => {
      if (!codebook?.applied) return texto;
      const compacta = tryParse(texto);
      return compacta.ok ? JSON.stringify(codebook.plan.expand(compacta.value)) : texto;
    };

    let textoServido = expandirDelCodebook(response.text);
    // El uso de la llamada QUE SE MARCÓ, capturado antes de que una escalada
    // pueda reemplazar `response`. La medición de la caché de prefijo solo vale
    // de la petición que llevaba la marca; leer el uso de la escalada —que sale
    // sin marcar, y encima contra la caché de OTRO modelo— apuntaría un fallo de
    // acierto que nunca tuvo ocasión de producirse y apagaría la verja por una
    // medición que no es sobre ella.
    const usoDeLaLlamadaMarcada = response.usage;

    // --- Etapa 10c: la cascada de modelos verifica y, si hace falta, escala. ---
    let escalo = false;
    if (cascada.enruta) {
      const veredicto = verificarRespuesta({
        texto: textoServido,
        schema,
        finishReason: response.finishReason,
        pidioHerramientas: (response.toolCalls?.length ?? 0) > 0,
      });
      // Se apunta SIEMPRE, acepte o rechace: la tasa de escalado de este workload
      // es la razón de ser de la verja, y solo se puede medir sobre peticiones que
      // de verdad se enrutaron.
      this.verjaDeCascada.registrar(cascada.bucket, !veredicto.acepta);
      trace.record("model-cascade", veredicto.acepta ? "accepted" : "escalating", {
        servedModel: cascada.modeloServido,
        reason: veredicto.motivo,
        checks: veredicto.comprobaciones,
      });
      if (!veredicto.acepta) {
        escalo = true;
        // El intento con el barato ya está pagado y no produjo la respuesta: su
        // dinero va a `actual` con SU precio, y ni sus tokens ni su coste tocan el
        // baseline. Es la misma regla que la reparación y el sondeo.
        ledger.cascadeAttempt(response.usage, cascada.precioBarato ?? costModel);
        ledger.actualLlm += 1;
        // Sin `promptCacheKey`: el prefijo que se midió es el del modelo barato, y
        // marcar aquí pagaría la prima de escritura de una caché (la del fuerte)
        // sobre la que esta petición no tiene ninguna medición.
        response = await this.llamarProveedor(
          { model: request.model, ...peticionAlProveedor },
          testigo,
        );
        textoServido = expandirDelCodebook(response.text);
      }
    }
    const modeloServido = escalo ? request.model : cascada.modeloServido;
    // EL PRECIO SIGUE AL MODELO QUE ACABÓ CONTESTANDO. `costModel` se resolvió
    // antes de la etapa 2 con el modelo que la cascada iba a usar; si se ha
    // escalado, quien contesta es otro y sus tokens los factura a SU tarifa.
    // Sin esto, una petición escalada publicaba `cost.actual` con el precio del
    // barato sobre tokens del fuerte: casi diecisiete veces por debajo de lo que
    // el cliente iba a pagar, y sobre la única cifra del informe que se contrasta
    // contra la factura.
    const precioServido = escalo ? this.costModelFor(request.model) : costModel;

    // La contabilidad de tokens habla de la llamada que produjo LO SERVIDO. La
    // del intento descartado vive en `ledger.cascadeInput/Output`, y se publica
    // aparte —en `report.modelCascade`— porque la facturó otro modelo a otro
    // precio y sumarla aquí la tarifaría al precio equivocado.
    ledger.actualInput += response.usage.inputTokens;
    ledger.actualOutput += response.usage.outputTokens;

    if (codebook?.applied) {
      trace.record(
        "output-codebook",
        tryParse(response.text).ok ? "expanded" : "not-expanded (response was not JSON)",
        tryParse(response.text).ok
          ? {
              localOutputTokensCompact: this.tokensFor(response.text, request),
              localOutputTokensExpanded: this.tokensFor(textoServido, request),
              creditedLedger: "none",
              note: "local count of the served answer in both shapes; not credited to any ledger",
            }
          : {},
      );
    }

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
      this.assemblePromptText(messages, herramientasAEnviar),
      request,
    );
    ledger.removedInputLocal = Math.max(0, baselineInput - ledger.sentInputLocal);
    // El prompt del sondeo entra en la lectura local DESPUÉS de calcular lo
    // quitado, exactamente como el de la reparación: `removedInputLocal` compara
    // el baseline contra la llamada del CLIENTE, y meter ahí una llamada que puso
    // la capa se comería el ahorro que sí es suyo. Pero sí tiene que sumar a
    // `sentInputLocal`, porque `actualInput` ya cuenta las dos llamadas y si la
    // lectura local cubriera solo una, k saldría ~2x y acreditaría el doble.
    ledger.sentInputLocal += descubrimiento.tokensLocalesDelSondeo;
    ledger.estimatorExact = this.estimatorEsExacto(request);

    if (response.usage.cachedInputTokens) {
      ledger.providerCached(response.usage.cachedInputTokens);
    }

    // LO QUE CONTESTÓ EL PROVEEDOR ES LA ÚNICA MEDICIÓN DE h QUE EXISTE, y sólo
    // vale de las peticiones que de verdad se marcaron: apuntar una sin marcar
    // como «no acertó» hundiría la tasa con peticiones que nunca tuvieron
    // ocasión de acertar, y la verja se apagaría por una medición que no es
    // sobre ella.
    if (marcado.marcar) {
      // LA VERJA Y LA TRAZA LEEN DE LA MISMA VARIABLE, no de dos expresiones
      // equivalentes. Con dos, una mutación de la que alimenta a la VERJA —la que
      // decide el dinero— deja la traza intacta, y un test que mire la traza sigue
      // en verde mientras la verja mide otra cosa. Medido al provocarlo: en una
      // petición escalada la traza publicaba 1800 tokens de acierto y la verja
      // apuntaba 0, o sea que se habría apagado sola por una lectura ajena.
      this.verjaDeCache.registrar(marcado.huella, usoDeLaLlamadaMarcada);
      trace.record("prefix-cache", "measured", {
        cacheRead: usoDeLaLlamadaMarcada.cachedInputTokens ?? 0,
        // La prima de escritura se publica en la traza JUNTO al descuento, no
        // escondida: es lo que costó obtenerlo, y sin ella el número de al lado
        // parece un ahorro neto que no es.
        cacheWritePremiumTokens: usoDeLaLlamadaMarcada.cacheWriteInputTokens ?? 0,
      });
    }

    // --- Etapa 10d: la MUESTRA del modo sombra (opt-in, y cuesta dinero). ---
    //
    // El modo sombra es gratis porque no llama al modelo barato: publica la
    // elegibilidad, la aritmética del par y lo que habría valido el cambio. Lo
    // que NO puede saber gratis es la única cifra que decide, P(escalar) — y esa
    // no existe hasta que el modelo barato escribe una respuesta que juzgar. No
    // hay atajo: es una propiedad de un texto que nadie ha generado.
    //
    // Así que se compra, y el precio se publica: una llamada barata de más, o sea
    // `r` sobre lo que la petición ya costaba (~6% con gpt-4o → gpt-4o-mini). Con
    // `shadowSampleRate: 0.05` eso es ~0,3% de la factura. Va DESPUÉS de la
    // respuesta buena y envuelta en su propio try/catch: medir no puede romper ni
    // retrasar lo que el cliente vino a buscar. Sí duplica la latencia de la
    // petición muestreada, y por eso está apagado por defecto.
    let muestra: { coste: number; divergio: boolean | null } | null = null;
    if (
      cascada.modo === "shadow" &&
      cascada.elegible &&
      cascada.candidato &&
      cascada.precioBarato &&
      enLaMuestra(exactKey, cascada.tasaDeMuestreo)
    ) {
      try {
        const respuestaBarata = await this.llamarProveedor(
          { model: cascada.candidato, ...peticionAlProveedor },
          testigo,
        );
        ledger.actualLlm += 1;
        const antes = ledger.extraCostUsd;
        ledger.cascadeAttempt(respuestaBarata.usage, cascada.precioBarato);
        const textoBarato = expandirDelCodebook(respuestaBarata.text);
        const veredicto = verificarRespuesta({
          texto: textoBarato,
          schema,
          finishReason: respuestaBarata.finishReason,
          pidioHerramientas: (respuestaBarata.toolCalls?.length ?? 0) > 0,
        });
        this.verjaDeCascada.registrar(cascada.bucket, !veredicto.acepta);
        // La divergencia solo tiene sentido cuando las DOS respuestas pasan el
        // contrato: si la barata ya lo incumple, el desacuerdo no dice nada nuevo.
        const divergencia = veredicto.acepta ? hechosDivergentes(textoBarato, textoServido) : null;
        muestra = {
          coste: ledger.extraCostUsd - antes,
          divergio: divergencia ? divergencia.divergen : null,
        };
        trace.record("model-cascade", veredicto.acepta ? "sample accepted" : "sample escalated", {
          candidateModel: cascada.candidato,
          reason: veredicto.motivo,
          sampleCost: muestra.coste,
          ...(divergencia ? { diverged: divergencia.divergen, divergence: divergencia.motivo } : {}),
          note:
            "measurement only: this answer was NEVER served. The escalation rate it feeds is a " +
            "money figure, not a quality one",
        });
      } catch (err) {
        // Ni un token que apuntar y, sobre todo, ni una excepción que propagar:
        // la respuesta del cliente ya está en la mano.
        trace.record("model-cascade", "sample failed (measurement only; the answer is unaffected)", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // --- Stage 11: structural validation (+ at most one repair). ---
    let data: unknown = textoServido;
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
      const parsed = tryParse(textoServido);
      let validation = parsed.ok
        ? validateAgainstSchema(parsed.value, schema)
        : { valid: false, errors: [{ path: "$", message: "not valid JSON" }] };

      // EL RESCATE SOLO CUENTA SI ADEMÁS CUMPLE EL CONTRATO.
      //
      // Sacar el objeto de la valla no basta para servirlo: si lo rescatado no
      // valida, `textoServido` tiene que seguir siendo la respuesta ORIGINAL,
      // porque es la que se le enseña al modelo en el mensaje de reparación.
      // Enseñarle un recorte nuestro le ocultaría justo la parte que explica el
      // fallo (la prosa que envolvía el JSON) y le pediría corregir un texto que
      // él no escribió.
      //
      // Cuando sí valida, se sirve la forma limpia: el llamante pidió un
      // contrato, así que devolverle la valla markdown le obligaría a repetir
      // este mismo rescate por su cuenta — y es lo que se cachea, de modo que la
      // prosa se quedaría pegada a la respuesta durante toda la vida de la
      // entrada.
      if (parsed.ok && parsed.rescatado != null && validation.valid) {
        textoServido = parsed.rescatado;
        trace.record("validation", "rescued-locally", {
          reason:
            "the model wrapped valid JSON in prose or a markdown fence; it was extracted locally " +
            "instead of paying a repair call",
        });
      }

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
        const techoDelEsquema = tokensDeLaMayorRespuesta(schema, (t) => this.tokensFor(t, request));
        // UN TRUNCADO TAMBIÉN ES UN INCUMPLIMIENTO DE VALOR, Y ERA EL ÚNICO QUE LA
        // MEMORIA NO PODÍA VER.
        //
        // `esFalloDeValor` decide sobre los errores del validador, y una respuesta
        // cortada no llega a producir ninguno de los suyos: el JSON se parte a
        // media cadena (`not valid JSON`) o —contra Anthropic, donde el contrato
        // viaja como herramienta forzada— llega como `{}` porque la API no puede
        // entregar un `input` a medio parsear, y entonces el error es `missing
        // required property`. Los dos son fallos de FORMA, así que el contrato NO
        // entraba en `contratosQueIncumplen` y la pista de restricciones no se
        // enviaba NUNCA. Es el mismo bloqueo que el PR #79 cerró un nivel más
        // abajo: el fallo de forma tapaba el aprendizaje.
        //
        // El resultado es el día de la marmota, y está medido: escenario
        // «Forwarded support thread» contra `claude-sonnet-4-5`, tirada del
        // 2026-08-16, 8 pares con la memoria COMPARTIDA entre repeticiones y 8
        // truncados idénticos a 500 tokens de salida (el tope) — calidad 0/8 y un
        // ahorro del 32,4% publicado sobre respuestas rotas. Reproducido contra un
        // servidor local que habla el dialecto de Anthropic: 0/3 con la memoria
        // compartida, o sea que la primera repetición no enseñaba nada a la
        // segunda.
        //
        // SOLO CUANDO EL ESQUEMA CABE EN EL TOPE, y la distinción es la misma que
        // ya hace el aviso de arriba:
        //
        //   · el esquema NO cabe (el caso del #79) → el contrato se contradice a sí
        //     mismo y ninguna respuesta conforme entra. Anunciarle sus límites al
        //     modelo no arregla nada, así que apuntarlo sería cobrar la pista en
        //     cada petición para siempre a cambio de nada;
        //   · el esquema SÍ cabe → el modelo está escribiendo por encima de lo que
        //     su propio contrato autoriza, y la pista es exactamente el remedio:
        //     ningún modo estructurado impone `maxLength`, así que decírselo es lo
        //     ÚNICO que puede hacer la capa sin subirle el tope a quien lo fijó.
        //
        // Se exige `maxOutputTokens` declarado: sin él, el corte lo puso un tope
        // del proveedor que no conocemos (la API de Anthropic exige `max_tokens` y
        // el adaptador manda 4096), y "cabe" no sería una afirmación demostrable.
        const tope = request.response?.maxOutputTokens ?? null;
        const desbordaSuContrato =
          techoDelEsquema !== null && tope != null && techoDelEsquema <= tope;
        if (desbordaSuContrato) this.contratosQueIncumplen.add(contractKey(request));
        trace.record("validation", "repair-skipped", {
          reason: "output truncated by maxOutputTokens; a retry with the same cap would truncate again",
          maxOutputTokens: request.response?.maxOutputTokens ?? null,
          outputTokens: response.usage.outputTokens,
          model: modeloServido,
          ...(techoDelEsquema !== null ? { schemaAllowsTokens: techoDelEsquema } : {}),
          // Que se vea en la traza si la capa APRENDIÓ algo de este truncado: es la
          // diferencia entre "la siguiente petición lleva la pista" y "esto se va a
          // repetir igual", y sin decirlo no hay forma de distinguirlas desde fuera.
          learnedValueLimits: desbordaSuContrato,
        });
        this.avisarDeTruncado(
          request,
          modeloServido,
          response.usage.outputTokens,
          techoDelEsquema,
          desbordaSuContrato,
        );
      } else if (!validation.valid && backendPlan.backend === "none") {
        // Single deterministic repair attempt only when we had no constraint
        // backend to prevent the invalid output in the first place.
        //
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
              `Previous reply:\n${textoServido}\n\n` +
              `Problems found:\n${detalle}\n\n` +
              "Return ONLY the corrected JSON object. Keep the same content; fix only what is listed.",
          },
        ];
        // ═══════════════════════════════════════════════════════════════════════
        // VERJA DE DINERO: NO SE REPARA SI REPARAR SALE MÁS CARO QUE NO HABER
        // USADO LA CAPA.
        // ═══════════════════════════════════════════════════════════════════════
        //
        // Las dos guardias de arriba (truncado por tope, esquema roto) ya niegan
        // el reintento cuando se sabe que va a FALLAR. Esta niega el caso distinto
        // y peor: el reintento que va a FUNCIONAR, y que aun así deja al cliente
        // pagando más de lo que habría pagado sin nosotros. Medido contra el
        // proveedor real, escenario "Tool-heavy request": 0,004635 $ sin capa
        // contra 0,007401 $ con ella, el mismo par repetido en 14 de 18
        // repeticiones. La capa cobraba un 60% de sobrecoste mientras publicaba
        // que ahorraba.
        //
        // LA COMPARACIÓN NO SE REIMPLEMENTA AQUÍ, y eso es deliberado. El baseline
        // de una llamada ejecutada se reconstruye descontando `repairInput` y
        // `repairOutput` (mira `estimateCost`), o sea que NO se mueve cuando se
        // repara: solo se mueve `actual`. Así que basta con preguntarle al libro
        // por las dos cifras de AHORA —cuando los contadores de reparación siguen
        // a cero, luego son exactamente las de "no reparar"— y sumarle a `actual`
        // lo que costaría el reintento. Una sola regla de tarificación, en su
        // sitio.
        //
        // LAS DOS ESTIMACIONES, Y HACIA DÓNDE SESGA CADA UNA:
        //
        //   entrada: se cuenta el prompt de reparación en local y se escala por
        //     k = actualInput/sentInputLocal, la misma calibración que usa el
        //     libro. SUBESTIMA, porque el peaje de protocolo de esta API (el
        //     prompt de uso de herramientas) es ADITIVO y no multiplicativo: en el
        //     escenario medido la reparación real fueron 751 tokens de los que 674
        //     eran peaje. O sea que la verja tarda MÁS en dispararse de lo que
        //     debería, que es el lado prudente — solo se niega la reparación
        //     cuando sobra margen.
        //
        //   salida: la de la primera llamada. SOBREESTIMA, porque el reintento
        //     devuelve solo el JSON corregido y la primera respuesta traía además
        //     la prosa que envolvía. Es una cota superior honesta, no un factor
        //     de ajuste.
        //
        // Los dos sesgos apuntan en sentidos contrarios y ninguno decide nada en
        // el caso que motiva esto: ahí el margen es del 60%, no del 2%.
        const reparacionEnLocal = this.tokensFor(
          this.assemblePromptText(mensajesReparacion),
          request,
        );
        const k =
          ledger.sentInputLocal > 0 ? ledger.actualInput / ledger.sentInputLocal : 1;
        const entradaEstimada = Math.round(k * reparacionEnLocal);
        const salidaEstimada = Math.min(
          response.usage.outputTokens,
          request.response?.maxOutputTokens ?? Number.POSITIVE_INFINITY,
        );
        // Sin tarifa cacheada: el prompt de reparación es corto y nuevo, no
        // comparte prefijo con nada, así que no hay acierto de caché que aplicar.
        const precioDeReparar =
          (entradaEstimada / 1000) * precioServido.inputPer1k +
          (salidaEstimada / 1000) * precioServido.outputPer1k;
        // OPT-IN, Y NO POR PRUDENCIA SINO POR ARITMÉTICA. El baseline excluye la
        // reparación por construcción, así que NUNCA se mueve cuando se repara:
        // solo se mueve `actual`. Eso hace el umbral inalcanzable en cuanto los
        // demás libros salen planos — sin compresión ni caché ni eliminación,
        // `baseline === actual` exactamente y la verja niega TODA reparación, por
        // barata que sea. No es acotar la cola, es dejar de reparar salvo que la
        // capa ya haya ahorrado más de lo que la reparación va a costar. Eso es
        // una política de calidad, y la decide quien llama. La explicación entera,
        // con el argumento en contra, en `skipRepairAboveBaseline` (config.ts).
        const sinReparar = this.config.skipRepairAboveBaseline
          ? ledger.estimateCost(precioServido)
          : undefined;
        // Un baseline de 0 es el caso "unmeasured" (el proveedor no reportó uso):
        // ahí no hay contra qué comparar, y negar la reparación por una cifra que
        // no existe sería peor que pagarla. Se repara.
        const saldriaCaro =
          sinReparar != null &&
          sinReparar.baselineEstimate > 0 &&
          sinReparar.actual + precioDeReparar > sinReparar.baselineEstimate;

        if (saldriaCaro && sinReparar != null) {
          trace.record("validation", "repair-skipped", {
            reason:
              "repairing would cost more than not using the layer at all; the invalid answer is " +
              "served as-is and reported as invalid",
            errors: validation.errors,
            baselineUsd: sinReparar.baselineEstimate,
            actualUsd: sinReparar.actual,
            repairEstimateUsd: precioDeReparar,
          });
          // EN VOZ ALTA, SIEMPRE. Servir una respuesta que no cumple el contrato
          // es una decisión que el llamante tiene que poder ver: es su contrato,
          // y la alternativa que le ahorramos era dinero suyo. Callarlo dejaría
          // una respuesta inválida indistinguible de una válida salvo mirando
          // `structurallyValid`.
          this.avisar(
            "reparacion-mas-cara-que-el-baseline",
            "[bvsala] The answer did not satisfy the output contract, and repairing it would have " +
              "cost MORE than sending this request without the layer at all " +
              `(baseline ~$${sinReparar.baselineEstimate}, already spent ~$${sinReparar.actual}, ` +
              `repair ~$${precioDeReparar.toFixed(6)}). The repair was skipped and the invalid ` +
              "answer is returned with `constraints.structurallyValid: false` — check it before " +
              "using it. This combination is usually a request carrying both tools and an output " +
              "contract; see the adapter warning for the cheaper shapes.",
          );
        } else {
          ledger.retries = 1;
          trace.record("validation", "repair-attempt", { errors: validation.errors });
          // Con el esquema ORIGINAL, nunca con el compacto. La respuesta previa
          // que se le enseña y los errores que se le enumeran están en la forma
          // del llamante, así que pedirle la corrección en otra forma sería darle
          // dos contratos distintos en el mismo mensaje. Reparar ya es un coste
          // que esta capa detesta: no se le añade una traducción de más.
          response = await this.llamarProveedor({
            // Al MODELO SERVIDO, no al pedido: con la cascada enrutando, todo el
            // informe está tarifado con el precio del que contesta, y reparar en
            // otro metería en `actual` tokens a un precio que no es el que se usó
            // para tarifarlos. (Con la cascada aceptando no se llega aquí —el
            // verificador ya validó el contrato— y con ella escalada
            // `modeloServido` ES el pedido, así que esto solo fija la regla.)
            model: modeloServido,
            messages: mensajesReparacion,
            schema,
            ...(request.response?.maxOutputTokens != null
              ? { maxOutputTokens: request.response.maxOutputTokens }
              : {}),
          }, testigo);
          ledger.actualLlm += 1;
          ledger.actualInput += response.usage.inputTokens;
          ledger.actualOutput += response.usage.outputTokens;
          // La reparación es coste NUESTRO, así que su salida se marca aparte
          // para que NO engorde el baseline. Antes solo se sumaba a actualOutput,
          // y como el baseline de una llamada ejecutada se deriva de
          // actualOutput, el reintento se pagaba a sí mismo: la pérdida se
          // reportaba mucho menor de lo que fue. La entrada del reintento también
          // entra en sentInputLocal para que la calibración no se descuadre
          // (actualInput ya acumula las dos llamadas; si la lectura local cubriera
          // solo la primera, k saldría ~2x).
          ledger.repairOutput += response.usage.outputTokens;
          // Y la ENTRADA del reintento, que faltaba. Sin esto el baseline se
          // reconstruía desde un `actualInput` que ya incluía las dos llamadas,
          // así que el reintento se pagaba a sí mismo: una petición que costó el
          // doble que el camino naive se publicaba con ahorro POSITIVO.
          ledger.repairInput += response.usage.inputTokens;
          // SIN las herramientas: la llamada de reparación no las envía (mírala
          // arriba, no lleva `tools`). Contarlas aquí metía en la lectura local
          // tokens que el proveedor nunca facturó, y descuadraba la calibración
          // en el sentido de acreditar de más.
          //
          // Es el MISMO recuento que la verja acaba de hacer para decidir, así que
          // se reutiliza en vez de contarlo dos veces: el tokenizador no es gratis
          // y este es el camino caliente.
          ledger.sentInputLocal += reparacionEnLocal;
          // La reparación ya viene en la forma del llamante (se pidió con el
          // esquema original), así que pasa a ser lo servido tal cual.
          textoServido = response.text;
          const reparsed = tryParse(textoServido);
          validation = reparsed.ok
            ? validateAgainstSchema(reparsed.value, schema)
            : { valid: false, errors: [{ path: "$", message: "not valid JSON" }] };
          if (reparsed.ok) {
            data = reparsed.value;
            // Si la reparación TAMBIÉN vino envuelta en prosa, se sirve el recorte
            // limpio por la misma razón que arriba: el llamante pidió un contrato.
            if (reparsed.rescatado != null && validation.valid) {
              textoServido = reparsed.rescatado;
            }
          }
        }
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
      text: textoServido,
      data: data as T,
      rendered,
      storedAtMs: this.now(),
    };
    // EL TIER SERVIDO, LEIDO ANTES DE ARCHIVAR NADA.
    //
    // Y NO ENTRA EN LA CLAVE DE CACHE, que es la pregunta que habia que
    // contestar. Una respuesta servida por `flex` es la MISMA respuesta: mismo
    // modelo, mismo prompt, mismo `temperature` y mismo `seed`. El tier elige la
    // cola en la que se atiende, no como se genera, asi que meterlo en la clave
    // partiria la cache por un accidente de programacion del proveedor.
    //
    // El coste de esa particion no es teorico y va justo contra el trafico que
    // esta palanca sirve: enriquecimiento y backfill repiten peticiones, o sea
    // que viven del libro 1 (llamadas evitadas), que vale el 100% de una llamada
    // -- el doble que el 50% del tier. Y hay algo peor: el tier servido no se
    // conoce hasta DESPUES de llamar, asi que la clave tendria que construirse
    // con el PEDIDO, y entonces dos peticiones identicas que pidieron tiers
    // distintos no se encontrarian nunca aunque las dos acabaran servidas igual.
    const diferido = this.informeDeDiferido(toggles, response, precioServido);
    if (diferido) {
      trace.record("deferred-tier", diferido.credited ? "credited" : "not-credited", {
        ...(diferido.requestedTier ? { requestedTier: diferido.requestedTier } : {}),
        ...(diferido.servedTier ? { servedTier: diferido.servedTier } : {}),
        creditedLedger: "none",
        reason: diferido.reason,
      });
    }

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
      // Y TAMPOCO se cachea una respuesta que salió con MENOS herramientas de
      // las que declaró el llamante. Reproducido: el sondeo elige `tool_3`, la
      // invocación solo ve `tool_3`, el modelo contesta «no tengo una herramienta
      // para eso» —texto válido, contrato cumplido, ninguna tool call— y eso se
      // guarda 24 h. La siguiente petición idéntica, INCLUSO SIN la palanca
      // puesta (la clave exacta lleva el `toolsetHash` del llamante, no el de lo
      // que se envió), la sirve de caché con `avoidedLlm: 1` y `netSavings: 1`.
      //
      // O sea: una capacidad que la capa escondió se congela un día entero y se
      // publica como el mayor ahorro posible, sobre trabajo que nadie hizo. Es el
      // mismo fallo que ya cerraron las dos condiciones de arriba, por una puerta
      // que ninguna cubre: la respuesta no incumple nada y no pide herramientas.
      //
      // Y no basta con meter la palanca en la clave: qué herramientas viajan lo
      // decide la respuesta del sondeo, que NO es determinista. Dos peticiones
      // idénticas con la palanca igual pueden ver catálogos distintos, así que la
      // única regla honesta es no cachear lo que se generó con la vista recortada.
      const vistaRecortada = descubrimiento.aplicado;
      // Y LA CUARTA PUERTA: TAMPOCO SE CACHEA MEDIA RESPUESTA.
      //
      // Aquí no hay heurística que discutir —lo dice el propio proveedor con
      // `finish_reason: "length"`—, y la condición de "incumple su contrato" NO
      // lo cubre: una petición SIN esquema (o con uno que no acota nada) sale con
      // `structurallyValid` en true porque no hay nada que validar, así que el
      // truncado no lo veía nadie. Ni siquiera hace falta que el llamante ponga
      // tope: la API de Anthropic EXIGE `max_tokens` y el adaptador manda 4096
      // por defecto, o sea que una generación larga se corta sin que el cliente
      // haya pedido ningún tope.
      //
      // Lo que entraba por ahí es el mismo fallo que cierran las tres
      // condiciones de arriba: media respuesta guardada 24 h y servida a cada
      // petición idéntica con `avoidedLlm: 1`, publicada como ahorro del 100%
      // sobre algo que ningún cliente aceptaría. Equivocarse al revés —no
      // cachear una respuesta cortada que al llamante le valía— cuesta una
      // llamada más, y queda dicho en la traza en vez de en silencio.
      const cortadaPorElTope = response.finishReason === "length";
      const cacheable =
        structurallyValid !== false && !pidioHerramientas && !vistaRecortada && !cortadaPorElTope;
      if (!cacheable) {
        trace.record(
          "cache-write",
          pidioHerramientas
            ? "skipped: tool-call turn (an action request must not be replayed from cache)"
            : structurallyValid === false
              ? "skipped: response fails its output contract"
              : cortadaPorElTope
                ? "skipped: answer cut off by the output cap (finish_reason \"length\"); replaying half " +
                  "an answer would bill it as a 100% avoided call"
                : "skipped: answered with a reduced tool view (tool discovery), so it must not be replayed",
        );
      }

      // LA CLAVE DE ESCRITURA ES LA DEL MODELO QUE ESCRIBIÓ LA RESPUESTA. La de
      // lectura se construyó antes de la etapa 2 con el modelo al que la cascada
      // iba a llamar; si se ha escalado, quien contestó es OTRO y guardar bajo la
      // clave del barato archivaría una respuesta del fuerte como si fuera suya.
      // No es una fuga —a nadie se le sirve algo peor de lo que pidió— pero sí
      // una mentira: la siguiente petición idéntica saldría de caché etiquetada
      // `bounded_degradation` sobre un texto que escribió el modelo bueno, y la
      // escalada, que es la parte cara, desaparecería del historial.
      const claveDeEscritura = escalo
        ? buildExactKey(canonical, { servedModel: modeloServido })
        : exactKey;
      if (cacheable && policy.allowExactCache && toggles.exactCache !== false) {
        // TTL finito (no "para siempre") para que una consulta que la heurística
        // de frescura no detectó no sirva una respuesta rancia indefinidamente.
        // El techo del `freshnessBucket` manda sobre el TTL configurado: es lo
        // único que hace que "hour" y "day" signifiquen algo, porque el bucket va
        // crudo al hash de la clave y NO la rota.
        const ttlBase = this.config.exactCacheTtlMs ?? 24 * 60 * 60 * 1000;
        const ttl = policy.maxCacheAgeMs == null ? ttlBase : Math.min(ttlBase, policy.maxCacheAgeMs);
        await this.deps.exactCache.set(claveDeEscritura, answer, ttl);
      }
      // LA CACHÉ SEMÁNTICA NO GUARDA UNA RESPUESTA ENRUTADA, y es la otra puerta
      // por la que un cambio de modelo se volvería silencioso. Su identidad la
      // fija `canonical.model` —el que PIDIÓ el llamante—, no la clave que se
      // construyó para el que contestó, así que una respuesta del modelo barato
      // guardada ahí se le serviría después a quien pidiera el fuerte, con la
      // cascada apagada y todo, y el informe diría `semantic` sin más. La clave
      // exacta sí lo separa (lleva el modelo servido); ésta no puede, porque el
      // filtro es de la caché y no nuestro. Así que no se guarda.
      const respuestaEnrutada = modeloServido !== request.model;
      if (
        cacheable &&
        !respuestaEnrutada &&
        policy.allowSemanticCache &&
        toggles.semanticCache &&
        this.deps.semanticCache
      ) {
        await this.deps.semanticCache.store(canonical, answer as CachedAnswer);
      } else if (cacheable && respuestaEnrutada && toggles.semanticCache) {
        trace.record(
          "cache-write",
          "semantic write skipped: a cheaper model answered, and this cache keys on the model the " +
            "caller asked for",
        );
      }
    } catch (err) {
      trace.record("cache-write", "failed (non-fatal; answer already served)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const result = this.finish<T>(
      request, canonical, answer, "miss", ledger, precioServido, trace,
      route, formatChoice, undefined, undefined, structurallyValid,
      backendPlan.backend, providerMs,
      this.informeDeCascada(cascada, {
        servedModel: modeloServido,
        ...(cascada.enruta ? { escalated: escalo } : {}),
        // Lo que habría valido (o costado) el cambio de modelo en dinero, con las
        // cuentas de tokens MEDIDAS de esta petición a los dos precios. Es un
        // contrafactual —el otro modelo no se ejecutó— y por eso no entra en
        // `cost.netSavings`; entra aquí, con su etiqueta. Solo se publica sobre
        // peticiones ELEGIBLES: dar la cifra de un cambio que nunca podría
        // hacerse (sin contrato, con herramientas de escritura) sería enseñar un
        // ahorro que no está en la mesa.
        ...(cascada.elegible && cascada.precioBarato
          ? {
              estimatedSwapSaving: ahorroDelCambio(
                ledger,
                escalo,
                cascada.precioBarato,
                this.costModelFor(request.model),
              ),
            }
          : {}),
        ...(muestra
          ? {
              sampled: true,
              sampleCost: roundUsdPublico(muestra.coste),
              ...(muestra.divergio !== null ? { divergedOnSample: muestra.divergio } : {}),
            }
          : {}),
        // LOS TOKENS DE LA LLAMADA QUE NO SIRVIÓ, publicados aquí porque en
        // ningún otro sitio caben. Se quedan fuera de `tokens.actualInput/Output`
        // a propósito —los facturó otro modelo a otro precio, y `estimateCost`
        // recibe UN solo `CostModel`— pero su DINERO sí entra en `cost.actual`
        // vía `extraCostUsd`. Sin estas dos cifras, la identidad que el cliente
        // usa para cuadrar el informe contra su factura
        // (`actualInput·pIn + actualOutput·pOut == cost.actual`) se rompe en toda
        // petición escalada o muestreada, y no hay ningún campo que explique el
        // hueco. Los contadores existían en el ledger y no los leía NADIE.
        ...(ledger.cascadeInput > 0 || ledger.cascadeOutput > 0
          ? {
              cascadeInputTokens: ledger.cascadeInput,
              cascadeOutputTokens: ledger.cascadeOutput,
            }
          : {}),
      }),
      // El tier se lee de `response`, que a estas alturas es la respuesta que de
      // verdad se sirvio -- la del fuerte si la cascada escalo -- y se tarifa con
      // `precioServido`, que es el precio de quien contesto. Las dos cosas tienen
      // que venir de la misma llamada, o el descuento se aplicaria a los tokens de
      // una y al precio de otra.
      diferido,
    );
    // Las tool calls y el finishReason viajan HASTA EL LLAMANTE. Se quedaban en
    // ProviderResponse: el arreglo del adaptador (content:null + tool_calls)
    // moría una capa más arriba porque aquí solo se copiaba `text`, y el cliente
    // recibía cadena vacía como si fuera la respuesta buena.
    if (pidioHerramientas) result.toolCalls = response.toolCalls!;
    if (response.finishReason !== undefined) result.finishReason = response.finishReason;
    return result;
  }

  /**
   * SCHEMA-ON-DEMAND: primero se pregunta CUÁL, después se manda el esquema.
   *
   * Devuelve las herramientas que llevará la llamada de verdad. Sin patrón (o con
   * él descartado, degradado o roto) devuelve las candidatas tal cual, así que el
   * llamante no tiene ninguna rama que escribir: la ruta de una sola llamada con
   * todos los esquemas es literalmente el valor por defecto de esta función.
   *
   * TRES CUIDADOS QUE NO SON NEGOCIABLES, y los tres están aquí:
   *
   *  1. LA VERJA ECONÓMICA (`decidirDescubrimiento`). La segunda llamada cuesta:
   *     el prompt se paga dos veces y la salida del sondeo entera. Con un
   *     catálogo pequeño esto PIERDE dinero, y sin verja sería un empeoramiento
   *     disfrazado de optimización. Se decide en dinero y por petición.
   *  2. LA RESPUESTA DEL SONDEO NO SE SIRVE NUNCA. Aunque venga un texto perfecto
   *     y ganas de ahorrarse la segunda llamada: ese texto lo escribió un modelo
   *     que veía descriptores SIN `parameters`, o sea con menos información de la
   *     que declaró el llamante. Convertir eso en la respuesta del cliente es la
   *     forma exacta del fallo que documenta el router — «claro, la reenvío» sin
   *     poder reenviarla — y encima contabilizado como ahorro.
   *  3. FAIL-OPEN DE VERDAD. Si el sondeo revienta, o devuelve basura, o no elige
   *     nada, se sigue con TODOS los esquemas. Un patrón de ahorro no puede ser un
   *     punto de caída nuevo en la petición del cliente.
   */
  private async descubrirHerramientas(
    testigo: TestigoDeFacturacion,
    request: SavingsRequest,
    toggles: NonNullable<SavingsRequest["savings"]>,
    candidatas: ToolDescriptor[],
    messages: ChatMessage[],
    ledger: SavingsLedger,
    costModel: CostModel,
    trace: TraceCollector,
  ): Promise<{ tools: ToolDescriptor[]; tokensLocalesDelSondeo: number; aplicado: boolean }> {
    const sinPatron = { tools: candidatas, tokensLocalesDelSondeo: 0, aplicado: false };
    if (toggles.toolDiscovery !== true) return sinPatron;
    // Con una sola candidata no hay nada que descubrir: el sondeo preguntaría por
    // la única respuesta posible y después habría que mandar su esquema igual.
    // Se deja constancia igualmente — una palanca que se pide y no hace nada no
    // puede además ser muda, que es como se descubren probando.
    if (candidatas.length < 2) {
      trace.record("tool-discovery", "skipped (nothing to discover)", {
        candidates: candidatas.length,
      });
      return sinPatron;
    }

    // Las herramientas se cuentan con `textoDeHerramienta`, que es LA regla —la
    // misma que usan el ensamblador del baseline y el libro 2 de las descartadas
    // por el selector—, no con una copia paralela. Es la regla de una sola regla:
    // si el baseline y la cuenta de lo que se evita ensamblan distinto, la
    // diferencia se cuela como ahorro (medido en su día: 785 tokens publicados
    // contra 262 reales). Este fichero llegó a contarlo como
    // `assemblePromptText([], [t])`, que hoy da el MISMO texto byte a byte; pero
    // eso es un empate que dependía de que el ensamblador no cambie, y un empate
    // no es una garantía. Llamando a la función compartida, si mañana cambia el
    // envoltorio cambia en los tres sitios a la vez o no cambia en ninguno.
    const esquemaDe = (t: ToolDescriptor): number =>
      this.tokensFor(textoDeHerramienta(t), request);
    const ligeras = candidatas.map(descriptorLigero);

    const decision = decidirDescubrimiento({
      promptTokens: this.tokensFor(this.assemblePromptText(messages), request),
      esquemasCompletos: candidatas.reduce((n, t) => n + esquemaDe(t), 0),
      descriptoresLigeros: ligeras.reduce((n, t) => n + esquemaDe(t), 0),
      esquemasDeLaSegunda: peorCasoDeEsquemas(
        candidatas.map((t) => ({ risk: t.risk, tokens: esquemaDe(t) })),
        MAX_LECTURAS_DE_LA_SEGUNDA,
      ),
      salidaFinal: request.response?.maxOutputTokens ?? 256,
      salidaDelSondeo: SALIDA_DEL_SONDEO_TOKENS,
      precio: costModel,
    });

    if (!decision.aplicar) {
      trace.record("tool-discovery", "skipped (not worth a second call)", {
        reason: decision.razon,
        oneCall: decision.costeDeUnaLlamada,
        twoCalls: decision.costeDeDosLlamadas,
      });
      return sinPatron;
    }

    // El sondeo va SIN el contrato de salida a propósito, ni el del llamante ni
    // el compacto del codebook (`esquemaAlProveedor`, etapa 10a). Forzar ahí el
    // modo estructurado le pide al modelo la respuesta final —que es justo lo que
    // no queremos todavía— y en varios proveedores compite con las tool calls. Va
    // también sin `constraintBackend`: no hay nada que restringir. Y como el
    // codebook solo existe para abaratar la SALIDA que se sirve, y la del sondeo
    // no se sirve jamás, mandarlo aquí sería pagar tokens de contrato dos veces
    // para nada.
    //
    // Y va con `maxOutputTokens` PROPIO, el techo duro del sondeo. Es el peor
    // caso con el que acaba de decidir la verja de arriba, así que tiene que
    // aplicarse de verdad; y no lo hereda la llamada de abajo, que lleva el
    // presupuesto de salida del llamante intacto.
    //
    // Y VA SIN MARCADO DE CACHÉ DE PREFIJO: ni `stablePrefixMessages` ni
    // `promptCacheKey`. Es una decisión, no un olvido, y la tentación es real —
    // las instrucciones de sistema del cliente son idénticas en el sondeo y en la
    // llamada de abajo, así que parece que marcar aquí le regalaría a la segunda
    // una lectura a 0,10x. No es cierto, y por el orden de renderizado:
    //
    //     tools -> system -> messages
    //
    // El emparejamiento de la caché es por BYTES DESDE EL PRINCIPIO, y lo primero
    // que hay es `tools`. El sondeo manda descriptores ligeros SIN `parameters`;
    // la llamada de abajo manda los esquemas completos de un subconjunto. Los dos
    // bloques difieren en el primer byte que cuenta, así que todo lo que va
    // detrás —el `system` compartido incluido— deja de ser prefijo común. No es
    // que el punto de ruptura caiga mal: es que NO EXISTE un punto que se pueda
    // poner por delante de `tools`, porque `cache_control` marca el FINAL de un
    // tramo. La segunda llamada no puede leer lo que escribiera el sondeo, jamás.
    //
    // Marcar aquí sería, entonces, pagar la prima de escritura (1,25x) por un
    // prefijo cuyo único lector posible sería OTRO sondeo con el mismo catálogo
    // ligero dentro del TTL. Eso es una apuesta sobre tráfico que no se ha
    // medido, y el equilibrio no perdona: h > 0,217. La casa ya tiene regla para
    // esto — se prefiere el ahorro no capturado a la apuesta con dinero del
    // cliente.
    //
    // COMPROBADO, y conviene que quede escrito porque la trampa está a un paso:
    // `finDelPrefijo` se calcula sobre `request.messages` y sigue siendo un
    // índice VÁLIDO aquí, porque el sondeo reenvía el MISMO array `messages` que
    // la llamada de abajo (mismos bloques inyectados, misma compresión). O sea
    // que marcar el sondeo sería seguro en cuanto a índices; se descarta por
    // dinero, no por riesgo de recortar mal. Si algún día el sondeo se montara su
    // propio array de mensajes, esa frontera dejaría de valer y habría que
    // recalcularla — pero para entonces esta llamada seguirá sin marcarse.
    let sondeo: ProviderResponse;
    const tokensLocalesDelSondeo = this.tokensFor(
      this.assemblePromptText(messages, ligeras),
      request,
    );
    try {
      sondeo = await this.llamarProveedor({
        model: request.model,
        messages,
        tools: ligeras,
        maxOutputTokens: SALIDA_DEL_SONDEO_TOKENS,
        ...(request.temperature != null ? { temperature: request.temperature } : {}),
        ...(request.seed != null ? { seed: request.seed } : {}),
      }, testigo);
    } catch (err) {
      // Ni un token que apuntar: la llamada no llegó a devolver uso. Lo que sí
      // queda es la constancia de que se intentó, porque el intento pudo costar
      // dinero y el cliente no puede enterarse de esto por su factura.
      trace.record("tool-discovery", "failed (falling back to a single call with every schema)", {
        error: err instanceof Error ? err.message : String(err),
      });
      return sinPatron;
    }

    ledger.actualLlm += 1;
    ledger.actualInput += sondeo.usage.inputTokens;
    ledger.actualOutput += sondeo.usage.outputTokens;
    // Y aparte, para que no engorde el baseline: esta llamada la pone la capa.
    ledger.discoveryInput += sondeo.usage.inputTokens;
    ledger.discoveryOutput += sondeo.usage.outputTokens;
    // El libro 4 (tokens que el proveedor sirvió de su caché de prefijo) NO se
    // alimenta del sondeo. Ese libro habla del prompt del cliente; los tokens de
    // una llamada que añadimos nosotros no le abaratan nada a él, y meterlos
    // aplicaría el descuento también al lado del baseline, donde esa llamada ni
    // existe. Se paga a precio lleno en el informe: equivocarse en contra propia.

    const elegidas = herramientasDeLaSegunda(
      (sondeo.toolCalls ?? []).map((c) => c.name),
      candidatas,
      MAX_LECTURAS_DE_LA_SEGUNDA,
    );

    if (elegidas.reconocidos.length === 0) {
      // Ni una herramienta reconocida: o el modelo contestó en texto, o se
      // inventó nombres. Se manda la llamada de siempre, con todos los esquemas.
      // Cuesta el sondeo de más, y por eso la verja de arriba exige que la
      // ganancia cubra justamente este caso.
      trace.record("tool-discovery", "degraded: probe named no known tool", {
        finishReason: sondeo.finishReason ?? null,
        ...(elegidas.ignorados.length ? { unknownNames: elegidas.ignorados } : {}),
      });
      return { tools: candidatas, tokensLocalesDelSondeo, aplicado: false };
    }

    trace.record("tool-discovery", "applied (two provider calls)", {
      chosen: elegidas.reconocidos,
      sent: elegidas.tools.map((t) => t.id),
      candidates: candidatas.length,
      ...(elegidas.ignorados.length ? { unknownNames: elegidas.ignorados } : {}),
    });
    return { tools: elegidas.tools, tokensLocalesDelSondeo, aplicado: true };
  }

  // --- helpers -----------------------------------------------------------

  /**
   * El bloque `report.modelCascade`, o `undefined` si la cascada está apagada.
   *
   * Se publica también cuando la petición NO era elegible, y a propósito: «no se
   * enrutó esto, y por esto» es la respuesta que más veces hace falta. Un informe
   * que solo aparece cuando la palanca actúa deja a quien la evalúa sin saber si
   * está apagada, si no aplica, o si aplica y no vale la pena.
   */
  private informeDeCascada(
    cascada: DecisionDeCascada,
    extra: Partial<ModelCascadeReport> = {},
  ): ModelCascadeReport | undefined {
    if (cascada.modo === "off") return undefined;
    return {
      mode: cascada.modo,
      servedModel: extra.servedModel ?? cascada.modeloServido,
      eligible: cascada.elegible,
      reason: cascada.razon,
      verifier: cascada.fuerza,
      creditedLedger: "none",
      ...(cascada.candidato ? { candidateModel: cascada.candidato } : {}),
      ...(cascada.economia
        ? {
            costRatio: redondear(cascada.economia.r),
            breakEvenEscalationRate: redondear(cascada.economia.equilibrio),
            targetEscalationRate: redondear(cascada.economia.escaladoMaximo),
          }
        : {}),
      ...(cascada.bucket ? { workload: cascada.bucket } : {}),
      ...(cascada.observada != null
        ? { escalationRate: redondear(cascada.observada), escalationSamples: cascada.muestras }
        : {}),
      ...extra,
      // `requestedModel` se fija DESPUÉS del spread, y es el único campo que
      // ningún llamante puede reescribir: es el hecho de partida —lo que el
      // cliente pidió— y dejar que se confunda con lo servido sería justo el
      // cambio silencioso que esta palanca tiene prohibido.
      requestedModel: cascada.modeloPedido,
    };
  }

  /**
   * El bloque `report.deferred` de una peticion que SI llamo al proveedor.
   *
   * TODO SALE DEL TIER SERVIDO, NUNCA DEL PEDIDO, y ese es el motivo de que este
   * metodo exista en vez de rellenar el informe donde se manda la peticion. Un
   * tier degradado se cobra a precio estandar EN SILENCIO -- la respuesta llega
   * con exactamente la misma pinta --, asi que acreditar por haber pedido
   * publicaria un descuento que la factura del cliente no trae. Es el mismo fallo
   * que ya se cazo dos veces en este repo: un libro sin llamantes y una verja
   * huerfana.
   *
   * El ahorro se tarifa sobre los tokens de LA LLAMADA CUYO TIER SE LEYO, y no
   * sobre `cost.actual`. No es lo mismo: `cost.actual` puede llevar el dinero de
   * una reparacion, de un sondeo o del intento descartado de la cascada, y de
   * ninguna de esas tres se leyo el tier. Acreditarlas seria extender un
   * descuento medido a llamadas que nadie miro.
   */
  private informeDeDiferido(
    toggles: NonNullable<SavingsRequest["savings"]>,
    response: ProviderResponse,
    precio: CostModel,
  ): DeferredExecutionReport | undefined {
    if (toggles.deferrable !== true) return undefined;

    const pedido = response.requestedServiceTier;
    const veredicto = veredictoDelTier(response.servedServiceTier);
    const base: DeferredExecutionReport = {
      ...(pedido ? { requestedTier: pedido } : {}),
      ...(veredicto ? { servedTier: veredicto.servido } : {}),
      credited: false,
      creditedLedger: "none",
      latency: latenciaDelTier(pedido),
      reason: "",
    };

    if (!pedido) {
      return { ...base, reason: SIN_TIER_DIFERIBLE };
    }
    if (!veredicto) {
      // AUSENTE NO ES <<ESTANDAR>>. Significa que no se puede saber a que tarifa
      // se facturo, y de lo que no se sabe no se acredita nada.
      return {
        ...base,
        reason:
          `asked the provider for the "${pedido}" tier, and it reported none back: the rate this ` +
          `request was billed at cannot be known, so nothing is credited`,
      };
    }
    if (veredicto.factor == null) {
      return {
        ...base,
        reason:
          `asked for "${pedido}" and the provider reports serving "${veredicto.servido}", a tier ` +
          `this layer has no published rate for: nothing is credited`,
      };
    }
    if (!veredicto.conDescuento) {
      return {
        ...base,
        reason:
          `asked for "${pedido}" and the provider reports serving "${veredicto.servido}", which ` +
          `bills at the standard rate: this request was billed as if it had never been deferred`,
      };
    }

    // Los tokens que el proveedor sirvio de su cache de prefijo se tarifan a SU
    // tarifa tambien aqui. Sin esto el descuento del tier se aplicaria sobre un
    // coste inflado (todo a precio de entrada normal) y saldria mayor del real,
    // que es exactamente el sentido en el que no se puede errar.
    const uso = response.usage;
    const cacheados = Math.min(
      Math.max(0, uso.cachedInputTokens ?? 0),
      Math.max(0, uso.inputTokens),
    );
    const tarifaCacheada = precio.cachedInputPer1k ?? precio.inputPer1k;
    const costeEstandar =
      ((Math.max(0, uso.inputTokens) - cacheados) / 1000) * precio.inputPer1k +
      (cacheados / 1000) * tarifaCacheada +
      (Math.max(0, uso.outputTokens) / 1000) * precio.outputPer1k;
    const ahorro = ahorroDelTier(veredicto, costeEstandar);

    return {
      ...base,
      credited: true,
      discountRate: redondear(veredicto.factor),
      ...(ahorro != null ? { estimatedTierSaving: roundUsdPublico(ahorro) } : {}),
      reason:
        `the provider reports serving the "${veredicto.servido}" tier, which bills at ` +
        `${(veredicto.factor * 100).toFixed(0)}% of the standard rate; the discount stacks with ` +
        `provider prefix caching rather than replacing it`,
    };
  }

  /**
   * El bloque `report.deferred` de una peticion que NO llamo al proveedor: un
   * acierto de cache, un resolver determinista, un seguidor de singleflight.
   *
   * Se publica igualmente, y no es relleno: sin el, la palanca desaparece del
   * informe justo en las peticiones donde MAS ahorro. Y lo que dice es lo
   * correcto -- no hubo tier porque no hubo llamada --, asi que nadie puede leer
   * un descuento de proveedor sobre una llamada que no se hizo.
   */
  private diferidoSinLlamada(request: SavingsRequest): DeferredExecutionReport | undefined {
    if (request.savings?.deferrable !== true) return undefined;
    return {
      credited: false,
      creditedLedger: "none",
      latency: "not applicable: no provider call was made for this request.",
      reason:
        "no provider call was made, so no processing tier was served and none is credited; the " +
        "call was avoided outright, which is worth more than any tier discount on it",
    };
  }

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
    cascada?: ModelCascadeReport | undefined,
    diferido?: DeferredExecutionReport | undefined,
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
      formatChoice, ageMs, confidence, valid, backend, providerMs, cascada,
      // El camino del proveedor pasa el suyo; los ATAJOS no lo pasan, y ahi es
      // donde `diferidoSinLlamada` rellena. Sin esa rama, una peticion declarada
      // diferible que acierta en cache salia SIN el bloque, y un panel que
      // condiciona por su presencia habria dado por apagada una palanca que el
      // cliente si encendio.
      diferido ?? this.diferidoSinLlamada(request),
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
    cascada: ModelCascadeReport | undefined,
    diferido: DeferredExecutionReport | undefined,
  ): SavingsReport {
    const cost = ledger.estimateCost(costModel);
    const total = trace.elapsed();
    // UNA RESPUESTA SERVIDA POR UN MODELO MÁS BARATO DEL QUE SE PIDIÓ. Es lo que
    // convierte el informe en algo que se puede leer sin engañarse: `model` pasa
    // a nombrar al que contestó, y `qualityStatus` baja a `bounded_degradation`.
    const degradado = cascada != null && cascada.servedModel !== cascada.requestedModel;
    return {
      requestId: this.generateId(),
      // EL INFORME DECLARA SIEMPRE EL MODELO QUE CONTESTÓ. Sin la cascada esto es
      // literalmente el modelo pedido (nada cambia para quien no la encienda);
      // con ella enrutando, seguir publicando el pedido convertiría el informe en
      // el sitio donde el cambio de modelo se vuelve invisible — y `cost.actual`
      // está tarifado con el precio del que contestó, así que además no cuadraría
      // con su propia etiqueta.
      model: cascada?.servedModel ?? request.model,
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
      // El ÚNICO sitio donde se calcula la etiqueta de calidad. Sale de aquí
      // para las tres familias de camino —atajos, camino del proveedor y
      // fail-open— porque las tres pasan por buildReport(); el seguidor de
      // singleflight es la excepción y hereda (ver asCoalescedFollower).
      qualityStatus: estadoDeCalidad(cacheResult, structurallyValid, degradado),
      ...(cascada ? { modelCascade: cascada } : {}),
      ...(diferido ? { deferred: diferido } : {}),
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
      // Sin bloque de cascada: el fail-open llama al proveedor DIRECTAMENTE, sin
      // capa, así que aquí no hay decisión de cascada que informar — ni la hubo,
      // porque este camino se toma cuando el optimizador ya falló. Publicar uno
      // vacío afirmaría que la palanca corrió.
      undefined,
      // EL FAIL-OPEN NO PIDE TIER BARATO, Y ES UNA DECISION, NO UN OLVIDO. El
      // tier diferible puede contestar 429 por falta de capacidad donde el
      // estandar habria contestado; en el camino de ultimo recurso -- el que
      // existe porque el optimizador YA se rompio -- cambiar disponibilidad por un
      // 50% es el trueque equivocado. Pero se DICE, en vez de omitir el bloque:
      // quien declaro la peticion diferible tiene que poder ver por que esta no lo
      // fue.
      request.savings?.deferrable === true
        ? {
            credited: false,
            creditedLedger: "none",
            latency:
              "unchanged: the fail-open path asks for no processing tier, so this request was " +
              "scheduled exactly as an ordinary one.",
            reason:
              "the optimizer failed and this request went out on the direct fail-open path, which " +
              "asks for no cheaper tier: that tier can be refused for lack of capacity, and " +
              "trading availability for a discount on a last-resort call is the wrong trade",
          }
        : undefined,
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
    request: SavingsRequest,
  ): SavingsResult<T> {
    const ledger = new SavingsLedger();
    ledger.avoidCall(baselineInput, baselineOutput);
    const cost = ledger.estimateCost(costModel);

    // Un id por seguidor, no dos. Antes se llamaba a generateId() por separado
    // para el resultado y para el informe, así que result.requestId nunca
    // coincidía con result.report.requestId y correlacionar una petición con su
    // registro de medición era imposible.
    const requestId = this.generateId();

    // Se calcula UNA vez y se esparce, para que la clave `deferred` no llegue a
    // existir con valor `undefined` cuando el seguidor no declaro nada: un panel
    // que pregunta por la PRESENCIA del bloque no puede distinguir esas dos cosas.
    const diferidoDelSeguidor = this.diferidoSinLlamada(request);
    const bloqueDiferidoDelSeguidor = diferidoDelSeguidor
      ? { deferred: diferidoDelSeguidor }
      : {};

    const { deferred: _delLider, ...informeDelLider } = leader.report;

    return {
      ...leader,
      requestId,
      report: {
        ...informeDelLider,
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
        // `deferred` SE RECONSTRUYE, NO SE HEREDA, y es el mismo motivo que los
        // tokens de aqui arriba: el seguidor NO llamo al proveedor, asi que
        // ningun tier se sirvio para el. Heredando el bloque del lider, un
        // `estimatedTierSaving` de UNA llamada se republicaba N+1 veces -- una por
        // seguidor -- sobre peticiones que no tocaron al proveedor. Es
        // exactamente el fallo que el bloque `tokens` ya documenta.
        //
        // Y se reconstruye desde la peticion DEL SEGUIDOR, no la del lider: la
        // clave de singleflight no lleva el flag (a proposito, igual que la de
        // cache), asi que un seguidor que no declaro nada puede coalescerse con un
        // lider que si, y viceversa. Lo que el informe del seguidor tiene que
        // decir es lo que EL pidio.
        ...bloqueDiferidoDelSeguidor,
        // `qualityStatus` es de lo POCO que sí se hereda del líder, y es
        // deliberado: el seguidor sirve EL TEXTO DEL LÍDER, así que le
        // corresponde la calidad del líder. Coalescerse no verifica nada, de
        // modo que no puede subir la nota; y si el líder acabó en `rejected`,
        // el seguidor está sirviendo esa misma respuesta incumplidora y tiene
        // que decirlo. Los tokens son lo contrario —gasto del líder que el
        // seguidor no hizo— y por eso se reconstruyen arriba.
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
  /**
   * El precio de un modelo SOLO si de verdad se conoce: el del cliente, o el de
   * lista del catálogo. Nunca el ilustrativo, nunca el `defaultCostModel`.
   *
   * `costModelFor` no puede decir «no lo sé»: tiene que devolver algo con lo que
   * tarifar el informe, así que acaba en el precio ilustrativo con su aviso al
   * lado. Para TARIFAR eso está bien —una cifra aproximada y advertida es mejor
   * que ninguna—. Para DECIDIR si enrutar es exactamente lo contrario: la
   * aritmética del par es toda la protección que hay contra una cascada que
   * pierde dinero, y correrla sobre un precio inventado la convierte en un sello
   * de goma.
   *
   * Medido al provocarlo: con `pairs: { "gpt-4o": "mi-modelo-casero" }` y el
   * precio del casero sin declarar, el ilustrativo (0,0005/0,0015) contra el real
   * de gpt-4o daba `r = 0,200` y el par salía VIABLE — se enrutaba el tráfico del
   * cliente a un modelo cuyo precio la capa no conoce, y el informe publicaba
   * `costRatio: 0.2` como si fuera una cuenta. Si el modelo costara el doble que
   * el fuerte, la cascada perdería dinero en cada petición y nada la pararía: el
   * apagado automático vigila P(escalar), no el precio.
   */
  private precioConocido(model: string): CostModel | undefined {
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
    return precioDeLista(model);
  }

  private costModelFor(model: string): CostModel {
    // Una sola regla de medir para los dos: lo que `costModelFor` añade por
    // encima de `precioConocido` son las dos capas de respaldo, y son justo las
    // que la cascada no puede usar.
    const conocido = this.precioConocido(model);
    if (conocido) return conocido;

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

/**
 * Parseo del texto servido, CON RESCATE LOCAL antes de darlo por perdido.
 *
 * Era un `JSON.parse` pelado, y esa desnudez costaba una llamada entera. El modo
 * de fallo dominante contra Anthropic no es que el modelo invente una forma: es
 * que contesta en prosa de cortesía con el JSON CORRECTO dentro de una valla
 * markdown. `JSON.parse` de eso lanza, la validación anota "not valid JSON" y el
 * pipeline dispara su única reparación — una SEGUNDA llamada completa que en esa
 * API vuelve a pagar el prompt de uso de herramientas entero.
 *
 * O sea: se pagaba una llamada por sacar un objeto que ya estaba en la respuesta.
 *
 * El rescate es local, cuesta cero tokens y cero llamadas, y NO puede empeorar
 * nada: solo se intenta cuando el parseo estricto YA falló, así que lo único que
 * puede hacer es convertir un fallo en un acierto. Se prueba en orden de menos a
 * más adivinanza:
 *
 *   1. el texto tal cual (camino rápido, conducta idéntica a la de antes);
 *   2. el contenido de cada valla markdown, que es el caso real medido;
 *   3. el primer `{` o `[` con su cierre equilibrado, para la prosa sin valla.
 *
 * `rescatado` viaja de vuelta para que quien llama pueda servir la forma limpia
 * en vez de la prosa: el llamante pidió un contrato, y devolverle la valla lo
 * obligaría a repetir este mismo trabajo por su cuenta.
 */
function tryParse(
  text: string,
): { ok: true; value: unknown; rescatado?: string } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    // El estricto falló: se pasa al rescate. No es un camino de error, es el
    // caso normal cuando el modelo contesta en prosa.
  }

  for (const candidato of candidatosDeJson(text)) {
    try {
      return { ok: true, value: JSON.parse(candidato), rescatado: candidato };
    } catch {
      continue;
    }
  }
  return { ok: false };
}

/**
 * Trozos del texto que podrían ser el JSON, en orden de preferencia.
 *
 * Se devuelven como mucho unos pocos: cada candidato es un `JSON.parse` más, y
 * esta función corre en el camino caliente de cada respuesta con contrato.
 */
function candidatosDeJson(text: string): string[] {
  const candidatos: string[] = [];

  // Las vallas primero, porque son la señal MÁS fuerte que hay: el modelo marcó
  // él mismo dónde empieza y acaba la carga útil. Se admite el infijo de lenguaje
  // (```json) y también su ausencia (```), que es lo que sale cuando el modelo se
  // salta la etiqueta.
  const valla = /```[ \t]*[a-zA-Z0-9_-]*[ \t]*\r?\n([\s\S]*?)```/g;
  for (const m of text.matchAll(valla)) {
    const dentro = m[1]?.trim();
    if (dentro) candidatos.push(dentro);
  }

  // Y si no hubo valla, el primer objeto o array equilibrado. SOLO el primero de
  // cada clase: escanear desde cada llave del texto sería cuadrático sobre una
  // respuesta que puede ser larga, y el JSON de una respuesta con prosa alrededor
  // está en el primer `{` en la práctica totalidad de los casos.
  for (const apertura of ["{", "["] as const) {
    const desde = text.indexOf(apertura);
    if (desde === -1) continue;
    const recorte = recorteEquilibrado(text, desde);
    if (recorte) candidatos.push(recorte);
  }

  return candidatos;
}

/**
 * Desde `desde`, el trozo hasta el cierre que equilibra la apertura.
 *
 * Cuenta profundidad SALTÁNDOSE lo que va dentro de cadenas, que es la parte que
 * un contador ingenuo se come: un `}` dentro de un valor de texto cerraría el
 * objeto antes de tiempo y devolvería un recorte que no parsea. Las comillas
 * escapadas (`\"`) tampoco abren ni cierran cadena.
 */
function recorteEquilibrado(text: string, desde: number): string | undefined {
  const abre = text[desde];
  const cierra = abre === "{" ? "}" : "]";
  let profundidad = 0;
  let enCadena = false;
  let escapado = false;

  for (let i = desde; i < text.length; i += 1) {
    const c = text[i]!;
    if (enCadena) {
      if (escapado) escapado = false;
      else if (c === "\\") escapado = true;
      else if (c === '"') enCadena = false;
      continue;
    }
    if (c === '"') {
      enCadena = true;
      continue;
    }
    if (c === abre) profundidad += 1;
    else if (c === cierra) {
      profundidad -= 1;
      if (profundidad === 0) return text.slice(desde, i + 1);
    }
  }
  // Sin cierre: la respuesta se cortó a media estructura (tope de salida). No se
  // devuelve nada — cerrar el objeto por nuestra cuenta sería inventar contenido.
  return undefined;
}

function renderLocally(data: unknown): string {
  if (typeof data === "string") return data;
  return JSON.stringify(data, null, 2);
}

/**
 * QUÉ CLASE DE RESPUESTA SE ESTÁ SIRVIENDO, EN UNA PALABRA.
 *
 * La única señal de calidad era `constraints.structurallyValid`, un booleano y
 * encima opcional: metía en la misma casilla lo que CALCULÓ un resolver
 * determinista —exacto por construcción— y lo que escribió el modelo sin que
 * nadie comprobara nada más que la forma. Son la diferencia entre «esto es el
 * resultado» y «esto es lo que dijo el modelo», y el producto afirma ahorro
 * sobre las dos.
 *
 * LA REGLA QUE SOSTIENE EL VOCABULARIO: NUNCA decir «sin pérdida» cuando lo
 * único medido es similitud coseno, BLEU, ROUGE o el juicio de otro LLM. Esas
 * métricas se quedan altas mientras desaparece una cifra, una negación o una
 * excepción — justo los campos que deciden un documento jurídico o financiero.
 * Por eso el acierto semántico NO es `task_equivalent` por su coseno: lo es por
 * la verja determinista que corre por debajo del embebedor (números y fechas
 * como multiconjunto, paridad de negaciones, suelo de solapamiento de
 * entidades). Si un día esa verja se quitara, el acierto semántico tendría que
 * bajar a `not_verified` — el coseno solo no compra la etiqueta.
 *
 * PRECEDENCIA, y el orden importa: el incumplimiento del contrato manda sobre la
 * procedencia. El resolver aritmético devuelve `{value: 8}` a quien pidió
 * `{answer: string}`: acierta el número y falla el contrato. Eso es `rejected`,
 * no `exact`. La etiqueta solo puede DEGRADAR lo que el resto del informe dice.
 *
 * `not_verified` es el defecto y es el caso mayoritario. Ahí cae también el
 * fail-open —respuesta directa del proveedor, sin capa— y a propósito no tiene
 * estado propio: lo que se degradó es el OPTIMIZADOR, no la respuesta, que está
 * tan verificada (o tan poco) como en el camino normal. La degradación ya se ve
 * donde le corresponde, en la traza `fail-open`; darle además una etiqueta de
 * calidad sería contar dos veces lo mismo y, peor, sugerir que la respuesta es
 * de peor calidad por un motivo que no la toca.
 *
 * Un turno de herramientas SÍ lleva etiqueta, al contrario que
 * `structurallyValid`, que se omite. No es una contradicción: `true`/`false` ahí
 * serían certificar o acusar de incumplir un contrato que nadie ha mirado,
 * mientras que `not_verified` no afirma nada sobre el contrato — dice que nadie
 * verificó, que es exactamente lo que pasa. Y la ausencia del campo ya significa
 * otra cosa («este SDK es anterior a la etiqueta»): darle un segundo significado
 * haría indistinguibles los dos casos para el cliente.
 *
 * `bounded_degradation` ES EL CASO DE LA CASCADA DE MODELOS, y va DESPUÉS de
 * `rejected` y ANTES que todo lo demás. Después de `rejected` porque el
 * incumplimiento del contrato sigue mandando sobre la procedencia. Y antes que
 * `exact`, que es lo que menos se ve venir: un acierto de caché exacta cuya clave
 * llevaba el modelo BARATO está repitiendo una respuesta que escribió un modelo
 * más flojo del que se pidió, y llamar a eso «exacto por construcción» sería
 * ascender la respuesta por el mero hecho de repetirla. Lo que la caché conserva
 * es la respuesta; no puede conservar una calidad que no hubo.
 *
 * El límite que promete la etiqueta es exactamente el de la verja determinista:
 * la forma, y las restricciones de VALOR que declare el contrato. NO el
 * significado. Una respuesta bien formada con contenido equivocado lleva también
 * esta etiqueta, y esa es la razón de que la etiqueta exista en vez de dejar la
 * cascada en `not_verified`: el lector tiene que poder ver que se le sirvió otro
 * modelo.
 */
function estadoDeCalidad(
  cacheResult: CacheOutcome,
  structurallyValid: boolean | null,
  degradado = false,
): QualityStatus {
  if (structurallyValid === false) return "rejected";
  if (degradado) return "bounded_degradation";
  switch (cacheResult) {
    // Exacto POR CONSTRUCCIÓN: o lo calculó un resolver, o es la respuesta que ya
    // se dio a esta misma pregunta (la clave exacta incluye tenant, modelo,
    // system, datos adjuntos, contrato, locale y muestreo: «la misma pregunta»
    // significa la misma de verdad).
    case "deterministic":
    case "exact":
      return "exact";
    // Otra redacción, misma tarea: pasó la verja determinista.
    case "semantic":
      return "task_equivalent";
    // `miss` (proveedor y fail-open) y `singleflight`, que no llega aquí porque
    // el seguidor hereda: cualquier cosa que no se haya demostrado es el suelo.
    default:
      return "not_verified";
  }
}

/** Proporciones publicables: seis decimales, como `netSavings`. */
function redondear(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Importes publicables, con la misma resolución que usa el ledger. */
function roundUsdPublico(n: number): number {
  const r = Math.round(n * 1e10) / 1e10;
  // `-0` no es un importe: es lo mismo que 0 y se lee peor en un JSON.
  return r === 0 ? 0 : r;
}

/**
 * ¿QUÉ VALE EL CAMBIO DE MODELO EN ESTA PETICIÓN? En dinero, con las cuentas de
 * tokens MEDIDAS tarifadas a los dos precios.
 *
 * Hace la misma cuenta enrutando y en SOMBRA, y ahí está su utilidad: en sombra
 * los tokens son los del modelo fuerte y tarifarlos también con el barato
 * responde «esto es lo que se habría ahorrado hoy», que es exactamente para lo
 * que existe el modo sombra. Enrutando son los del barato y la cuenta es la
 * misma al revés.
 *
 * ES UN CONTRAFACTUAL Y SE PUBLICA COMO TAL. El otro modelo no se ejecutó, así
 * que no hay medición suya: solo se sabe cuántos tokens hubo con el que sí
 * corrió, y el número de SALIDA es justamente el que un modelo distinto habría
 * cambiado. Por eso esta cifra NO entra en `cost.netSavings`, que se queda siendo
 * lo que siempre fue —una comparación a un solo precio, sobre lo que hicieron
 * las otras palancas—; entra en `report.modelCascade`, con su nombre y su aviso
 * al lado.
 *
 * En una petición ESCALADA sale negativa, que es exactamente lo que le pasó a la
 * factura: se pagaron las dos llamadas, y la del barato no sirvió de nada.
 */
function ahorroDelCambio(
  ledger: SavingsLedger,
  escalo: boolean,
  precioBarato: CostModel,
  precioFuerte: CostModel,
): number {
  // Al escalar, lo pagado de más es literalmente el intento descartado: no hay
  // contrafactual que estimar, hay una factura de más que ya está medida.
  if (escalo) return roundUsdPublico(-ledger.extraCostUsd);

  const coste = (p: CostModel): number =>
    (ledger.actualInput / 1000) * p.inputPer1k + (ledger.actualOutput / 1000) * p.outputPer1k;
  return roundUsdPublico(coste(precioFuerte) - coste(precioBarato));
}

/**
 * ¿Entra esta petición en la muestra del modo sombra?
 *
 * DETERMINISTA, y no es un capricho: `Math.random` haría que la misma petición
 * se muestreara o no según la tirada, o sea que el gasto del cliente dependería
 * de un dado. Con el hash de su propia clave de caché, una petición está siempre
 * dentro o siempre fuera, dos procesos deciden igual, y un test puede fijar el
 * comportamiento sin inyectar relojes ni semillas.
 *
 * Los 13 primeros dígitos hexadecimales (52 bits) caben exactos en un `double`,
 * así que la fracción no pierde precisión ni se sesga por redondeo.
 */
function enLaMuestra(clave: string, tasa: number): boolean {
  if (!(tasa > 0)) return false;
  if (tasa >= 1) return true;
  const digest = sha256(`${clave}:cascade-sample`);
  const trozo = Number.parseInt(digest.slice(0, 13), 16);
  return trozo / 2 ** 52 < tasa;
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
 *
 * DURANTE UN TIEMPO ESTO SE APLICÓ A UN SOLO BLOQUE. La medición de arriba está
 * en este fichero desde que se hizo, pero solo el payload serializado la
 * respetaba: la evidencia de retrieval y el aviso de límites JSON entraban con
 * `messages.push`, o sea DETRÁS de la pregunta — exactamente la variante que
 * mide 403 tokens y trunca la mitad de las veces. Y el peor sitio es justo el
 * del retrieval, porque es el bloque más grande.
 *
 * Ahora los tres entran por aquí, y el orden entre ellos también está elegido.
 * Cada inserción queda pegada a la pregunta, así que la ÚLTIMA en insertarse es
 * la más cercana. De más estable a más variable:
 *
 *   [ … del cliente ]  límites JSON  ·  payload  ·  evidencia  ·  pregunta
 *
 * Los límites dependen solo del contrato; el payload, de esta petición; la
 * evidencia, de esta consulta concreta. Poner lo variable al final es lo que
 * deja crecer el prefijo cacheable.
 *
 * Lo fija `test/orden-del-prompt.test.ts`: ningún bloque de la capa puede
 * quedar por detrás de la última pregunta del usuario.
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

/**
 * Dónde acaba el prefijo que se puede llamar ESTABLE, como número de mensajes
 * iniciales.
 *
 * Por defecto es todo lo que hay antes de la última pregunta del usuario:
 * instrucciones de sistema y el historial, que es append-only. Con
 * `soloSystem` se recorta al tramo de `system` INICIAL, que es lo que queda
 * garantizado cuando la compresión ha podido reescribir turnos del historial.
 *
 * Nunca incluye la última pregunta: es, por construcción, la parte variable.
 * Meterla en el prefijo pagaría prima de escritura por un texto que no se va a
 * repetir jamás — el error caro, y el único que esta función existe para evitar.
 */
function limiteDelPrefijoEstable(messages: ChatMessage[], soloSystem = false): number {
  if (soloSystem) {
    let n = 0;
    while (n < messages.length && messages[n]!.role === "system") n += 1;
    return n;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") return i;
  }
  // Sin pregunta del usuario no hay cola variable identificable. Se devuelve el
  // tramo de `system` inicial en vez de todo: afirmar de más aquí es afirmar que
  // texto variable es estable, y eso se paga.
  return limiteDelPrefijoEstable(messages, true);
}

/**
 * Qué tramo de caché aplica a este modelo, o `null` si marcar no puede pagar.
 *
 * RESUELVE CON `tramoDeCache`, EL MISMO QUE LA COMPRESIÓN, y eso es lo único
 * importante de esta función. Nació con su propia tabla de expresiones
 * regulares, escrita cuando la compresión todavía no tenía ninguna; mantener dos
 * mapas modelo→tramo es garantizar que un día discrepen, y el día que discrepen
 * una palanca creerá que el modelo cachea y la otra que no —sobre el MISMO
 * prompt y la misma petición—. Es el mismo argumento que `textoDeHerramienta`:
 * una sola regla, o la diferencia se cuela.
 *
 * Componer sale además gratis en alcance: `tramoDeCache` honra el tramo que el
 * cliente declare en `compressionEconomics.cacheTier`, así que quien conozca su
 * proveedor pasa a poder reclamar prefijo aunque su modelo no esté en la tabla.
 *
 * `null` = ESTE TRAMO NO DESCUENTA LA LECTURA. Cubre el proveedor desconocido
 * (`UNKNOWN_PROVIDER_CACHE_TIER` deja los multiplicadores a 1) y cualquier tramo
 * sin descuento, y la regla vale para los dos por la misma razón económica: si
 * leer no sale más barato, la prima de escritura no se recupera NUNCA y marcar
 * solo puede perder dinero. Se prefiere el ahorro no capturado a la apuesta con
 * dinero del cliente: los dos errores no cuestan lo mismo.
 */
function tramoDelModelo(
  model: string,
  econ: SavingsLayerConfig["compressionEconomics"],
): CacheTier | null {
  const tier = tramoDeCache(model, econ);
  return tier.cacheReadMultiplier < 1 ? tier : null;
}
