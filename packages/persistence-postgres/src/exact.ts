import {
  DATABASE_NOW_MS,
  PgStore,
  validateTtlMs,
  type PgPersistenceOptions,
  type PgQueryResultRow,
} from "./shared.js";

export interface CachedAnswer<T = unknown> {
  text: string;
  data?: T;
  rendered?: string;
  storedAtMs: number;
  meta?: Record<string, unknown>;
}

export interface ExactCache {
  get<T = unknown>(key: string): Promise<CachedAnswer<T> | null>;
  set<T = unknown>(key: string, value: CachedAnswer<T>, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

interface ExactRow extends PgQueryResultRow {
  value: unknown;
}

export class PgExactCache extends PgStore implements ExactCache {
  constructor(options: PgPersistenceOptions) {
    super(options);
  }

  async get<T = unknown>(key: string): Promise<CachedAnswer<T> | null> {
    const result = await this.query<ExactRow>(
      `WITH deleted AS (
         DELETE FROM bivelio_savings.exact_cache_entries
         WHERE cache_key = $1
           AND expires_at_ms IS NOT NULL
           AND ${DATABASE_NOW_MS} > expires_at_ms
       )
       SELECT value
       FROM bivelio_savings.exact_cache_entries
       WHERE cache_key = $1
         AND (expires_at_ms IS NULL OR expires_at_ms >= ${DATABASE_NOW_MS})`,
      [key],
    );
    const row = result.rows[0];
    if (row == null) return null;
    return deserializeCachedAnswer<T>(row.value);
  }

  async set<T = unknown>(
    key: string,
    value: CachedAnswer<T>,
    ttlMs?: number,
  ): Promise<void> {
    const serialized = serializeCachedAnswer(value);
    const ttl = ttlMs == null ? null : validateTtlMs(ttlMs);
    await this.query(
      `INSERT INTO bivelio_savings.exact_cache_entries
         (cache_key, value, expires_at_ms)
       VALUES (
         $1,
         $2::jsonb,
         CASE WHEN $3::bigint IS NULL
           THEN NULL
           ELSE ${DATABASE_NOW_MS} + $3::bigint
         END
       )
       ON CONFLICT (cache_key) DO UPDATE SET
         value = EXCLUDED.value,
         expires_at_ms = EXCLUDED.expires_at_ms`,
      [key, serialized, ttl],
    );
  }

  async delete(key: string): Promise<void> {
    await this.query(
      "DELETE FROM bivelio_savings.exact_cache_entries WHERE cache_key = $1",
      [key],
    );
  }

  async purgeExpired(): Promise<number> {
    const result = await this.query(
      `DELETE FROM bivelio_savings.exact_cache_entries
       WHERE expires_at_ms IS NOT NULL
         AND ${DATABASE_NOW_MS} > expires_at_ms`,
    );
    return result.rowCount ?? 0;
  }
}

export function serializeCachedAnswer<T>(value: CachedAnswer<T>): string {
  assertCachedAnswer(value);
  assertJsonCompatible(value, new Set());
  return JSON.stringify(value);
}

export function deserializeCachedAnswer<T>(value: unknown, clone = true): CachedAnswer<T> {
  assertCachedAnswer(value);
  assertJsonCompatible(value, new Set());
  return (clone ? JSON.parse(JSON.stringify(value)) : value) as CachedAnswer<T>;
}

function assertCachedAnswer(value: unknown): asserts value is CachedAnswer {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("CachedAnswer must be an object");
  }
  const candidate = value as Partial<CachedAnswer>;
  if (typeof candidate.text !== "string" || !Number.isFinite(candidate.storedAtMs)) {
    throw new TypeError("CachedAnswer requires text and a finite storedAtMs");
  }
  if (candidate.rendered !== undefined && typeof candidate.rendered !== "string") {
    throw new TypeError("CachedAnswer.rendered must be a string");
  }
}

function assertJsonCompatible(value: unknown, ancestors: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("CachedAnswer numbers must be finite");
    return;
  }
  if (typeof value !== "object") {
    throw new TypeError(`CachedAnswer contains a non-JSON ${typeof value} value`);
  }
  if (ancestors.has(value)) throw new TypeError("CachedAnswer contains a cycle");

  const prototype: unknown = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("CachedAnswer must contain only plain JSON objects and arrays");
  }

  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonCompatible(item, ancestors);
  } else {
    for (const item of Object.values(value)) assertJsonCompatible(item, ancestors);
  }
  ancestors.delete(value);
}
