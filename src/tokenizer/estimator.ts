/**
 * Token estimation.
 *
 * A production deployment should register a real tokenizer (tiktoken /
 * o200k_base, the provider's own tokenizer, etc.) via {@link TokenizerRegistry}.
 * BV-SALA never hard-codes savings; every format / compression decision is made
 * against the tokenizer of the *destination* model. This module ships a
 * dependency-free heuristic estimator so the layer works out of the box and so
 * tests are deterministic — but it is explicitly an *estimate*, and the whole
 * point of the registry is that you can swap in an exact counter.
 */

export interface TokenEstimator {
  /** Stable id, e.g. "o200k_base" or "heuristic". */
  readonly id: string;
  /**
   * ¿Cuenta este estimador con la MISMA regla que factura el proveedor?
   *
   * No es un detalle de calidad: decide si una cifra derivada puede llamarse
   * MEDIDA. El baseline de una llamada que se ejecutó se reconstruye como
   * "lo enviado (medido por el proveedor) + lo quitado (contado aquí)". Si lo
   * quitado se cuenta con otra regla, el resultado es una estimación aunque uno
   * de los dos sumandos venga del proveedor — y publicarlo como medido es
   * exactamente la clase de mentira que este producto existe para no contar.
   *
   * El heurístico vale para RANKEAR formatos candidatos (le basta con acertar el
   * orden). No vale para restar tokens entre formatos distintos: cobra cada
   * símbolo suelto como un token entero, así que infla el JSON denso en símbolos
   * mucho más que el the compact encoder, y la diferencia se acredita como ahorro inexistente.
   */
  readonly exact: boolean;
  /** Estimate the number of tokens in a string. */
  count(text: string): number;
}

/**
 * Heuristic estimator. Modern BPE tokenizers (cl100k/o200k) average roughly
 * ~3.7-4 characters per token on English/code, with whitespace, digits and
 * punctuation costing relatively more. This estimator approximates that by
 * combining a word-boundary pass with a character-based floor, which tracks
 * real tokenizers well enough to *rank* candidate encodings — which is all the
 * format selector needs. It is intentionally conservative and stable.
 */
export class HeuristicEstimator implements TokenEstimator {
  readonly id: string;
  /** Aproxima; no comparte regla con ningún proveedor. Ver {@link TokenEstimator.exact}. */
  readonly exact = false;

  constructor(id = "heuristic") {
    this.id = id;
  }

  count(text: string): number {
    if (text.length === 0) return 0;

    // Segment into word-like runs, digit runs, whitespace runs and symbols.
    const segments = text.match(/[A-Za-z]+|\d+|\s+|[^\sA-Za-z\d]/g) ?? [];
    let tokens = 0;

    for (const seg of segments) {
      const first = seg[0]!;
      if (/\s/.test(first)) {
        // Runs of whitespace: a single space usually merges into the next
        // token; newlines and long gaps cost more.
        const newlines = (seg.match(/\n/g) ?? []).length;
        tokens += newlines + Math.floor(Math.max(0, seg.length - 1) / 2);
      } else if (/[A-Za-z]/.test(first)) {
        // ~1 token per ~4 chars of a word, at least 1.
        tokens += Math.max(1, Math.ceil(seg.length / 4));
      } else if (/\d/.test(first)) {
        // Digits tokenize densely (often 1 token per 1-3 digits).
        tokens += Math.max(1, Math.ceil(seg.length / 2));
      } else {
        // Standalone symbol/punctuation.
        tokens += 1;
      }
    }

    // Floor: never below the coarse chars/4 approximation.
    return Math.max(tokens, Math.ceil(text.length / 4));
  }
}

export const heuristicEstimator = new HeuristicEstimator();
