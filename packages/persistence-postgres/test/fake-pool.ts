import { vi } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import type { PgPool } from "../src/index.js";

export interface QueryCall {
  text: string;
  values: unknown[];
}

type Handler = (text: string, values: unknown[]) => Promise<QueryResult<QueryResultRow>>;

export class FakePool implements PgPool {
  readonly calls: QueryCall[] = [];
  readonly end = vi.fn(async () => undefined);

  constructor(private readonly handler: Handler) {}

  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    this.calls.push({ text, values });
    return this.handler(text, values) as Promise<QueryResult<R>>;
  }
}

export function rows<Row extends QueryResultRow>(
  values: Row[],
  rowCount = values.length,
): Promise<QueryResult<Row>> {
  return Promise.resolve({ rows: values, rowCount } as QueryResult<Row>);
}

export function compactSql(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
