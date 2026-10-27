import { Pool } from "pg";

export const DATABASE_NOW_MS =
  "floor(extract(epoch from clock_timestamp()) * 1000)::bigint";
export const DEFAULT_QUERY_TIMEOUT_MS = 250;

export type PgQueryResultRow = Record<string, unknown>;

export interface PgQueryResult<R extends PgQueryResultRow> {
  rows: R[];
  rowCount: number | null;
}

export interface PgQueryRunner {
  query<R extends PgQueryResultRow = PgQueryResultRow>(
    queryText: string,
    values?: unknown[],
  ): Promise<PgQueryResult<R>>;
}

export interface PgPool extends PgQueryRunner {
  connect?(): Promise<PgPoolClient>;
  end(): Promise<void>;
}

export interface PgPoolClient extends PgQueryRunner {
  release(): void;
}

export interface PgPoolConfig {
  max?: number;
  min?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  query_timeout?: number;
  statement_timeout?: number;
  idle_in_transaction_session_timeout?: number;
  keepAlive?: boolean;
  ssl?: boolean | { rejectUnauthorized?: boolean };
}

export interface PgPersistenceOptions {
  pool?: PgPool;
  connectionString?: string;
  queryTimeoutMs?: number;
  poolConfig?: PgPoolConfig;
}

export function validateTtlMs(ttlMs: number): number {
  if (!Number.isSafeInteger(ttlMs)) {
    throw new TypeError("ttlMs must be a safe integer");
  }
  return ttlMs;
}

export function versionToken(value: string | number | bigint): string {
  const token = String(value);
  if (!/^\d+$/.test(token)) {
    throw new Error("PostgreSQL returned an invalid breakpoint version");
  }
  return BigInt(token).toString();
}

export function expectedVersionToken(value: string): string {
  if (!/^\d+$/.test(value)) {
    throw new TypeError("expectedVersion must be an unsigned bigint token");
  }
  return BigInt(value).toString();
}

export abstract class PgStore {
  protected readonly pool: PgPool;
  protected readonly queryTimeoutMs: number;
  private readonly ownsPool: boolean;
  private closePromise: Promise<void> | null = null;

  protected constructor(options: PgPersistenceOptions) {
    if ((options.pool == null) === (options.connectionString == null)) {
      throw new TypeError("Provide exactly one of pool or connectionString");
    }
    if (options.pool != null && options.poolConfig != null) {
      throw new TypeError("poolConfig is only valid with connectionString");
    }

    this.queryTimeoutMs = options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
    if (!Number.isFinite(this.queryTimeoutMs) || this.queryTimeoutMs <= 0) {
      throw new TypeError("queryTimeoutMs must be a positive finite number");
    }

    this.ownsPool = options.pool == null;
    this.pool = options.pool ?? new Pool({
      connectionTimeoutMillis: this.queryTimeoutMs,
      query_timeout: this.queryTimeoutMs,
      statement_timeout: this.queryTimeoutMs,
      idle_in_transaction_session_timeout: this.queryTimeoutMs,
      keepAlive: true,
      ...options.poolConfig,
      connectionString: options.connectionString,
    });
  }

  protected async query<R extends PgQueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<PgQueryResult<R>> {
    return this.withTimeout(this.pool.query<R>(text, values));
  }

  protected async transaction<T>(
    work: (client: PgPoolClient) => Promise<T>,
    options: { lockTimeoutMs?: number; efSearch?: number } = {},
  ): Promise<T> {
    if (!this.pool.connect) throw new TypeError("PgSemanticCache requires a pool with connect()");
    const pending = (async (): Promise<T> => {
      const client = await this.pool.connect!();
      try {
        await client.query("BEGIN");
        await client.query(
          `SELECT set_config('statement_timeout', $1, true),
                  set_config('lock_timeout', $2, true),
                  set_config('idle_in_transaction_session_timeout', $1, true),
                  set_config('hnsw.ef_search', $3, true)`,
          [
            String(this.queryTimeoutMs),
            String(options.lockTimeoutMs ?? 50),
            String(options.efSearch ?? 64),
          ],
        );
        const result = await work(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch { /* original error wins */ }
        throw error;
      } finally {
        client.release();
      }
    })();
    return this.withTimeout(pending);
  }

  private async withTimeout<T>(pending: Promise<T>): Promise<T> {
    void pending.catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`PostgreSQL operation timed out after ${this.queryTimeoutMs} ms`));
      }, this.queryTimeoutMs);
    });
    try {
      return await Promise.race([pending, timeout]);
    } finally {
      if (timer != null) clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    if (!this.ownsPool) return;
    this.closePromise ??= this.pool.end();
    await this.closePromise;
  }
}
