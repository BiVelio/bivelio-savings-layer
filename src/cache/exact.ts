/**
 * Exact cache.
 *
 * When the canonical key represents the request completely, a hit removes 100%
 * of input tokens, 100% of output tokens, and the whole provider call. This is
 * the single highest-value, lowest-risk saving in the layer. The interface is
 * deliberately minimal (get/set with TTL) so any store — Redis, a KV, an LRU —
 * can back it.
 */
export interface CachedAnswer<T = unknown> {
  text: string;
  data?: T;
  rendered?: string;
  /** Epoch ms when stored; used to compute age and honor TTL. */
  storedAtMs: number;
  /**
   * Optional metadata carried alongside the answer.
   *
   * `meta.reference` carries the provider counter of the call that produced this
   * answer, when that call ran untouched; readers that do not know it ignore it.
   */
  meta?: Record<string, unknown>;
}

export interface ExactCache {
  get<T = unknown>(key: string): Promise<CachedAnswer<T> | null>;
  set<T = unknown>(
    key: string,
    value: CachedAnswer<T>,
    ttlMs?: number,
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

interface Entry {
  value: CachedAnswer;
  expiresAtMs: number | null;
}

/**
 * In-memory exact cache with TTL and a size bound (LRU-ish by insertion order).
 * Suitable for tests and single-process deployments; swap for Redis in prod.
 */
export class InMemoryExactCache implements ExactCache {
  private readonly store = new Map<string, Entry>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts: { maxEntries?: number; now?: () => number } = {}) {
    this.maxEntries = opts.maxEntries ?? 10_000;
    this.now = opts.now ?? (() => Date.now());
  }

  async get<T = unknown>(key: string): Promise<CachedAnswer<T> | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs !== null && this.now() > entry.expiresAtMs) {
      this.store.delete(key);
      return null;
    }
    // Refresh recency.
    this.store.delete(key);
    this.store.set(key, entry);
    // COPIA, nunca la referencia: el llamante puede mutar lo que recibe (la
    // capa lo hace al reparar o al añadir metadatos) y, por referencia, esa
    // mutación corrompía la entrada para todo el proceso. Hallazgo «medio» de
    // la auditoría de agosto (CIERRE.md § 2.3), cerrado el 2026-09-13.
    return copiaDe(entry.value) as CachedAnswer<T>;
  }

  async set<T = unknown>(
    key: string,
    value: CachedAnswer<T>,
    ttlMs?: number,
  ): Promise<void> {
    if (this.store.size >= this.maxEntries && !this.store.has(key)) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, {
      // Copia también al guardar: lo que el llamante siga tocando después de
      // `set` no puede cambiar lo que la caché sirve.
      value: copiaDe(value) as CachedAnswer,
      expiresAtMs: ttlMs != null ? this.now() + ttlMs : null,
    });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  get size(): number {
    return this.store.size;
  }
}

/**
 * Copia profunda de una respuesta cacheada. `structuredClone` (Node ≥ 17)
 * cubre todo lo que una CachedAnswer lleva (texto, datos, usage, fechas); si
 * algún llamante colara algo no clonable (una función), se devuelve la
 * referencia antes que romper una lectura de caché.
 */
function copiaDe<T>(valor: T): T {
  try {
    return structuredClone(valor);
  } catch {
    return valor;
  }
}
