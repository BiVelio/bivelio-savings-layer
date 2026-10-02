import type { CanonicalRequest } from "../canonicalization/canonicalize.js";
import type { SemanticCalibrationBound } from "../contracts/types.js";
import {
  CalibrationStateError,
  EstadoDeCalibracion,
  escribirEstado,
  indiceEnRejilla,
  leerEstado,
  umbralDeIndice,
  validarCalibracion,
  type IdentidadDeCalibracion,
} from "./calibracion.js";
import {
  sameAnswer,
  type AnswerJudge,
  type SemanticCalibrationOptions,
  type SemanticCalibrationState,
  type SemanticCalibrationStatus,
} from "./calibration.js";
import { cantidadesEnLetra } from "./cantidades-en-letra.js";
import { localEmbedding, LOCAL_EMBEDDING_THRESHOLD } from "./embedder-local.js";
import type { CachedAnswer } from "./exact.js";

/**
 * Semantic cache (safe-by-construction).
 *
 * A semantic cache reuses a previous answer for a *similar* query. Its danger is
 * the false positive: confidently returning a valid answer to a nearby-but-wrong
 * question. Therefore the headline metric here is NOT hit ratio — it is the
 * PRECISION of hits. Every candidate must pass: tenant/permission filter,
 * knowledge-epoch filter, a similarity threshold, a stronger local verifier, a
 * freshness check, and an output-contract compatibility check.
 */
export interface EmbeddingFn {
  (text: string): Promise<number[]> | number[];
}

export interface SemanticVerifier {
  /**
   * Second-stage check (ideally a small cross-encoder). Returns a confidence in
   * [0,1] that the candidate answer genuinely answers the query. The pipeline
   * only accepts a hit above the configured acceptance threshold.
   */
  (query: string, candidateQuery: string): Promise<number> | number;
}

export interface SemanticRecord {
  embedding: number[];
  query: string;
  answer: CachedAnswer;
  tenantId: string;
  authorizationScope: string;
  knowledgeEpoch: string;
  contractId: string | null;
  /**
   * Who made the request (session/principal), or null when anonymous.
   *
   * Isolation boundary: `tenantId` separates organizations, `principal`
   * separates people within one. Both are hard filters applied BEFORE any
   * similarity scoring — a semantic match never crosses either.
   */
  principal: string | null;
  /**
   * The COMPLETE identity of the request that produced this answer.
   *
   * Every field here is a hard filter, checked before similarity is scored.
   * Together with the isolation fields above they are the identity the exact
   * cache keys on, except for the text itself, which is what similarity
   * compares. Freshness is covered by construction: the semantic cache only
   * runs on requests whose freshness bucket is `any`, the default. Two questions worded
   * alike but carrying different attached data, a different model, a different
   * system prompt, a different tool catalog or different sampling controls are
   * different questions, and never match.
   */
  model: string;
  systemPromptHash: string;
  structuredDataHash: string;
  locale: string;
  schemaVersion: string;
  safetyPolicyVersion: string;
  /** Hash of the declared tool catalog (ids, risk and parameters). */
  toolsetHash: string;
  /**
   * Hash of the tool-loop fields of the conversation (tool calls, the call each
   * tool result answers, its error flag and name); absent when it had none.
   * Compared for equality like the other identity fields: similarity is scored
   * on text only, and never decides between two tool loops.
   */
  toolTurnsHash?: string;
  /** Sampling temperature of the request, or null when it set none. */
  temperature: number | null;
  /** Sampling seed of the request, or null when it set none. */
  seed: number | null;
  /** `reasoning_effort` of the request; absent when it declared none. */
  reasoningEffort?: string;
  storedAtMs: number;
  /**
   * With calibration on: the highest score at which this stored answer was
   * judged wrong for another request. It is never served at or below it.
   */
  failedAtScore?: number;
}

export interface SemanticHit {
  record: SemanticRecord;
  similarity: number;
  /** Your verifier's score, or the similarity itself when no verifier is configured (see `verifierRan`). */
  verifierScore: number;
  /** The lower of `similarity` and `verifierScore`; a hit is served only at or above `acceptFloor`. */
  confidence: number;
  ageMs: number;
  /** Similarity a candidate had to reach to be considered at all. */
  similarityFloor: number;
  /** Confidence a candidate had to reach to be served. */
  acceptFloor: number;
  /** `built_in`: the lexical embedder shipped with the SDK. `custom`: the one you passed as `embed`. */
  embedder: "built_in" | "custom";
  /** Whether a verifier scored this hit. When false, `verifierScore` equals `similarity`. */
  verifierRan: boolean;
  /** With calibration on: the bound this hit is served under. `acceptFloor` is then the certified floor. */
  calibration?: SemanticCalibrationBound;
}

/**
 * With calibration on, a candidate the cache did not serve: the request goes to
 * your provider, and {@link InMemorySemanticCache.observe} turns the answer into
 * a label.
 *
 * - `calibrating`: no floor is certified yet in this traffic segment.
 * - `below_floor`: the candidate's score is under the certified floor.
 * - `record_floor`: this stored answer was already judged wrong at this score or higher.
 * - `audit`: the candidate cleared the floor and was sampled to keep testing it.
 */
