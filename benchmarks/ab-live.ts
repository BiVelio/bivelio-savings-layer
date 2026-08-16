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
 *           savings claim" because the mock is not a real model.
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
 * ENV: BVSALA_AB_REPS (paired reps for generative scenarios), BVSALA_AB_SEED,
 *      BVSALA_DEMO_KEEP_PREFIX, BVSALA_AB_BUDGET_USD (aborta si la estimación de
 *      coste de la tirada lo supera), and optionally a judge endpoint
 *      BVSALA_JUDGE_BASE_URL / _API_KEY / _MODEL for LIVE answer-vs-answer QA.
 */
import {
  createSavingsLayer,
  OpenAICompatibleProvider,
  precioDeLista,
  PRECIOS_AL_DIA,
  type CostModel,
  type Provider,
  type SavingsRequest,
  type SavingsResult,
  TokenizerRegistry,
  registrarTokenizadorExacto,
} from "../src/index.js";
import type { ProviderRequest } from "../src/providers/types.js";
import {
  scenarios,
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
  proveedorDelBanco,
  transporteDeModelo,
  type ConfigDeTransporte,
} from "./transporte.js";
import { compresorDeRepeticionesLiterales } from "./compresor.js";
import { bootstrapRatioCI, wilcoxonSignedRankP, mean, type CI } from "./stats.js";
import { writeReport, writeCsv } from "./report.js";
import { validateAgainstSchema } from "../src/constraints/validate.js";

function tryParseJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return undefined; }
}

// ── Real per-model price table (USD per 1K tokens). Public list pricing; the
// EXACT figures are dated in the report and overridable. Because both arms are
// priced with the SAME model, any price error cancels in the savings RATIO —
// only cross-model and cached-rate differences move the percentage.
const PRICES: Record<string, CostModel> = {
  "gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006, cachedInputPer1k: 0.000075 },
  "gpt-4o": { inputPer1k: 0.0025, outputPer1k: 0.01, cachedInputPer1k: 0.00125 },
  "gpt-4.1-mini": { inputPer1k: 0.0004, outputPer1k: 0.0016, cachedInputPer1k: 0.0001 },
  "gpt-4.1": { inputPer1k: 0.002, outputPer1k: 0.008, cachedInputPer1k: 0.0005 },
  // Anthropic. La lectura cacheada cuesta el 10% de la entrada —contra el 50%
  // de la familia 4o/4.1— y por eso es donde más vale la palanca de la caché de
  // prefijo. Lo que esta tabla NO puede expresar es la otra mitad del trato: la
  // ESCRITURA se cobra a 1,25x, así que un escenario con pocos aciertos sale más
  // caro de lo que este precio sugiere. La verja económica del layer es quien
  // vigila eso; aquí sólo se tarifa lo que el proveedor reporte.
  "claude-sonnet-4-5": { inputPer1k: 0.003, outputPer1k: 0.015, cachedInputPer1k: 0.0003 },
};
const PRICING_NOTE =
  "USD/1K tokens, illustrative public list pricing; verify against your provider's current rates. " +
  "Both arms share one price, so the savings % is insensitive to price level.";
const FALLBACK_PRICE: CostModel = { inputPer1k: 0.00015, outputPer1k: 0.0006, cachedInputPer1k: 0.000075 };

const baseUrl = process.env.BVSALA_DEMO_BASE_URL;
const apiKey = process.env.BVSALA_DEMO_API_KEY;
const keepPrefix = !!process.env.BVSALA_DEMO_KEEP_PREFIX;
const mode: "LIVE" | "MOCK" = baseUrl ? "LIVE" : "MOCK";

/**
 * EL ENDPOINT NATIVO DE ANTHROPIC, OPCIONAL Y APARTE DEL PRINCIPAL.
 *
 * Es aparte porque no es intercambiable: `BVSALA_DEMO_BASE_URL` habla el
 * protocolo de OpenAI (una pasarela, OpenAI, vLLM…) y `AnthropicProvider` habla
 * el de Mensajes. No es «otra URL para lo mismo»: son dos dialectos, y el único
 * de los dos que tiene `cache_control` es el segundo.
 *
 * Quien apunte su endpoint principal directamente a Anthropic pone aquí la MISMA
 * url: el banco elegirá adaptador por familia de modelo y cada escenario irá por
 * donde le corresponde.
 */
const anthropicBaseUrl = process.env.BVSALA_DEMO_ANTHROPIC_BASE_URL;

/**
 * LOS ENDPOINTS, LEÍDOS DEL ENTORNO UNA SOLA VEZ Y AQUÍ.
 *
 * La decisión que sale de ellos vive en `benchmarks/transporte.ts`, sin entorno
 * y sin red, para que una verja pueda comprobarla sin pagar una tirada. Este
 * objeto es la única frontera con `process.env`.
 */
