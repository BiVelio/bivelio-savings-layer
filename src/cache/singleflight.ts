/**
 * Singleflight (in-flight coalescing).
 *
 * When N equivalent requests arrive at once, exactly one executes the work and
 * the other N-1 await the same promise. This is NOT a historical cache — it is
 * de-duplication of concurrent work, so it carries no staleness risk and needs
 * no TTL. On traffic spikes it can eliminate a large fraction of duplicate
 * provider calls for free.
 */
export class Singleflight {
  private readonly inflight = new Map<string, Promise<unknown>>();

  /** How many callers are currently sharing an in-flight execution. */
  private readonly waiters = new Map<string, number>();

  /**
   * Run `fn` under `key`. If a call with the same key is already running, share
   * its result instead of starting a new one. Returns the shared result plus
   * whether this caller was a coalesced follower (a "hit").
   */
  async run<T>(
    key: string,
    fn: () => Promise<T>,
  ): Promise<{ value: T; coalesced: boolean }> {
    const existing = this.inflight.get(key) as Promise<T> | undefined;
    if (existing) {
      this.waiters.set(key, (this.waiters.get(key) ?? 1) + 1);
      const value = await existing;
      return { value, coalesced: true };
    }

    const promise = (async () => fn())();
    this.inflight.set(key, promise);
    this.waiters.set(key, 1);
    try {
      const value = await promise;
      return { value, coalesced: false };
    } finally {
      this.inflight.delete(key);
      this.waiters.delete(key);
    }
  }

  /**
   * The in-flight execution under `key`, if one is running, joined as a
   * follower; `undefined` when nothing is in flight. Never starts one.
   */
  join<T>(key: string): Promise<T> | undefined {
    const existing = this.inflight.get(key) as Promise<T> | undefined;
    if (existing) this.waiters.set(key, (this.waiters.get(key) ?? 1) + 1);
    return existing;
  }

  get activeKeys(): number {
    return this.inflight.size;
  }
}
