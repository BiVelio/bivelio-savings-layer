CREATE SCHEMA IF NOT EXISTS bivelio_savings;

CREATE TABLE IF NOT EXISTS bivelio_savings.exact_cache_entries (
  cache_key text PRIMARY KEY,
  value jsonb NOT NULL,
  expires_at_ms bigint NULL
);

CREATE INDEX IF NOT EXISTS exact_cache_entries_expires_at_ms_idx
  ON bivelio_savings.exact_cache_entries (expires_at_ms)
  WHERE expires_at_ms IS NOT NULL;

CREATE TABLE IF NOT EXISTS bivelio_savings.breakpoint_measurements (
  cache_key text PRIMARY KEY,
  value text NOT NULL,
  expires_at_ms bigint NOT NULL,
  version bigint NOT NULL
);
