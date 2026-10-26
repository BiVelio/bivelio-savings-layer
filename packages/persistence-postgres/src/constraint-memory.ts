import { DATABASE_NOW_MS, PgStore, type PgPersistenceOptions } from "./shared.js";

export interface ConstraintMemoryStore {
  has(key: string): Promise<boolean>;
  remember(key: string): Promise<void>;
}

export class PgConstraintMemoryStore extends PgStore implements ConstraintMemoryStore {
  constructor(options: PgPersistenceOptions) {
    super(options);
  }

  async has(key: string): Promise<boolean> {
    const result = await this.query(
      "SELECT 1 AS present FROM bivelio_savings.constraint_value_hints WHERE memory_key = $1",
      [key],
    );
    return result.rows.length === 1;
  }

  async remember(key: string): Promise<void> {
    await this.query(
      `INSERT INTO bivelio_savings.constraint_value_hints (memory_key, created_at_ms)
       VALUES ($1, ${DATABASE_NOW_MS})
       ON CONFLICT (memory_key) DO NOTHING`,
      [key],
    );
  }
}
