/**
 * Where the layer keeps what it learned about your prompt-cache reuse
 * (`cacheBreakpoints: "auto"`), when it must outlive a single instance.
 *
 * By default that measurement lives in the layer's memory, which is enough for
 * a long-running server. On serverless platforms, where an instance serves one
 * request or lives a few minutes, memory is gone before the measurement means
 * anything, so the layer never gets past its fixed placement. Pass a store
 * shared by your instances (Redis, a KV) and every instance reads and extends
 * the same measurement.
 *
 * What is stored, per traffic class (model, tools, output contract and system
 * header): prompt-prefix fingerprints, the times they were sent, reuse counts
 * and how many predicted cache reads the provider confirmed (with
 * `cacheMissDiagnostics`, also the provider's response ids). Never prompt text
 * or any other content. Values are opaque JSON strings, one key per traffic
 * class, rewritten after each request of that class. A client that hands them
 * back already parsed (as some Redis and KV clients do) works as well.
 *
 * The interface is deliberately minimal so any key-value store can back it.
 * The layer awaits `get` before placing breakpoints and `get` + `set` after the
 * provider answers, so a slow store adds its latency to those requests. A store
 * that fails is treated as empty for that request, and nothing is written
 * back: the placement falls back to what a fresh process would do.
 */
export interface CacheBreakpointStore {
  /** The value last `set` for `key` (the string, or the same JSON already parsed), or null/undefined when there is none. */
  get(key: string): Promise<unknown>;
  /** `ttlMs`: drop the value if no request of its traffic class rewrites it for this long. What it resolves to is ignored. */
  set(key: string, value: string, ttlMs: number): Promise<unknown>;
}

interface Entrada {
  valor: string;
  vence: number;
}

/**
 * In-memory {@link CacheBreakpointStore}, with TTL and a size bound. Useful for
 * tests and for several layers in one process; across processes, back the
 * interface with a shared store.
 */
export class InMemoryCacheBreakpointStore implements CacheBreakpointStore {
  private readonly entradas = new Map<string, Entrada>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts: { maxEntries?: number; now?: () => number } = {}) {
    this.maxEntries = Math.max(1, opts.maxEntries ?? 1024);
    this.now = opts.now ?? (() => Date.now());
  }

  async get(key: string): Promise<string | null> {
    const e = this.entradas.get(key);
    if (!e) return null;
    if (this.now() > e.vence) {
      this.entradas.delete(key);
      return null;
    }
    return e.valor;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    // Se reinserta al final: la primera clave del Map es la escrita hace más tiempo.
    this.entradas.delete(key);
    if (this.entradas.size >= this.maxEntries) {
      const vieja = this.entradas.keys().next().value;
      if (vieja !== undefined) this.entradas.delete(vieja);
    }
    this.entradas.set(key, { valor: value, vence: this.now() + ttlMs });
  }

  get size(): number {
    return this.entradas.size;
  }
}
