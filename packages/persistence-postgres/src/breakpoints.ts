import {
  DATABASE_NOW_MS,
  PgStore,
  expectedVersionToken,
  validateTtlMs,
  versionToken,
  type PgPersistenceOptions,
  type PgQueryResultRow,
} from "./shared.js";

export interface VersionedBreakpointValue {
  value: unknown;
  version: string;
}

export interface CacheBreakpointStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: string, ttlMs: number): Promise<unknown>;
}

export interface VersionedCacheBreakpointStore extends CacheBreakpointStore {
  getVersioned(key: string): Promise<VersionedBreakpointValue | null>;
  compareAndSet(
    key: string,
    value: string,
    ttlMs: number,
    expectedVersion: string | null,
  ): Promise<boolean>;
}

interface BreakpointRow extends PgQueryResultRow {
  value: string;
  version: string | number | bigint;
}

export class PgCacheBreakpointStore
  extends PgStore
  implements VersionedCacheBreakpointStore
{
  constructor(options: PgPersistenceOptions) {
    super(options);
  }

  async get(key: string): Promise<string | null> {
    const result = await this.query<BreakpointRow>(
      `SELECT value, version
       FROM bivelio_savings.breakpoint_measurements
       WHERE cache_key = $1
         AND expires_at_ms >= ${DATABASE_NOW_MS}`,
      [key],
    );
    return result.rows[0]?.value ?? null;
  }

  async getVersioned(key: string): Promise<VersionedBreakpointValue | null> {
    const result = await this.query<BreakpointRow>(
      `SELECT value, version,
         expires_at_ms >= ${DATABASE_NOW_MS} AS live
       FROM bivelio_savings.breakpoint_measurements
       WHERE cache_key = $1`,
      [key],
    );
    const row = result.rows[0] as (BreakpointRow & { live: boolean }) | undefined;
    if (row == null) return null;
    return {
      value: row.live ? row.value : null,
      version: versionToken(row.version),
    };
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    const ttl = validateTtlMs(ttlMs);
    await this.query(
      `INSERT INTO bivelio_savings.breakpoint_measurements
         (cache_key, value, expires_at_ms, version)
       VALUES ($1, $2, ${DATABASE_NOW_MS} + $3::bigint, 1)
       ON CONFLICT (cache_key) DO UPDATE SET
         value = EXCLUDED.value,
         expires_at_ms = EXCLUDED.expires_at_ms,
         version = bivelio_savings.breakpoint_measurements.version + 1`,
      [key, value, ttl],
    );
  }

  async compareAndSet(
    key: string,
    value: string,
    ttlMs: number,
    expectedVersion: string | null,
  ): Promise<boolean> {
    const ttl = validateTtlMs(ttlMs);
    if (expectedVersion === null) {
      const result = await this.query(
        `INSERT INTO bivelio_savings.breakpoint_measurements
           (cache_key, value, expires_at_ms, version)
         VALUES ($1, $2, ${DATABASE_NOW_MS} + $3::bigint, 1)
         ON CONFLICT (cache_key) DO NOTHING
         RETURNING version`,
        [key, value, ttl],
      );
      return result.rows.length === 1;
    }

    const expected = expectedVersionToken(expectedVersion);
    const result = await this.query(
      `UPDATE bivelio_savings.breakpoint_measurements
       SET value = $2,
           expires_at_ms = ${DATABASE_NOW_MS} + $3::bigint,
           version = version + 1
       WHERE cache_key = $1
         AND version = $4::bigint
       RETURNING version`,
      [key, value, ttl, expected],
    );
    return result.rows.length === 1;
  }
}