export interface SemanticProbe {
  reason: "calibrating" | "below_floor" | "record_floor" | "audit";
  /** The score the decision was made on: the lower of similarity and your verifier's score. */
  score: number;
  segment: "single_shot" | "agentic";
  record: SemanticRecord;
}

/** What {@link InMemorySemanticCache.lookup} found: a hit to serve, a candidate to label, or neither. */
export interface SemanticLookup {
  hit: SemanticHit | null;
  probe: SemanticProbe | null;
}

export interface SemanticCacheOptions {
  /**
   * How text becomes a vector. OPTIONAL: omit it and {@link localEmbedding} is
   * used — no network, no API key, no per-call cost.
   *
   * It used to be required, and the package shipped NO implementation, so this
   * cache could not be constructed without bringing your own embedding provider.
   * That is why the benchmark reported it as unmeasurable run after run: not that
   * it saved little, but that it never got to run at all.
   *
   * Pass your own for true semantics; the local one only sees LEXICAL closeness.
   * Either way the deterministic guard below still rejects a candidate whose
   * numbers (in digits or spelled out in en/es/ca: "three", "twice", "half"),
   * negation parity or content words differ beyond its overlap floor. It is a
   * lexical guard, not a proof: a one-word entity swap in a long query can
   * still clear the overlap floor, and through 0.4.30 a number written in words
   * cleared it too (GSM8K: 477 of 564 such variants got their original's
   * answer). Calibrate on your own traffic before trusting it with answers
   * that differ by one word.
   */
  embed?: EmbeddingFn;
  /**
   * Names your `embed` function: model and version, e.g.
   * `"text-embedding-3-small@1536"`. A saved calibration carries it, and one
   * recorded under another embedder is refused on import. Required to export a
   * calibration when you pass your own `embed`.
   */
  embedderId?: string;
  verify?: SemanticVerifier;
  /** Names your `verify` function, like {@link embedderId}. Required to export a calibration when you pass one. */
  verifierId?: string;
  /** Cosine similarity floor for a candidate to be considered at all. */
  similarityThreshold?: number;
  /** Verifier score floor for acceptance. */
  acceptThreshold?: number;
  ttlMs?: number;
  maxRecords?: number;
  now?: () => number;
  /**
   * Opt-in: replace the fixed acceptance floor with one your own labeled
   * traffic certifies for a wrong-reuse rate you choose. Off by default. See
   * {@link SemanticCalibrationOptions}.
   */
  calibration?: SemanticCalibrationOptions;
}

