BEGIN;
SELECT pg_advisory_xact_lock(hashtext('bivelio_savings_migration'));

CREATE SCHEMA IF NOT EXISTS bivelio_savings;

CREATE TABLE IF NOT EXISTS bivelio_savings.constraint_value_hints (
  memory_key text PRIMARY KEY,
  created_at_ms bigint NOT NULL
);

COMMIT;
