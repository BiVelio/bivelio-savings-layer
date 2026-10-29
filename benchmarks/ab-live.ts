/**
 * BV-SALA TRUE A/B live benchmark. Run: pnpm ab
 * ---------------------------------------------------------------------------
 * The only honest way to prove a saving is to MEASURE both worlds against the
 * same real provider — never to compare a measured optimized call against a
 * MODELED baseline. So for every scenario this runs TWO real requests to the
 * SAME endpoint/model:
 *
 *   Arm A (naive)     — what a team WITHOUT BV-SALA sends: full uncompressed
 *                       JSON payload on the wire, all tools transmitted, no
 *                       cache, no output cap, no schema. Priced from the
 *                       provider's own usage.
 *   Arm B (BV-SALA)   — the same task through the layer. Priced from the
 *                       provider's own usage (or $0 when the call is genuinely
 *                       avoided).
 *
 * savings = the MEASURED paired dollar delta. Both arms are metered by the same
 * provider tokenizer, so no fabricated baseline can enter. We report the 95%
 * bootstrap CI LOWER bound ("verified ≥ X%"), never the flattering point value,
 * and a quality gate voids any saving whose answer regressed.
 *
 * MODES:
 *   LIVE  — set BVSALA_DEMO_BASE_URL (+ BVSALA_DEMO_API_KEY, BVSALA_DEMO_MODEL)
 *           to an OpenAI-compatible endpoint (OpenAI, Vercel AI Gateway, vLLM…).
 *           Dollars are REAL provider tokens & cost.
 *   MOCK  — no network. Exercises the entire A/B pipeline deterministically to
 *           prove the plumbing, but every dollar is labeled "ESTIMATED — NOT a
 *           savings claim" because the mock is not a real model. Sus duraciones
 *           son ESTIMATED/INSTRUMENTAL: prueban la cronometría, nunca un SLA.
 *
 * LATENCIA B2-F0 (benchmarks/b2/): todos los brazos usan performance.now().
 * El artefacto conserva p50/p95/max por escenario y agregado, total y proveedor.
 * p95 > 3000 ms o max > 5000 ms en cualquier brazo activo impide publicar;
 * `latency.gate.reasons` deja el motivo. Semilla, CI, calidad y floors no cambian.
 *
 * EL ENDPOINT NATIVO DE ANTHROPIC, Y POR QUÉ HACE FALTA UNO APARTE.
 * `BVSALA_DEMO_BASE_URL` apunta casi siempre a una PASARELA que habla el
 * protocolo de OpenAI, y por ahí `cache_control` no cabe: no hay campo donde
 * ponerlo. Como Anthropic no cachea sola, la palanca de la caché de prefijo
 * explícita —la que más vale de la entrada, lectura a 0,1x— no viaja y el banco
 * publicaba un 0 en los dos brazos sobre un prefijo de 7.287 tokens, que se lee
 * como un fracaso medido y no lo era: el adaptador no se instanciaba nunca.
 * Declara `BVSALA_DEMO_ANTHROPIC_BASE_URL` (+ `_API_KEY`) y los modelos de esa
 * familia van por `AnthropicProvider`. Sin él, esos escenarios NO se miden: se
 * declaran no medibles con su motivo, que es lo contrario de publicar un cero.
 *
 * POR MODELO. `BVSALA_DEMO_MODEL` fija UN modelo para todos los escenarios;
 * `BVSALA_DEMO_MODELS` acepta una lista separada por comas y mide cada uno por
 * separado, saltando los escenarios que no apliquen a ese modelo (ver
 * `Scenario.familia`) y publicando una tabla comparable entre modelos.
 *
 * CUATRO BRAZOS (desde el 2026-09-27): B0 naive, B1 razonable, B2 «nativo bien
 * configurado» (B1 más los ajustes gratuitos que el proveedor documenta para
 * esta forma de petición; benchmarks/nativo.ts) y B = la capa. El artefacto
 * publica el suelo del IC frente a los tres controles (`floors`) y cualquier
 * cifra tiene que caber bajo el menor.
 *
 * ENV (la tabla completa está en benchmarks/README.md):
 *      por defecto se mide el SDK TAL COMO SE INSTALA (`sdk.asShipped: true`);
 *      BVSALA_AB_CON_COMPRESOR=1 inyecta el compresor del banco, que npm no trae
 *      (investigación: `pnpm ab:publish` lo rechaza). BVSALA_AB_SIN_COMPRESOR
 *      queda obsoleta: `1` solo avisa; cualquier otro valor aborta.
 *      BVSALA_AB_PRESET=2026 (o 2026+optional) mide los modelos de 2026
 *      (benchmarks/modelos.ts); incompatible con BVSALA_DEMO_MODEL(S).
 *      BVSALA_AB_B2=0 apaga B2 (no publicable), BVSALA_AB_B2_EFFORT
 *      (none|minimal|low|medium|default, `low` por defecto),
 *      BVSALA_AB_MARGEN_RAZONAMIENTO (tokens de tope extra en modelos que razonan),
 *      BVSALA_AB_PERMITIR_PRECIO_ILUSTRATIVO=1, BVSALA_AB_OUT_DIR,
 *      BVSALA_AB_REPS (paired reps for generative scenarios), BVSALA_AB_SEED,
 *      BVSALA_DEMO_KEEP_PREFIX, BVSALA_AB_BUDGET_USD (OBLIGATORIO en LIVE: aborta
 *      si la estimación lo supera y corta la tirada si el gasto real lo pasa),
 *      endpoints directos por familia BVSALA_DEMO_OPENAI_BASE_URL / _API_KEY y
 *      BVSALA_DEMO_GOOGLE_BASE_URL / _API_KEY, and optionally a judge endpoint
 *      BVSALA_JUDGE_BASE_URL / _API_KEY / _MODEL for LIVE answer-vs-answer QA.
 */
import { execSync } from "node:child_process";

import {
  BV_SALA_VERSION,
  createSavingsLayer,
  OpenAICompatibleProvider,
  PRICES_AS_OF,
  type CostModel,
  type Provider,
  type SavingsRequest,
  type SavingsResult,
  TokenizerRegistry,
  registerExactTokenizer,
} from "../src/index.js";
import type { ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import {
  scenarios,
  conSalDeFrio,
  conMuestreoPareado,
  conMargenDeRazonamiento,
  muestreoPareadoPara,
  llevaPistaDeLimites,
  estadoDePalanca,
  familiaDeModelo,
  noMedibleEnTransporte,
  LIBROS,
  PALANCAS_SIN_ESCENARIO,
  type LedgerTag,
  type EstadoDePalanca,
  type PalancaNoMedible,
  type Palanca,
  type Scenario,
  type TransporteDelBanco,
} from "./scenarios.js";
import {
  conReintentos,
  endpointDeModelo,
  proveedorDelBanco,
  proveedorDelBrazoNativo,
  sinSecretos,
  transporteDeModelo,
} from "./transporte.js";
import { compresorDeRepeticionesLiterales } from "./compresor.js";
import {
  construirBrazoNaive,
  construirBrazoNativo,
  construirBrazoRazonable,
  DEFINICION_DE_BRAZOS,
} from "./brazos.js";
import {
  ESFUERZOS_B2,
  HERRAMIENTAS_SOLO_SIN_RAZONAMIENTO_EN_CHAT,
  FUENTES,
  desnudo,
  planNativo,
  resumenDelPlan,
  resumirPlanes,
  type EsfuerzoB2,
  type PlanNativo,
} from "./nativo.js";
import {
  costeDeLlamada,
  escriturasDeLlamada,
  leerEscrituras,
  precioYPrima,
  usoCrudo,
  MENSAJE_DE_COMPACTACION,
  PRECIO_ILUSTRATIVO,
} from "./coste.js";
import { configDesdeEntorno, modoDe, resolverModelos, veredictoDePrevuelo } from "./modelos.js";
import { babosaDeModelo } from "./publish-guard.js";
import { avisoDeTruncado, cortadaPorElTope, veredictoDeCalidad } from "./verja-de-calidad.js";
import { bootstrapRatioCI, bootstrapRatioCIEstratificado, wilcoxonSignedRankP, mean, type CI } from "./stats.js";
import { writeReport, writeCsv } from "./report.js";
import { validateAgainstSchema } from "../src/constraints/validate.js";
import {
  conVerjaDeLatencia,
  cronometrar,
  resumirLatencias,
  type InformeLatencia,
  type MuestraLatenciaLegacy,
  type MuestrasPorBrazo,
} from "./b2/latencia.js";

function tryParseJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return undefined; }
}

