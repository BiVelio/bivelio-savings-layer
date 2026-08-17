/**
 * A LOCAL EMBEDDING FUNCTION — no network, no API key, no per-call cost.
 *
 * The semantic cache needs a way to compare meaning. Wiring it to a hosted
 * embedding endpoint is the obvious answer and a bad default: it makes every
 * miss cost a network round-trip and money, and it forces a provider choice onto
 * a customer who never asked for one. So the cache shipped with no embedder at
 * all, which means it never matched anything.
 *
 * This is the third option: a deterministic bag-of-features vector computed in
 * microseconds from the text itself. It captures LEXICAL closeness — the same
 * question asked with different filler words — which is the overwhelming majority
 * of real repeat traffic. It does NOT capture deep semantics: "what is a CDN"
 * and "explain content delivery networks" share no tokens and will not match.
 *
 * WHY THAT IS SAFE, AND THIS IS THE PART THAT MATTERS. A semantic cache's one
 * unforgivable failure is confidently answering a NEARBY BUT DIFFERENT question.
 * This vector never gets the chance: the cache runs a deterministic precision
 * guard beneath the embedding — matching numbers and dates, negation parity and a
 * content-overlap floor — and every isolation field (tenant, principal, model,
 * schema, attached data) is a hard filter applied before similarity is scored.
 * A weak embedding can only cause a MISS, which costs one real call. It cannot
 * produce a wrong answer.
 *
 * Pass your own `embed` to {@link InMemorySemanticCache} to get true semantics.
 * This one exists so that the feature is worth something with zero setup.
 */

/** Vector width. Small on purpose: cosine over 256 dims is a few microseconds,
 *  and collisions are absorbed by the precision guard that runs underneath. */
const DIMENSIONES = 256;

/** FNV-1a, 32-bit. Deterministic across runtimes — the same text must produce
 *  the same vector on every machine, or a cache written by one process is
 *  invisible to the next. */
function hash(texto: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < texto.length; i++) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** Lowercase, strip punctuation, split. Unicode-aware so accented and
 *  non-Latin text tokenizes instead of collapsing into one blob. */
function tokenizar(texto: string): string[] {
  return texto
    .toLowerCase()
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * The vector for a piece of text.
 *
 * Features are unigrams plus adjacent bigrams: bigrams are what keep word ORDER
 * from being free. Without them "does A cause B" and "does B cause A" are the
 * same point in space.
 *
 * Term weight is sublinear (`1 + log tf`) so a word repeated forty times does not
 * dominate the direction of the vector, and the result is L2-normalised so cosine
 * similarity is a plain dot product.
 */
export function vectorLocal(texto: string): number[] {
  const v = new Array<number>(DIMENSIONES).fill(0);
  const tokens = tokenizar(texto);
  if (tokens.length === 0) return v;

  const cuenta = new Map<string, number>();
  for (let i = 0; i < tokens.length; i++) {
    const uni = tokens[i]!;
    cuenta.set(uni, (cuenta.get(uni) ?? 0) + 1);
    if (i + 1 < tokens.length) {
      // Separador `\0`: un carácter que no puede salir de `tokenizar` (que
      // parte por todo lo que no es letra ni número), así que "ab cd" y "abc d"
      // no pueden colisionar en el mismo rasgo. Va ESCAPADO y no como byte
      // crudo: un NUL literal en el fuente vuelve el fichero binario para grep,
      // diff y revisión de código.
      const bi = `${uni}\0${tokens[i + 1]!}`;
      cuenta.set(bi, (cuenta.get(bi) ?? 0) + 1);
    }
  }

  for (const [rasgo, tf] of cuenta) {
    const h = hash(rasgo);
    const indice = h % DIMENSIONES;
    // The sign bit spreads features across the dimension instead of piling every
    // collision onto the same side, which would make unrelated texts drift together.
    const signo = (h >>> 31) === 1 ? -1 : 1;
    v[indice]! += signo * (1 + Math.log(tf));
  }

  let norma = 0;
  for (const x of v) norma += x * x;
  norma = Math.sqrt(norma);
  if (norma === 0) return v;
  for (let i = 0; i < v.length; i++) v[i]! /= norma;
  return v;
}

/**
 * The default embedding function for {@link InMemorySemanticCache}.
 *
 * Synchronous by design — it returns the array, not a promise — so a cache lookup
 * adds no await and no latency to the request path.
 */
export function embebedorLocal(texto: string): number[] {
  return vectorLocal(texto);
}

/**
 * The similarity floor this embedder is calibrated for.
 *
 * A lexical vector sits lower than a sentence-transformer on genuine paraphrases,
 * so the 0.9 default that suits a hosted embedder would reject almost everything
 * here. This value was measured on paraphrase pairs against near-miss pairs, not
 * guessed — see `test/embebedor-local.test.ts`, which fails if the two
 * populations stop being separable.
 */
export const UMBRAL_LOCAL = 0.72;
