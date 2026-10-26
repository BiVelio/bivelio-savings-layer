CREATE SCHEMA IF NOT EXISTS bivelio_savings;

CREATE TABLE IF NOT EXISTS bivelio_savings.constraint_value_hints (
  memory_key text PRIMARY KEY,
  created_at_ms bigint NOT NULL
);