/** Commit corto del árbol que produjo esta tirada, o "unknown" fuera de git. */
function gitCommitCorto(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

// ── Precios: el CATÁLOGO del SDK, y nada más (benchmarks/coste.ts). La tabla
// local `PRICES` que vivía aquí duplicaba el catálogo con otra fecha y otro
// criterio; una cifra con dos fuentes acaba teniendo dos valores. Como todos los
// brazos se tarifan con el MISMO modelo, un error de precio se cancela en el
// porcentaje salvo en la prima de escritura y la tarifa cacheada — que es
// justo lo que el catálogo tiene que decir bien.
const PRICING_NOTE =
  "USD per 1K tokens: the list prices of the SDK price catalogue (`catalogueDated`), the measured model's own row. " +
  "Cache writes are billed at the model's write premium (`cacheWrites.premium`), read from the provider's counter. " +
  "All arms share one price, so the savings % moves only with the cached and cache-write rates.";

/**
 * LOS ENDPOINTS, LEÍDOS DEL ENTORNO UNA SOLA VEZ Y AQUÍ.
 *
 * La decisión que sale de ellos vive en `benchmarks/transporte.ts`, sin entorno
 * y sin red, para que una verja pueda comprobarla sin pagar una tirada. Este
 * objeto es la única frontera con `process.env` para los endpoints: pasarela
 * (`BVSALA_DEMO_BASE_URL`), nativo de Anthropic (`BVSALA_DEMO_ANTHROPIC_*`: la
 * API de Mensajes, el único dialecto con `cache_control`) y directos por
 * familia (`BVSALA_DEMO_OPENAI_*`, `BVSALA_DEMO_GOOGLE_*`).
 */
const CONFIG_DE_TRANSPORTE = configDesdeEntorno(process.env);
/** LIVE si hay CUALQUIER endpoint declarado; sin ninguno, MOCK y lo dice. */
const mode: "LIVE" | "MOCK" = modoDe(CONFIG_DE_TRANSPORTE);
const keepPrefix = !!CONFIG_DE_TRANSPORTE.keepPrefix;

/** Por dónde va a hablar el banco con el proveedor PARA ESTE MODELO. */
const transporteDe = (model: string | null): TransporteDelBanco =>
  transporteDeModelo(model, CONFIG_DE_TRANSPORTE);

/**
 * LOS MODELOS QUE SE MIDEN, cada uno por separado.
 *
 * `BVSALA_DEMO_MODEL` sobrescribía el modelo de TODOS los escenarios y producía
 * UNA cifra: la del último modelo que alguien puso en el `.env`. El dueño
 * necesita la cifra de cada modelo, y sobre todo necesita que un escenario que
 * no aplica a un modelo (la caché de prefijo explícita de Anthropic contra un
 * endpoint de OpenAI) se SALTE en vez de medirse mal.
 *
 * `BVSALA_AB_PRESET=2026` mide los modelos de 2026 (benchmarks/modelos.ts).
 * Vacío todo = comportamiento de siempre: cada escenario con el modelo que declara.
 */
const RESOLUCION = resolverModelos(process.env);
/** `null` = no se fuerza ningún modelo; manda el de cada escenario. */
const modelosAMedir: (string | null)[] = RESOLUCION.modelos;
const SEED = intEnv("BVSALA_AB_SEED", 1234567);
/**
 * Remuestreos del bootstrap: el valor por defecto de `benchmarks/stats.ts`. Se
 * publica en `config.resamples` para que un tercero recalcule los agregados con
 * el CSV de ensayos (apps/web/public/measure/reproduce.mjs); la verja
 * `banco-seco-extremo-a-extremo` comprueba que el recálculo sale idéntico.
 */
const REMUESTREOS = 10_000;
/**
 * Nonce de TIRADA para la sal de frío: la caché de prefijo del proveedor vive
 * minutos, así que sin él la rep N de esta tirada pegaría con la rep N de la
 * anterior. Aleatorio a propósito — no participa en ninguna estadística.
 */
const NONCE_DE_TIRADA = Math.random().toString(36).slice(2, 8);
const REPS = intEnv("BVSALA_AB_REPS", mode === "LIVE" ? 8 : 4);
// Adaptive sampling (LIVE only): keep drawing paired reps for a noisy scenario
// until its savings CI is tight enough, or a hard cap is reached. Deterministic
// MOCK converges immediately (CI half-width 0).
const MAX_REPS = intEnv("BVSALA_AB_MAX_REPS", REPS * 3);
const CI_TARGET = Number(process.env.BVSALA_AB_CI_TARGET ?? 0.03); // desired ± half-width on the savings fraction
const QUALITY_FLOOR = Number(process.env.BVSALA_AB_QUALITY_FLOOR ?? 0.999);
/**
 * EL SEGUNDO BRAZO DE CONTROL (B1, «integración razonablemente optimizada»),
 * encendido por defecto: la guía de investigación exige publicar el ahorro
 * frente a B0 Y frente a B1, y sin el segundo no se sabe qué parte del titular
 * es mérito del SDK y qué parte es el descuento del proveedor o el JSON compacto
 * que un cliente razonable ya tendría. Cuesta una llamada más por repetición;
 * BVSALA_AB_B1=0 vuelve al banco de dos brazos. Ver benchmarks/brazos.ts.
 */
const B1_ACTIVO = process.env.BVSALA_AB_B1 !== "0";

/**
 * EL TERCER BRAZO DE CONTROL (B2, «nativo bien configurado»), encendido por
 * defecto: B1 más lo que el proveedor documenta gratis para esta forma de
 * petición (benchmarks/nativo.ts). Es la comparación con la que va a medirnos
 * un comprador técnico (informe de competencia, §4.3 y §8 rec. 3). Cuesta una
 * llamada más por repetición; BVSALA_AB_B2=0 lo apaga, y entonces el artefacto
 * no se puede publicar.
 */
const B2_ACTIVO = process.env.BVSALA_AB_B2 !== "0";
/** El esfuerzo de razonamiento de B2. `low` por defecto; ver la decisión D3 en el README. */
const ESFUERZO_B2_CRUDO = (process.env.BVSALA_AB_B2_EFFORT ?? "low").trim();
const ESFUERZO_B2: EsfuerzoB2 = (ESFUERZOS_B2 as readonly string[]).includes(ESFUERZO_B2_CRUDO)
  ? (ESFUERZO_B2_CRUDO as EsfuerzoB2)
  : "low";
/**
 * El margen de razonamiento (tokens), declarado por el dueño tras la tirada de
 * calibración y nunca inventado: 0 por defecto. Ver `conMargenDeRazonamiento`.
 */
const MARGEN_RAZONAMIENTO = enteroNoNegativo(process.env.BVSALA_AB_MARGEN_RAZONAMIENTO);
/** Correr (nunca publicar) un modelo sin fila de catálogo, con el precio ilustrativo. */
const PERMITIR_ILUSTRATIVO = process.env.BVSALA_AB_PERMITIR_PRECIO_ILUSTRATIVO === "1";
/** El presupuesto de la tirada: obligatorio en LIVE (lo exige el prevuelo). */
const PRESUPUESTO = Number(process.env.BVSALA_AB_BUDGET_USD ?? NaN);

/**
 * ¿MIDE ESTA TIRADA EL SDK TAL COMO SE INSTALA DESDE NPM? Sí, POR DEFECTO.
 *
 * El paquete de npm solo trae `noopCompressor`; el compresor de
 * `benchmarks/compresor.ts` es del banco y no viaja. Con él, el escenario de
 * compresión ahorra lo que un cliente NO puede ahorrar, y el titular de la web
 * del 2026-09-12 (≥ 23,2 %) se midió así: 15,1 % de ahorro en un escenario caro
 * que, con el SDK instalado, no comprime nada. Hasta el 2026-09-27 el modo
 * honesto era el que había que pedir (`BVSALA_AB_SIN_COMPRESOR=1`) y el de
 * investigación el que salía sin pedir nada. Ahora es al revés: `pnpm ab` mide
 * lo que el cliente instala, y el compresor del banco hay que pedirlo con
 * `BVSALA_AB_CON_COMPRESOR=1`. La decisión se SELLA en el artefacto
 * (`sdk.asShipped`) y `pnpm ab:publish` rechaza cualquier artefacto sin
 * `asShipped: true`, MOCK incluido.
 *
 * `asShipped` depende SOLO de `BVSALA_AB_CON_COMPRESOR`.
 */
const CON_COMPRESOR = process.env.BVSALA_AB_CON_COMPRESOR === "1";
const SDK_TAL_COMO_SE_INSTALA = !CON_COMPRESOR;
/** La variable antigua: `1` ya es lo que hace el banco; otro valor es un malentendido. */
const SIN_COMPRESOR_OBSOLETA = process.env.BVSALA_AB_SIN_COMPRESOR || undefined;

/**
 * EL SELLO DEL SDK MEDIDO, el mismo en el artefacto de un modelo y en el
 * informe multi-modelo. Tres cosas que un lector necesita para saber si la
 * cifra es la de SU instalación:
 *
 *   · `asShipped`: sin piezas que el banco inyecta y npm no trae (el
 *     compresor). Es lo que exige `pnpm ab:publish`.
 *   · `version`: la de `src/` en este commit, que es lo que el banco importa
 *     (`../src/index.js`), NO el tarball publicado. Si `main` va por delante de
 *     npm, la tirada mide código que aún no se puede instalar; por eso se sella
 *     la versión, para compararla con `npm view @bivelio/savings-layer version`.
 *   · `tokenizer`: el banco registra el tokenizador exacto (gpt-tokenizer, una
 *     dependencia opcional del paquete). Una instalación que no lo añada usa el
 *     estimador heurístico, que interviene en la elección TOON/JSON y en las
 *     verjas de compresión. Se declara en vez de callarlo.
 */
function selloDelSdk(): { version: string; asShipped: boolean; compressor: string; tokenizer: string } {
  return {
    version: BV_SALA_VERSION,
    asShipped: SDK_TAL_COMO_SE_INSTALA,
    compressor: SDK_TAL_COMO_SE_INSTALA
      ? "none: the npm package ships noopCompressor only, so a request that asks for compression is sent uncompressed"
      : "bench-only literal-repetition compressor (benchmarks/compresor.ts), NOT shipped on npm: research run, not a headline",
    tokenizer: tokenizadorExacto
      ? "exact (gpt-tokenizer registered; an optional dependency of the package — without it the SDK uses its heuristic estimator)"
      : "heuristic estimator (gpt-tokenizer not installed): token counts are ESTIMATED",
  };
}

/**
 * Sin compresor la capa no deja traza de la etapa de compresión (solo avisa por
 * consola), y el motivo genérico «la capa no dejó traza» se leería como un fallo
 * del banco. No lo es: es lo que entrega el paquete. Se dice con esas palabras.
 */
function conMotivoDelPaquete(p: EstadoDePalanca | null): EstadoDePalanca | null {
  if (!p || !SDK_TAL_COMO_SE_INSTALA || p.palanca !== "compression" || p.ejercitada) return p;
  return {
    ...p,
    motivo:
      "not run: the npm package ships noopCompressor only, so the request travels uncompressed; " +
      "this scenario is still measured because it is traffic a customer sends, and its saving is what the shipped SDK achieves on it",
  };
}

/**
 * EL AVISO MÁS CARO DEL BANCO, y va junto a la cifra que desmiente — no en un
 * fichero que hay que ir a buscar.
 *
 * En MOCK el codebook de salida sale ahorrando SIEMPRE, contra cualquier modelo
 * simulado, porque `providers/mock.ts` fabrica la respuesta A PARTIR DEL ESQUEMA
 * que recibe: dale un contrato compacto y fabrica una respuesta compacta. La
 * mitad de esta palanca que de verdad decide el dinero —cuánto elige ESCRIBIR un
 * modelo de verdad— el simulador no la modela en absoluto.
 *
 * Y en vivo esa mitad cambia de SIGNO según el modelo, lo que hace que este
 * aviso no sea prudencia genérica sino un hecho medido. Con solo la tirada de
 * `gpt-4o-mini` la conclusión fue «retirar la palanca»; la de `gpt-4o` la
 * invirtió. Una tirada contra un solo modelo no es un resultado — y eso vale
 * para todas las filas de este informe, no solo para ésta.
 */
const AVISO_MOCK_DEL_CODEBOOK =
  "    · outputCodebook: ⚠ SE EJERCITÓ, Y SU CIFRA NO VALE. El proveedor simulado fabrica la\n" +
  "      respuesta DESDE EL ESQUEMA, así que un contrato compacto le sale siempre en una\n" +
  "      respuesta compacta: en MOCK esta palanca ahorra por construcción, contra cualquier\n" +
  "      modelo. Medido en vivo sobre el MISMO escenario y con 8 pares por modelo:\n" +
  "          gpt-4o        A 184/75 → B 158/72   salida −3 tokens   → +8,0 % (95%lo 4,8 %)\n" +
  "          gpt-4o-mini   A 184/72 → B 158/88   salida +16 tokens  → −8,2 %\n" +
  "      La ENTRADA baja igual en los dos (−26): eso es el esquema compacto y es determinista.\n" +
  "      Lo que cambia de signo es la SALIDA, y depende del MODELO. Con solo la tirada del\n" +
  "      pequeño se concluyó «retirar la palanca» y la del grande lo invirtió: UNA TIRADA\n" +
  "      CONTRA UN SOLO MODELO NO ES UN RESULTADO, aquí ni en ninguna otra fila.";

function intEnv(name: string, def: number): number {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

/** Un entero ≥ 0 desde una variable; ausente o inválido = 0. */
function enteroNoNegativo(v: string | undefined): number {
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Raw provider (Arm A calls this directly, bypassing the layer).
 *
 * EL ADAPTADOR SE ELIGE POR EL MODELO, y ése era el fallo: `makeProvider()`
 * instanciaba SIEMPRE `OpenAICompatibleProvider`, así que el escenario de
 * Anthropic —el único que mide `cache_control`— hablaba el protocolo
 * equivocado. La palanca del PR #71 no la había medido nadie y el informe
 * publicaba su cero como si fuera un resultado.
 *
 * Sin endpoint nativo declarado NO se cae a la pasarela para esa familia: el
 * escenario que depende del protocolo se declara no medible antes de gastar un
 * céntimo (ver `repartirEscenarios`). Los demás escenarios sí van por la
 * pasarela con un modelo de Anthropic — no dependen del dialecto — y eso es lo
 * que permite seguir teniendo una cifra por modelo.
 */
// `conReintentos`: una tirada LIVE son cientos de llamadas secuenciales y los
// artefactos se escriben al final — sin esto, un solo timeout de red tira horas
// de llamadas pagadas (pasó el 2026-08-24, en el cuarto modelo de cuatro).
const makeProvider = (model: string | null): Provider =>
  conReintentos(proveedorDelBanco(model, CONFIG_DE_TRANSPORTE));

// ── EL GASTO REAL, LLAMADA A LLAMADA ─────────────────────────────────────────
//
// La estimación de antes de empezar es un techo SOLO donde el escenario declara
// su tope de salida: sin tope, un modelo que razona puede escribir lo que
// quiera. Así que la tirada lleva la cuenta de lo que de verdad gasta —toda
// llamada al proveedor: sondeo, los cuatro brazos y la amortización; el juez
// no, y se dice— y se corta en cuanto pasa `BVSALA_AB_BUDGET_USD`.

/** El presupuesto se agotó: el modelo en curso no se publica y los siguientes no se miden. */
class PresupuestoAgotado extends Error {
  constructor(readonly gastado: number, readonly presupuesto: number) {
    super(`running spend ${gastado.toFixed(4)} USD passed BVSALA_AB_BUDGET_USD = ${presupuesto} USD`);
    this.name = "PresupuestoAgotado";
  }
}

const GASTO = {
  total: 0,
  /** Llamadas vistas y cuántas trajeron el contador de escritura de caché. */
  llamadas: 0,
  informadas: 0,
  /**
   * Lo mismo, solo en modelos que PAGAN la escritura a prima (> 1). Es lo que
   * decide `pricing.cacheWrites.metered`: sin prima, una escritura sin contador
   * cuesta lo mismo que la entrada normal y no mueve el coste.
   */
  llamadasConPrima: 0,
  informadasConPrima: 0,
  /** De dónde salió el contador de escritura, llamada a llamada (adaptador, respuesta cruda, ninguno). */
  fuentes: { adapter: 0, "raw-usage": 0, none: 0 } as Record<"adapter" | "raw-usage" | "none", number>,
  /** Alguna respuesta traía `usage.iterations` de compactación (ningún brazo la manda). */
  compactacion: false,
};

/** Una foto del contador, para restar lo que gastó UN modelo de la tirada. */
function fotoDelGasto() {
  return {
    total: GASTO.total,
    llamadas: GASTO.llamadas,
    informadas: GASTO.informadas,
    llamadasConPrima: GASTO.llamadasConPrima,
    informadasConPrima: GASTO.informadasConPrima,
    fuentes: { ...GASTO.fuentes } as Record<string, number>,
  };
}

/**
 * Cuenta el coste de cada llamada que pasa por aquí, sin lanzar nunca: vive
 * también DENTRO de la capa (brazo B), donde una excepción del banco se
 * confundiría con un fallo del proveedor. La tirada comprueba presupuesto y
 * compactación FUERA de la capa, en `comprobarGasto()`.
 */
function conContadorDeGasto(p: Provider, model: string): Provider {
  return {
    id: p.id,
    async generate(req) {
      const resp = await p.generate(req);
      const { precio, prima } = precioYPrima(model);
      const e = leerEscrituras(resp);
      GASTO.total += costeDeLlamada(precio, prima, resp.usage, e.escrituras);
      GASTO.llamadas++;
      if (e.informada) GASTO.informadas++;
      if (prima > 1) {
        GASTO.llamadasConPrima++;
        if (e.informada) GASTO.informadasConPrima++;
      }
      GASTO.fuentes[e.fuente]++;
      if (e.compactacion) GASTO.compactacion = true;
      return resp;
    },
  };
}

/** Para la tirada si se pasó del presupuesto o si apareció una compactación. */
function comprobarGasto(): void {
  if (GASTO.compactacion) throw new Error(MENSAJE_DE_COMPACTACION);
  if (mode === "LIVE" && Number.isFinite(PRESUPUESTO) && GASTO.total > PRESUPUESTO) {
    throw new PresupuestoAgotado(GASTO.total, PRESUPUESTO);
  }
}

const modelId = (r: SavingsRequest, forzado: string | null): string => forzado ?? r.model;

// ── Tokenizador EXACTO. Una tirada que hace afirmaciones en dólares no puede
// contar con el estimador heurístico: mide 2171 tokens donde o200k_base mide
// 1155 en el mismo JSON (1,88x), y ese sesgo NO se cancela al restar contra un
// formato distinto. Con él registrado, `basis` puede ser "measured"; sin él, el
// propio layer degrada a "estimated" y la tirada lo dirá.
const registroTokens = new TokenizerRegistry();
const tokenizadorExacto = await registerExactTokenizer(registroTokens);
if (!tokenizadorExacto) {
  console.warn(
    "[ab] gpt-tokenizer no está instalado: se usará el estimador heurístico y la " +
      "contabilidad se publicará como ESTIMADA. Instálalo con `pnpm add -D gpt-tokenizer`.",
  );
}

/**
 * Todas las capas de la tirada comparten el mismo registro y el mismo proveedor.
 *
 * LA MEMORIA DE CONTRATOS SE ESTRENA EN CADA LLAMADA MEDIDA, igual que la caché.
 * El titular es «por llamada fría»: el brazo B es una capa nueva por repetición
 * para que ningún acierto de caché se precaliente. Hasta el 2026-09-12 la
 * memoria de contratos era la excepción: un `Set` único a nivel de módulo para
 * TODA la tirada. Cuando un contrato incumple una restricción de valor, la capa
 * lo apunta y desde entonces antepone a cada petición de ese contrato la pista
 * `JSON limits (not API-enforced): …` (~30 tokens de entrada en el cable y una
 * salida más larga; solo la paga el brazo B). Eso es coste REAL de la capa y
 * está bien medirlo — pero con una memoria compartida, cuándo se encendía
 * dependía de lo que el modelo hubiera contestado antes en la misma tirada:
 *
 *   tirada publicada (f2f2143):  «Stable-prefix» B +12 tokens de entrada de media
 *                                (la pista se encendió a mitad del escenario)
 *   2026-09-12 v1 (0bd1d83):     «Stable-prefix» B +33 en las 24 repeticiones,
 *                                salida 81 frente a 65 del A
 *   2026-09-12 v2:               «Constrained» B +27 en 23 de 24 repeticiones,
 *                                y una repetición con reparación de dos llamadas
 *
 * En esas tiradas el disparador fue casi siempre el propio escenario (su sondeo
 * o una repetición suya); el contagio entre escenarios era POSIBLE —ocho
 * escenarios comparten el contrato `answerContract` de scenarios.ts— y no se
 * podía distinguir. Nada de eso cambió en la capa: la petición del brazo B es
 * idéntica byte a byte entre esos commits (reproducido offline).
 *
 * Ahora cada llamada medida estrena su memoria: la repetición es reproducible,
 * la reparación dentro de UNA llamada (dos llamadas al proveedor, ambas
 * contadas) sigue siendo coste de la capa, y `pistaDeLimites` dice en cuántas
 * repeticiones viajó la pista. Lo que ya no se mide es el estado «caliente» de
 * una capa que aprendió de una llamada anterior: eso es tráfico repetido, y el
 * tráfico repetido va en la amortización, no en el titular.
 */
const nuevaCapa = (provider: Provider, model: string, memoriaDeContratos: Set<string>) =>
  createSavingsLayer({
    provider,
    defaultCostModel: priceFor(model),
    tokenizer: registroTokens,
    constraintMemory: memoriaDeContratos,
    // EL COMPRESOR VA EN TODAS LAS CAPAS, no solo en la del escenario que lo
    // usa: la palanca `compression` es opt-in POR PETICIÓN, así que quien decide
    // si corre es el escenario, y quien decide si vale la pena son las tres
    // verjas económicas del pipeline. Un contexto corto no lo activa por mucho
    // que el compresor esté ahí (mínimo de 2000 tokens comprimibles), y eso es
    // comprobable: los demás escenarios siguen midiendo lo mismo con y sin él.
    //
    // Sin esto, el escenario de compresión no comprime NADA y el informe
    // publicaría un 0% que se lee como "la compresión no ahorra".
    // Desde el 2026-09-27 SOLO va con BVSALA_AB_CON_COMPRESOR=1 (investigación):
    // por defecto el banco mide EL SDK TAL COMO SE INSTALA. Es la tirada honesta
    // para la web: `defaults.ts` no
    // resuelve ningún compresor y el pipeline avisa por consola de que «se pidió
    // compression pero esta capa no tiene compresor, así que NO se comprime
    // nada» — o sea que el 0 % de ese escenario no es un defecto del banco, es
    // lo que obtiene quien instala hoy. Publicar el titular CON un compresor que
    // no viaja en el paquete es cobrar por una palanca que el cliente no tiene.
    ...(SDK_TAL_COMO_SE_INSTALA ? {} : { compressor: compresorDeRepeticionesLiterales }),
    // `compressionEconomics.prefix` NO se declara a propósito. Es la tasa de
    // aciertos de prefijo del tráfico, y nadie la ha medido para este banco;
    // inventarla desbloquea la decisión completa a cambio de un número falso. Sin
    // ella la capa se niega a comprimir un prompt fuera del tramo cacheable, que
    // es la abstención honesta.
  });

/**
 * El precio del modelo: la fila del PROPIO modelo en el catálogo de precios de
 * lista del SDK (benchmarks/coste.ts). Sin fila, el precio ilustrativo — y el
 * prevuelo no deja gastar con él salvo `BVSALA_AB_PERMITIR_PRECIO_ILUSTRATIVO=1`,
 * y la verja de publicación no deja publicarlo nunca (`pricing.listPriceKnown`).
 */
function priceFor(model: string): CostModel {
  return precioYPrima(model).precio;
}

/** ¿El precio de este modelo sale de su fila del catálogo, o del ilustrativo? */
function precioConocido(model: string): boolean {
  return precioYPrima(model).conocido;
}

/**
 * El reparto entrada/salida del gasto, EN DINERO y no en tokens.
 *
 * La distinción no es cosmética: la salida cuesta unas 4x por token, así que un
 * tráfico con 80% de tokens de entrada tiene una factura repartida al 50/50. Un
 * plan que razone sobre el reparto de TOKENS presupuesta mal las palancas.
 */
function repartoDeLaFactura(
  model: string,
  entradaTokens: number,
  salidaTokens: number,
): { entrada: number; salida: number } {
  const p = priceFor(model);
  const entrada = (entradaTokens / 1000) * p.inputPer1k;
  const salida = (salidaTokens / 1000) * p.outputPer1k;
  const total = entrada + salida;
  return total > 0 ? { entrada: entrada / total, salida: salida / total } : { entrada: 0, salida: 0 };
}

interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}
/**
 * El coste de una llamada, con sus ESCRITURAS de caché a la prima del modelo
 * (1,25× en Anthropic y en GPT-5.6+). Antes se cobraban a 1× en todos los
 * brazos, y eso escondía justo lo que el modo de caché explícito de B2 ahorra.
 */
function cost(model: string, u: Usage, escrituras = 0): number {
  const { precio, prima } = precioYPrima(model);
  return costeDeLlamada(precio, prima, u, escrituras);
}

/**
 * Arm A — the naive request an un-optimized team would send. La definición
 * vive en benchmarks/brazos.ts junto a la del brazo A1, para que los tests
 * puedan afirmar qué manda cada uno sin arrancar la tirada.
 */
function buildNaive(req: SavingsRequest, forzado: string | null): ProviderRequest {
  return construirBrazoNaive(req, modelId(req, forzado));
}

type Kind = "resolver" | "cache" | "ran";

/**
 * El modelo que el proveedor dice haber servido. Se normaliza el prefijo de
 * proveedor ("openai/gpt-4o-mini" y "gpt-4o-mini" son el mismo modelo) porque a
 * través de una pasarela el eco puede traerlo o no.
 */
function modeloDe(raw: unknown): string | null {
  const m = (raw as { model?: unknown } | undefined)?.model;
  return typeof m === "string" && m ? m.replace(/^[^/]+\//, "") : null;
}

function usageOf(res: SavingsResult): Usage {
  const t = res.report.tokens;
  return {
    inputTokens: t.actualInput,
    outputTokens: t.actualOutput,
    ...(t.providerCachedInput ? { cachedInputTokens: t.providerCachedInput } : {}),
  };
}

/** Los contadores facturables de una respuesta cruda del proveedor. */
function usoDe(resp: ProviderResponse): Usage {
  return {
    inputTokens: resp.usage.inputTokens,
    outputTokens: resp.usage.outputTokens,
    ...(resp.usage.cachedInputTokens != null ? { cachedInputTokens: resp.usage.cachedInputTokens } : {}),
  };
}

/** Tokens de las definiciones de herramientas, en la forma en que viajan por Chat Completions. */
function tokensDeHerramientas(tools: SavingsRequest["tools"], model: string): number {
  if (!tools?.length) return 0;
  return tokensDe(
    JSON.stringify(
      tools.map((t) => ({
        type: "function",
        function: { name: t.id, description: t.description, parameters: t.parameters ?? {} },
      })),
    ),
    model,
  );
}

function safeExpect(s: Scenario, res: SavingsResult): boolean {
  try {
    return s.expect ? s.expect(res) : true;
  } catch {
    return false;
  }
}

interface LatenciasPareadas {
  A: MuestraLatenciaLegacy;
  A1?: MuestraLatenciaLegacy;
  A2?: MuestraLatenciaLegacy;
  B: MuestraLatenciaLegacy;
}

interface ParDeEnsayo {
  costA: number;
  costA1?: number;
  costA2?: number;
  costB: number;
  latencies: LatenciasPareadas;
}

interface ScenarioResult {
  name: string;
  lever: string;
  ledger: string;
  /** El modelo que se le PIDIÓ al proveedor en esta tirada. */
  model: string;
  /** La palanca opt-in del escenario y si llegó a disparar. `null` = no declara ninguna. */
  palanca: EstadoDePalanca | null;
  kind: Kind;
  reps: number;
  armA: { meanInputTokens: number; meanOutputTokens: number; meanCost: number };
  /** Brazo A1 (B1, integración razonablemente optimizada). Ausente si BVSALA_AB_B1=0. */
  armA1?: { meanInputTokens: number; meanOutputTokens: number; meanCost: number };
  /** Brazo A2 (B2, nativo bien configurado). Ausente si BVSALA_AB_B2=0. */
  armA2?: { meanInputTokens: number; meanOutputTokens: number; meanCost: number };
  armB: { meanInputTokens: number; meanOutputTokens: number; meanCost: number };
  measured: {
    inputTokenDeltaMean: number;
    outputTokenDeltaMean: number;
    savings: CI;
    wilcoxonP: number;
  };
  /**
   * El ahorro de B frente a B1, con su propio intervalo. Es la cifra que la guía
   * llama «el valor adicional de Savings»: lo que queda después de descontar lo
   * que un cliente razonable ya tendría sin nosotros.
   */
  measuredB1?: {
    inputTokenDeltaMean: number;
    outputTokenDeltaMean: number;
    savings: CI;
    wilcoxonP: number;
  };
  /**
   * El ahorro de B frente a B2: lo que queda después de TODO lo que el
   * proveedor da gratis para esta petición. Ausente si BVSALA_AB_B2=0.
   */
  measuredB2?: {
    inputTokenDeltaMean: number;
    outputTokenDeltaMean: number;
    savings: CI;
    wilcoxonP: number;
  };
  /** Qué ajustes nativos aplicó B2 en ESTE escenario y cuáles no, con el motivo. */
  native?: ReturnType<typeof resumenDelPlan>;
  /** Cuántas respuestas de B2 cumplían el contrato: B2 puede ahorrar contestando peor (esfuerzo bajo). */
  nativeContractValid?: { valid: number; total: number };
  /** Tokens de ESCRITURA de caché por brazo (suma de la tirada), a la prima del modelo en el coste. */
  cacheWrites: { naive: number; razonable?: number; nativo?: number; optimizado: number };
  /** Tokens de razonamiento oculto por brazo, cuando el proveedor los declara (OpenAI). */
  reasoningTokens: { naive: number; razonable?: number; nativo?: number; optimizado: number };
  /** El muestreo que recibieron TODOS los brazos de este escenario. */
  sampling: { temperature: number | null; seed: number | null };
  /**
   * FORMA DE LA FACTURA del brazo naive: qué fracción del dinero es entrada y
   * qué fracción es salida.
   *
   * Sin esto el titular es imposible de interpretar, y llevábamos tiempo
   * publicándolo. `docs/ROADMAP-ALGORITMOS.md` declaraba 36,3/63,7; recomputar
   * el propio artefacto de este banco da 46,4/53,6; y la tirada del 2026-08-13
   * contra el proveedor real, con preguntas de FAQ de ~16 tokens, daba 3,8/96,2.
   * Los tres son ciertos sobre tráficos distintos, y cambian el valor de cada
   * palanca por un factor de tres: una palanca que solo toca la entrada vale
   * mucho o no vale NADA según cuál de las tres sea el tráfico del cliente.
   *
   * Se publica por escenario y agregada, para que nadie tenga que recomputarla
   * a mano desde el CSV como hubo que hacer.
   */
  formaFactura: { entrada: number; salida: number };
  /**
   * Tokens que el PROVEEDOR dice haber servido desde su caché de prefijo, en los
   * DOS brazos. El brazo naive también cuenta, y es la mitad que faltaba: si el
   * cliente ya obtiene ese descuento sin nosotros y nuestra compresión lo saca
   * del tramo mínimo, le estamos QUITANDO dinero mientras el informe dice que se
   * lo ahorramos. `attribution` solo miraba el brazo optimizado.
   */
  cacheDePrefijo: { naive: number; razonable?: number; nativo?: number; optimizado: number };
  quality: { gate: string; passed: number; total: number };
  /** Cuántas respuestas del brazo NAIVE cumplían el contrato que se le pidió. */
  naiveContractValid: { valid: number; total: number };
  /**
   * Repeticiones que el PROVEEDOR cortó al agotar el tope, por brazo.
   *
   * Va en la fila y no solo en el agregado porque es lo que convierte un «calidad
   * 0/8» ilegible en un diagnóstico: la tirada del 2026-08-16 obligó a deducirlo
   * comparando los tokens de salida con el tope, a mano y desde un CSV.
   */
  truncated: { naive: number; razonable?: number; nativo?: number; optimizado: number };
  /**
   * En cuántas repeticiones la petición del brazo B llevó la PISTA DE LÍMITES
   * de la capa (`JSON limits (not API-enforced): …`). Solo la lleva el B, y
   * como cada llamada medida estrena su memoria, solo puede aparecer en la
   * SEGUNDA llamada de una reparación dentro de esa misma repetición. Cuesta
   * ~30 tokens de entrada más una salida más larga; se cuenta para que la fila
   * diga cuántas repeticiones repararon.
   */
  pistaDeLimites: { reps: number; total: number };
  /** Provably positive savings at 95% AND every answer passed the gate. */
  proven: boolean;
  /**
   * True cuando LOS DOS BRAZOS hablaron con el mismo modelo en todas las reps.
   * Esta es la garantía que hace comparable un A/B pareado.
   */
  modelStable: boolean;
  servedModels: string[];
  /**
   * INFORMATIVO, nunca una verja: a través de una pasarela `system_fingerprint`
   * es un id por petición, así que exigir que sea estable haría imposible
   * demostrar nada.
   */
  fingerprints: string[];
  amortization?: { coldMissCost: number; hitCost: number; breakEvenK: number | null };
  attribution: {
    avoidedCall: boolean;
    eliminatedInputTokens: number;
    compressedInputTokens: number;
    providerCachedInputTokens: number;
  };
  paired: ParDeEnsayo[];
  latency: InformeLatencia;
  /** Muestras internas: el agregado incluye sonda y amortización, no solo las parejas del CSV. */
  latencySamples: MuestrasPorBrazo;
  /** El plan de B2 de este escenario (interno: se resume en `native` y en el agregado). */
  planB2?: PlanNativo;
  /** Escrituras de caché de B2 en las repeticiones SIN breakpoint, y de B0 en esas mismas. */
  sondaDeModo?: { escriturasB2SinBreakpoint: number; escriturasB0: number; reps: number };
}

async function runScenario(s: Scenario, forzado: string | null): Promise<ScenarioResult> {
  // El adaptador se elige por el modelo QUE SE VA A PEDIR, así que se instancia
  // después de resolverlo — y el de este escenario puede no ser el forzado.
  const transporte = transporteDe(forzado ?? s.request.model);
  // Toda llamada de este escenario pasa por el contador de gasto (sondeo,
  // brazos, amortización): el presupuesto se comprueba con lo que se GASTA.
  const provider = conContadorDeGasto(makeProvider(forzado ?? s.request.model), forzado ?? s.request.model);
  const model = modelId(s.request, forzado);
  // Todos los brazos tienen que muestrear de la MISMA distribución, y cuál es
  // lo decide el MODELO (`muestreoPareadoPara`): temperature 0 y seed 7 donde se
  // honran; nada donde el proveedor los rechaza (Claude Sonnet 5: 400) o solo
  // acepta el suyo (gpt-5, gpt-6). Hasta el 2026-09-27 esta petición fijaba
  // 0/7 a mano y la primera llamada contra un modelo de 2026 habría sido un
  // 400. Lo pone `conMuestreoPareado` en `reqDeRep`, para todos los brazos.
  //
  // Y el margen de razonamiento va AQUÍ, sobre la petición del escenario, para
  // que lo reciban los cuatro brazos por igual (el que atraviesa la capa
  // incluido): solo en modelos que razonan y solo si el dueño lo declaró.
  const req: SavingsRequest = conMargenDeRazonamiento(
    { ...s.request, ...(forzado ? { model: forzado } : {}) },
    model,
    MARGEN_RAZONAMIENTO,
  );
  const muestreo = muestreoPareadoPara(model);

  // FRÍO POR CONSTRUCCIÓN. Contra un endpoint que cachea prefijos solo (OpenAI,
  // con cualquier prompt ≥1024 tokens), repetir el prompt idéntico calienta los
  // dos brazos a partir de la rep 2 — y la sonda de clasificación ya calienta el
  // del brazo B antes de la rep 1. El titular «por llamada fría» pasaba a medir
  // una mezcla mayormente caliente (2026-09-01, api.openai.com: 43,9 % la rep
  // fría, 14,4 % las calientes, 12,8 % el agregado publicado como «frío»). La
  // sal por repetición viaja idéntica en los dos brazos, así que la comparación
  // sigue siendo pareada; el nonce de tirada evita que una tirada pegue con la
  // caché aún viva de la anterior. Los escenarios cuyo VALOR es el prefijo
  // estable (warm, prefijoEstable, palanca providerPrefixCache) no se salan.
  const salar = !s.warm && s.prefijoEstable !== true && s.palanca !== "providerPrefixCache";
  // Y el MISMO muestreo que el brazo A: `buildNaive` siempre mandó 0/7, y la
  // petición del escenario no declara ninguno, así que el brazo B iba con el
  // valor por defecto del proveedor. Ver `MUESTREO_PAREADO`.
  const reqDeRep = (marca: string): SavingsRequest =>
    conMuestreoPareado(salar ? conSalDeFrio(req, `${NONCE_DE_TIRADA}-${marca}`) : req);

  // Cada capa de este escenario estrena su memoria de contratos (ver `nuevaCapa`).
  const memoriaNueva = (): Set<string> => new Set<string>();

  // ── EL BRAZO B2 de este escenario ──────────────────────────────────────────
  // El plan (benchmarks/nativo.ts) depende de la petición: el breakpoint va
  // donde acaba SU prefijo estable, y la búsqueda de herramientas mira cuántas
  // herramientas tiene la integración (las de B0) y cuánto pesan sus esquemas.
  const numHerramientas = req.tools?.length ?? 0;
  const tokensDeEsquemas = tokensDeHerramientas(req.tools, model);
  const planPara = (r: ProviderRequest): PlanNativo =>
    planNativo({
      modelo: model,
      transporte,
      peticion: r,
      esfuerzo: ESFUERZO_B2,
      numHerramientas,
      tokensDeEsquemas,
      ...(s.toolsB1 ? { noDiferidas: s.toolsB1 } : {}),
    });
  // ¿Usa B2 la búsqueda de herramientas del proveedor? Lo decide la regla una
  // vez por escenario: con ella B2 manda todas las herramientas (el proveedor
  // elige), sin ella las de B1.
  const busquedaB2 = B2_ACTIVO
    ? planPara(construirBrazoRazonable(req, model, s.toolsB1 ? { toolsB1: s.toolsB1 } : {})).decisiones.some(
        (d) => d.funcion === "toolSearch" && d.aplicada,
      )
    : false;
  const proveedorB2 = B2_ACTIVO
    ? conContadorDeGasto(proveedorDelBrazoNativo(model, CONFIG_DE_TRANSPORTE, planPara), model)
    : undefined;
  let planB2: PlanNativo | undefined;
  const sondaDeModo = { escriturasB2SinBreakpoint: 0, escriturasB0: 0, reps: 0 };

  const latencias: MuestrasPorBrazo = {
    A: [],
    ...(B1_ACTIVO ? { A1: [] } : {}),
    ...(B2_ACTIVO ? { A2: [] } : {}),
    B: [],
  };
  const paired: ParDeEnsayo[] = [];
  const aIn: number[] = [], aOut: number[] = [], bIn: number[] = [], bOut: number[] = [];
  const a1In: number[] = [], a1Out: number[] = [];
  const a2In: number[] = [], a2Out: number[] = [];
  const fingerprints = new Set<string>();
  // Lo que de verdad hay que garantizar: que los DOS brazos hablaron con el
  // mismo modelo. La verja anterior solo recogía el fingerprint del brazo A y
  // nunca los comparaba, mientras el README y la verja de publicación afirmaban
  // literalmente "los dos brazos no midieron el mismo modelo". Y encima
  // `system_fingerprint` a través de una pasarela es un id POR PETICIÓN (14 de
  // 14 distintos en la primera tirada), así que como señal de estabilidad es
  // inalcanzable: proven=true nunca podría darse con más de una repetición.
  const modelosServidos = new Set<string>();
  let naiveValid = 0;
  let naiveTotal = 0;
  let truncadasA = 0;
  let truncadasA1 = 0;
  let truncadasA2 = 0;
  let truncadasB = 0;
  let nativoValid = 0;
  let nativoTotal = 0;
  // Escrituras de caché y razonamiento oculto por brazo: la prima se cobra en
  // el coste, y el razonamiento explica una salida larga sin que nadie la vea.
  const escrituras = { naive: 0, razonable: 0, nativo: 0, optimizado: 0 };
  const razonamiento = { naive: 0, razonable: 0, nativo: 0, optimizado: 0 };
  let escriturasEnEstaRep = 0;
  let razonamientoEnEstaRep = 0;
  let proveedorEnEstaRep = 0;
  /**
   * Envuelve el proveedor para poder ver qué modelo sirvió al brazo B, y si la
   * petición llevaba la pista de límites de la capa: es la única forma de saber
   * cuántas repeticiones midieron la petición CON pista y cuántas SIN ella.
   */
  let pistaEnEstaRep = false;
  let repsConPista = 0;
  const espia: Provider = {
    id: provider.id,
    generate: async (r) => {
      if (llevaPistaDeLimites(r.messages)) pistaEnEstaRep = true;
      const medida = await cronometrar(() => provider.generate(r));
      const resp = medida.value;
      proveedorEnEstaRep += medida.durationMs;
      const m = modeloDe(resp.raw);
      if (m) modelosServidos.add(m);
      // Las escrituras de TODAS las llamadas de la capa en esta repetición
      // (sondeo de herramientas, reparación…): el brazo B las paga todas. Sin
      // lanzar: estamos dentro de la capa (ver `conContadorDeGasto`).
      escriturasEnEstaRep += leerEscrituras(resp).escrituras;
      razonamientoEnEstaRep += usoCrudo(resp.raw).razonamiento ?? 0;
      return resp;
    },
  };

  // El sondeo de clasificación también es una request de B y entra en el techo.
  proveedorEnEstaRep = 0;
  const probeMedida = await cronometrar(() => nuevaCapa(espia, model, memoriaNueva()).generate(reqDeRep("sonda")));
  const probe = probeMedida.value;
  latencias.B!.push({ totalMs: probeMedida.durationMs, providerMs: proveedorEnEstaRep });
  comprobarGasto();
  const kind: Kind = s.warm
    ? "cache"
    : probe.report.calls.actualLlm === 0
      ? "resolver"
      : "ran";
  const minReps = kind === "ran" ? REPS : Math.max(2, Math.ceil(REPS / 2));
  let qPass = 0;
  let gate = "structural";
  // Acumuladores de caché de prefijo, uno por brazo.
  let cacheNaive = 0;
  let cacheRazonable = 0;
  let cacheNativo = 0;
  let cacheOptimizado = 0;
  let attribution = {
    avoidedCall: probe.report.calls.avoidedLlm > 0,
    eliminatedInputTokens: probe.report.tokens.eliminatedInput,
    compressedInputTokens: probe.report.tokens.compressedInput,
    providerCachedInputTokens: probe.report.tokens.providerCachedInput ?? 0,
  };
  // Se calcula sobre el SONDEO de clasificación (una petición completa por la
  // capa) y se recalcula en la primera repetición, para que refleje la misma
  // llamada que produjo las cifras que se publican.
  let palanca = conMotivoDelPaquete(estadoDePalanca(s, probe, probe.report.tokens.providerCachedInput ?? 0, transporte));

  async function sampleOnce(t: number): Promise<void> {
    // La MISMA sal para los dos brazos de esta repetición: pareado de verdad.
    const reqRep = reqDeRep(String(t));
    // Arm A: naive baseline — a real call, measured.
    const medicionA = await cronometrar(() => provider.generate(buildNaive(reqRep, forzado)));
    const respA = medicionA.value;
    const latenciaA = { totalMs: medicionA.durationMs, providerMs: medicionA.durationMs };
    latencias.A!.push(latenciaA);
    comprobarGasto();
    const fp = (respA.raw as { system_fingerprint?: string } | undefined)?.system_fingerprint;
    if (fp) fingerprints.add(fp);
    modelosServidos.add(modeloDe(respA.raw) ?? "(sin declarar)");
    const uA = usoDe(respA);
    const eA = escriturasDeLlamada(respA);
    const costA = cost(model, uA, eA.escrituras);
    cacheNaive += uA.cachedInputTokens ?? 0;
    escrituras.naive += eA.escrituras;
    razonamiento.naive += usoCrudo(respA.raw).razonamiento ?? 0;

    // ¿El brazo naive cumplió de verdad el contrato? Hasta ahora nadie lo
    // comprobaba: se le exigía validez SOLO al brazo optimizado. Pero el layer
    // paga tokens por avisar al modelo de las restricciones que el proveedor NO
    // impone (maxLength, maxItems…), y el naive no los paga. Si a cambio el
    // naive devuelve respuestas que incumplen el contrato, no ha hecho la misma
    // tarea y compararlas es engañoso — esta vez en NUESTRO favor.
    if (req.response?.schema) {
      naiveTotal++;
      const p = tryParseJson(respA.text);
      if (p !== undefined && validateAgainstSchema(p, req.response.schema).valid) naiveValid++;
    }
    // El brazo naive TAMBIÉN puede salir cortado, y hay que contarlo aparte: un
    // truncado que ocurre en los dos brazos no lo causó la capa, lo causó un
    // contrato que no cabe. Sin este contador, la fila se lee como si la capa
    // hubiera roto una respuesta que el cliente tenía sana.
    if (cortadaPorElTope(respA.finishReason)) truncadasA++;

    // Arm A1: la MISMA petición que un equipo razonable mandaría sin nosotros —
    // caché nativa configurada donde el prefijo se repite de verdad y solo las
    // herramientas que el escenario declara a mano (benchmarks/brazos.ts). Misma
    // sal que A y B: sigue siendo un pareado de verdad, ahora de tres.
    // SAL PROPIA PARA A1. Con la misma sal que A, el brazo A1 manda un prompt
    // byte a byte idéntico al que A acaba de escribir en la caché automática del
    // proveedor, y OpenAI se lo sirve cacheado: la primera tirada (2026-09-12)
    // dio 26.496 tokens cacheados en A1 con 0 en A sobre la tabla uniforme, y
    // −56 % «frente a B1» en el hilo de soporte. Eso no es la integración
    // razonable, es la petición idéntica de un segundo antes. La sal distinta
    // rompe ese prefijo y deja a A1 tan frío como a A y a B; la tarea es la
    // misma (la sal no forma parte de ella), así que el pareado se mantiene.
    // Los escenarios sin sal (prefijo estable, caché exacta) siguen sin sal en
    // los tres brazos: ahí el prefijo repetido ES lo que se mide.
    let costA1: number | undefined;
    let latenciaA1: MuestraLatenciaLegacy | undefined;
    if (B1_ACTIVO) {
      const reqRepB1 = reqDeRep(`${t}-b1`);
      const medicionA1 = await cronometrar(() => provider.generate(construirBrazoRazonable(reqRepB1, model, { toolsB1: s.toolsB1 })));
      const respA1 = medicionA1.value;
      latenciaA1 = { totalMs: medicionA1.durationMs, providerMs: medicionA1.durationMs };
      latencias.A1!.push(latenciaA1);
      comprobarGasto();
      modelosServidos.add(modeloDe(respA1.raw) ?? "(sin declarar)");
      const uA1 = usoDe(respA1);
      const eA1 = escriturasDeLlamada(respA1);
      costA1 = cost(model, uA1, eA1.escrituras);
      cacheRazonable += uA1.cachedInputTokens ?? 0;
      escrituras.razonable += eA1.escrituras;
      razonamiento.razonable += usoCrudo(respA1.raw).razonamiento ?? 0;
      a1In.push(uA1.inputTokens); a1Out.push(uA1.outputTokens);
      if (cortadaPorElTope(respA1.finishReason)) truncadasA1++;
    }

    // Arm A2 (B2, «nativo bien configurado»): B1 más los ajustes gratuitos que
    // el proveedor documenta para esta forma de petición, puestos en el cable
    // por el mismo adaptador (benchmarks/nativo.ts). SAL PROPIA, por lo mismo
    // que A1: con la de A o la de A1 heredaría la caché que ellos acaban de
    // escribir, y eso no es la integración nativa, es la petición de un segundo
    // antes. Su contrato se valida como el del naive: B2 puede abaratar
    // contestando peor (esfuerzo bajo), y eso cuenta EN CONTRA nuestra.
    let costA2: number | undefined;
    let latenciaA2: MuestraLatenciaLegacy | undefined;
    if (proveedorB2) {
      const reqRepB2 = reqDeRep(`${t}-b2`);
      const peticionB2 = construirBrazoNativo(reqRepB2, model, {
        ...(s.toolsB1 ? { toolsB1: s.toolsB1 } : {}),
        busquedaDeHerramientas: busquedaB2,
      });
      const planDeEstaRep = planPara(peticionB2);
      planB2 ??= planDeEstaRep;
      const medicionA2 = await cronometrar(() => proveedorB2.generate(peticionB2));
      const respA2 = medicionA2.value;
      latenciaA2 = { totalMs: medicionA2.durationMs, providerMs: medicionA2.durationMs };
      latencias.A2!.push(latenciaA2);
      comprobarGasto();
      modelosServidos.add(modeloDe(respA2.raw) ?? "(sin declarar)");
      const uA2 = usoDe(respA2);
      const eA2 = escriturasDeLlamada(respA2);
      costA2 = cost(model, uA2, eA2.escrituras);
      cacheNativo += uA2.cachedInputTokens ?? 0;
      escrituras.nativo += eA2.escrituras;
      razonamiento.nativo += usoCrudo(respA2.raw).razonamiento ?? 0;
      a2In.push(uA2.inputTokens); a2Out.push(uA2.outputTokens);
      if (cortadaPorElTope(respA2.finishReason)) truncadasA2++;
      if (req.response?.schema) {
        nativoTotal++;
        const p = tryParseJson(respA2.text);
        if (p !== undefined && validateAgainstSchema(p, req.response.schema).valid) nativoValid++;
      }
      // ¿Llegó el modo explícito al proveedor? En una repetición sin breakpoint,
      // B2 no debería escribir caché; B0 (implícito) sí, si el prompt pasa del
      // mínimo. Se acumula y se juzga a nivel de modelo (`native.honored`).
      const o = planDeEstaRep.cable.openai;
      if (o?.promptCacheMode && o.breakpointEnMensaje == null) {
        sondaDeModo.escriturasB2SinBreakpoint += eA2.escrituras;
        sondaDeModo.escriturasB0 += eA.escrituras;
        sondaDeModo.reps++;
      }
    }

    // Arm B: BV-SALA optimized — a COLD run (fresh layer) so caching is never
    // secretly pre-warmed for the headline. Avoided calls cost $0 (real).
    pistaEnEstaRep = false;
    escriturasEnEstaRep = 0;
    razonamientoEnEstaRep = 0;
    proveedorEnEstaRep = 0;
    const medicionB = await cronometrar(() => nuevaCapa(espia, model, memoriaNueva()).generate(reqRep));
    const resB = medicionB.value;
    const latenciaB = { totalMs: medicionB.durationMs, providerMs: proveedorEnEstaRep };
    latencias.B!.push(latenciaB);
    comprobarGasto();
    if (pistaEnEstaRep) repsConPista++;
    const uB = usageOf(resB);
    cacheOptimizado += uB.cachedInputTokens ?? 0;
    escrituras.optimizado += escriturasEnEstaRep;
    razonamiento.optimizado += razonamientoEnEstaRep;
    const ran = resB.report.calls.actualLlm > 0;
    const costB = ran ? cost(model, uB, escriturasEnEstaRep) : 0;

    paired.push({
      costA,
      ...(costA1 != null ? { costA1 } : {}),
      ...(costA2 != null ? { costA2 } : {}),
      costB,
      latencies: {
        A: latenciaA,
        ...(latenciaA1 ? { A1: latenciaA1 } : {}),
        ...(latenciaA2 ? { A2: latenciaA2 } : {}),
        B: latenciaB,
      },
    });
    aIn.push(uA.inputTokens); aOut.push(uA.outputTokens);
    bIn.push(uB.inputTokens); bOut.push(uB.outputTokens);

    // Quality gate: ground-truth when available, else structural / judge. Cache
    // scenarios' own expect() asserts a HIT, impossible on this cold call — gate
    // them structurally here; hit correctness is asserted in the amortization pass.
    // El veto por truncado va DELANTE del `expect` del escenario, y por eso pasa
    // por `veredictoDeCalidad` en vez de por un `if` aquí: media respuesta no es
    // una respuesta, la mire quien la mire. Un escenario sin contrato de salida
    // aprobaba un texto cortado a media frase con `text.trim().length > 0` y
    // publicaba su ahorro como probado — el mismo agujero que el pipeline ya cerró
    // para la escritura en caché.
    if (cortadaPorElTope(resB.finishReason)) truncadasB++;
    const q = await veredictoDeCalidad({
      finishReason: resB.finishReason,
      evaluar: () => qualityGate(s, resB, respA.text, model, kind === "cache"),
    });
    if (q.passed) qPass++;
    gate = q.gate;
    if (t === 0) {
      attribution = {
        avoidedCall: resB.report.calls.avoidedLlm > 0,
        eliminatedInputTokens: resB.report.tokens.eliminatedInput,
        compressedInputTokens: resB.report.tokens.compressedInput,
        providerCachedInputTokens: resB.report.tokens.providerCachedInput ?? 0,
      };
      palanca = conMotivoDelPaquete(estadoDePalanca(s, resB, uB.cachedInputTokens ?? 0, transporte));
    }
  }

  // Draw the minimum, then (LIVE only) keep drawing until the savings CI is tight
  // enough or the cap is hit — spend more reps only where variance demands it.
  let t = 0;
  for (; t < minReps; t++) await sampleOnce(t);
  // EL MÁS ANCHO de los intervalos activos manda: el titular publicable es el
  // MENOR de los suelos (frente a B0, B1 y B2), así que su precisión no puede
  // depender de contra cuál se decidió parar. La cota dura (`MAX_REPS`) es la
  // misma, así que el techo de la estimación no cambia.
  const semiancho = (a: number[], b: number[]): number => {
    const ci = bootstrapRatioCI(a, b, { seed: SEED });
    return (ci.upper - ci.lower) / 2;
  };
  const ciHalf = (): number => {
    const costB = paired.map((p) => p.costB);
    let h = semiancho(paired.map((p) => p.costA), costB);
    if (B1_ACTIVO) h = Math.max(h, semiancho(paired.map((p) => p.costA1 ?? 0), costB));
    if (B2_ACTIVO) h = Math.max(h, semiancho(paired.map((p) => p.costA2 ?? 0), costB));
    return h;
  };
  while (mode === "LIVE" && paired.length < MAX_REPS && ciHalf() > CI_TARGET) {
    await sampleOnce(t++);
  }

  const savings = bootstrapRatioCI(paired.map((p) => p.costA), paired.map((p) => p.costB), { seed: SEED });
  const reps = paired.length;
  const qualityOk = reps > 0 && qPass / reps >= QUALITY_FLOOR;
  // Solo cuenta cuando hubo llamada de verdad en el brazo B: en un escenario
  // resolver la capa no llama al proveedor, así que solo hay modelo del brazo A
  // y exigir dos coincidentes convertiría el único +100% de la tirada en error.
  const modelStable = modelosServidos.size <= 1;

  const result: ScenarioResult = {
    name: s.name,
    lever: s.lever,
    ledger: s.ledger,
    model,
    palanca,
    kind,
    reps,
    armA: { meanInputTokens: mean(aIn), meanOutputTokens: mean(aOut), meanCost: mean(paired.map((p) => p.costA)) },
    ...(B1_ACTIVO
      ? { armA1: { meanInputTokens: mean(a1In), meanOutputTokens: mean(a1Out), meanCost: mean(paired.map((p) => p.costA1 ?? 0)) } }
      : {}),
    ...(B2_ACTIVO
      ? { armA2: { meanInputTokens: mean(a2In), meanOutputTokens: mean(a2Out), meanCost: mean(paired.map((p) => p.costA2 ?? 0)) } }
      : {}),
    armB: { meanInputTokens: mean(bIn), meanOutputTokens: mean(bOut), meanCost: mean(paired.map((p) => p.costB)) },
    formaFactura: repartoDeLaFactura(model, mean(aIn), mean(aOut)),
    cacheDePrefijo: {
      naive: cacheNaive,
      ...(B1_ACTIVO ? { razonable: cacheRazonable } : {}),
      ...(B2_ACTIVO ? { nativo: cacheNativo } : {}),
      optimizado: cacheOptimizado,
    },
    cacheWrites: {
      naive: escrituras.naive,
      ...(B1_ACTIVO ? { razonable: escrituras.razonable } : {}),
      ...(B2_ACTIVO ? { nativo: escrituras.nativo } : {}),
      optimizado: escrituras.optimizado,
    },
    reasoningTokens: {
      naive: razonamiento.naive,
      ...(B1_ACTIVO ? { razonable: razonamiento.razonable } : {}),
      ...(B2_ACTIVO ? { nativo: razonamiento.nativo } : {}),
      optimizado: razonamiento.optimizado,
    },
    sampling: { temperature: muestreo.temperature ?? null, seed: muestreo.seed ?? null },
    measured: {
      inputTokenDeltaMean: mean(aIn) - mean(bIn),
      outputTokenDeltaMean: mean(aOut) - mean(bOut),
      savings,
      wilcoxonP: wilcoxonSignedRankP(paired.map((p) => p.costA - p.costB)),
    },
    ...(B1_ACTIVO
      ? {
          measuredB1: {
            inputTokenDeltaMean: mean(a1In) - mean(bIn),
            outputTokenDeltaMean: mean(a1Out) - mean(bOut),
            savings: bootstrapRatioCI(paired.map((p) => p.costA1 ?? 0), paired.map((p) => p.costB), { seed: SEED }),
            wilcoxonP: wilcoxonSignedRankP(paired.map((p) => (p.costA1 ?? 0) - p.costB)),
          },
        }
      : {}),
    ...(B2_ACTIVO
      ? {
          measuredB2: {
            inputTokenDeltaMean: mean(a2In) - mean(bIn),
            outputTokenDeltaMean: mean(a2Out) - mean(bOut),
            savings: bootstrapRatioCI(paired.map((p) => p.costA2 ?? 0), paired.map((p) => p.costB), { seed: SEED }),
            wilcoxonP: wilcoxonSignedRankP(paired.map((p) => (p.costA2 ?? 0) - p.costB)),
          },
          ...(planB2 ? { native: resumenDelPlan(planB2), planB2 } : {}),
          nativeContractValid: { valid: nativoValid, total: nativoTotal },
          sondaDeModo,
        }
      : {}),
    quality: { gate, passed: qPass, total: reps },
    naiveContractValid: { valid: naiveValid, total: naiveTotal },
    truncated: {
      naive: truncadasA,
      ...(B1_ACTIVO ? { razonable: truncadasA1 } : {}),
      ...(B2_ACTIVO ? { nativo: truncadasA2 } : {}),
      optimizado: truncadasB,
    },
    pistaDeLimites: { reps: repsConPista, total: reps },
    proven: mode === "LIVE" && savings.lower > 0 && qualityOk && modelStable,
    modelStable,
    servedModels: [...modelosServidos],
    fingerprints: [...fingerprints],
    attribution,
    paired,
    latency: resumirLatencias(latencias, mode),
    latencySamples: latencias,
  };

  // Cache amortization: repeat traffic pays the miss ONCE, then hits are $0.
  if (kind === "cache") {
    // Una capa para el par miss/hit (el valor de la caché ES el estado que
    // sobrevive entre las dos llamadas), con el mismo muestreo que los brazos.
    // El espía de B también aquí: la amortización paga sus escrituras de caché.
    const layer = nuevaCapa(espia, model, memoriaNueva());
    const reqAmortizacion = conMuestreoPareado(req);
    escriturasEnEstaRep = 0;
    proveedorEnEstaRep = 0;
    const medicionMiss = await cronometrar(() => layer.generate(reqAmortizacion)); // cold miss (real optimized cost)
    const miss = medicionMiss.value;
    latencias.B!.push({ totalMs: medicionMiss.durationMs, providerMs: proveedorEnEstaRep });
    comprobarGasto();
    const coldMissCost = miss.report.calls.actualLlm > 0 ? cost(model, usageOf(miss), escriturasEnEstaRep) : 0;
    escriturasEnEstaRep = 0;
    proveedorEnEstaRep = 0;
    const medicionHit = await cronometrar(() => layer.generate(reqAmortizacion)); // warmed → hit
    const hit = medicionHit.value;
    latencias.B!.push({ totalMs: medicionHit.durationMs, providerMs: proveedorEnEstaRep });
    comprobarGasto();
    const hitCost = hit.report.calls.actualLlm > 0 ? cost(model, usageOf(hit), escriturasEnEstaRep) : 0;
    // The hit must actually be a cache hit AND satisfy the scenario's own
    // correctness assertion — a saving on a stale/wrong cached answer is void.
    const hitVerified = hit.report.calls.actualLlm === 0 && safeExpect(s, hit);
    if (!hitVerified) result.quality.gate += "+cache-hit-unverified";
    const costA = result.armA.meanCost;
    // savings(K) = 1 − (coldMissCost + (K−1)*hitCost) / (K*costA). Break-even = first K>0.
    let breakEvenK: number | null = null;
    for (let k = 1; k <= 1000; k++) {
      const bTotal = coldMissCost + (k - 1) * hitCost;
      if (costA > 0 && 1 - bTotal / (k * costA) > 0) { breakEvenK = k; break; }
    }
    result.amortization = { coldMissCost, hitCost, breakEvenK };
  }
  result.latency = resumirLatencias(latencias, mode);

  return result;
}

// ── Quality gate ────────────────────────────────────────────────────────────
const judgeBase = process.env.BVSALA_JUDGE_BASE_URL;
const judgeProvider: Provider | null = judgeBase
  ? conReintentos(
      new OpenAICompatibleProvider({
        baseUrl: judgeBase,
        ...(process.env.BVSALA_JUDGE_API_KEY ? { apiKey: process.env.BVSALA_JUDGE_API_KEY } : {}),
        stripProviderPrefix: !keepPrefix,
        requireUsage: false,
      }),
    )
  : null;

async function qualityGate(
  s: Scenario,
  optimized: SavingsResult,
  baselineAnswer: string,
  model: string,
  ignoreExpect = false,
): Promise<{ passed: boolean; gate: string }> {
  // 1. Strongest: scenario ground-truth check (e.g. arithmetic == "12", schema valid).
  if (s.expect && !ignoreExpect) return { passed: safeExpect(s, optimized), gate: "ground-truth" };

  const answer = optimized.text ?? "";
  // 2. Structural: a non-empty answer; if a schema was enforced, it is valid.
  // `structurallyValid` es OPCIONAL en el contrato, así que esto era
  // `boolean | undefined` y nadie lo veía: `benchmarks/` no estaba en el
  // `include` del tsconfig. Para una verja de calidad, AUSENTE significa NO
  // VERIFICADO, y no verificado no pasa — la duda tiene que restar afirmación.
  const structural =
    answer.trim().length > 0 && optimized.report.constraints.structurallyValid === true;

  // 3. LIVE + judge configured: blind answer-vs-answer semantic equivalence.
  if (mode === "LIVE" && judgeProvider && baselineAnswer.trim().length > 0) {
    try {
      const equivalent = await judgeEquivalent(baselineAnswer, answer, s, model);
      return { passed: structural && equivalent, gate: "judge" };
    } catch {
      return { passed: structural, gate: "structural(judge-failed)" };
    }
  }
  return { passed: structural, gate: mode === "LIVE" ? "structural" : "plumbing(mock)" };
}

async function judgeEquivalent(a: string, b: string, s: Scenario, model: string): Promise<boolean> {
  if (!judgeProvider) return true;
  // Blind: randomize which answer is labeled "1" vs "2" to kill position bias.
  const flip = (s.name.length + a.length) % 2 === 0;
  const one = flip ? b : a;
  const two = flip ? a : b;
  const modeloJuez = process.env.BVSALA_JUDGE_MODEL ?? model;
  const res = await judgeProvider.generate({
    model: modeloJuez,
    messages: [
      { role: "system", content: "You are a strict evaluator. Reply ONLY with compact JSON {\"equivalent\":bool}." },
      { role: "user", content:
        `Task: ${s.request.messages.map((m) => m.content).join(" ")}\n\n` +
        `Response 1:\n${one}\n\nResponse 2:\n${two}\n\n` +
        `Is Response ${flip ? "1" : "2"} at least as correct and complete as the other, with no factual regression? JSON only.` },
    ],
    maxOutputTokens: 20,
    // Solo donde el modelo la honra: a Claude Sonnet 5 o a la familia gpt-5 un
    // `temperature: 0` les cuesta un 400 y el juez caería siempre a estructural.
    ...(muestreoPareadoPara(modeloJuez).temperature != null ? { temperature: 0 } : {}),
  });
  try {
    return !!JSON.parse(res.text.trim()).equivalent;
  } catch {
    return /"equivalent"\s*:\s*true/.test(res.text);
  }
}

// ── Reporting ────────────────────────────────────────────────────────────────
const pct = (n: number): string => (n * 100).toFixed(1) + "%";
const money = (n: number): string => "$" + n.toFixed(6);
const dinero4 = (n: number): string => "$" + n.toFixed(4);
const pad = (s: string, n: number): string => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));
const padL = (s: string, n: number): string => (s.length >= n ? s : " ".repeat(n - s.length) + s);

// ── ¿Qué escenarios aplican a qué modelo? ────────────────────────────────────
/**
 * Un escenario que no se mide, con la CAUSA de por qué no.
 *
 * Son dos causas distintas y llevan a acciones distintas, así que no comparten
 * frase: `familia` significa "este escenario no va con este modelo" (se arregla
 * midiendo el modelo que toca) y `transporte` significa "va con este modelo pero
 * el endpoint configurado no puede ejercitarlo" (se arregla configurando el
 * endpoint). Lo que ninguna de las dos permite es publicar un cero.
 */
interface EscenarioNoMedido {
  name: string;
  lever: string;
  causa: "familia" | "transporte";
  motivo: string;
  /** Qué hay que configurar para poder medirlo. Sólo en la causa `transporte`. */
  comoMedirlo?: string;
}

/**
 * Un escenario que declara `familia` solo se mide contra modelos de esa familia,
 * y además necesita un TRANSPORTE capaz de ejercitar su palanca.
 *
 * Nada de lo que devuelve la segunda lista se descarta en silencio: va al informe
 * con su motivo, porque "no se midió" y "se midió y salió cero" son cosas
 * distintas — y la segunda es la que se lee como un fracaso del producto.
 */
function repartirEscenarios(modelo: string | null): {
  aplican: Scenario[];
  noAplican: EscenarioNoMedido[];
  noMedibles: PalancaNoMedible[];
} {
  const familia = modelo ? familiaDeModelo(modelo) : null;
  const aplican: Scenario[] = [];
  const noAplican: EscenarioNoMedido[] = [];
  const noMedibles: PalancaNoMedible[] = [];
  for (const s of scenarios) {
    // 1. ¿Va este escenario con este modelo? Sólo se puede juzgar cuando hay un
    //    modelo forzado; sin él cada escenario lleva el suyo y siempre encaja.
    if (familia && s.familia && s.familia !== familia) {
      noAplican.push({
        name: s.name,
        lever: s.lever,
        causa: "familia",
        motivo:
          `el escenario mide una palanca de la familia ${s.familia} y ${modelo} es ` +
          `${familia === "desconocida" ? "de una familia que este banco no reconoce" : `de la familia ${familia}`}`,
      });
      continue;
    }
    // 2. ¿Hay endpoint para la familia de este modelo? Con un modelo forzado el
    //    prevuelo ya abortó si no lo hay; sin él (cada escenario con su modelo)
    //    el escenario se declara no medible, con qué declarar para medirlo.
    const modeloDelEscenario = modelo ?? s.request.model;
    if (!endpointDeModelo(modeloDelEscenario, CONFIG_DE_TRANSPORTE)) {
      noAplican.push({
        name: s.name,
        lever: s.lever,
        causa: "transporte",
        motivo: `no endpoint is declared for the family of ${modeloDelEscenario}`,
        comoMedirlo:
          "declare the direct endpoint of that family (BVSALA_DEMO_OPENAI_BASE_URL, BVSALA_DEMO_ANTHROPIC_BASE_URL or " +
          "BVSALA_DEMO_GOOGLE_BASE_URL, each with its _API_KEY) or the gateway (BVSALA_DEMO_BASE_URL)",
      });
      continue;
    }
    // 3. ¿Admite este modelo, por este transporte, la FORMA de la petición? La
    //    página de gpt-6-luna dice que Chat Completions solo acepta `tools` con
    //    `reasoning_effort: "none"`. B0 manda el esfuerzo por defecto y el SDK
    //    no sabe mandar otro, así que el escenario no se puede medir aquí sin
    //    cambiar lo que mide: se declara, con su fuente, en vez de romper el
    //    modelo entero a mitad de una tirada pagada.
    const transporteDelEscenario = transporteDe(modeloDelEscenario);
    const idDesnudo = desnudo(modeloDelEscenario);
    if (
      transporteDelEscenario === "openai-compatible" &&
      (s.request.tools?.length ?? 0) > 0 &&
      HERRAMIENTAS_SOLO_SIN_RAZONAMIENTO_EN_CHAT.some((k) => idDesnudo === k || idDesnudo.startsWith(`${k}-`))
    ) {
      const motivo =
        `${idDesnudo}: Chat Completions supports function calling only with reasoning_effort "none" ` +
        `(${FUENTES.gpt6Luna.url}, checked ${FUENTES.gpt6Luna.consultado}); arm B0 sends the default effort and the SDK ` +
        "cannot send another, so this request shape is not measurable on this transport";
      const comoMedirlo =
        "measure it through the Responses API (not supported by the SDK's adapter today: a product change), or " +
        "on a model without this restriction";
      if (s.palanca) noMedibles.push({ palanca: s.palanca, escenario: s.name, motivo, comoMedirla: comoMedirlo });
      noAplican.push({ name: s.name, lever: s.lever, causa: "transporte", motivo, comoMedirlo });
      continue;
    }
    // 4. ¿Puede el transporte configurado ejercitar su palanca? El modelo que
    //    manda es el de la tirada si lo hay, y si no el que declara el escenario.
    const noMedible = noMedibleEnTransporte(s, transporteDelEscenario);
    if (noMedible) {
      noMedibles.push(noMedible);
      noAplican.push({
        name: s.name,
        lever: s.lever,
        causa: "transporte",
        motivo: noMedible.motivo,
        comoMedirlo: noMedible.comoMedirla,
      });
      continue;
    }
    aplican.push(s);
  }
  return { aplican, noAplican, noMedibles };
}

// ── Estimación de coste de la tirada ─────────────────────────────────────────
/**
 * LO QUE VA A COSTAR ESTA TIRADA, ANTES DE LANZARLA.
 *
 * Nadie debería pagar una medición sin saber su precio, y el banco tiene todos
 * los datos para calcularlo: los tokens de cada escenario los cuenta el mismo
 * tokenizador que factura el proveedor, y el precio sale del catálogo de precios
 * de lista del SDK.
 *
 * ES UN TECHO, y se dice: la salida se cuenta al tope declarado (`maxOutputTokens`)
 * aunque el modelo casi siempre escriba menos, el brazo B se cuenta como si
 * gastara lo mismo que el A —cuando la gracia del producto es que gaste menos— y
 * el muestreo adaptativo se cuenta a su cota dura. Equivocarse por arriba es el
 * lado correcto en una cifra que sirve para decidir si se lanza el gasto.
 */
interface EstimacionDeEscenario {
  escenario: string;
  /** Sin `maxOutputTokens` declarado: la salida no tiene tope y esto NO es un techo. */
  sinTope: boolean;
  /** Tokens de entrada por llamada, tal y como sale el brazo naive. */
  entradaTokens: number;
  /** Techo de tokens de salida por llamada. */
  salidaTokens: number;
  llamadasMinimo: number;
  llamadasTecho: number;
  costeMinimo: number;
  costeTecho: number;
}

interface EstimacionDeModelo {
  modelo: string;
  precioConocido: boolean;
  escenarios: EstimacionDeEscenario[];
  costeMinimo: number;
  costeTecho: number;
}

function tokensDe(texto: string, model: string): number {
  return registroTokens.count(texto, { model });
}

function estimarEscenario(s: Scenario, model: string): EstimacionDeEscenario {
  const { precio: p, prima } = precioYPrima(model);
  let entrada = tokensDe(s.request.messages.map((m) => m.content).join("\n"), model);
  if (s.request.structuredData !== undefined) {
    entrada += tokensDe(JSON.stringify(s.request.structuredData), model);
  }
  if (s.request.tools?.length) {
    entrada += tokensDe(
      JSON.stringify(
        s.request.tools.map((t) => ({
          type: "function",
          function: { name: t.id, description: t.description, parameters: t.parameters ?? {} },
        })),
      ),
      model,
    );
  }
  // El contrato viaja en `response_format` en LOS DOS brazos.
  if (s.request.response?.schema) entrada += tokensDe(JSON.stringify(s.request.response.schema), model);

  // El tope que de verdad llevará la petición: con el margen de razonamiento,
  // si el modelo razona y el dueño lo declaró (`conMargenDeRazonamiento`).
  const tope = conMargenDeRazonamiento({ ...s.request, model }, model, MARGEN_RAZONAMIENTO).response?.maxOutputTokens;
  const salida = tope ?? 256;

  // Llamadas: 1 sondeo de clasificación (brazo B) + por repetición un brazo A y
  // un brazo B; `toolDiscovery` puede partir el brazo B en dos; los escenarios de
  // caché añaden el par fallo-frío/acierto de la amortización.
  const porRepeticion =
    2 + (B1_ACTIVO ? 1 : 0) + (B2_ACTIVO ? 1 : 0) + (s.request.savings?.toolDiscovery === true ? 1 : 0);
  const extraCache = s.warm ? 2 : 0;
  // Los escenarios de caché tiran la mitad de repeticiones; los resolvers
  // también, pero eso no se sabe hasta ejecutarlos, así que se les cuenta la
  // tanda entera. Un techo que se pasa por arriba en el caso barato no engaña a
  // nadie; uno que se quede corto, sí.
  const minimo = s.warm ? Math.max(2, Math.ceil(REPS / 2)) : REPS;
  const llamadasMinimo = 1 + extraCache + minimo * porRepeticion;
  const llamadasTecho = 1 + extraCache + MAX_REPS * porRepeticion;

  // La entrada a la prima de escritura: en el peor caso cada llamada escribe
  // su prompt entero en la caché (1,25× en Anthropic y GPT-5.6+).
  const porLlamada = (entrada / 1000) * p.inputPer1k * Math.max(1, prima) + (salida / 1000) * p.outputPer1k;
  return {
    escenario: s.name,
    sinTope: tope == null,
    entradaTokens: entrada,
    salidaTokens: salida,
    llamadasMinimo,
    llamadasTecho,
    costeMinimo: llamadasMinimo * porLlamada,
    costeTecho: llamadasTecho * porLlamada,
  };
}

/** La estimación de UN modelo de la tirada (la misma que se imprime antes de gastar). */
function estimarModelo(modelo: string | null): EstimacionDeModelo {
  const { aplican } = repartirEscenarios(modelo);
  // Sin modelo forzado cada escenario lleva el suyo, así que la estimación se
  // hace escenario a escenario con su propio precio.
  const filas = aplican.map((s) => estimarEscenario(s, modelo ?? s.request.model));
  return {
    modelo: modelo ?? "(el de cada escenario)",
    precioConocido: modelo
      ? precioConocido(modelo)
      : aplican.every((s) => precioConocido(s.request.model)),
    escenarios: filas,
    costeMinimo: filas.reduce((n, f) => n + f.costeMinimo, 0),
    costeTecho: filas.reduce((n, f) => n + f.costeTecho, 0),
  };
}

function estimarTirada(): EstimacionDeModelo[] {
  return modelosAMedir.map(estimarModelo);
}

function imprimirEstimacion(est: EstimacionDeModelo[]): number {
  const totalMin = est.reduce((n, e) => n + e.costeMinimo, 0);
  const totalMax = est.reduce((n, e) => n + e.costeTecho, 0);
  console.log("\nCoste estimado de la tirada (techo: salida al tope, brazo B como el A, reps a la cota dura)");
  for (const e of est) {
    const aviso = e.precioConocido ? "" : "   ⚠ precio ILUSTRATIVO: este modelo no está en el catálogo";
    const sinTope = e.escenarios.filter((x) => x.sinTope).length;
    console.log(
      `  ${pad(e.modelo, 34)} ${padL(dinero4(e.costeMinimo), 10)} – ${padL(dinero4(e.costeTecho), 10)}` +
        `   ${e.escenarios.length} escenarios${aviso}` +
        (sinTope ? `   (${sinTope} sin tope de salida: ahí no es un techo)` : ""),
    );
  }
  if (est.length > 1) console.log(`  ${pad("TOTAL", 34)} ${padL(dinero4(totalMin), 10)} – ${padL(dinero4(totalMax), 10)}`);
  console.log(
    mode === "LIVE"
      ? "  Estas llamadas se pagan. Corta ahora si la cifra no te cuadra."
      : "  MOCK: esta tirada no cuesta nada. La cifra es lo que costaría en LIVE.",
  );
  return totalMax;
}

// ── Una tirada completa contra UN modelo ─────────────────────────────────────
//
// El banco medía SIEMPRE un solo modelo —el que hubiera en `BVSALA_DEMO_MODEL`—
// y publicaba una cifra sin apellido. Aquí cada modelo tiene su tirada, sus
// escenarios aplicables y su artefacto, y la comparación entre ellos es una
// tabla y no una conjetura.

/** Los libros que se agregan. Sale de `LIBROS` para que un libro nuevo no pueda
 *  caer en silencio en el saco de "none" — que es lo que le pasaba al libro 4:
 *  la lista de aquí estaba escrita a mano y no lo incluía, así que el escenario
 *  de Anthropic no tenía fila propia en la atribución. */
const LEDGERS: LedgerTag[] = LIBROS.filter((l): l is Exclude<LedgerTag, "none"> => l !== "none");

interface FilaDeLibro {
  ledger: string;
  scenarios: string[];
  savings: CI;
  deltaCost: number;
  proven: boolean;
}

interface EstadoDePalancaEnLaTirada {
  palanca: Palanca;
  escenario: string;
  ejercitada: boolean;
  motivo: string;
}

interface Tirada {
  modelo: string | null;
  etiqueta: string;
  results: ScenarioResult[];
  noAplican: EscenarioNoMedido[];
  /** Palancas que este transporte no puede ejercitar, con cómo configurarlo. */
  noMedibles: PalancaNoMedible[];
  /** El titular: estratificado por escenario, peso 1 por escenario. */
  agg: CI;
  /** El agregado antiguo (todas las muestras juntas). Ya no es el titular; ver `aggregatePooled`. */
  aggPooled: CI;
  /** El agregado frente a B1 (integración razonable). Ausente si BVSALA_AB_B1=0. */
  aggB1?: CI;
  provenB1?: boolean;
  /** Frente a B2 (nativo bien configurado), y B2 frente a B0. Ausentes si BVSALA_AB_B2=0. */
  aggB2?: CI;
  provenB2?: boolean;
  aggNativoVsB0?: CI;
  /** Los suelos del IC frente a cada brazo de control, y el menor. */
  floors: { vsB0: number; vsB1: number | null; vsB2: number | null; min: number; minAgainst: string; note: string };
  /** Lo que B2 decidió en este modelo (público, en inglés). */
  nativo?: Record<string, unknown>;
  coste: Record<string, unknown>;
  wilcoxonP: number;
  qualityPassRate: number;
  proven: boolean;
  modelStable: boolean;
  ledgerRollup: FilaDeLibro[];
  palancas: EstadoDePalancaEnLaTirada[];
  latencia: InformeLatencia;
  artefacto: Record<string, unknown>;
}

const sumArr = (xs: number[]): number => xs.reduce((n, x) => n + x, 0);

function agregarMuestrasDeLatencia(results: readonly ScenarioResult[]): MuestrasPorBrazo {
  const out: MuestrasPorBrazo = {};
  for (const brazo of ["A", "A1", "A2", "B"] as const) {
    const muestras = results.flatMap((r) => r.latencySamples[brazo] ?? []);
    if (muestras.length > 0) out[brazo] = muestras;
  }
  return out;
}

async function medirModelo(modelo: string | null): Promise<Tirada> {
  const etiqueta = modelo ?? "(el de cada escenario)";
  const { aplican, noAplican, noMedibles } = repartirEscenarios(modelo);

  const gastoAlEmpezar = fotoDelGasto();
  console.log(`\n╭─ modelo: ${etiqueta}`);
  const ancho = 132 + (B1_ACTIVO ? 34 : 0) + (B2_ACTIVO ? 50 : 0);
  const cabeceraCache = ["A", ...(B1_ACTIVO ? ["A1"] : []), ...(B2_ACTIVO ? ["A2"] : []), "B"].join("/");
  console.log(
    pad("scenario", 26) + pad("kind", 9) + padL("A in/out tok", 16) +
    (B1_ACTIVO ? padL("A1 in/out tok", 16) : "") + (B2_ACTIVO ? padL("A2 in/out tok", 16) : "") +
    padL("B in/out tok", 16) +
    padL("bill in/out", 14) + padL(`cached ${cabeceraCache}`, 18) +
    padL("vs B0 (95% lo)", 20) + (B1_ACTIVO ? padL("vs B1 (95% lo)", 20) : "") +
    (B2_ACTIVO ? padL("vs B2 (95% lo)", 20) : "") + padL("qa", 8),
  );
  console.log("─".repeat(ancho));

  const results: ScenarioResult[] = [];
  for (const s of aplican) results.push(await runScenario(s, modelo));
  const latenciaBase = resumirLatencias(agregarMuestrasDeLatencia(results), mode);

  for (const r of results) {
    const qa = `${r.quality.passed}/${r.quality.total}`;
    const cache = [
      r.cacheDePrefijo.naive,
      ...(r.cacheDePrefijo.razonable != null ? [r.cacheDePrefijo.razonable] : []),
      ...(r.cacheDePrefijo.nativo != null ? [r.cacheDePrefijo.nativo] : []),
      r.cacheDePrefijo.optimizado,
    ].join("/");
    console.log(
      pad(r.name, 26) + pad(r.kind, 9) +
      padL(`${r.armA.meanInputTokens.toFixed(0)}/${r.armA.meanOutputTokens.toFixed(0)}`, 16) +
      (r.armA1 ? padL(`${r.armA1.meanInputTokens.toFixed(0)}/${r.armA1.meanOutputTokens.toFixed(0)}`, 16) : "") +
      (r.armA2 ? padL(`${r.armA2.meanInputTokens.toFixed(0)}/${r.armA2.meanOutputTokens.toFixed(0)}`, 16) : "") +
      padL(`${r.armB.meanInputTokens.toFixed(0)}/${r.armB.meanOutputTokens.toFixed(0)}`, 16) +
      padL(`${(r.formaFactura.entrada * 100).toFixed(0)}/${(r.formaFactura.salida * 100).toFixed(0)}`, 14) +
      padL(cache, 18) +
      padL(`${pct(r.measured.savings.point)} (${pct(r.measured.savings.lower)})`, 20) +
      (r.measuredB1 ? padL(`${pct(r.measuredB1.savings.point)} (${pct(r.measuredB1.savings.lower)})`, 20) : "") +
      (r.measuredB2 ? padL(`${pct(r.measuredB2.savings.point)} (${pct(r.measuredB2.savings.lower)})`, 20) : "") +
      padL(qa, 8),
    );
  }
  console.log("─".repeat(ancho));

  // LA SEÑAL QUE DECIDE SI ESTE BANCO PUEDE VER LA PALANCA MAYOR DE LA ENTRADA.
  // Si ningún escenario consigue que el proveedor devuelva `cached_tokens > 0`,
  // la caché de prefijo es INVISIBLE aquí: no se puede ni medir lo que ya hace
  // el cliente sin nosotros, ni demostrar lo que aportaríamos. Durante siete
  // escenarios el banco reportó 0 en los dos brazos y nadie lo miró.
  const conCache = results.filter((r) => r.cacheDePrefijo.naive > 0 || r.cacheDePrefijo.optimizado > 0);
  if (mode === "LIVE" && conCache.length === 0) {
    console.log(
      "\n⚠ NINGÚN escenario alcanzó la caché de prefijo del proveedor (cached_tokens = 0 en los dos\n" +
      "  brazos). Este banco NO puede medir esa palanca: los prompts no llegan al mínimo de tramo.\n" +
      "  Cualquier titular que salga de aquí ignora una de las mayores palancas de la entrada.",
    );
  }

  // EL TITULAR: estratificado por escenario, con PESO 1 por escenario.
  //
  //   f = 1 − Σ_s mean(costB_s) / Σ_s mean(costA_s)
  //
  // Hasta el 2026-09-12 el titular era el agregado de TODAS las muestras juntas
  // (1 − ΣcostB/ΣcostA), que pondera cada escenario por sus reps × su coste. El
  // muestreo adaptativo de abajo mete más reps en los escenarios RUIDOSOS, así
  // que el titular cambiaba con el reparto de reps y no con la capa: 20,8 % con
  // REPS=16 (194 muestras); 16,5 % con REPS=8 cuando «Constrained structured
  // answer» y «Stable-prefix agent turn» —que ahorran poco o nada— y «Large
  // uniform table» —con una salida bimodal del brazo B— llegaron a 24 reps;
  // 19,1 % en la tirada siguiente. Con peso igual por escenario las mismas tres
  // tiradas quedan a menos de dos puntos: 21,3 / 19,4 / 20,5. El remuestreo se hace DENTRO de cada escenario, así
  // que el peso de un escenario no depende de cuánto tiempo corrió el muestreador.
  // Sigue siendo la llamada fría, una por escenario (la caché enseña aquí su
  // coste de fallo; la amortización por tráfico repetido va aparte).
  const porEscenario = results.map((r) => ({
    costA: r.paired.map((p) => p.costA),
    costB: r.paired.map((p) => p.costB),
  }));
  const agg = bootstrapRatioCIEstratificado(porEscenario, { seed: SEED });
  // El agregado ANTIGUO se conserva como `aggregatePooled` para poder comparar
  // con los artefactos publicados antes de este cambio — pero ya no titula.
  const allA = results.flatMap((r) => r.paired.map((p) => p.costA));
  const allB = results.flatMap((r) => r.paired.map((p) => p.costB));
  const aggPooled = bootstrapRatioCI(allA, allB, { seed: SEED });
  // El Wilcoxon sigue sobre las muestras pareadas: contesta «¿la mediana del
  // ahorro por llamada es > 0?», que no depende del peso de cada escenario.
  const wP = wilcoxonSignedRankP(results.flatMap((r) => r.paired.map((p) => p.costA - p.costB)));
  const qTotalPass = results.reduce((n, r) => n + r.quality.passed, 0);
  const qTotal = results.reduce((n, r) => n + r.quality.total, 0);
  const qualityPassRate = qTotal ? qTotalPass / qTotal : 0;
  const allFpStable = results.every((r) => r.modelStable);

  const proven = mode === "LIVE" && agg.lower > 0 && qualityPassRate >= QUALITY_FLOOR && allFpStable;

  // EL MISMO TITULAR, FRENTE A B1. Mismas parejas, misma verja de calidad (las
  // respuestas del brazo B son las mismas), mismo modelo servido: solo cambia el
  // brazo de control. Lo que quede aquí es lo que un cliente razonable NO tenía
  // ya sin nosotros — y es la única cifra que la guía acepta como «valor
  // adicional de Savings».
  const parejasB1 = results.flatMap((r) => r.paired).filter((p) => p.costA1 != null);
  // El MISMO estimador que el titular: estratificado por escenario, peso 1.
  const aggB1 = B1_ACTIVO && parejasB1.length
    ? bootstrapRatioCIEstratificado(
        results.map((r) => {
          const conB1 = r.paired.filter((p) => p.costA1 != null);
          return { costA: conB1.map((p) => p.costA1!), costB: conB1.map((p) => p.costB) };
        }),
        { seed: SEED },
      )
    : undefined;
  const wPB1 = aggB1 ? wilcoxonSignedRankP(parejasB1.map((p) => p.costA1! - p.costB)) : undefined;
  const provenB1 = aggB1 ? mode === "LIVE" && aggB1.lower > 0 && qualityPassRate >= QUALITY_FLOOR && allFpStable : undefined;

  // EL MISMO TITULAR, FRENTE A B2 («nativo bien configurado»): lo que queda
  // después de todo lo que el proveedor da gratis para estas peticiones. Mismo
  // estimador, mismas parejas, misma verja de calidad del brazo B.
  const parejasB2 = results.flatMap((r) => r.paired).filter((p) => p.costA2 != null);
  const estratosB2 = results.map((r) => {
    const conB2 = r.paired.filter((p) => p.costA2 != null);
    return { costA: conB2.map((p) => p.costA2!), costB: conB2.map((p) => p.costB) };
  });
  const aggB2 = B2_ACTIVO && parejasB2.length ? bootstrapRatioCIEstratificado(estratosB2, { seed: SEED }) : undefined;
  const wPB2 = aggB2 ? wilcoxonSignedRankP(parejasB2.map((p) => p.costA2! - p.costB)) : undefined;
  const provenB2 = aggB2 ? mode === "LIVE" && aggB2.lower > 0 && qualityPassRate >= QUALITY_FLOOR && allFpStable : undefined;
  // Y LO QUE AHORRA EL PROVEEDOR SOLO: B2 frente a B0. No es una cifra de
  // BV-SALA —es el descuento que cualquiera obtiene leyendo la documentación—,
  // y por eso se publica aparte y con esa etiqueta.
  const aggNativoVsB0 = aggB2
    ? bootstrapRatioCIEstratificado(
        results.map((r) => {
          const conB2 = r.paired.filter((p) => p.costA2 != null);
          return { costA: conB2.map((p) => p.costA), costB: conB2.map((p) => p.costA2!) };
        }),
        { seed: SEED },
      )
    : undefined;

  // LOS SUELOS: la cota inferior del IC frente a cada brazo de control, y el
  // MENOR. Cualquier cifra que se publique tiene que caber bajo `min`: prometer
  // solo contra la base más favorable es elegir la comparación que más enseña.
  const suelos: { brazo: "B0" | "B1" | "B2"; lower: number }[] = [
    { brazo: "B0", lower: agg.lower },
    ...(aggB1 ? [{ brazo: "B1" as const, lower: aggB1.lower }] : []),
    ...(aggB2 ? [{ brazo: "B2" as const, lower: aggB2.lower }] : []),
  ];
  const menor = Math.min(...suelos.map((x) => x.lower));
  // Ante un empate, el control más fuerte: B2, luego B1, luego B0.
  const contraQuien = [...suelos].reverse().find((x) => x.lower === menor)!.brazo;
  const floors = {
    vsB0: agg.lower,
    vsB1: aggB1 ? aggB1.lower : null,
    vsB2: aggB2 ? aggB2.lower : null,
    min: menor,
    minAgainst: contraQuien,
    note:
      "95% CI lower bounds of the same stratified estimator against each control arm. Any claim must fit under `min`.",
  };

  // Per-ledger attribution. Each scenario maps to exactly ONE ledger, so the
  // ledger cost-deltas PARTITION the total delta — double-counting is impossible
  // by construction, and the reconciliation residual below proves it.
  const ledgerRollup: FilaDeLibro[] = LEDGERS.map((lg) => {
    const rs = results.filter((r) => r.ledger === lg);
    const a = rs.flatMap((r) => r.paired.map((p) => p.costA));
    const b = rs.flatMap((r) => r.paired.map((p) => p.costB));
    const ci = bootstrapRatioCI(a, b, { seed: SEED });
    return {
      ledger: lg,
      scenarios: rs.map((r) => r.name),
      savings: ci,
      deltaCost: sumArr(a) - sumArr(b),
      proven: mode === "LIVE" && ci.lower > 0 && rs.length > 0 && rs.every((r) => r.quality.passed === r.quality.total && r.modelStable),
    };
  });

  const ledgerRollupB1: FilaDeLibro[] | undefined = aggB1
    ? LEDGERS.map((lg) => {
        const rs = results.filter((r) => r.ledger === lg);
        const ps = rs.flatMap((r) => r.paired).filter((p) => p.costA1 != null);
        const a = ps.map((p) => p.costA1!);
        const b = ps.map((p) => p.costB);
        const ci = bootstrapRatioCI(a, b, { seed: SEED });
        return {
          ledger: lg,
          scenarios: rs.map((r) => r.name),
          savings: ci,
          deltaCost: sumArr(a) - sumArr(b),
          proven: mode === "LIVE" && ci.lower > 0 && rs.length > 0 && rs.every((r) => r.quality.passed === r.quality.total && r.modelStable),
        };
      })
    : undefined;

  const ledgerRollupB2: FilaDeLibro[] | undefined = aggB2
    ? LEDGERS.map((lg) => {
        const rs = results.filter((r) => r.ledger === lg);
        const ps = rs.flatMap((r) => r.paired).filter((p) => p.costA2 != null);
        const a = ps.map((p) => p.costA2!);
        const b = ps.map((p) => p.costB);
        const ci = bootstrapRatioCI(a, b, { seed: SEED });
        return {
          ledger: lg,
          scenarios: rs.map((r) => r.name),
          savings: ci,
          deltaCost: sumArr(a) - sumArr(b),
          proven: mode === "LIVE" && ci.lower > 0 && rs.length > 0 && rs.every((r) => r.quality.passed === r.quality.total && r.modelStable),
        };
      })
    : undefined;

  // Reconciliation: (Σ ledger deltas) + (the "none"/setup bucket) must equal the
  // total measured delta, to the cent. A non-zero residual means a bug.
  const totalDelta = sumArr(allA) - sumArr(allB);
  const noneRs = results.filter((r) => !(LEDGERS as string[]).includes(r.ledger));
  const noneDelta =
    sumArr(noneRs.flatMap((r) => r.paired.map((p) => p.costA))) -
    sumArr(noneRs.flatMap((r) => r.paired.map((p) => p.costB)));
  const ledgerSum = ledgerRollup.reduce((n, l) => n + l.deltaCost, 0) + noneDelta;
  const residual = totalDelta - ledgerSum;
  const reconciled = Math.abs(residual) < 1e-9;
  // La misma partición, frente a B1: los libros también tienen que cuadrar ahí.
  let reconciliationB1: { totalDelta: number; ledgerSum: number; residual: number; reconciled: boolean } | undefined;
  if (ledgerRollupB1) {
    const totalB1 = sumArr(parejasB1.map((p) => p.costA1!)) - sumArr(parejasB1.map((p) => p.costB));
    const noneB1 = noneRs.flatMap((r) => r.paired).filter((p) => p.costA1 != null);
    const noneDeltaB1 = sumArr(noneB1.map((p) => p.costA1!)) - sumArr(noneB1.map((p) => p.costB));
    const sumaB1 = ledgerRollupB1.reduce((n, l) => n + l.deltaCost, 0) + noneDeltaB1;
    const residualB1 = totalB1 - sumaB1;
    reconciliationB1 = { totalDelta: totalB1, ledgerSum: sumaB1, residual: residualB1, reconciled: Math.abs(residualB1) < 1e-9 };
  }
  // Y frente a B2: la misma partición tiene que cuadrar.
  let reconciliationB2: { totalDelta: number; ledgerSum: number; residual: number; reconciled: boolean } | undefined;
  if (ledgerRollupB2) {
    const totalB2 = sumArr(parejasB2.map((p) => p.costA2!)) - sumArr(parejasB2.map((p) => p.costB));
    const noneB2 = noneRs.flatMap((r) => r.paired).filter((p) => p.costA2 != null);
    const noneDeltaB2 = sumArr(noneB2.map((p) => p.costA2!)) - sumArr(noneB2.map((p) => p.costB));
    const sumaB2 = ledgerRollupB2.reduce((n, l) => n + l.deltaCost, 0) + noneDeltaB2;
    const residualB2 = totalB2 - sumaB2;
    reconciliationB2 = { totalDelta: totalB2, ledgerSum: sumaB2, residual: residualB2, reconciled: Math.abs(residualB2) < 1e-9 };
  }

  // ── B2: sus decisiones a nivel de modelo, y si el modo de caché llegó ──────
  const planes = results.filter((r) => r.planB2).map((r) => ({ escenario: r.name, plan: r.planB2! }));
  const decisionesB2 = resumirPlanes(planes);
  const transportesB2 = [...new Set(planes.map((x) => x.plan.transporte))];
  // ¿Honró el proveedor el modo explícito? Falso si B2 escribió caché en una
  // repetición sin breakpoint; verdadero si en alguna B0 escribió y B2 no; si
  // no se pudo observar (prompts por debajo del mínimo, o ninguna repetición
  // sin breakpoint), null — que no es un sí.
  const sondas = results.map((r) => r.sondaDeModo).filter((x): x is NonNullable<typeof x> => !!x && x.reps > 0);
  const honradoModo: boolean | null = sondas.length === 0 || mode !== "LIVE"
    ? null
    : sondas.some((x) => x.escriturasB2SinBreakpoint > 0)
      ? false
      : sondas.some((x) => x.escriturasB0 > 0)
        ? true
        : null;
  const nativo = B2_ACTIVO
    ? {
        effort: ESFUERZO_B2,
        transport: transportesB2.length === 1 ? transportesB2[0]! : transportesB2.length ? transportesB2.join(",") : "none",
        simulated: mode !== "LIVE",
        degradedByTransport: planes.some((x) => x.plan.degradadoPorTransporte),
        decisions: decisionesB2,
        honored: { promptCacheMode: honradoModo },
        note:
          "What arm B2 applied, per feature, with the official page it follows. `scenarios` lists where a feature was " +
          "applied; `honored.promptCacheMode` is true only when the provider was seen writing no cache under explicit " +
          "mode without a breakpoint while the naive arm wrote, false when it wrote anyway, null when not observable.",
      }
    : undefined;

  // Validez del contrato en B2, a nivel de modelo: B2 puede abaratar contestando peor.
  const nativoValidos = results.reduce((n, r) => n + (r.nativeContractValid?.valid ?? 0), 0);
  const nativoTotal = results.reduce((n, r) => n + (r.nativeContractValid?.total ?? 0), 0);

  // ── Lo que se gastó, contra qué precio y contra qué endpoint ─────────────
  const gastoAlAcabar = fotoDelGasto();
  const gastoDelModelo = gastoAlAcabar.total - gastoAlEmpezar.total;
  const llamadasDelModelo = gastoAlAcabar.llamadas - gastoAlEmpezar.llamadas;
  const informadasDelModelo = gastoAlAcabar.informadas - gastoAlEmpezar.informadas;
  // De dónde salió el contador de escritura en las llamadas de ESTE modelo.
  const fuentesDelModelo = (["adapter", "raw-usage"] as const).filter(
    (f) => (gastoAlAcabar.fuentes[f] ?? 0) - (gastoAlEmpezar.fuentes[f] ?? 0) > 0,
  );
  const modelosTarifados = [...new Set(results.map((r) => r.model))];
  const primaMaxima = Math.max(1, ...modelosTarifados.map((m) => precioYPrima(m).prima));
  const conocidos = modelosTarifados.filter((m) => precioYPrima(m).conocido);
  const ilustrativos = modelosTarifados.filter((m) => !precioYPrima(m).conocido);
  const precioDeListaConocido = modelosTarifados.length > 0 && ilustrativos.length === 0;
  // SOLO las filas del catálogo: un precio ilustrativo bajo la clave del modelo
  // se leería como su precio de lista.
  const tablaDePrecios = Object.fromEntries(
    conocidos.map((m) => {
      const pp = precioYPrima(m);
      return [pp.clave ?? desnudo(m), pp.precio];
    }),
  );
  // ¿Trajo el contador de escritura TODA llamada a un modelo que paga la
  // escritura a prima? Es condición para publicar: una escritura sin contador se
  // tarifaría a 0. Sin llamadas con prima no hay nada que medir (`null`).
  const llamadasConPrima = gastoAlAcabar.llamadasConPrima - gastoAlEmpezar.llamadasConPrima;
  const informadasConPrima = gastoAlAcabar.informadasConPrima - gastoAlEmpezar.informadasConPrima;
  const escriturasMedidas: boolean | null = llamadasConPrima === 0 ? null : informadasConPrima === llamadasConPrima;
  const techoDelModelo = estimarModelo(modelo).costeTecho;
  const hosts = [
    ...new Set(
      results.map((r) => endpointDeModelo(r.model, CONFIG_DE_TRANSPORTE)?.host).filter((h): h is string => !!h),
    ),
  ];
  const kinds = [...new Set(results.map((r) => transporteDe(r.model)))];
  // El muestreo lo decide el modelo (`muestreoPareadoPara`); sin modelo forzado,
  // cada escenario el suyo.
  const muestreos = [...new Set(results.map((r) => `${r.sampling.temperature}/${r.sampling.seed}`))];
  const muestreoUnico = muestreos.length <= 1 ? results[0]?.sampling : undefined;
  const sampling = muestreoUnico
    ? {
        temperature: muestreoUnico.temperature,
        seed: muestreoUnico.seed,
        reason:
          muestreoUnico.temperature != null
            ? "the model honours a fixed temperature and seed: every arm sends temperature 0 and seed 7"
            : "the model is classified as reasoning or unclassified (src/pricing/razonamiento.ts), where a fixed " +
              "temperature is rejected or ignored: every arm uses the provider default",
      }
    : {
        temperature: "per-scenario",
        seed: "per-scenario",
        reason: "each scenario uses its own model's rule; see scenarios[].sampling",
      };
  const costeDelModelo = {
    ceilingUsd: techoDelModelo,
    spentUsd: gastoDelModelo,
    budgetUsd: Number.isFinite(PRESUPUESTO) ? PRESUPUESTO : null,
    calls: llamadasDelModelo,
    note:
      "spentUsd = every provider call of this model in this run (classification probe, all arms and the cache " +
      "amortization) at list price, cache writes at their premium; the judge is excluded. ceilingUsd is the estimate " +
      "printed before the first call. In MOCK both are what the run would cost, not money spent.",
  };

  console.log("\nHeadline (per cold single call, measured both sides; one effective rep per scenario)");
  if (mode === "LIVE") {
    console.log(`  Net savings:   point ${pct(agg.point)}   95% CI [${pct(agg.lower)}, ${pct(agg.upper)}]   (stratified by scenario, equal weight)`);
    console.log(`  Claim:         ${proven ? `VERIFIED ≥ ${pct(agg.lower)} at 95% confidence` : "NOT PROVEN (CI lower ≤ 0, quality regressed, or model swapped)"}`);
    console.log(`  Pooled (old):  point ${pct(aggPooled.point)}   95% CI [${pct(aggPooled.lower)}, ${pct(aggPooled.upper)}]   (all trials together — weighted by reps × cost; not the headline)`);
    console.log(`  Wilcoxon p:    ${wP.toExponential(2)}   (H1: median saving > 0)`);
    if (!allFpStable) console.log(`  ⚠ los dos brazos no hablaron con el mismo modelo: ${results.flatMap((r) => r.servedModels).join(", ")}`);
    if (aggB1 && wPB1 != null) {
      console.log(`  vs B1 (razonable): point ${pct(aggB1.point)}   95% CI [${pct(aggB1.lower)}, ${pct(aggB1.upper)}]   Wilcoxon p ${wPB1.toExponential(2)}`);
      console.log(`  Claim vs B1:   ${provenB1 ? `VERIFIED ≥ ${pct(aggB1.lower)} beyond a reasonably optimized integration` : "NOT PROVEN vs B1 (CI lower ≤ 0, quality regressed, or model swapped)"}`);
    }
    if (aggB2 && wPB2 != null) {
      console.log(`  vs B2 (nativo):    point ${pct(aggB2.point)}   95% CI [${pct(aggB2.lower)}, ${pct(aggB2.upper)}]   Wilcoxon p ${wPB2.toExponential(2)}`);
      console.log(`  Claim vs B2:   ${provenB2 ? `VERIFIED ≥ ${pct(aggB2.lower)} beyond a natively well-configured integration` : "NOT PROVEN vs B2 (CI lower ≤ 0, quality regressed, or model swapped)"}`);
    }
    if (aggNativoVsB0) {
      console.log(`  B2 vs B0:      point ${pct(aggNativoVsB0.point)}   95% CI [${pct(aggNativoVsB0.lower)}, ${pct(aggNativoVsB0.upper)}]   (lo que ahorra el proveedor SOLO: no es cifra de BV-SALA)`);
    }
  } else {
    console.log(`  Net savings:   ${pct(agg.point)}  — ESTIMATED (mock provider), NOT a real savings claim   (pooled: ${pct(aggPooled.point)})`);
    if (aggB1) console.log(`  vs B1:         ${pct(aggB1.point)}  — ESTIMATED (mock provider), NOT a real savings claim`);
    if (aggB2) console.log(`  vs B2:         ${pct(aggB2.point)}  — ESTIMATED (mock provider), NOT a real savings claim`);
    console.log(`  Run LIVE (declare an endpoint: BVSALA_DEMO_BASE_URL or a per-family one) for real provider tokens & dollars.`);
  }
  console.log(`  Suelo mínimo:  ${pct(floors.min)} frente a ${floors.minAgainst} — cualquier cifra publicada tiene que caber debajo`);
  console.log(`  Quality:       ${qTotalPass}/${qTotal} answers passed the gate (${pct(qualityPassRate)})`);
  const nv = results.reduce((n, r) => n + r.naiveContractValid.valid, 0);
  const nt = results.reduce((n, r) => n + r.naiveContractValid.total, 0);
  if (nt > 0) {
    console.log(`  Naive valid:   ${nv}/${nt} respuestas del brazo SIN la capa cumplían el contrato (${pct(nv / nt)})`);
    console.log(`                 (la capa paga tokens por garantizarlo; el naive no, y hasta ahora nadie se lo exigía)`);
  }
  // LA PISTA DE LÍMITES, ESCENARIO POR ESCENARIO. Es la petición extra que solo
  // paga el brazo B y solo después de un fallo de valor en ese contrato; una fila
  // con la pista en PARTE de sus repeticiones ha medido dos peticiones distintas.
  const conPista = results.filter((r) => r.pistaDeLimites.reps > 0);
  if (conPista.length) {
    console.log(
      `  Pista límites: ${conPista.map((r) => `${r.name} ${r.pistaDeLimites.reps}/${r.pistaDeLimites.total}`).join(", ")}`,
    );
    console.log(`                 (repeticiones cuyo brazo B llevó \`JSON limits (not API-enforced)\`: ~30 tokens de entrada y salida más larga)`);
  }
  console.log(`  Reconciles:    ${reconciled ? "yes" : "NO — residual " + money(residual)}  (ledger deltas partition the total, no double-counting)`);
  // Va PEGADO al titular de calidad, no en una sección al final: es la diferencia
  // entre «la capa empeoró la respuesta» y «el tope cortó la respuesta», y quien
  // lea el 0/8 sin esto sacará la conclusión equivocada — que es la que sacó la
  // tirada del 2026-08-16 hasta que alguien fue a contar tokens al CSV.
  const cortadas = avisoDeTruncado(results);
  if (cortadas) console.log(cortadas);

  console.log("\nPer-ledger attribution (measured; a ledger is 'proven' only if its 95% CI clears 0)");
  for (const l of ledgerRollup) {
    const badge = l.scenarios.length === 0 ? "sin escenario" : mode !== "LIVE" ? "est" : l.proven ? "proven" : "not-proven";
    const b1 = ledgerRollupB1?.find((x) => x.ledger === l.ledger);
    const colB1 = b1 ? `   vs B1 ${padL(pct(b1.savings.point), 8)}  95%lo ${padL(pct(b1.savings.lower), 8)}` : "";
    const b2 = ledgerRollupB2?.find((x) => x.ledger === l.ledger);
    const colB2 = b2 ? `   vs B2 ${padL(pct(b2.savings.point), 8)}  95%lo ${padL(pct(b2.savings.lower), 8)}` : "";
    console.log(`  ${pad(l.ledger, 20)} ${padL(pct(l.savings.point), 8)}  95%lo ${padL(pct(l.savings.lower), 8)}   ${badge}${colB1}${colB2}`);
  }

  // ── B2: qué hizo, con qué fuente, y si el proveedor lo honró ──────────────
  if (nativo) {
    console.log(
      `\nB2 nativo  (transporte ${nativo.transport}, esfuerzo ${ESFUERZO_B2}` +
        `${nativo.simulated ? ", SIMULADO: MOCK, nada llegó a un proveedor" : ""})`,
    );
    for (const d of decisionesB2) {
      const donde = d.applied && d.scenarios?.length ? `  [${d.scenarios.length} escenario(s)]` : "";
      console.log(`  ${d.applied ? "✓" : "–"} ${pad(d.feature, 26)} ${d.reason}${donde}`);
      console.log(`    ${" ".repeat(26)} ${d.source.url} (${d.source.checked})`);
    }
    if (nativo.degradedByTransport) {
      console.log("  ⚠ DEGRADADO POR TRANSPORTE: un modelo de Claude por un endpoint OpenAI. Esta tirada no se puede publicar.");
    }
    console.log(
      `  modo de caché explícito honrado: ${honradoModo === null ? "no observable (null)" : honradoModo ? "sí" : "NO — no se puede publicar"}`,
    );
  }
  console.log(
    `\nGasto de este modelo: ${dinero4(gastoDelModelo)} (techo estimado ${dinero4(techoDelModelo)}; ` +
      `${llamadasDelModelo} llamadas, contador de escritura de caché en ${informadasDelModelo}/${llamadasDelModelo})` +
      (mode === "LIVE" ? "" : "  — MOCK: lo que costaría, no dinero gastado"),
  );

  // ── EL AVISO HONESTO: qué palancas NO se ejercitaron y por qué ────────────
  //
  // Una palanca que la verja económica descartó, una que degradó y una que
  // ahorra cero producen la MISMA cifra. Sin esta sección el lector no puede
  // distinguirlas, y las tres se arreglan de forma distinta.
  const palancas: EstadoDePalancaEnLaTirada[] = results
    .filter((r) => r.palanca)
    .map((r) => ({ ...r.palanca!, escenario: r.name }));
  const sinEjercitar = palancas.filter((p) => !p.ejercitada);
  console.log("\nPalancas opt-in de la 0.3.0 en esta tirada");
  for (const p of palancas) {
    console.log(`  ${p.ejercitada ? "✓" : "✗"} ${pad(p.palanca, 22)} ${pad(p.escenario, 28)} ${p.motivo}`);
  }
  for (const { palanca, motivo } of PALANCAS_SIN_ESCENARIO) {
    console.log(`  ✗ ${pad(palanca, 22)} ${pad("(sin escenario)", 28)} ${motivo}`);
  }
  // LA TERCERA CATEGORÍA, y sin ella el informe mentía por omisión. Un ✗ dice
  // "se pidió y no disparó", que es una medición; esto dice "con este endpoint no
  // se puede ni pedir", que no lo es. El escenario ni se ha ejecutado, así que
  // aquí no hay ningún cero que enseñar — hay una instrucción de configuración.
  for (const p of noMedibles) {
    console.log(`  ⊘ ${pad(p.palanca, 22)} ${pad(p.escenario, 28)} NO MEDIBLE: ${p.motivo}`);
    console.log(`    ${" ".repeat(22)} ${pad("", 28)} → para medirla: ${p.comoMedirla}`);
  }
  if (sinEjercitar.length > 0 || PALANCAS_SIN_ESCENARIO.length > 0) {
    console.log(
      "  ⚠ Las marcadas con ✗ NO se midieron. Un cero suyo no significa que no ahorren:\n" +
      "    significa que en esta tirada no llegaron a ejecutarse.",
    );
  }
  if (noMedibles.length > 0) {
    console.log(
      "  ⚠ Las marcadas con ⊘ NO se midieron NI SE PODÍAN MEDIR con este transporte, así que su\n" +
      "    escenario no llegó a ejecutarse y no hay cifra suya en este informe — ni un cero.",
    );
  }
  // Dos avisos que solo tienen sentido en MOCK, y que evitan leer como resultado
  // lo que es una limitación del proveedor simulado.
  if (mode === "MOCK") {
    if (sinEjercitar.some((p) => p.palanca === "toolDiscovery")) {
      console.log(
        "    · toolDiscovery: el proveedor simulado NUNCA devuelve tool_calls, así que el sondeo\n" +
        "      siempre degrada y esta fila mide el PEOR caso del patrón (una llamada extra pagada\n" +
        "      y ningún esquema ahorrado). En LIVE el modelo sí elige, y ahí se mide la palanca.",
      );
    }
    if (sinEjercitar.some((p) => p.palanca === "providerPrefixCache")) {
      console.log(
        "    · providerPrefixCache: el proveedor simulado no reporta `cached_tokens`. Esta palanca\n" +
        "      solo es medible en LIVE, por construcción.",
      );
    }
    // EL CASO INVERSO, Y EL MÁS CARO DE LOS TRES: aquí la palanca SÍ se ejercitó
    // y su cifra es la que no vale. Un ✗ se lee como "no medido"; un ✓ con un
    // 24,8% al lado se lee como resultado, y es un artefacto del fixture.
    if (palancas.some((p) => p.palanca === "outputCodebook" && p.ejercitada)) {
      console.log(AVISO_MOCK_DEL_CODEBOOK);
    }
  }
  for (const s of noAplican) {
    // Las de causa `transporte` ya salieron arriba con su ⊘ y su instrucción de
    // configuración; repetirlas aquí como "(no aplica)" diría lo contrario de lo
    // que pasa: el escenario SÍ aplica a este modelo, es el endpoint el que no
    // puede ejercitarlo.
    if (s.causa === "transporte") continue;
    console.log(`  – ${pad("(no aplica)", 22)} ${pad(s.name, 28)} ${s.motivo}`);
  }

  const cacheRows = results.filter((r) => r.amortization);
  if (cacheRows.length) {
    console.log("\nRepeat-traffic (cache amortization — savings grow with reuse)");
    for (const r of cacheRows) {
      const a = r.amortization!;
      console.log(`  ${pad(r.name, 26)} cold-miss ${money(a.coldMissCost)}  hit ${money(a.hitCost)}  break-even at K=${a.breakEvenK ?? "∞"}`);
    }
  }

  const escenariosDelArtefacto = results.map((r) => ({
    ...r,
    paired: undefined,
    planB2: undefined,
    latencySamples: undefined,
  }));
  const latencia = conVerjaDeLatencia(latenciaBase, escenariosDelArtefacto, mode);
  console.log(`\nLatency B2-F0 (total end-to-end ms; ${mode === "MOCK" ? "INSTRUMENTAL, never a production SLA" : "measured"})`);
  for (const brazo of latencia.activeArms) {
    const l = latencia.arms[brazo]!.total;
    console.log(`  ${pad(brazo, 4)} n=${l.n}  p50=${l.p50.toFixed(1)}  p95=${l.p95.toFixed(1)}  max=${l.max.toFixed(1)}`);
  }
  console.log(`  gate: ${latencia.gate!.approved ? "within p95 ≤ 3000ms and max ≤ 5000ms" : latencia.gate!.reasons.join("; ")}`);

  const artefacto: Record<string, unknown> = {
    mode,
    latency: latencia,
    ...(modelo ? { model: modelo } : {}),
    // SELLO DE PROCEDENCIA. Sin él, un artefacto publicado no dice de qué tirada
    // salió, así que era imposible detectar a posteriori que el JSON y el CSV de
    // ensayos venían de corridas DISTINTAS — el fallo que encontró la auditoría:
    // el CSV recomputaba 27,1 % junto a un JSON que titulaba ≥24,1 %. Con la
    // fecha y el commit, JSON y CSV de la misma tirada quedan atados y una
    // desincronía futura se ve a simple vista.
    generatedAt: new Date().toISOString(),
    commit: gitCommitCorto(),
    // Y EL LAZO QUE DE VERDAD LO IMPIDE, no solo lo delata: el número de ensayos
    // que esta misma tirada vuelca al CSV. `pnpm ab:publish` cuenta las filas del
    // CSV que va a copiar y se niega si no cuadran, así que un CSV rezagado de
    // una corrida anterior ya no puede viajar junto a este JSON.
    trials: results.reduce((n, r) => n + r.paired.length, 0),
    // QUÉ SDK SE MIDIÓ. `asShipped: false` = con el compresor del banco, que el
    // paquete de npm no trae: sirve para investigar la palanca, nunca para el
    // titular (la verja de publicación lo bloquea). Público: en inglés.
    sdk: selloDelSdk(),
    generatedNote: mode === "LIVE" ? "real provider tokens & cost, quality-gated" : "ESTIMATED — mock provider, not a savings claim",
    // El precio, del CATÁLOGO del SDK y de nada más: la fila del propio modelo.
    // Sin ella, `listPriceKnown: false` y la verja de publicación lo rechaza.
    pricing: {
      note: PRICING_NOTE,
      table: tablaDePrecios,
      catalogueDated: PRICES_AS_OF,
      listPriceKnown: precioDeListaConocido,
      ...(ilustrativos.length
        ? {
            illustrative: {
              models: ilustrativos,
              price: PRECIO_ILUSTRATIVO,
              note:
                "These models have no row in the SDK price catalogue: their dollars use the gpt-4o-mini catalogue row as an " +
                "illustrative price. This artefact cannot be published.",
            },
          }
        : {}),
      cacheWrites: {
        premium: primaMaxima,
        metered: escriturasMedidas,
        source: fuentesDelModelo.length ? fuentesDelModelo.join(",") : "none",
        note:
          "Cache writes are priced at the input rate times `premium` (src/pricing/primas.ts), read from the provider's " +
          "counter (the adapter's cacheWriteInputTokens, else the raw usage). `metered` is true only when every call to a " +
          "model with a write premium carried that counter, and null when no such call was made; with premium > 1 an " +
          "artefact without it cannot be published.",
      },
    },
    sampling,
    transport: { kind: kinds.join(","), endpointHost: hosts.length ? hosts.join(",") : null },
    cost: costeDelModelo,
    // EL CONJUNTO ENTERO, antes del reparto por modelo: cada nombre tiene que
    // aparecer en `scenarios` o en `scenariosNotApplicable`. Quitar una fila roja
    // en silencio es elegir la cifra, y la verja de publicación lo comprueba.
    scenarioSet: { size: scenarios.length, names: scenarios.map((x) => x.name) },
    methodology:
      "Paired A/B: Arm A = naive request (B0: full compact JSON, all tools, no cache marks; same contract and cap as the caller) executed against the same provider; " +
      (B1_ACTIVO ? "Arm A1 = the same integration reasonably optimized (B1: native provider cache configured on the stable prefix, hand-picked tools where the scenario declares them); " : "") +
      (B2_ACTIVO ? "Arm A2 = the same integration natively well-configured (B2: B1 plus the provider's documented no-cost settings that apply to the request shape, each decision and its source in `native.decisions`); " : "") +
      "Arm B = BV-SALA optimized. All arms priced from provider usage, cache writes at the model's write premium. Headline = 95% STRATIFIED bootstrap CI lower bound of " +
      "1 − Σ_s mean(costB_s) / Σ_s mean(costA_s), one stratum per scenario with equal weight, resampled within each scenario " +
      "(so the headline does not move with how many reps the adaptive sampler gave each scenario; the interval is conditional " +
      "on this fixed scenario set and covers per-scenario sampling noise only). The pooled 1−ΣcostB/ΣcostA " +
      "over all trials is kept in `aggregatePooled` for comparison with earlier artefacts; it is no longer the headline" +
      (B1_ACTIVO ? "; `aggregateB1` is the same stratified headline against Arm A1 — the research guide's «additional value of Savings»" : "") +
      (B2_ACTIVO ? "; `aggregateB2` is the same stratified headline against Arm A2, and `floors.min` is the lowest of the three lower bounds: any claim must fit under it" : "") +
      ". Quality gate voids regressed answers. Cache savings amortized separately with a break-even K. " +
      "B2-F0 latency uses a monotonic clock for every arm; per-scenario and aggregate p50/p95/max cover total, provider and layer overhead. " +
      "Publication requires total p95 ≤ 3000ms and max ≤ 5000ms. MOCK timings are estimated/instrumental, never a production SLA.",
    arms: {
      A: DEFINICION_DE_BRAZOS.A,
      ...(B1_ACTIVO ? { A1: DEFINICION_DE_BRAZOS.A1 } : {}),
      ...(B2_ACTIVO ? { A2: DEFINICION_DE_BRAZOS.A2 } : {}),
      B: DEFINICION_DE_BRAZOS.B,
    },
    // `resamples` y `seed` son los del bootstrap: con ellos y el CSV de ensayos,
    // `apps/web/public/measure/reproduce.mjs` recalcula los agregados bit a bit.
    config: {
      reps: REPS,
      minReps: REPS,
      maxReps: MAX_REPS,
      ciTarget: CI_TARGET,
      qualityFloor: QUALITY_FLOOR,
      seed: SEED,
      resamples: REMUESTREOS,
      b1: B1_ACTIVO,
      b2: B2_ACTIVO,
      ...(B2_ACTIVO ? { b2Effort: ESFUERZO_B2 } : {}),
      reasoningHeadroomTokens: MARGEN_RAZONAMIENTO,
    },
    // `planB2` y las muestras crudas auxiliares son internos; los percentiles sí se publican.
    scenarios: escenariosDelArtefacto,
    // LOS ESCENARIOS QUE NO SE MIDIERON CONTRA ESTE MODELO, con su motivo. Sin
    // esta lista, un artefacto de `gpt-4o-mini` y uno de `claude-haiku` parecen
    // comparables aunque midan conjuntos de escenarios distintos.
    scenariosNotApplicable: noAplican,
    // LAS PALANCAS, ejercitadas o no. Ver la nota de `EstadoDePalanca`.
    levers: {
      exercised: palancas.filter((p) => p.ejercitada),
      notExercised: [
        ...sinEjercitar,
        ...PALANCAS_SIN_ESCENARIO.map((p) => ({ ...p, escenario: null, ejercitada: false, motivo: p.motivo })),
      ],
      // NO MEDIBLE ≠ NO EJERCITADA. La primera es una propiedad del endpoint que
      // se ha configurado —el escenario ni se ejecutó— y la segunda es el
      // resultado de ejecutarlo. Meterlas en el mismo saco fue lo que dejó que se
      // publicara un 0 de la caché de Anthropic como si fuera un fracaso medido.
      notMeasurable: noMedibles,
      warning:
        "Una palanca NO ejercitada produce las mismas cifras que una que no ahorra. " +
        "No leas su cero como una medición: no llegó a ejecutarse.",
      notMeasurableWarning:
        "Una palanca en `notMeasurable` no tiene cifra en este artefacto porque su escenario NO " +
        "se ejecutó: el transporte configurado no puede ejercitarla. `comoMedirla` dice qué " +
        "configurar para que la haya.",
    },
    ledgers: ledgerRollup,
    reconciliation: { totalDelta, ledgerSum, residual, reconciled },
    ...(ledgerRollupB1 ? { ledgersB1: ledgerRollupB1 } : {}),
    ...(reconciliationB1 ? { reconciliationB1 } : {}),
    ...(ledgerRollupB2 ? { ledgersB2: ledgerRollupB2 } : {}),
    ...(reconciliationB2 ? { reconciliationB2 } : {}),
    modelStable: allFpStable,
    aggregate: {
      savings: agg,
      estimator: "stratified-by-scenario",
      scenarioWeight: "equal (one effective rep per scenario; bootstrap resamples within each scenario)",
      strata: results.length,
      wilcoxonP: wP,
      qualityPassRate,
      proven,
      headline: mode === "LIVE"
        ? (proven ? `verified ≥ ${pct(agg.lower)} (95% CI lower bound)` : "not proven")
        : "ESTIMATED (mock) — not a savings claim",
    },
    // EL AGREGADO ANTIGUO, ya no el titular. Se conserva para poder comparar con
    // los artefactos publicados antes del 2026-09-12 y para que se vea cuánto
    // mueve la ponderación por reps.
    aggregatePooled: {
      savings: aggPooled,
      estimator: "pooled-all-trials",
      note:
        "1 − ΣcostB/ΣcostA over every trial of every scenario. Weights each scenario by reps × cost, " +
        "and the adaptive sampler gives more reps to the noisy scenarios, so this figure moved with the " +
        "rep split (20.8% → 16.5% → 19.1% across three runs of the same layer) while the stratified one " +
        "stayed put (21.3 / 19.4 / 20.5). Kept for comparison; it is NOT the headline.",
    },
    ...(aggB1 && wPB1 != null
      ? {
          aggregateB1: {
            savings: aggB1,
            estimator: "stratified-by-scenario",
            wilcoxonP: wPB1,
            qualityPassRate,
            proven: provenB1,
            headline: mode === "LIVE"
              ? (provenB1 ? `verified ≥ ${pct(aggB1.lower)} beyond a reasonably optimized integration (95% CI lower bound)` : "not proven vs B1")
              : "ESTIMATED (mock) — not a savings claim",
          },
        }
      : {}),
    ...(aggB2 && wPB2 != null
      ? {
          aggregateB2: {
            savings: aggB2,
            estimator: "stratified-by-scenario",
            strata: estratosB2.filter((e) => e.costA.length > 0).length,
            wilcoxonP: wPB2,
            qualityPassRate,
            ...(nativoTotal > 0 ? { nativeContractValidRate: nativoValidos / nativoTotal } : {}),
            proven: provenB2,
            headline: mode === "LIVE"
              ? (provenB2 ? `verified ≥ ${pct(aggB2.lower)} beyond a natively well-configured integration (95% CI lower bound)` : "not proven vs B2")
              : "ESTIMATED (mock) — not a savings claim",
          },
        }
      : {}),
    ...(aggNativoVsB0
      ? {
          aggregateNativeVsB0: {
            savings: aggNativoVsB0,
            estimator: "stratified-by-scenario",
            note: "What the provider's own settings (arm B2) save against the naive request (B0). Not a BV-SALA figure.",
          },
        }
      : {}),
    floors,
    ...(nativo ? { native: nativo } : {}),
    honesty: [
      "Both arms are metered by the provider's own tokenizer — no modeled baseline.",
      "Since 2026-09-12 every arm is sampled the same way. Before, only the naive arm was: arm B went out with the " +
        "provider's default sampling, so its outputs carried variance that was not the layer's. Earlier artefacts are " +
        "not comparable rep by rep. Since 2026-09-27 the rule is per model (`sampling`): temperature 0 and seed 7 where " +
        "the model honours them (Anthropic ignores seed), the provider default where src/pricing/razonamiento.ts " +
        "classifies the model as reasoning or unclassified — a fixed temperature is rejected or ignored there.",
      "Since 2026-09-12 every measured call of arm B starts with a fresh contract memory, like it starts with a " +
        "cold cache: the limits hint the layer adds after a value failure can only appear inside a within-call " +
        "repair (both provider calls counted). `scenarios[].pistaDeLimites` counts the reps where it travelled.",
      "The headline is the 95% CI lower bound, never the point estimate.",
      SDK_TAL_COMO_SE_INSTALA
        ? "Arm B is the SDK exactly as installed from npm (`sdk.asShipped`): no compressor is injected, because the package " +
          "ships noopCompressor only. A scenario that asks for compression is still measured — it is traffic a customer " +
          "sends — and its saving is whatever the shipped SDK achieves on it, with the lever declared in `levers.notExercised`."
        : "Arm B carries a bench-only compressor the npm package does not ship (`sdk.asShipped: false`). This run " +
          "measures a lever a customer does not have; it is research, not a headline, and `pnpm ab:publish` refuses it.",
      "The headline is STRATIFIED by scenario with equal weight: f = 1 − Σ_s mean(costB_s)/Σ_s mean(costA_s), resampled " +
        "within each scenario. Pooling every trial let the adaptive sampler's rep split move the headline by 4 points " +
        "between runs of the same layer; the pooled figure is kept as `aggregatePooled` and is not the claim.",
      "The stratified interval is CONDITIONAL on this fixed set of scenarios: it covers per-scenario sampling noise only, " +
        "not the uncertainty of which scenarios stand for a customer's traffic. That is why it is narrower than the pooled " +
        "one — it answers a narrower question, not a more confident one. A traffic mix unlike these scenarios is not covered.",
      "A saving is voided if its answer fails the quality gate.",
      "Una respuesta cortada por el tope (`finish_reason: \"length\"`) SUSPENDE la verja aunque el " +
        "escenario no tenga contrato de salida: media respuesta con longitud > 0 aprobaba y publicaba " +
        "su ahorro. `scenarios[].truncated` cuenta los cortes de cada brazo, porque un corte en LOS DOS " +
        "no lo causó la capa — lo causó un contrato que no cabe.",
      "Each scenario maps to one ledger, so ledger deltas partition the total (reconciliation residual proves no double-counting).",
      "Adaptive sampling adds reps only where variance is high, up to a hard cap — and because the headline is stratified, those extra reps tighten a scenario's estimate without changing its weight.",
      "El modelo SERVIDO se compara entre los dos brazos; si difiere, la afirmación no vale. (system_fingerprint se registra pero no se usa como verja: a través de una pasarela es un id por petición.)",
      "Cache savings are shown as repeat-traffic amortization with a break-even K, not a single-call number.",
      "Missing provider usage is a hard error (requireUsage), never a silent 0 → 100% saving.",
      "Una palanca opt-in que no llegó a dispararse se DECLARA en `levers.notExercised`: su cero no es una medición.",
      "Un escenario que no aplica a este modelo se SALTA y se declara en `scenariosNotApplicable`, en vez de medirse mal.",
      "Una palanca que el TRANSPORTE configurado no puede ejercitar (cache_control por una pasarela OpenAI) se declara en `levers.notMeasurable` con lo que hay que configurar, y su escenario NO se ejecuta: publicar su cero sería publicar un fracaso que nadie ha medido.",
      ...(B1_ACTIVO
        ? [
            "Dos brazos de control, no uno: `aggregate` es el ahorro frente a B0 (la integración sin optimizar) y `aggregateB1` frente a B1 (la misma integración con la caché nativa configurada y las herramientas elegidas a mano). Solo la segunda cifra es mérito atribuible al SDK; la primera incluye lo que un cliente razonable ya tendría sin nosotros.",
          ]
        : []),
      ...(B2_ACTIVO
        ? [
            "A third control arm, B2 «natively well-configured»: B1 plus every setting the provider documents at no extra " +
              "charge that applies to the request shape (reasoning effort, explicit cache mode on GPT-5.6+, tool search " +
              "over its documented threshold). Each decision, applied or not, is published in `native.decisions` with the " +
              "official page it follows. `aggregateB2` is what is left after all of that; `aggregateNativeVsB0` is what " +
              "the provider alone saves and is not a BV-SALA figure. Any claim must fit under `floors.min`.",
            "B2 runs at a lower reasoning effort than the provider default (`config.b2Effort`), which is not free in " +
              "quality: `scenarios[].nativeContractValid`, `truncated.nativo` and `reasoningTokens.nativo` show what it " +
              "cost. If B2 is cheaper because it answers worse, that counts against BV-SALA's savings, never for them.",
          ]
        : []),
      "Cache writes are priced at the model's write premium in every arm (`pricing.cacheWrites`), read from the " +
        "provider's counter. Until 2026-09-27 the bench billed them at 1x, which hid what an explicit cache mode saves.",
    ],
  };

  return {
    modelo,
    etiqueta,
    results,
    noAplican,
    noMedibles,
    agg,
    aggPooled,
    ...(aggB1 ? { aggB1, provenB1 } : {}),
    ...(aggB2 ? { aggB2, provenB2 } : {}),
    ...(aggNativoVsB0 ? { aggNativoVsB0 } : {}),
    floors,
    ...(nativo ? { nativo } : {}),
    coste: costeDelModelo,
    wilcoxonP: wP,
    qualityPassRate,
    proven,
    modelStable: allFpStable,
    ledgerRollup,
    palancas,
    latencia,
    artefacto,
  };
}

/**
 * LAS COLUMNAS DEL CSV DE ENSAYOS: una fila por repetición pareada, con el
 * coste de cada brazo. Es lo que `apps/web/public/measure/reproduce.mjs` lee
 * para recalcular los agregados sin confiar en el JSON. Las columnas nuevas se
 * AÑADEN; los lectores del CSV buscan por nombre, no por posición.
 */
const COLUMNAS_DE_ENSAYOS = [
  "scenario",
  "kind",
  "rep",
  "costA",
  "costA1",
  "costA2",
  "costB",
  "savedFraction",
  "savedFractionB1",
  "savedFractionB2",
  "totalMsA",
  "providerMsA",
  "totalMsA1",
  "providerMsA1",
  "totalMsA2",
  "providerMsA2",
  "totalMsB",
  "providerMsB",
];

function filasDeEnsayos(t: Tirada): Record<string, unknown>[] {
  const fraccion = (control: number | undefined, b: number): number | "" =>
    control == null ? "" : control > 0 ? 1 - b / control : 0;
  return t.results.flatMap((r) =>
    r.paired.map((p, i) => ({
      scenario: r.name,
      kind: r.kind,
      rep: i,
      costA: p.costA,
      costA1: p.costA1 ?? "",
      costA2: p.costA2 ?? "",
      costB: p.costB,
      savedFraction: fraccion(p.costA, p.costB),
      savedFractionB1: fraccion(p.costA1, p.costB),
      savedFractionB2: fraccion(p.costA2, p.costB),
      totalMsA: p.latencies.A.totalMs,
      providerMsA: p.latencies.A.providerMs,
      totalMsA1: p.latencies.A1?.totalMs ?? "",
      providerMsA1: p.latencies.A1?.providerMs ?? "",
      totalMsA2: p.latencies.A2?.totalMs ?? "",
      providerMsA2: p.latencies.A2?.providerMs ?? "",
      totalMsB: p.latencies.B.totalMs,
      providerMsB: p.latencies.B.providerMs,
    })),
  );
}

/** Aborta la tirada ANTES de cualquier llamada, con el motivo. */
function abortarAntesDeGastar(motivos: string[]): void {
  console.error("\n✗ La tirada NO empieza (no se ha llamado a ningún proveedor):");
  for (const m of motivos) console.error(`  · ${m}`);
  console.error("");
  process.exitCode = 1;
}

async function main(): Promise<void> {
  console.log(`\nBV-SALA TRUE A/B live benchmark  [mode: ${mode}]`);

  // ── Lo que impide empezar, antes que nada ────────────────────────────────
  if (RESOLUCION.error) return abortarAntesDeGastar([RESOLUCION.error]);
  if (RESOLUCION.aviso) console.warn(`⚠ ${RESOLUCION.aviso}`);
  // La variable antigua. `1` pedía lo que ahora es el defecto; cualquier otro
  // valor es alguien que cree estar pidiendo otra cosa, y adivinar qué es peor
  // que parar.
  if (SIN_COMPRESOR_OBSOLETA !== undefined) {
    if (SIN_COMPRESOR_OBSOLETA === "1" && !CON_COMPRESOR) {
      console.warn(
        "⚠ BVSALA_AB_SIN_COMPRESOR=1 está obsoleta: medir el SDK tal como se instala ya es lo que hace `pnpm ab`. Quítala.",
      );
    } else {
      return abortarAntesDeGastar([
        `BVSALA_AB_SIN_COMPRESOR=${SIN_COMPRESOR_OBSOLETA} está obsoleta y no se interpreta. El SDK tal como se instala ` +
          "es el modo por defecto; el compresor del banco (investigación, nunca publicable) se pide con " +
          "BVSALA_AB_CON_COMPRESOR=1. Quita BVSALA_AB_SIN_COMPRESOR (mira también .env.bench).",
      ]);
    }
  }

  // ── El prevuelo: todo lo que haría inservible una tirada de pago ─────────
  const porEscenario = modelosAMedir.some((m) => m === null);
  const prevuelo = veredictoDePrevuelo({
    modelos: porEscenario
      ? [...new Set(scenarios.map((s) => s.request.model))].map((id) => ({ id, obligatorio: false }))
      : modelosAMedir.map((id) => ({
          id: id!,
          obligatorio: true,
          exigeNativo: RESOLUCION.exigenNativo.includes(id!),
        })),
    modo: mode,
    cfg: CONFIG_DE_TRANSPORTE,
    presupuesto: PRESUPUESTO,
    // El valor CRUDO: si no es un esfuerzo válido, el prevuelo lo dice y para.
    esfuerzo: ESFUERZO_B2_CRUDO as EsfuerzoB2,
    permitirIlustrativo: PERMITIR_ILUSTRATIVO,
    margen: MARGEN_RAZONAMIENTO,
    b2: B2_ACTIVO,
    escenariosSinTope: scenarios.filter((s) => s.request.response?.maxOutputTokens == null).map((s) => s.name),
    escenariosConHerramientas: scenarios.filter((s) => (s.request.tools?.length ?? 0) > 0).map((s) => s.name),
  });
  for (const a of prevuelo.avisos) console.warn(`⚠ ${a}`);
  if (prevuelo.aborta) return abortarAntesDeGastar(prevuelo.motivos);

  console.log(
    SDK_TAL_COMO_SE_INSTALA
      ? `sdk: ${BV_SALA_VERSION} tal como se instala desde npm (sin compresor: el paquete solo trae noopCompressor)`
      : `sdk: ${BV_SALA_VERSION} CON el compresor del banco, que npm NO trae — tirada de investigación, no publicable\n` +
          "     (quita BVSALA_AB_CON_COMPRESOR para medir lo que instala el cliente)",
  );
  console.log(
    mode === "LIVE"
      ? `provider: real endpoint   models: ${modelosAMedir.map((m) => m ?? "(per-request)").join(", ")}   reps: ${REPS}   (every arm metered by the provider)`
      : `provider: mock (no network)   models: ${modelosAMedir.map((m) => m ?? "(per-request)").join(", ")}   reps: ${REPS}   —  ESTIMATED plumbing run, NOT a savings claim`,
  );
  console.log(
    B2_ACTIVO
      ? `B2 (nativo bien configurado): encendido, esfuerzo ${ESFUERZO_B2}, margen de razonamiento ${MARGEN_RAZONAMIENTO} tokens`
      : "B2: APAGADO (BVSALA_AB_B2=0) — tirada de investigación: sin B2 no se puede publicar",
  );
  // POR EXISTENCIA, NUNCA POR VALOR: se dice QUÉ endpoints hay declarados,
  // jamás cuál ni con qué clave. Y se dice siempre, porque su ausencia es la que
  // decide que una familia o una palanca no se mida en esta tirada.
  if (mode === "LIVE") {
    const declarados = [
      CONFIG_DE_TRANSPORTE.baseUrl ? "pasarela (BVSALA_DEMO_BASE_URL)" : null,
      CONFIG_DE_TRANSPORTE.anthropicBaseUrl ? "anthropic nativo" : null,
      CONFIG_DE_TRANSPORTE.openaiBaseUrl ? "openai directo" : null,
      CONFIG_DE_TRANSPORTE.googleBaseUrl ? "google directo" : null,
    ].filter((x): x is string => !!x);
    console.log(`endpoints declarados: ${declarados.join(", ")}`);
    console.log(
      CONFIG_DE_TRANSPORTE.anthropicBaseUrl
        ? "anthropic: endpoint NATIVO declarado — los modelos de esa familia van por AnthropicProvider (cache_control viaja)"
        : "anthropic: sin endpoint nativo (BVSALA_DEMO_ANTHROPIC_BASE_URL) — `cache_control` no cabe en el protocolo de OpenAI,\n" +
          "           así que los escenarios que lo miden se declaran NO MEDIBLES y no se ejecutan",
    );
  }

  // ── El precio ANTES de gastarlo ──────────────────────────────────────────
  const estimacion = estimarTirada();
  const techo = imprimirEstimacion(estimacion);
  if (mode === "LIVE" && techo > PRESUPUESTO) {
    console.error(
      `\n✗ La tirada puede costar hasta ${dinero4(techo)} y BVSALA_AB_BUDGET_USD son ${dinero4(PRESUPUESTO)}.\n` +
        `  No se ha llamado a ningún proveedor. Sube el presupuesto o recorta BVSALA_AB_REPS / los modelos.\n`,
    );
    process.exitCode = 1;
    return;
  }

  // Un modelo que revienta se DESCARTA ÉL, no la tirada: los artefactos se
  // escriben al final, así que dejar subir la excepción convertía el fallo del
  // cuarto modelo en la pérdida de los tres anteriores — llamadas pagadas
  // incluidas (2026-08-24). El fallo queda en el artefacto y en el exit code.
  //
  // DOS EXCEPCIONES que sí paran la tirada entera: el presupuesto agotado (el
  // gasto real pasó `BVSALA_AB_BUDGET_USD`; seguir sería gastar lo que no se
  // autorizó) y una compactación que ningún brazo pidió (el uso de arriba deja
  // de ser el total facturado, y eso vale para todos los modelos que siguen).
  const tiradas: Tirada[] = [];
  const modelosFallidos: { modelo: string; error: string; detail?: string }[] = [];
  for (const [i, modelo] of modelosAMedir.entries()) {
    try {
      tiradas.push(await medirModelo(modelo));
    } catch (err) {
      const etiqueta = modelo ?? "(el de cada escenario)";
      const agotado = err instanceof PresupuestoAgotado;
      const compactacion = GASTO.compactacion || (err instanceof Error && err.message === MENSAJE_DE_COMPACTACION);
      // El texto de error del proveedor puede traer una clave ENMASCARADA
      // (`Incorrect API key provided: sk-…abcd`): va al artefacto y a la consola
      // sin nada que se parezca a una clave.
      const texto = sinSecretos(String(err));
      modelosFallidos.push({
        modelo: etiqueta,
        error: agotado ? "budget" : compactacion ? "compaction" : texto,
        ...(agotado || compactacion ? { detail: sinSecretos((err as Error).message) } : {}),
      });
      console.error(`\n✗ la medición de ${etiqueta} FALLÓ y se descarta este modelo: ${texto}\n`);
      if (agotado || compactacion) {
        for (const resto of modelosAMedir.slice(i + 1)) {
          modelosFallidos.push({
            modelo: resto ?? "(el de cada escenario)",
            error: agotado ? "budget" : "compaction",
            detail: "not started: the run stopped at an earlier model",
          });
        }
        console.error(
          agotado
            ? "✗ presupuesto agotado: los modelos que faltaban NO se miden y este no se publica.\n"
            : "✗ el proveedor devolvió una compactación que nadie pidió: la tirada para aquí.\n",
        );
        break;
      }
    }
  }
  if (modelosFallidos.length > 0) process.exitCode = 1;
  if (tiradas.length === 0) {
    console.error("✗ ningún modelo completó la medición; no hay nada que escribir.");
    process.exitCode = 1;
    return;
  }

  // ── La tabla comparable entre modelos ────────────────────────────────────
  if (tiradas.length > 1) {
    const nombres = [...new Set(scenarios.map((s) => s.name))];
    console.log("\n\nAhorro por escenario y modelo  (punto, con la cota inferior al 95% entre paréntesis)");
    console.log("n/a = el escenario no aplica a ese modelo y NO se midió; ver el motivo en el artefacto.\n");
    const anchoNombre = 34;
    const anchoModelo = 26;
    // Se recorta a `anchoModelo - 2` para que SIEMPRE queden dos espacios entre
    // columnas: un id de modelo que ocupe la celda entera se pega al siguiente y
    // la tabla deja de poder leerse.
    const celda = (s: string): string => padL(s.slice(0, anchoModelo - 2), anchoModelo);
    const raya = "─".repeat(anchoNombre + anchoModelo * tiradas.length);
    console.log(pad("scenario", anchoNombre) + tiradas.map((t) => celda(t.etiqueta)).join(""));
    console.log(raya);
    for (const nombre of nombres) {
      const celdas = tiradas.map((t) => {
        const r = t.results.find((x) => x.name === nombre);
        if (!r) return celda("n/a");
        return celda(`${pct(r.measured.savings.point)} (${pct(r.measured.savings.lower)})`);
      });
      console.log(pad(nombre, anchoNombre) + celdas.join(""));
    }
    console.log(raya);
    console.log(
      pad("AGREGADO vs B0", anchoNombre) +
        tiradas.map((t) => celda(`${pct(t.agg.point)} (${pct(t.agg.lower)})`)).join(""),
    );
    if (tiradas.some((t) => t.aggB1)) {
      console.log(
        pad("AGREGADO vs B1", anchoNombre) +
          tiradas.map((t) => celda(t.aggB1 ? `${pct(t.aggB1.point)} (${pct(t.aggB1.lower)})` : "n/a")).join(""),
      );
    }
    if (tiradas.some((t) => t.aggB2)) {
      console.log(
        pad("AGREGADO vs B2", anchoNombre) +
          tiradas.map((t) => celda(t.aggB2 ? `${pct(t.aggB2.point)} (${pct(t.aggB2.lower)})` : "n/a")).join(""),
      );
      // Lo que ahorra el proveedor solo: NO es una cifra de BV-SALA.
      console.log(
        pad("B2 vs B0 (native)", anchoNombre) +
          tiradas.map((t) => celda(t.aggNativoVsB0 ? `${pct(t.aggNativoVsB0.point)} (${pct(t.aggNativoVsB0.lower)})` : "n/a")).join(""),
      );
    }
    console.log(
      pad("suelo mínimo (contra)", anchoNombre) +
        tiradas.map((t) => celda(`${pct(t.floors.min)} (${t.floors.minAgainst})`)).join(""),
    );
    console.log(
      pad("proven", anchoNombre) +
        tiradas.map((t) => celda(mode === "LIVE" ? String(t.proven) : "est")).join(""),
    );
    console.log(
      pad("calidad", anchoNombre) + tiradas.map((t) => celda(pct(t.qualityPassRate))).join(""),
    );
  }
  console.log("");

  // ── Artefactos ───────────────────────────────────────────────────────────
  const rutas: string[] = [];
  // La ruta mono-modelo exige que se PIDIERA un solo modelo: una tirada de
  // cuatro con tres caídos no puede disfrazarse del titular que publica la web.
  if (modelosAMedir.length === 1 && tiradas.length === 1) {
    // UN solo modelo: el artefacto de siempre, en su ruta de siempre. Es la que
    // lee `pnpm ab:publish`, y cambiarla rompería la publicación.
    const t = tiradas[0]!;
    rutas.push(writeReport("ab-live", t.artefacto));
    rutas.push(writeCsv("ab-live-trials", COLUMNAS_DE_ENSAYOS, filasDeEnsayos(t)));
  } else {
    // VARIOS modelos: un artefacto por modelo y una comparación. `ab-live.json`
    // NO se escribe, y es deliberado: publicar una tirada multi-modelo bajo un
    // solo titular es exactamente la confusión que este cambio viene a quitar.
    // Para publicar UNO sin pagar otra tirada: `pnpm ab:publish --model <id>`,
    // que lee `ab-live--<babosa>.json` y su CSV (la babosa es la misma función,
    // `babosaDeModelo`, en los dos lados).
    for (const t of tiradas) {
      const slug = babosaDeModelo(t.etiqueta);
      rutas.push(writeReport(`ab-live--${slug}`, t.artefacto));
      rutas.push(writeCsv(`ab-live-trials--${slug}`, COLUMNAS_DE_ENSAYOS, filasDeEnsayos(t)));
    }
    rutas.push(
      writeReport("ab-live-por-modelo", {
        mode,
        sdk: selloDelSdk(),
        generatedNote:
          mode === "LIVE"
            ? "real provider tokens & cost, quality-gated, one run per model"
            : "ESTIMATED — mock provider, not a savings claim",
        models: tiradas.map((t) => t.etiqueta),
        // Un modelo caído se DECLARA: su ausencia de la tabla no es un cero ni
        // un olvido, y quien lea el artefacto tiene que poder distinguirlo.
        ...(modelosFallidos.length > 0 ? { modelsFailed: modelosFallidos } : {}),
        costEstimate: estimacion,
        comparison: tiradas.map((t) => ({
          model: t.etiqueta,
          aggregate: { savings: t.agg, estimator: "stratified-by-scenario", proven: t.proven, qualityPassRate: t.qualityPassRate },
          aggregatePooled: { savings: t.aggPooled, estimator: "pooled-all-trials" },
          ...(t.aggB1 ? { aggregateB1: { savings: t.aggB1, estimator: "stratified-by-scenario", proven: t.provenB1 } } : {}),
          ...(t.aggB2 ? { aggregateB2: { savings: t.aggB2, estimator: "stratified-by-scenario", proven: t.provenB2 } } : {}),
          ...(t.aggNativoVsB0
            ? {
                aggregateNativeVsB0: {
                  savings: t.aggNativoVsB0,
                  estimator: "stratified-by-scenario",
                  note: "What the provider's own settings (arm B2) save against B0. Not a BV-SALA figure.",
                },
              }
            : {}),
          floors: t.floors,
          cost: t.coste,
          latency: t.latencia,
          ...(t.nativo ? { native: t.nativo } : {}),
          ledgers: t.ledgerRollup.map((l) => ({ ledger: l.ledger, savings: l.savings, scenarios: l.scenarios.length })),
          levers: t.palancas,
          leversNotMeasurable: t.noMedibles,
          scenariosNotApplicable: t.noAplican,
          scenarios: t.results.map((r) => ({
            name: r.name,
            ledger: r.ledger,
            kind: r.kind,
            savings: r.measured.savings,
            ...(r.measuredB2 ? { savingsB2: r.measuredB2.savings } : {}),
            quality: r.quality,
            truncated: r.truncated,
            latency: r.latency,
            palanca: r.palanca,
          })),
        })),
        leversWithoutScenario: PALANCAS_SIN_ESCENARIO,
        honesty: [
          "Cada modelo se mide por separado, con sus propios escenarios aplicables.",
          "n/a en la tabla = el escenario NO se midió contra ese modelo; nunca es un cero.",
          "Una palanca opt-in que no llegó a dispararse se declara; su cero no es una medición.",
          "Una palanca que el transporte configurado no puede ejercitar va en `leversNotMeasurable`, con qué configurar para medirla; su escenario no se ejecuta.",
          "No se escribe `ab-live.json` en una tirada multi-modelo: un titular necesita un modelo. Para publicar uno sin volver a pagar: `pnpm ab:publish --model <id>`.",
          "`floors.min` de cada modelo es el menor de los suelos frente a B0, B1 y B2: cualquier cifra de ese modelo tiene que caber debajo. `aggregateNativeVsB0` es lo que ahorra el proveedor solo y no es una cifra de BV-SALA.",
        ],
      }),
    );
    rutas.push(
      writeCsv(
        "ab-live-por-modelo",
        // `truncadasA`/`truncadasB` van en el CSV porque es donde se leyó a mano la
        // tirada del 2026-08-16: entonces había que deducir el truncado comparando
        // los tokens de salida con el tope, columna a columna.
        ["model", "scenario", "ledger", "kind", "palanca", "palancaEjercitada", "savingsPoint", "savingsLower", "savingsB2Point", "savingsB2Lower", "reps", "qualityPassed", "qualityTotal", "truncadasA", "truncadasA2", "truncadasB"],
        tiradas.flatMap((t) =>
          t.results.map((r) => ({
            model: t.etiqueta,
            scenario: r.name,
            ledger: r.ledger,
            kind: r.kind,
            palanca: r.palanca?.palanca ?? "",
            palancaEjercitada: r.palanca ? String(r.palanca.ejercitada) : "",
            savingsPoint: r.measured.savings.point,
            savingsLower: r.measured.savings.lower,
            savingsB2Point: r.measuredB2?.savings.point ?? "",
            savingsB2Lower: r.measuredB2?.savings.lower ?? "",
            reps: r.reps,
            qualityPassed: r.quality.passed,
            qualityTotal: r.quality.total,
            truncadasA: r.truncated.naive,
            truncadasA2: r.truncated.nativo ?? "",
            truncadasB: r.truncated.optimizado,
          })),
        ),
      ),
    );
  }
  for (const ruta of rutas) console.log(`Wrote ${ruta}`);
  console.log("");

  if (mode === "LIVE" && tiradas.some((t) => !t.proven)) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