export function cosine(a: number[], b: number[]): number {
  // Dos vectores de dimensiones distintas vienen de dos embebedores distintos
  // (o de un modelo cambiado a mitad de vida de la caché): compararlos
  // truncando al más corto daba similitudes altas entre cosas que no tienen
  // nada que ver, y eso es un acierto de caché falso. No hay similitud: 0.
  // Hallazgo «medio» de la auditoría de agosto (CIERRE.md § 2.3).
  if (a.length !== b.length) return 0;
  const n = a.length;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// --- Deterministic precision guard (always on, beneath the embedding) ---------
//
// A semantic cache's cardinal sin is confidently serving an answer to a
// nearby-but-DIFFERENT question. Sentence embeddings are famously blind to
// negations ("safe" vs "not safe"), swapped numbers/dates (100 vs 200), and
// one-token entity changes (North vs South Dakota) — cosine can sit >0.95 across
// all of these. This lexical check catches what the embedding cannot: a candidate
// is rejected unless the two (already normalized/lowercased) queries agree on the
// multiset of numeric/date tokens, on negation parity, and on a content-token
// overlap floor. A rejection only forgoes a cache hit (we make the real call) —
// it can never produce a wrong answer. (The stopword list is English/es/ca; the
// digit and overlap checks are language-agnostic; numbers spelled out in words
// are read in en/es/ca only — see `cantidades-en-letra.ts`.)
// LA LISTA ERA SOLO INGLESA, Y ESO SÍ ERA UN AGUJERO DE CORRECCIÓN — no de ahorro.
// Con la paridad de negación ciega al castellano y al catalán, dos preguntas de
// significado OPUESTO contaban ambas 0 negaciones, pasaban la verja y la caché
// podía servir la respuesta contraria. Medido ejecutando `keyTokensMatch` contra
// este mismo fichero antes del arreglo (2026-08-29):
//
//     «resume el informe SIN los datos personales» ≡ «… CON los datos personales» → PASABA
//     «es seguro tomar aspirina» ≡ «NUNCA es seguro tomar aspirina»               → PASABA
//     «is aspirin safe» ≡ «is aspirin not safe»                                    → cortaba
//
// El inglés estaba cubierto y el castellano no; funcionaba con «no» por PURA
// CASUALIDAD, porque la palabra coincide con la inglesa. Y lo agravaba el bloque
// de STOPWORDS de aquí abajo: mete `sin` y `sense` —que son NEGACIONES— entre las
// palabras vacías, así que además de no contarlas, las DESCARTA del solapamiento.
// «factura sin IVA» y «factura con IVA» quedaban idénticas a ojos de la verja.
//
// Sobra por el lado seguro a propósito: una negación de más solo renuncia a un
// acierto de caché (se hace la llamada real), mientras que una de menos sirve una
// respuesta invertida. Por eso entran palabras polisémicas como `cap` («ninguno»,
// pero también «cabeza») o `res` («nada»): el coste de equivocarse es asimétrico.
const NEGATIONS = new Set([
  // inglés
  "no", "not", "never", "none", "cannot", "cant", "without", "nor", "nt", "isnt",
  "arent", "wasnt", "werent", "dont", "doesnt", "didnt", "wont", "shouldnt",
  // castellano
  "sin", "nunca", "jamas", "jamás", "tampoco", "ni", "ningun", "ningún",
  "ninguna", "ninguno", "nada", "nadie",
  // catalán
  "sense", "mai", "tampoc", "cap", "gens", "ningu", "ningú", "res",
]);
// LA LISTA ERA SOLO INGLESA, Y ESO NO ERA UNA LAGUNA COSMÉTICA: hacía que la
// MISMA paráfrasis pasara o se cortara según el idioma. Medido con el guard:
//
//     "summarize this report" ↔ "please summarize this report"   → PASA
//     "resume este informe"   ↔ "por favor resume este informe"  → CORTA
//
// Idéntica semántica, resultado opuesto, y el producto es español-primero: en
// castellano y catalán la cortesía y los artículos contaban como tokens de
// CONTENIDO, así que dos palabras de relleno bastaban para hundir el Jaccard por
// debajo del 0,75 y negar el acierto. La caché semántica no es que ahorrase
// poco en esos idiomas: es que no podía acertar.
//
// Añadir stopwords no toca la parte de seguridad SIEMPRE QUE la paridad de
// negación cubra el mismo idioma — y eso es exactamente lo que faltaba. Los
// números y la negación se comprueban ANTES y por separado, sí, pero `sin` y
// `sense` entraron aquí como relleno mientras la lista de negaciones seguía en
// inglés: descartadas del solapamiento Y sin contar como negación, o sea
// invisibles por los dos lados. Arreglado arriba. Si algún día se añaden
// stopwords de otro idioma, hay que añadir SUS negaciones en el mismo commit.
//
// Se cubren es/ca porque son los idiomas con tráfico y con corpus (el golden set
// de 150 casos es es/ca). Los otros nueve locales siguen con el trato inglés:
// conservador, o sea que pierden aciertos, nunca que sirvan de más.
const STOPWORDS = new Set([
  // inglés
  "the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "is", "are", "was",
  "were", "what", "whats", "which", "who", "whom", "how", "when", "where", "me", "my",
  "i", "you", "please", "tell", "give", "show", "find", "do", "does", "did", "be",
  "that", "this", "it", "with", "as", "at", "by", "from", "about", "into", "over",
  "than", "then", "s",
  // castellano
  "el", "la", "los", "las", "un", "una", "unos", "unas", "de", "del", "al", "en",
  "por", "para", "con", "sin", "sobre", "y", "o", "u", "es", "son", "era", "eran",
  "ser", "estar", "esta", "este", "esto", "estos", "estas", "ese", "esa", "eso",
  "que", "cual", "cuales", "quien", "quienes", "como", "cuando", "donde", "dame",
  "dime", "quiero", "necesito", "puedes", "podrias", "favor", "porfavor", "gracias",
  "me", "mi", "mis", "tu", "tus", "su", "sus", "lo", "le", "se", "hay",
  // catalán
  "el", "la", "els", "les", "un", "una", "uns", "unes", "de", "del", "dels", "al",
  "als", "en", "per", "amb", "sense", "sobre", "i", "o", "es", "son", "era", "eren",
  "ser", "estar", "aquest", "aquesta", "aquests", "aquestes", "aquell", "aquella",
  "que", "quin", "quina", "qui", "com", "quan", "on", "dona", "vull", "necessito",
  "pots", "podries", "sisplau", "gracies", "meu", "meva", "seu", "seva", "hi",
]);
// NO entran, y es deliberado: los temporales ("ahora"/"ara"), los comparativos
// ("más"/"menos", "mes"/"menys") y los aditivos ("también"/"també") CAMBIAN el
// significado. «más de 100» no es «menos de 100», y preguntar «ahora» pide dato
// fresco. El inglés tampoco los tiene, así que dejarlos fuera es lo que iguala
// las listas en vez de volver el castellano MÁS permisivo que el inglés.

// LOS AYUDANTES SE EXPORTAN PARA QUE LA LISTA DE NEGACIONES VIVA EN UN SOLO
// SITIO. La verja de fidelidad de la compresión (`compression/compression.ts`)
// necesita exactamente los mismos hechos —números y paridad de negación—, y
// mantener una segunda copia de `NEGATIONS` es justo lo que el comentario de
// arriba prohíbe: la copia se queda sin las tildes, o sin es/ca, y entonces una
// de las dos verjas deja pasar lo que la otra corta.
export function numericTokens(s: string): string[] {
  return (s.match(/\d[\d.,:/-]*/g) ?? []).map((t) => t.replace(/[.,:/-]+$/, ""));
}
export function multisetEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const counts = new Map<string, number>();
  for (const x of a) counts.set(x, (counts.get(x) ?? 0) + 1);
  for (const y of b) {
    const c = counts.get(y);
    if (!c) return false;
    counts.set(y, c - 1);
  }
  return true;
}
export function words(s: string): string[] {
  return s.split(/\s+/).filter(Boolean);
}
export function negationCount(tokens: string[]): number {
  return tokens.filter((t) => NEGATIONS.has(t.replace(/'/g, "")) || t.endsWith("n't")).length;
}

// EL PREFIJO DE ROL CEGABA LA VERJA, y por el lado que sirve respuestas.
//
// `canonicalize` escribe un turno por línea como `${rol}:${texto}`
// (canonicalize.ts:236), así que la PRIMERA palabra de cada turno llega FUNDIDA
// con el rol: `user:nunca`, `user:por`. Partir por espacios no la separa, y
// entonces `user:nunca` no está en NEGATIONS y la negación NO SE CUENTA.
//
// MEDIDO contra el main de hoy, y con la misma pareja en las dos formas:
//
//   «user:es seguro tomar aspirina en el embarazo con anticoagulantes orales…»
//   vs la misma con «nunca» delante            → daba TRUE  (la caché servía
//                                                 «sí, es seguro»)
//   la MISMA pareja sin el prefijo `user:`      → daba FALSE (cortaba bien)
//
// Los tests usan cadenas peladas y producción usa `rol:texto`: por eso el
// arreglo es/ca de la lista de negaciones (#144) pasaba en verde sin llegar a
// morder donde importa. Con textos cortos el Jaccard lo tapaba por accidente;
// con un texto realista, una palabra más apenas lo mueve y la verja abre.
//
// El mismo prefijo estropea el otro lado: `user:por` tampoco está en STOPWORDS,
// así que la cortesía inicial cuenta como token de CONTENIDO y hunde el Jaccard
// — «por favor resume este informe» ↔ «resume este informe» se cortaba, que es
// un acierto de caché perdido en cada petición cortés.
//
// La verja se aplica ahora TURNO A TURNO con el rol fuera del texto. Comparar
// además el ROL es lo que impide que al quitar el prefijo se confunda «lo dijo
// el usuario» con «lo dijo el asistente»; y un número distinto de turnos no
// casa. Con una sola cadena sin prefijo —como la llaman los tests— el
// comportamiento es EXACTAMENTE el de antes.
const PREFIJO_DE_ROL = /^(system|user|assistant|tool):/;

function turnos(s: string): { rol: string; texto: string }[] {
  return s.split("\n").map((linea) => {
    const m = PREFIJO_DE_ROL.exec(linea);
    return m ? { rol: m[1]!, texto: linea.slice(m[0].length) } : { rol: "", texto: linea };
  });
}

/** True when two normalized queries agree on the facts an embedding tends to blur. */
export function keyTokensMatch(a: string, b: string): boolean {
  const va = turnos(a);
  const vb = turnos(b);
  if (va.length !== vb.length) return false;
  for (let i = 0; i < va.length; i++) {
    if (va[i]!.rol !== vb[i]!.rol) return false;
    if (!hechosCoinciden(va[i]!.texto, vb[i]!.texto)) return false;
  }
  return true;
}

/** Las mismas tres comprobaciones, sobre el texto de UN turno ya sin su rol. */
function hechosCoinciden(a: string, b: string): boolean {
  // 1. Numbers/dates must match exactly, as a multiset (100 vs 200; Jul 20 vs 21).
  //    LAS CANTIDADES EN LETRA TAMBIÉN. Solo con dígitos, «three baskets» y
  //    «four baskets» tenían el mismo multiconjunto (vacío) y el Jaccard las
  //    dejaba pasar: sin red, 477 de 564 variantes de GSM8K así recibían la
  //    respuesta de su original. Los tokens en letra llevan prefijo (`n:3`,
  //    `m:2`, `f:1/2`…) y no comparten valor con los de dígito, así que esto
  //    solo AÑADE cortes: nada que antes se cortara pasa ahora. Detalle y
  //    decisiones (falsos positivos, idiomas) en `cantidades-en-letra.ts`.
  const na = [...numericTokens(a), ...cantidadesEnLetra(a)];
  const nb = [...numericTokens(b), ...cantidadesEnLetra(b)];
  if (!multisetEqual(na, nb)) return false;
  const ta = words(a);
  const tb = words(b);
  // 2. Negation parity ("aspirin safe" vs "aspirin not safe").
  if (negationCount(ta) !== negationCount(tb)) return false;
  // 3. Content-token (non-stopword, non-numeric) overlap floor via Jaccard, which
  //    catches a single swapped entity (north/south) while letting true paraphrases
  //    through ("capital of france" vs "france capital" -> 1.0).
  const isContent = (t: string) => t.length > 1 && !STOPWORDS.has(t) && !/^\d/.test(t);
  const ca = new Set(ta.filter(isContent));
  const cb = new Set(tb.filter(isContent));
  if (ca.size === 0 && cb.size === 0) return true;
  let inter = 0;
  for (const x of ca) if (cb.has(x)) inter++;
  const union = ca.size + cb.size - inter;
  return union === 0 ? true : inter / union >= 0.75;
}

// La identidad del embebedor LÉXICO que viaja con el SDK en un estado de
// calibración. SUBIRLA en cuanto cambie un vector de `vectorLocal` (rasgos,
// dimensiones, hash, normalización): un suelo certificado con los vectores de
// antes no dice nada de los de ahora. `test/estado-de-calibracion.test.ts` fija
// los vectores y falla si cambian sin que cambie esto.
const ID_DEL_EMBEBEDOR_LOCAL = "lexical-256-v1";
// Lo mismo para el juez por defecto, `sameAnswer`.
const ID_DEL_JUEZ_POR_DEFECTO = "same-answer-v1";

/**
 * In-memory reference implementation. A production build would back this with a
 * real vector store and metadata filters pushed down
 * to the store. The verification logic — the part that makes it *safe* — stays
 * identical regardless of the backend.
 */
export class InMemorySemanticCache {
  private readonly records: SemanticRecord[] = [];
  private readonly embed: EmbeddingFn;
  private readonly verify: SemanticVerifier | undefined;
  private readonly similarityThreshold: number;
  private readonly acceptThreshold: number;
  private readonly ttlMs: number | undefined;
  private readonly maxRecords: number;
  private readonly now: () => number;
  // Si el embebedor es el léxico que viaja con el SDK. Se guarda para que el
  // acierto lo declare (`SemanticHit.embedder`) y el libro de calidad pueda
  // decir con qué vara se midió la similitud: 0,9 con un vector léxico y 0,9
  // con un sentence-transformer no significan lo mismo.
  private readonly embebedorPropio: boolean;
  // La calibración, si se pidió. Un estado por segmento de tráfico: lo agéntico
  // y lo de un solo turno no se certifican el uno al otro.
  private readonly calibracion:
    | {
        maxErrorRate: number;
        confidence: number;
        auditRate: number;
        judge: AnswerJudge;
        perRecordFloors: boolean;
        random: () => number;
      }
    | undefined;
  private readonly estados = new Map<SemanticProbe["segment"], EstadoDeCalibracion>();
  // Los nombres que declaró el llamante para su embebedor, su verificador y su
  // juez. Solo los lee la identidad de un estado exportado.
  private readonly nombres: { embedder?: string; verifier?: string; judge?: string };
  private readonly pendientes = new Set<Promise<boolean | null>>();
  // ¿Pasó el llamante un `acceptThreshold` suyo? Con calibración, solo uno
  // EXPLÍCITO sigue contando (como tope inferior adicional); el 0,85 por defecto no.
  private readonly aceptacionExplicita: boolean;

  constructor(opts: SemanticCacheOptions = {}) {
    // Sin `embed`, el local. Es lo que convierte esta caché en algo que se puede
    // construir —y por tanto medir— sin traerse un proveedor de embeddings.
    const propio = opts.embed == null;
    this.embebedorPropio = propio;
    this.embed = opts.embed ?? localEmbedding;
    this.verify = opts.verify;
    // EL UMBRAL SIGUE AL EMBEBEDOR, y no hacerlo dejaba la palanca muerta igual.
    //
    // 0,9 es el suelo que le corresponde a un sentence-transformer. Un vector
    // léxico se queda por debajo en paráfrasis legítimas, así que heredar ese 0,9
    // habría rechazado casi todo: la caché se construiría, no fallaría nada, y no
    // acertaría nunca — el mismo cero de antes con más código detrás.
    //
    // Solo cambia cuando el embebedor es el nuestro. Quien traiga el suyo
    // conserva 0,9 exactamente como hasta ahora.
    this.similarityThreshold =
      opts.similarityThreshold ?? (propio ? LOCAL_EMBEDDING_THRESHOLD : 0.9);
    this.acceptThreshold = opts.acceptThreshold ?? 0.85;
    this.aceptacionExplicita = opts.acceptThreshold != null;
    this.nombres = {
      ...(opts.embedderId != null ? { embedder: opts.embedderId } : {}),
      ...(opts.verifierId != null ? { verifier: opts.verifierId } : {}),
      ...(opts.calibration?.judgeId != null ? { judge: opts.calibration.judgeId } : {}),
    };
    this.ttlMs = opts.ttlMs;
    this.maxRecords = opts.maxRecords ?? 5_000;
    this.now = opts.now ?? (() => Date.now());
    if (opts.calibration) {
      // Se valida al construir: un δ mal puesto tiene que romper aquí, no en
      // la primera petición de producción.
      const v = validarCalibracion(opts.calibration);
      this.calibracion = {
        ...v,
        judge: opts.calibration.judge ?? sameAnswer,
        perRecordFloors: opts.calibration.perRecordFloors ?? true,
        random: opts.calibration.random ?? Math.random,
      };
    }
  }

  /** Whether this cache runs with `calibration`. */
  get calibrated(): boolean {
    return this.calibracion != null;
  }

  /**
   * Find a safe hit for a canonical request, or null. Metadata filters run
   * FIRST and hard — a candidate from another tenant, scope, or knowledge epoch
   * is never even scored.
   *
   * With calibration on, it returns only a hit served under a certified floor
   * and labels nothing: without {@link lookup} and {@link observe} (the layer
   * calls both) the calibration never gets a label and never certifies.
   */
  async find(c: CanonicalRequest): Promise<SemanticHit | null> {
    // Con calibración, lo que se sirve lo decide `lookup`; `find` devuelve solo
    // el acierto (una candidata que no se sirve no deja etiqueta por aquí).
    if (this.calibracion) return (await this.lookup(c)).hit;
    return this.mejorCandidata(c, true);
  }

  /**
   * The best candidate that passes every hard filter, the similarity floor and
   * the fact guard. With `conAceptacion`, also the confidence floor (the path
   * without calibration, unchanged); without it, calibration decides.
   */
  private async mejorCandidata(c: CanonicalRequest, conAceptacion: boolean): Promise<SemanticHit | null> {
    if (this.records.length === 0) return null;
    const queryEmbedding = await this.embed(c.normalizedText);

    let best: SemanticHit | null = null;
    for (const record of this.records) {
      if (record.tenantId !== c.tenantId) continue;
      if (record.authorizationScope !== c.authorizationScope) continue;
      // El principal separa PERSONAS dentro del tenant. `null === null` es
      // legítimo: dos peticiones anónimas del mismo tenant sí comparten (no hay
      // nadie a quien filtrar). Lo que no puede pasar es que la de un usuario
      // identificado sirva a otro — y la política ya apaga la caché para una
      // petición personalizada SIN principal, así que aquí no hay que adivinar.
      if (record.principal !== c.principal) continue;
      if (record.knowledgeEpoch !== c.knowledgeEpoch) continue;
      if (record.contractId !== c.contractId) continue;
      // Los cinco campos que la clave exacta declara necesarios y este filtro
      // ignoraba. Sin ellos, el embedding decide solo — y el embedding no ve el
      // modelo, ni el system prompt, ni los datos adjuntos.
      if (record.model !== c.model) continue;
      if (record.systemPromptHash !== c.systemPromptHash) continue;
      if (record.structuredDataHash !== c.structuredDataHash) continue;
      if (record.locale !== c.locale) continue;
      if (record.schemaVersion !== c.schemaVersion) continue;
      if (record.safetyPolicyVersion !== c.safetyPolicyVersion) continue;
      // Y LOS TRES QUE LA CLAVE EXACTA YA TENÍA Y ESTE FILTRO NO: el catálogo de
      // herramientas, la temperatura y la semilla (`buildExactKey`: `tools`,
      // `temperature`, `seed`). El JSDoc de `SemanticRecord` prometía la misma
      // identidad que la clave exacta y no era verdad: con herramientas de solo
      // lectura declaradas, una reformulación podía recibir la respuesta que se
      // generó viendo OTRO catálogo —o con otro muestreo—, y eso cambia qué
      // podía contestar el modelo. Van antes de puntuar, como los demás: un
      // candidato con otra identidad no llega ni a compararse.
      if (record.toolsetHash !== c.toolsetHash) continue;
      // Y LOS CAMPOS DEL BUCLE DE HERRAMIENTAS, que la clave exacta también lleva
      // (`toolTurnsHash`). Solo importan con `"include-agentic"` —sin él la
      // política ni siquiera consulta esta caché con llamadas o resultados de
      // herramienta—, y ahí son justo lo que el texto no ve: un resultado marcado
      // como error y el mismo texto como dato tienen el MISMO `normalizedText`, y
      // el embebedor y `keyTokensMatch` los darían por iguales. Igualdad estricta,
      // no similitud: con esto la caché solo sirve entre bucles cuyas llamadas,
      // argumentos, emparejamientos y marcas de error coinciden; nunca es más
      // permisiva que antes. Ausente de los dos lados (sin campos) sigue casando
      // como siempre.
      if (record.toolTurnsHash !== c.toolTurnsHash) continue;
      if (record.temperature !== c.temperature) continue;
      if (record.seed !== c.seed) continue;
      if (record.reasoningEffort !== c.reasoningEffort) continue;
      if (
        this.ttlMs != null &&
        this.now() - record.storedAtMs > this.ttlMs
      ) {
        continue;
      }

      const similarity = cosine(queryEmbedding, record.embedding);
      if (similarity < this.similarityThreshold) continue;

      // Precision floor beneath the embedding: reject a candidate whose query
      // disagrees on numbers/dates, negation, or key entities even when cosine is
      // high (embeddings are blind to exactly these). A rejection only costs a hit.
      if (!keyTokensMatch(c.normalizedText, record.query)) continue;

      const verifierScore = this.verify
        ? await this.verify(c.normalizedText, record.query)
        : similarity;
      const confidence = Math.min(similarity, verifierScore);
      if (conAceptacion && confidence < this.acceptThreshold) continue;

      if (!best || confidence > best.confidence) {
        best = {
          record,
          similarity,
          verifierScore,
          confidence,
          ageMs: this.now() - record.storedAtMs,
          similarityFloor: this.similarityThreshold,
          acceptFloor: this.acceptThreshold,
          embedder: this.embebedorPropio ? "built_in" : "custom",
          verifierRan: this.verify != null,
        };
      }
    }
    return best;
  }

  /**
   * Like {@link find}, and with calibration on it also returns the candidate it
   * did not serve, so the caller can label it with {@link observe} once the
   * provider has answered. Without calibration, `probe` is always null.
   *
   * `agentic` picks the traffic segment: calibrations are kept apart for
   * single-shot and agentic requests.
   */
  async lookup(c: CanonicalRequest, opts: { agentic?: boolean } = {}): Promise<SemanticLookup> {
    const cal = this.calibracion;
    if (!cal) return { hit: await this.mejorCandidata(c, true), probe: null };
    const segment: SemanticProbe["segment"] = opts.agentic ? "agentic" : "single_shot";
    // LA CANDIDATA ES LA MÁS CERCANA, SE SIRVA O NO. Si la más cercana no se
    // puede servir, no se busca la segunda: la etiqueta describe exactamente la
    // decisión «servir la más cercana si su puntuación llega al suelo», que es
    // lo que la prueba certifica.
    const candidata = await this.mejorCandidata(c, false);
    if (!candidata) return { hit: null, probe: null };
    const estado = this.estadoDe(segment);
    const suelo = estado.suelo;
    const score = candidata.confidence;
    const sonda = (reason: SemanticProbe["reason"]): SemanticLookup => ({
      hit: null,
      probe: { reason, score, segment, record: candidata.record },
    });
    if (suelo == null) return sonda("calibrating");
    if (indiceEnRejilla(score) < suelo || (this.aceptacionExplicita && score < this.acceptThreshold)) {
      return sonda("below_floor");
    }
    if (cal.perRecordFloors && candidata.record.failedAtScore != null && score <= candidata.record.failedAtScore) {
      return sonda("record_floor");
    }
    // El dado solo se tira aquí, con suelo y candidata servible: mientras se
    // calibra, la sonda ya es obligatoria y no hay nada que auditar.
    if (cal.auditRate > 0 && cal.random() < cal.auditRate) return sonda("audit");
    const floor = umbralDeIndice(suelo);
    const r = estado.resumen();
    return {
      hit: {
        ...candidata,
        acceptFloor: this.aceptacionExplicita ? Math.max(floor, this.acceptThreshold) : floor,
        calibration: {
          maxErrorRate: cal.maxErrorRate,
          confidence: cal.confidence,
          floor,
          heldOutAtFloor: r.retenidasEnSuelo,
          wrongHeldOutAtFloor: r.erroneasEnSuelo,
          labeled: r.etiquetas,
          segment,
        },
      },
      probe: null,
    };
  }

  /**
   * Label a candidate {@link lookup} did not serve, with the answer your provider
   * produced for that request. Resolves to the judge's verdict, or null when
   * there is no calibration or the judge failed (no label is recorded then).
   * It never rejects.
   */
  observe(probe: SemanticProbe, fresh: CachedAnswer): Promise<boolean | null> {
    const p = this.etiquetar(probe, fresh);
    this.pendientes.add(p);
    void p.finally(() => this.pendientes.delete(p));
    return p;
  }

  private async etiquetar(probe: SemanticProbe, fresh: CachedAnswer): Promise<boolean | null> {
    const cal = this.calibracion;
    if (!cal) return null;
    let correcta: boolean;
    try {
      // Solo un `true` estricto cuenta como correcta: cualquier otra cosa que
      // devuelva un juez es una reutilización que no se puede defender.
      correcta = (await cal.judge(probe.record.answer, fresh)) === true;
    } catch {
      return null;
    }
    this.estadoDe(probe.segment).anotar(probe.score, correcta);
    if (!correcta && cal.perRecordFloors) {
      probe.record.failedAtScore = Math.max(probe.record.failedAtScore ?? -Infinity, probe.score);
    }
    return correcta;
  }

  /** Resolves once every pending {@link observe} has recorded its label. */
  async settled(): Promise<void> {
    while (this.pendientes.size > 0) await Promise.allSettled([...this.pendientes]);
  }

  /** Where the calibration of a traffic segment stands, or null without calibration. */
  calibrationStatus(segment: SemanticProbe["segment"] = "single_shot"): SemanticCalibrationStatus | null {
    const cal = this.calibracion;
    if (!cal) return null;
    const r = this.estadoDe(segment).resumen();
    return {
      maxErrorRate: cal.maxErrorRate,
      confidence: cal.confidence,
      floor: r.suelo == null ? null : umbralDeIndice(r.suelo),
      labeled: r.etiquetas,
      heldOut: r.retenidas,
      heldOutAtFloor: r.retenidasEnSuelo,
      wrongHeldOutAtFloor: r.erroneasEnSuelo,
      minHeldOutToCertify: r.minimasParaLaSiguiente,
      nextTestAt: r.etiquetasParaLaSiguiente,
    };
  }

  /**
   * The calibration's full state, to restore it with {@link importCalibration}
   * in a later process: after a deploy, or in the next serverless invocation.
   * Plain JSON. Call it after `await cache.settled()` so labels still being
   * judged are included.
   *
   * The bound holds along one line of history: restore the latest state you
   * saved and keep saving from where it went. Processes that continue the same
   * state at the same time each spend its remaining confidence again. Each one
   * keeps its own bound, but the chance that some process certifies a wrong
   * floor grows with how many do it, and whichever saves last overwrites the
   * labels of the others.
   *
   * Throws {@link CalibrationStateError} without calibration, and when you
   * passed your own `embed`, `verify` or `judge` without naming it
   * (`embedderId`, `verifierId`, `calibration.judgeId`).
   */
  exportCalibration(): SemanticCalibrationState {
    return escribirEstado(this.identidad("exportCalibration"), this.estados);
  }

  /**
   * Restore a state saved with {@link exportCalibration} (the object, or its
   * JSON text), right after constructing the cache. The calibration continues
   * exactly where it was: the same labels in the same two halves, the same
   * tests already run and the same floor in force.
   *
   * All or nothing. Throws {@link CalibrationStateError}, and changes nothing,
   * when the state comes from another embedder, verifier, judge or
   * configuration, from a newer SDK, when its numbers do not add up, or when
   * this cache has already recorded labels in a segment the state carries
   * (merging two histories would count some labels twice).
   */
  importCalibration(state: SemanticCalibrationState | string | unknown): void {
    const id = this.identidad("importCalibration");
    let datos = state;
    if (typeof state === "string") {
      try {
        datos = JSON.parse(state);
      } catch {
        throw new CalibrationStateError("importCalibration: the state is a string but not JSON");
      }
    }
    const leidos = leerEstado(datos, id);
    for (const [segmento] of leidos) {
      const actual = this.estados.get(segmento);
      if (actual && actual.resumen().etiquetas > 0) {
        throw new CalibrationStateError(
          `importCalibration: this cache has already recorded ${actual.resumen().etiquetas} labels in the ` +
            `${segmento} segment; import right after constructing it`,
        );
      }
    }
    for (const [segmento, estado] of leidos) this.estados.set(segmento, estado);
  }

  // Quién puntúa, quién juzga y con qué números: lo que un estado exportado
  // tiene que compartir con la caché que lo importa. Sin nombre para una pieza
  // del cliente no hay identidad que comparar, y se rechaza en vez de adivinar.
  private identidad(accion: string): IdentidadDeCalibracion {
    const cal = this.calibracion;
    if (!cal) throw new CalibrationStateError(`${accion}: this cache runs without \`calibration\``);
    const falta = (opcion: string, pieza: string): never => {
      throw new CalibrationStateError(
        `${accion}: pass \`${opcion}\` naming your ${pieza}, so that a saved calibration is only ever ` +
          "restored under the same one",
      );
    };
    const embedder = this.embebedorPropio
      ? `built_in:${ID_DEL_EMBEBEDOR_LOCAL}`
      : `custom:${this.nombres.embedder ?? falta("embedderId", "embed function")}`;
    const verifier = this.verify == null ? null : `custom:${this.nombres.verifier ?? falta("verifierId", "verifier")}`;
    const judge =
      cal.judge === sameAnswer
        ? `built_in:${ID_DEL_JUEZ_POR_DEFECTO}`
        : `custom:${this.nombres.judge ?? falta("calibration.judgeId", "judge")}`;
    return {
      embedder,
      verifier,
      judge,
      maxErrorRate: cal.maxErrorRate,
      confidence: cal.confidence,
      similarityThreshold: this.similarityThreshold,
    };
  }

  private estadoDe(segmento: SemanticProbe["segment"]): EstadoDeCalibracion {
    let e = this.estados.get(segmento);
    if (!e) {
      const cal = this.calibracion!;
      e = new EstadoDeCalibracion(cal.maxErrorRate, 1 - cal.confidence);
      this.estados.set(segmento, e);
    }
    return e;
  }

  async store(c: CanonicalRequest, answer: CachedAnswer): Promise<void> {
    const embedding = await this.embed(c.normalizedText);
    if (this.records.length >= this.maxRecords) this.records.shift();
    this.records.push({
      embedding,
      query: c.normalizedText,
      answer,
      tenantId: c.tenantId,
      authorizationScope: c.authorizationScope,
      principal: c.principal,
      knowledgeEpoch: c.knowledgeEpoch,
      contractId: c.contractId,
      model: c.model,
      systemPromptHash: c.systemPromptHash,
      structuredDataHash: c.structuredDataHash,
      locale: c.locale,
      schemaVersion: c.schemaVersion,
      safetyPolicyVersion: c.safetyPolicyVersion,
      toolsetHash: c.toolsetHash,
      ...(c.toolTurnsHash !== undefined ? { toolTurnsHash: c.toolTurnsHash } : {}),
      temperature: c.temperature,
      seed: c.seed,
      ...(c.reasoningEffort !== undefined ? { reasoningEffort: c.reasoningEffort } : {}),
      storedAtMs: this.now(),
    });
  }

  /** Drop every record for a knowledge epoch (invalidation on re-index). */
  invalidateEpoch(knowledgeEpoch: string): number {
    let removed = 0;
    for (let i = this.records.length - 1; i >= 0; i--) {
      if (this.records[i]!.knowledgeEpoch === knowledgeEpoch) {
        this.records.splice(i, 1);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.records.length;
  }
}
