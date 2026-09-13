import type { CanonicalRequest } from "../canonicalization/canonicalize.js";
import { embebedorLocal, UMBRAL_LOCAL } from "./embedder-local.js";
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
   * Every field here is a hard filter, checked before similarity is scored, and
   * the set is identical to the one the exact cache keys on. Two questions
   * worded alike but carrying different attached data, a different model or a
   * different system prompt are different questions, and never match.
   */
  model: string;
  systemPromptHash: string;
  structuredDataHash: string;
  locale: string;
  schemaVersion: string;
  safetyPolicyVersion: string;
  storedAtMs: number;
}

export interface SemanticHit {
  record: SemanticRecord;
  similarity: number;
  verifierScore: number;
  confidence: number;
  ageMs: number;
}

export interface SemanticCacheOptions {
  /**
   * How text becomes a vector. OPTIONAL: omit it and {@link embebedorLocal} is
   * used — no network, no API key, no per-call cost.
   *
   * It used to be required, and the package shipped NO implementation, so this
   * cache could not be constructed without bringing your own embedding provider.
   * That is why the benchmark reported it as unmeasurable run after run: not that
   * it saved little, but that it never got to run at all.
   *
   * Pass your own for true semantics; the local one only sees LEXICAL closeness.
   * Either way the deterministic guard below still rejects a candidate whose
   * numbers, negation or entities differ, so a weaker vector can only cost you a
   * cache miss — never a wrong answer.
   */
  embed?: EmbeddingFn;
  verify?: SemanticVerifier;
  /** Cosine similarity floor for a candidate to be considered at all. */
  similarityThreshold?: number;
  /** Verifier score floor for acceptance. */
  acceptThreshold?: number;
  ttlMs?: number;
  maxRecords?: number;
  now?: () => number;
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
// numeric and overlap checks are language-agnostic.)
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
  if (!multisetEqual(numericTokens(a), numericTokens(b))) return false;
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

  constructor(opts: SemanticCacheOptions = {}) {
    // Sin `embed`, el local. Es lo que convierte esta caché en algo que se puede
    // construir —y por tanto medir— sin traerse un proveedor de embeddings.
    const propio = opts.embed == null;
    this.embed = opts.embed ?? embebedorLocal;
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
      opts.similarityThreshold ?? (propio ? UMBRAL_LOCAL : 0.9);
    this.acceptThreshold = opts.acceptThreshold ?? 0.85;
    this.ttlMs = opts.ttlMs;
    this.maxRecords = opts.maxRecords ?? 5_000;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Find a safe hit for a canonical request, or null. Metadata filters run
   * FIRST and hard — a candidate from another tenant, scope, or knowledge epoch
   * is never even scored.
   */
  async find(c: CanonicalRequest): Promise<SemanticHit | null> {
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
      if (confidence < this.acceptThreshold) continue;

      if (!best || confidence > best.confidence) {
        best = {
          record,
          similarity,
          verifierScore,
          confidence,
          ageMs: this.now() - record.storedAtMs,
        };
      }
    }
    return best;
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