const CONFIG_DE_TRANSPORTE: ConfigDeTransporte = {
  baseUrl,
  apiKey,
  keepPrefix,
  anthropicBaseUrl,
  anthropicApiKey: process.env.BVSALA_DEMO_ANTHROPIC_API_KEY,
};

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
 * Vacío = comportamiento de siempre: cada escenario con el modelo que declara.
 */
const modelosPedidos = (process.env.BVSALA_DEMO_MODELS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const modeloUnico = process.env.BVSALA_DEMO_MODEL;
/** `null` = no se fuerza ningún modelo; manda el de cada escenario. */
const modelosAMedir: (string | null)[] = modelosPedidos.length
  ? modelosPedidos
  : modeloUnico
    ? [modeloUnico]
    : [null];
const SEED = intEnv("BVSALA_AB_SEED", 1234567);
const REPS = intEnv("BVSALA_AB_REPS", mode === "LIVE" ? 8 : 4);
// Adaptive sampling (LIVE only): keep drawing paired reps for a noisy scenario
// until its savings CI is tight enough, or a hard cap is reached. Deterministic
// MOCK converges immediately (CI half-width 0).
const MAX_REPS = intEnv("BVSALA_AB_MAX_REPS", REPS * 3);
const CI_TARGET = Number(process.env.BVSALA_AB_CI_TARGET ?? 0.03); // desired ± half-width on the savings fraction
const QUALITY_FLOOR = Number(process.env.BVSALA_AB_QUALITY_FLOOR ?? 0.999);

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
const makeProvider = (model: string | null): Provider =>
  proveedorDelBanco(model, CONFIG_DE_TRANSPORTE);

const modelId = (r: SavingsRequest, forzado: string | null): string => forzado ?? r.model;

// ── Tokenizador EXACTO. Una tirada que hace afirmaciones en dólares no puede
// contar con el estimador heurístico: mide 2171 tokens donde o200k_base mide
// 1155 en el mismo JSON (1,88x), y ese sesgo NO se cancela al restar contra un
// formato distinto. Con él registrado, `basis` puede ser "measured"; sin él, el
// propio layer degrada a "estimated" y la tirada lo dirá.
const registroTokens = new TokenizerRegistry();
const tokenizadorExacto = await registrarTokenizadorExacto(registroTokens);
if (!tokenizadorExacto) {
  console.warn(
    "[ab] gpt-tokenizer no está instalado: se usará el estimador heurístico y la " +
      "contabilidad se publicará como ESTIMADA. Instálalo con `pnpm add -D gpt-tokenizer`.",
  );
}

/** Todas las capas de la tirada comparten el mismo registro y el mismo proveedor. */
// Lo aprendido sobre los contratos SÍ persiste entre repeticiones; las cachés
// no. Es el modelo honesto de una capa desplegada: los aciertos de caché no se
// precalientan para el titular, pero tampoco se finge que cada petición sea la
// primera que ve ese contrato — en producción no lo es.
const memoriaContratos = new Set<string>();

const nuevaCapa = (provider: Provider, model: string) =>
  createSavingsLayer({
    provider,
    defaultCostModel: priceFor(model),
    tokenizer: registroTokens,
    constraintMemory: memoriaContratos,
    // EL COMPRESOR VA EN TODAS LAS CAPAS, no solo en la del escenario que lo
    // usa: la palanca `compression` es opt-in POR PETICIÓN, así que quien decide
    // si corre es el escenario, y quien decide si vale la pena son las tres
    // verjas económicas del pipeline. Un contexto corto no lo activa por mucho
    // que el compresor esté ahí (mínimo de 2000 tokens comprimibles), y eso es
    // comprobable: los demás escenarios siguen midiendo lo mismo con y sin él.
    //
    // Sin esto, el escenario de compresión no comprime NADA y el informe
    // publicaría un 0% que se lee como "la compresión no ahorra".
    compressor: compresorDeRepeticionesLiterales,
    // `compressionEconomics.prefix` NO se declara a propósito. Es la tasa de
    // aciertos de prefijo del tráfico, y nadie la ha medido para este banco;
    // inventarla desbloquea la decisión completa a cambio de un número falso. Sin
    // ella la capa se niega a comprimir un prompt fuera del tramo cacheable, que
    // es la abstención honesta.
  });

/**
 * El precio del modelo, en este orden: la tabla local del banco, el CATÁLOGO DE
 * PRECIOS DE LISTA del SDK y, si tampoco está, el precio ilustrativo.
 *
 * El catálogo en medio es lo que permite medir un modelo que esta tabla no
 * enumera sin que la cifra en dólares se convierta en ficción silenciosa:
 * `precioDeLista` conoce las familias 4o/4.1 y Claude con sus tarifas cacheadas.
 * Cuando ninguno de los dos lo conoce se cae en el precio ilustrativo, y eso el
 * informe lo AVISA — un modelo ausente que se tarifa como si estuviera es
 * exactamente el fallo que documenta `pricing/catalogo.ts`.
 */
function priceFor(model: string): CostModel {
  const key = model.replace(/^[^/]+\//, "");
  return PRICES[key] ?? PRICES[model] ?? precioDeLista(model) ?? FALLBACK_PRICE;
}

/** ¿El precio de este modelo sale de una tarifa publicada, o del ilustrativo? */
function precioConocido(model: string): boolean {
  const key = model.replace(/^[^/]+\//, "");
  return !!(PRICES[key] ?? PRICES[model] ?? precioDeLista(model));
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
function cost(model: string, u: Usage): number {
  const p = priceFor(model);
  const cached = u.cachedInputTokens ?? 0;
  const billedInput = Math.max(0, u.inputTokens - cached);
  return (
    (billedInput / 1000) * p.inputPer1k +
    (cached / 1000) * (p.cachedInputPer1k ?? p.inputPer1k) +
    (u.outputTokens / 1000) * p.outputPer1k
  );
}

/**
 * Arm A — the naive request an un-optimized team would send: full JSON payload
 * inline, all tools transmitted natively, NO schema, NO output cap.
 */
function buildNaive(req: SavingsRequest, forzado: string | null): ProviderRequest {
  const messages = req.messages.map((m) => ({ role: m.role, content: m.content }));
  if (req.structuredData !== undefined) {
    messages.push({ role: "user", content: JSON.stringify(req.structuredData) });
  }
  return {
    model: modelId(req, forzado),
    messages,
    ...(req.tools && req.tools.length ? { tools: req.tools } : {}),
    // EL CONTRATO VA EN LOS DOS BRAZOS. Antes `buildNaive` descartaba
    // `req.response` entero, así que el brazo A resolvía una tarea MÁS FÁCIL:
    // respondía en texto libre mientras el B tenía que devolver JSON válido
    // contra el contrato. El B pagaba el bloque `response_format` (+38 tokens de
    // entrada, medidos) y la estructura JSON en la salida — que cuesta 4x por
    // token — sin que el A pagara ninguno de los dos. Eso no mide la capa: mide
    // la diferencia entre dos tareas distintas.
    //
    // El contrato lo pide QUIEN LLAMA (está en el request del escenario), no lo
    // añade la capa. Un equipo sin BV-SALA que necesite JSON estructurado manda
    // el mismo esquema. Así que el brazo A honesto lo manda también.
    //
    // Y el TOPE de salida también. Lo dejé fuera en su momento porque era el
    // lever bajo medición (`output_restriction`), pero 210 ensayos después ese
    // libro mide -2,8%: el tope NO ahorra. Así que la asimetría no estaba
    // midiendo nada, solo distorsionando en las dos direcciones — nos penalizaba
    // en calidad (nuestro brazo truncaba, el suyo no: 5 fallos de 210) y nos
    // favorecía en coste (pagábamos menos salida por estar capados).
    //
    // El tope está en el contrato de QUIEN LLAMA, exactamente igual que el
    // esquema. Un equipo sin BV-SALA que declare `maxOutputTokens` lo manda. Así
    // que va en los dos brazos y la comparación queda simétrica.
    ...(req.response?.schema ? { schema: req.response.schema } : {}),
    ...(req.response?.maxOutputTokens != null
      ? { maxOutputTokens: req.response.maxOutputTokens }
      : {}),
    temperature: 0,
    seed: 7,
  };
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

function safeExpect(s: Scenario, res: SavingsResult): boolean {
  try {
    return s.expect ? s.expect(res) : true;
  } catch {
    return false;
  }
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
  armB: { meanInputTokens: number; meanOutputTokens: number; meanCost: number };
  measured: {
    inputTokenDeltaMean: number;
    outputTokenDeltaMean: number;
    savings: CI;
    wilcoxonP: number;
  };
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
  cacheDePrefijo: { naive: number; optimizado: number };
  quality: { gate: string; passed: number; total: number };
  /** Cuántas respuestas del brazo NAIVE cumplían el contrato que se le pidió. */
  naiveContractValid: { valid: number; total: number };
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
  paired: { costA: number; costB: number }[];
}

async function runScenario(s: Scenario, forzado: string | null): Promise<ScenarioResult> {
  // El adaptador se elige por el modelo QUE SE VA A PEDIR, así que se instancia
  // después de resolverlo — y el de este escenario puede no ser el forzado.
  const transporte = transporteDe(forzado ?? s.request.model);
  const provider = makeProvider(forzado ?? s.request.model);
  // Los dos brazos tienen que muestrear de la MISMA distribución. El brazo A
  // fijaba temperature:0 y seed:7 (buildNaive) y el B no mandaba ninguno de los
  // dos, porque el pipeline solo los propaga si vienen en el request. Comparar
  // así mezcla el efecto de la capa con el del muestreo.
  const req: SavingsRequest = {
    ...s.request,
    ...(forzado ? { model: forzado } : {}),
    temperature: s.request.temperature ?? 0,
    seed: s.request.seed ?? 7,
  };
  const model = modelId(req, forzado);

  // Probe the optimized arm once (fresh layer) to classify the scenario.
  // `warm` scenarios demonstrate caching (their value is repeat-traffic, shown
  // in the amortization pass); the COLD headline treats their first call like
  // any ran call so caches honestly read ~0% per single call.
  const probe = await nuevaCapa(provider, model).generate(req);
  const kind: Kind = s.warm
    ? "cache"
    : probe.report.calls.actualLlm === 0
      ? "resolver"
      : "ran";

  const minReps = kind === "ran" ? REPS : Math.max(2, Math.ceil(REPS / 2));

  const paired: { costA: number; costB: number }[] = [];
  const aIn: number[] = [], aOut: number[] = [], bIn: number[] = [], bOut: number[] = [];
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
  /** Envuelve el proveedor para poder ver qué modelo sirvió al brazo B. */
  const espia: Provider = {
    id: provider.id,
    generate: async (r) => {
      const resp = await provider.generate(r);
      const m = modeloDe(resp.raw);
      if (m) modelosServidos.add(m);
      return resp;
    },
  };
  let qPass = 0;
  let gate = "structural";
  // Acumuladores de caché de prefijo, uno por brazo.
  let cacheNaive = 0;
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
  let palanca = estadoDePalanca(s, probe, probe.report.tokens.providerCachedInput ?? 0, transporte);

  async function sampleOnce(t: number): Promise<void> {
    // Arm A: naive baseline — a real call, measured.
    const respA = await provider.generate(buildNaive(req, forzado));
    const fp = (respA.raw as { system_fingerprint?: string } | undefined)?.system_fingerprint;
    if (fp) fingerprints.add(fp);
    modelosServidos.add(modeloDe(respA.raw) ?? "(sin declarar)");
    const uA: Usage = {
      inputTokens: respA.usage.inputTokens,
      outputTokens: respA.usage.outputTokens,
      ...(respA.usage.cachedInputTokens != null ? { cachedInputTokens: respA.usage.cachedInputTokens } : {}),
    };
    const costA = cost(model, uA);
    cacheNaive += uA.cachedInputTokens ?? 0;

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

    // Arm B: BV-SALA optimized — a COLD run (fresh layer) so caching is never
    // secretly pre-warmed for the headline. Avoided calls cost $0 (real).
    const resB = await nuevaCapa(espia, model).generate(req);
    const uB = usageOf(resB);
    cacheOptimizado += uB.cachedInputTokens ?? 0;
    const ran = resB.report.calls.actualLlm > 0;
    const costB = ran ? cost(model, uB) : 0;

    paired.push({ costA, costB });
    aIn.push(uA.inputTokens); aOut.push(uA.outputTokens);
    bIn.push(uB.inputTokens); bOut.push(uB.outputTokens);

    // Quality gate: ground-truth when available, else structural / judge. Cache
    // scenarios' own expect() asserts a HIT, impossible on this cold call — gate
    // them structurally here; hit correctness is asserted in the amortization pass.
    const q = await qualityGate(s, resB, respA.text, model, kind === "cache");
    if (q.passed) qPass++;
    gate = q.gate;
    if (t === 0) {
      attribution = {
        avoidedCall: resB.report.calls.avoidedLlm > 0,
        eliminatedInputTokens: resB.report.tokens.eliminatedInput,
        compressedInputTokens: resB.report.tokens.compressedInput,
        providerCachedInputTokens: resB.report.tokens.providerCachedInput ?? 0,
      };
      palanca = estadoDePalanca(s, resB, uB.cachedInputTokens ?? 0, transporte);
    }
  }

  // Draw the minimum, then (LIVE only) keep drawing until the savings CI is tight
  // enough or the cap is hit — spend more reps only where variance demands it.
  let t = 0;
  for (; t < minReps; t++) await sampleOnce(t);
  const ciHalf = (): number => {
    const ci = bootstrapRatioCI(paired.map((p) => p.costA), paired.map((p) => p.costB), { seed: SEED });
    return (ci.upper - ci.lower) / 2;
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
    armB: { meanInputTokens: mean(bIn), meanOutputTokens: mean(bOut), meanCost: mean(paired.map((p) => p.costB)) },
    formaFactura: repartoDeLaFactura(model, mean(aIn), mean(aOut)),
    cacheDePrefijo: { naive: cacheNaive, optimizado: cacheOptimizado },
    measured: {
      inputTokenDeltaMean: mean(aIn) - mean(bIn),
      outputTokenDeltaMean: mean(aOut) - mean(bOut),
      savings,
      wilcoxonP: wilcoxonSignedRankP(paired.map((p) => p.costA - p.costB)),
    },
    quality: { gate, passed: qPass, total: reps },
    naiveContractValid: { valid: naiveValid, total: naiveTotal },
    proven: mode === "LIVE" && savings.lower > 0 && qualityOk && modelStable,
    modelStable,
    servedModels: [...modelosServidos],
    fingerprints: [...fingerprints],
    attribution,
    paired,
  };

  // Cache amortization: repeat traffic pays the miss ONCE, then hits are $0.
  if (kind === "cache") {
    const layer = nuevaCapa(provider, model);
    const miss = await layer.generate(req); // cold miss (real optimized cost)
    const coldMissCost = miss.report.calls.actualLlm > 0 ? cost(model, usageOf(miss)) : 0;
    const hit = await layer.generate(req); // warmed → hit
    const hitCost = hit.report.calls.actualLlm > 0 ? cost(model, usageOf(hit)) : 0;
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

  return result;
}

// ── Quality gate ────────────────────────────────────────────────────────────
const judgeBase = process.env.BVSALA_JUDGE_BASE_URL;
const judgeProvider: Provider | null = judgeBase
  ? new OpenAICompatibleProvider({
      baseUrl: judgeBase,
      ...(process.env.BVSALA_JUDGE_API_KEY ? { apiKey: process.env.BVSALA_JUDGE_API_KEY } : {}),
      stripProviderPrefix: !keepPrefix,
      requireUsage: false,
    })
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
  const res = await judgeProvider.generate({
    model: process.env.BVSALA_JUDGE_MODEL ?? model,
    messages: [
      { role: "system", content: "You are a strict evaluator. Reply ONLY with compact JSON {\"equivalent\":bool}." },
      { role: "user", content:
        `Task: ${s.request.messages.map((m) => m.content).join(" ")}\n\n` +
        `Response 1:\n${one}\n\nResponse 2:\n${two}\n\n` +
        `Is Response ${flip ? "1" : "2"} at least as correct and complete as the other, with no factual regression? JSON only.` },
    ],
    maxOutputTokens: 20,
    temperature: 0,
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
    // 2. ¿Puede el transporte configurado ejercitar su palanca? El modelo que
    //    manda es el de la tirada si lo hay, y si no el que declara el escenario.
    const noMedible = noMedibleEnTransporte(s, transporteDe(modelo ?? s.request.model));
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
  const p = priceFor(model);
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

  const salida = s.request.response?.maxOutputTokens ?? 256;

  // Llamadas: 1 sondeo de clasificación (brazo B) + por repetición un brazo A y
  // un brazo B; `toolDiscovery` puede partir el brazo B en dos; los escenarios de
  // caché añaden el par fallo-frío/acierto de la amortización.
  const porRepeticion = 2 + (s.request.savings?.toolDiscovery === true ? 1 : 0);
  const extraCache = s.warm ? 2 : 0;
  // Los escenarios de caché tiran la mitad de repeticiones; los resolvers
  // también, pero eso no se sabe hasta ejecutarlos, así que se les cuenta la
  // tanda entera. Un techo que se pasa por arriba en el caso barato no engaña a
  // nadie; uno que se quede corto, sí.
  const minimo = s.warm ? Math.max(2, Math.ceil(REPS / 2)) : REPS;
  const llamadasMinimo = 1 + extraCache + minimo * porRepeticion;
  const llamadasTecho = 1 + extraCache + MAX_REPS * porRepeticion;

  const porLlamada = (entrada / 1000) * p.inputPer1k + (salida / 1000) * p.outputPer1k;
  return {
    escenario: s.name,
    entradaTokens: entrada,
    salidaTokens: salida,
    llamadasMinimo,
    llamadasTecho,
    costeMinimo: llamadasMinimo * porLlamada,
    costeTecho: llamadasTecho * porLlamada,
  };
}

function estimarTirada(): EstimacionDeModelo[] {
  const out: EstimacionDeModelo[] = [];
  for (const modelo of modelosAMedir) {
    const { aplican } = repartirEscenarios(modelo);
    // Sin modelo forzado cada escenario lleva el suyo, así que la estimación se
    // hace escenario a escenario con su propio precio.
    const filas = aplican.map((s) => estimarEscenario(s, modelo ?? s.request.model));
    out.push({
      modelo: modelo ?? "(el de cada escenario)",
      precioConocido: modelo
        ? precioConocido(modelo)
        : aplican.every((s) => precioConocido(s.request.model)),
      escenarios: filas,
      costeMinimo: filas.reduce((n, f) => n + f.costeMinimo, 0),
      costeTecho: filas.reduce((n, f) => n + f.costeTecho, 0),
    });
  }
  return out;
}

function imprimirEstimacion(est: EstimacionDeModelo[]): number {
  const totalMin = est.reduce((n, e) => n + e.costeMinimo, 0);
  const totalMax = est.reduce((n, e) => n + e.costeTecho, 0);
  console.log("\nCoste estimado de la tirada (techo: salida al tope, brazo B como el A, reps a la cota dura)");
  for (const e of est) {
    const aviso = e.precioConocido ? "" : "   ⚠ precio ILUSTRATIVO: este modelo no está en el catálogo";
    console.log(
      `  ${pad(e.modelo, 34)} ${padL(dinero4(e.costeMinimo), 10)} – ${padL(dinero4(e.costeTecho), 10)}` +
        `   ${e.escenarios.length} escenarios${aviso}`,
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
  agg: CI;
  wilcoxonP: number;
  qualityPassRate: number;
  proven: boolean;
  modelStable: boolean;
  ledgerRollup: FilaDeLibro[];
  palancas: EstadoDePalancaEnLaTirada[];
  artefacto: Record<string, unknown>;
}

const sumArr = (xs: number[]): number => xs.reduce((n, x) => n + x, 0);

async function medirModelo(modelo: string | null): Promise<Tirada> {
  const etiqueta = modelo ?? "(el de cada escenario)";
  const { aplican, noAplican, noMedibles } = repartirEscenarios(modelo);

  console.log(`\n╭─ modelo: ${etiqueta}`);
  console.log(
    pad("scenario", 26) + pad("kind", 9) + padL("A in/out tok", 16) + padL("B in/out tok", 16) +
    padL("bill in/out", 14) + padL("cached A/B", 12) +
    padL("savings (95% lo)", 20) + padL("qa", 8),
  );
  console.log("─".repeat(130));

  const results: ScenarioResult[] = [];
  for (const s of aplican) results.push(await runScenario(s, modelo));

  for (const r of results) {
    const qa = `${r.quality.passed}/${r.quality.total}`;
    console.log(
      pad(r.name, 26) + pad(r.kind, 9) +
      padL(`${r.armA.meanInputTokens.toFixed(0)}/${r.armA.meanOutputTokens.toFixed(0)}`, 16) +
      padL(`${r.armB.meanInputTokens.toFixed(0)}/${r.armB.meanOutputTokens.toFixed(0)}`, 16) +
      padL(`${(r.formaFactura.entrada * 100).toFixed(0)}/${(r.formaFactura.salida * 100).toFixed(0)}`, 14) +
      padL(`${r.cacheDePrefijo.naive}/${r.cacheDePrefijo.optimizado}`, 12) +
      padL(`${pct(r.measured.savings.point)} (${pct(r.measured.savings.lower)})`, 20) +
      padL(qa, 8),
    );
  }
  console.log("─".repeat(130));

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

  // Aggregate over ALL scenarios' cold single-call paired costs (honest: cache
  // shows its cold-miss cost here; repeat-traffic amortization is separate).
  const allA = results.flatMap((r) => r.paired.map((p) => p.costA));
  const allB = results.flatMap((r) => r.paired.map((p) => p.costB));
  const agg = bootstrapRatioCI(allA, allB, { seed: SEED });
  const wP = wilcoxonSignedRankP(results.flatMap((r) => r.paired.map((p) => p.costA - p.costB)));
  const qTotalPass = results.reduce((n, r) => n + r.quality.passed, 0);
  const qTotal = results.reduce((n, r) => n + r.quality.total, 0);
  const qualityPassRate = qTotal ? qTotalPass / qTotal : 0;
  const allFpStable = results.every((r) => r.modelStable);

  const proven = mode === "LIVE" && agg.lower > 0 && qualityPassRate >= QUALITY_FLOOR && allFpStable;

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

  console.log("\nHeadline (per cold single call, measured both sides)");
  if (mode === "LIVE") {
    console.log(`  Net savings:   point ${pct(agg.point)}   95% CI [${pct(agg.lower)}, ${pct(agg.upper)}]`);
    console.log(`  Claim:         ${proven ? `VERIFIED ≥ ${pct(agg.lower)} at 95% confidence` : "NOT PROVEN (CI lower ≤ 0, quality regressed, or model swapped)"}`);
    console.log(`  Wilcoxon p:    ${wP.toExponential(2)}   (H1: median saving > 0)`);
    if (!allFpStable) console.log(`  ⚠ los dos brazos no hablaron con el mismo modelo: ${results.flatMap((r) => r.servedModels).join(", ")}`);
  } else {
    console.log(`  Net savings:   ${pct(agg.point)}  — ESTIMATED (mock provider), NOT a real savings claim`);
    console.log(`  Run LIVE (set BVSALA_DEMO_BASE_URL) for real provider tokens & dollars.`);
  }
  console.log(`  Quality:       ${qTotalPass}/${qTotal} answers passed the gate (${pct(qualityPassRate)})`);
  const nv = results.reduce((n, r) => n + r.naiveContractValid.valid, 0);
  const nt = results.reduce((n, r) => n + r.naiveContractValid.total, 0);
  if (nt > 0) {
    console.log(`  Naive valid:   ${nv}/${nt} respuestas del brazo SIN la capa cumplían el contrato (${pct(nv / nt)})`);
    console.log(`                 (la capa paga tokens por garantizarlo; el naive no, y hasta ahora nadie se lo exigía)`);
  }
  console.log(`  Reconciles:    ${reconciled ? "yes" : "NO — residual " + money(residual)}  (ledger deltas partition the total, no double-counting)`);

  console.log("\nPer-ledger attribution (measured; a ledger is 'proven' only if its 95% CI clears 0)");
  for (const l of ledgerRollup) {
    const badge = l.scenarios.length === 0 ? "sin escenario" : mode !== "LIVE" ? "est" : l.proven ? "proven" : "not-proven";
    console.log(`  ${pad(l.ledger, 20)} ${padL(pct(l.savings.point), 8)}  95%lo ${padL(pct(l.savings.lower), 8)}   ${badge}`);
  }

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

  const artefacto: Record<string, unknown> = {
    mode,
    ...(modelo ? { model: modelo } : {}),
    generatedNote: mode === "LIVE" ? "real provider tokens & cost, quality-gated" : "ESTIMATED — mock provider, not a savings claim",
    pricing: { note: PRICING_NOTE, table: PRICES, fallback: FALLBACK_PRICE, catalogueDated: PRECIOS_AL_DIA, ...(modelo ? { listPriceKnown: precioConocido(modelo) } : {}) },
    methodology:
      "Paired A/B: Arm A = naive request (full JSON, all tools, no cap, no schema) executed against the same provider; " +
      "Arm B = BV-SALA optimized. Both priced from provider usage. Headline = 95% bootstrap CI lower bound of 1−ΣcostB/ΣcostA. " +
      "Quality gate voids regressed answers. Cache savings amortized separately with a break-even K.",
    config: { reps: REPS, minReps: REPS, maxReps: MAX_REPS, ciTarget: CI_TARGET, qualityFloor: QUALITY_FLOOR, seed: SEED },
    scenarios: results.map((r) => ({ ...r, paired: undefined })),
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
    modelStable: allFpStable,
    aggregate: {
      savings: agg,
      wilcoxonP: wP,
      qualityPassRate,
      proven,
      headline: mode === "LIVE"
        ? (proven ? `verified ≥ ${pct(agg.lower)} (95% CI lower bound)` : "not proven")
        : "ESTIMATED (mock) — not a savings claim",
    },
    honesty: [
      "Both arms are metered by the provider's own tokenizer — no modeled baseline.",
      "The headline is the 95% CI lower bound, never the point estimate.",
      "A saving is voided if its answer fails the quality gate.",
      "Each scenario maps to one ledger, so ledger deltas partition the total (reconciliation residual proves no double-counting).",
      "Adaptive sampling adds reps only where variance is high, up to a hard cap.",
      "El modelo SERVIDO se compara entre los dos brazos; si difiere, la afirmación no vale. (system_fingerprint se registra pero no se usa como verja: a través de una pasarela es un id por petición.)",
      "Cache savings are shown as repeat-traffic amortization with a break-even K, not a single-call number.",
      "Missing provider usage is a hard error (requireUsage), never a silent 0 → 100% saving.",
      "Una palanca opt-in que no llegó a dispararse se DECLARA en `levers.notExercised`: su cero no es una medición.",
      "Un escenario que no aplica a este modelo se SALTA y se declara en `scenariosNotApplicable`, en vez de medirse mal.",
      "Una palanca que el TRANSPORTE configurado no puede ejercitar (cache_control por una pasarela OpenAI) se declara en `levers.notMeasurable` con lo que hay que configurar, y su escenario NO se ejecuta: publicar su cero sería publicar un fracaso que nadie ha medido.",
    ],
  };

  return {
    modelo,
    etiqueta,
    results,
    noAplican,
    noMedibles,
    agg,
    wilcoxonP: wP,
    qualityPassRate,
    proven,
    modelStable: allFpStable,
    ledgerRollup,
    palancas,
    artefacto,
  };
}

/** `openai/gpt-4o-mini` → `openai-gpt-4o-mini`, para nombrar ficheros. */
function babosa(modelo: string): string {
  return modelo.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function main(): Promise<void> {
  console.log(`\nBV-SALA TRUE A/B live benchmark  [mode: ${mode}]`);
  console.log(
    mode === "LIVE"
      ? `provider: real endpoint   models: ${modelosAMedir.map((m) => m ?? "(per-request)").join(", ")}   reps: ${REPS}   (both arms metered by the provider)`
      : `provider: mock (no network)   models: ${modelosAMedir.map((m) => m ?? "(per-request)").join(", ")}   reps: ${REPS}   —  ESTIMATED plumbing run, NOT a savings claim`,
  );
  // POR EXISTENCIA, NUNCA POR VALOR: se dice SI hay endpoint nativo declarado,
  // jamás cuál ni con qué clave. Y se dice siempre, porque su ausencia es la que
  // decide que la palanca mayor de la entrada no se mida en esta tirada.
  if (mode === "LIVE") {
    console.log(
      anthropicBaseUrl
        ? "anthropic: endpoint NATIVO declarado — los modelos de esa familia van por AnthropicProvider (cache_control viaja)"
        : "anthropic: sin endpoint nativo (BVSALA_DEMO_ANTHROPIC_BASE_URL) — `cache_control` no cabe en el protocolo de OpenAI,\n" +
          "           así que los escenarios que lo miden se declaran NO MEDIBLES y no se ejecutan",
    );
  }

  // ── El precio ANTES de gastarlo ──────────────────────────────────────────
  const estimacion = estimarTirada();
  const techo = imprimirEstimacion(estimacion);
  const presupuesto = Number(process.env.BVSALA_AB_BUDGET_USD ?? NaN);
  if (mode === "LIVE" && Number.isFinite(presupuesto) && techo > presupuesto) {
    console.error(
      `\n✗ La tirada puede costar hasta ${dinero4(techo)} y BVSALA_AB_BUDGET_USD son ${dinero4(presupuesto)}.\n` +
        `  No se ha llamado a ningún proveedor. Sube el presupuesto o recorta BVSALA_AB_REPS / BVSALA_DEMO_MODELS.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const tiradas: Tirada[] = [];
  for (const modelo of modelosAMedir) tiradas.push(await medirModelo(modelo));

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
      pad("AGREGADO", anchoNombre) +
        tiradas.map((t) => celda(`${pct(t.agg.point)} (${pct(t.agg.lower)})`)).join(""),
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
  if (tiradas.length === 1) {
    // UN solo modelo: el artefacto de siempre, en su ruta de siempre. Es la que
    // lee `pnpm ab:publish`, y cambiarla rompería la publicación.
    const t = tiradas[0]!;
    rutas.push(writeReport("ab-live", t.artefacto));
    rutas.push(
      writeCsv(
        "ab-live-trials",
        ["scenario", "kind", "rep", "costA", "costB", "savedFraction"],
        t.results.flatMap((r) =>
          r.paired.map((p, i) => ({ scenario: r.name, kind: r.kind, rep: i, costA: p.costA, costB: p.costB, savedFraction: p.costA > 0 ? 1 - p.costB / p.costA : 0 })),
        ),
      ),
    );
  } else {
    // VARIOS modelos: un artefacto por modelo y una comparación. `ab-live.json`
    // NO se escribe, y es deliberado: publicar una tirada multi-modelo bajo un
    // solo titular es exactamente la confusión que este cambio viene a quitar.
    // Para publicar, se elige un modelo y se corre con `BVSALA_DEMO_MODEL`.
    for (const t of tiradas) {
      const slug = babosa(t.etiqueta);
      rutas.push(writeReport(`ab-live--${slug}`, t.artefacto));
      rutas.push(
        writeCsv(
          `ab-live-trials--${slug}`,
          ["scenario", "kind", "rep", "costA", "costB", "savedFraction"],
          t.results.flatMap((r) =>
            r.paired.map((p, i) => ({ scenario: r.name, kind: r.kind, rep: i, costA: p.costA, costB: p.costB, savedFraction: p.costA > 0 ? 1 - p.costB / p.costA : 0 })),
          ),
        ),
      );
    }
    rutas.push(
      writeReport("ab-live-por-modelo", {
        mode,
        generatedNote:
          mode === "LIVE"
            ? "real provider tokens & cost, quality-gated, one run per model"
            : "ESTIMATED — mock provider, not a savings claim",
        models: tiradas.map((t) => t.etiqueta),
        costEstimate: estimacion,
        comparison: tiradas.map((t) => ({
          model: t.etiqueta,
          aggregate: { savings: t.agg, proven: t.proven, qualityPassRate: t.qualityPassRate },
          ledgers: t.ledgerRollup.map((l) => ({ ledger: l.ledger, savings: l.savings, scenarios: l.scenarios.length })),
          levers: t.palancas,
          leversNotMeasurable: t.noMedibles,
          scenariosNotApplicable: t.noAplican,
          scenarios: t.results.map((r) => ({
            name: r.name,
            ledger: r.ledger,
            kind: r.kind,
            savings: r.measured.savings,
            quality: r.quality,
            palanca: r.palanca,
          })),
        })),
        leversWithoutScenario: PALANCAS_SIN_ESCENARIO,
        honesty: [
          "Cada modelo se mide por separado, con sus propios escenarios aplicables.",
          "n/a en la tabla = el escenario NO se midió contra ese modelo; nunca es un cero.",
          "Una palanca opt-in que no llegó a dispararse se declara; su cero no es una medición.",
          "Una palanca que el transporte configurado no puede ejercitar va en `leversNotMeasurable`, con qué configurar para medirla; su escenario no se ejecuta.",
          "No se escribe `ab-live.json` en una tirada multi-modelo: un titular necesita un modelo.",
        ],
      }),
    );
    rutas.push(
      writeCsv(
        "ab-live-por-modelo",
        ["model", "scenario", "ledger", "kind", "palanca", "palancaEjercitada", "savingsPoint", "savingsLower", "reps", "qualityPassed", "qualityTotal"],
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
            reps: r.reps,
            qualityPassed: r.quality.passed,
            qualityTotal: r.quality.total,
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
