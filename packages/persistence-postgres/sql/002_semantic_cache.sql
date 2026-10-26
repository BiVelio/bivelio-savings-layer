CREATE EXTENSION IF NOT EXISTS vector;

CREATE SCHEMA IF NOT EXISTS bivelio_savings;

CREATE TABLE IF NOT EXISTS bivelio_savings.semantic_cache_records (
  namespace text NOT NULL,
  record_id text NOT NULL,
  seq bigint NOT NULL GENERATED ALWAYS AS IDENTITY,
  embedding vector NOT NULL,
  embedding_256 vector(256) NULL,
  embedding_dimensions integer NOT NULL CHECK (embedding_dimensions > 0),
  embedding_norm double precision NOT NULL CHECK (embedding_norm >= 0),
  query text NOT NULL,
  answer jsonb NOT NULL,
  tenant_id text NOT NULL,
  authorization_scope text NOT NULL,
  principal text NULL,
  knowledge_epoch text NOT NULL,
  contract_id text NULL,
  model text NOT NULL,
  system_prompt_hash text NOT NULL,
  structured_data_hash text NOT NULL,
  locale text NOT NULL,
  schema_version text NOT NULL,
  safety_policy_version text NOT NULL,
  toolset_hash text NOT NULL,
  tool_turns_hash text NULL,
  temperature double precision NULL,
  seed double precision NULL,
  reasoning_effort text NULL,
  stored_at_ms bigint NOT NULL,
  failed_at_score double precision NULL,
  PRIMARY KEY (namespace, record_id)
);

ALTER TABLE bivelio_savings.semantic_cache_records
  ADD COLUMN IF NOT EXISTS embedding_256 vector(256) NULL;

CREATE INDEX IF NOT EXISTS semantic_cache_records_namespace_seq_idx
  ON bivelio_savings.semantic_cache_records (namespace, seq);

CREATE INDEX IF NOT EXISTS semantic_cache_records_namespace_knowledge_epoch_idx
  ON bivelio_savings.semantic_cache_records (namespace, knowledge_epoch);

CREATE INDEX IF NOT EXISTS semantic_cache_records_namespace_tenant_id_idx
  ON bivelio_savings.semantic_cache_records (namespace, tenant_id);

CREATE INDEX IF NOT EXISTS semantic_cache_records_identity_idx
  ON bivelio_savings.semantic_cache_records
  (namespace, tenant_id, authorization_scope, principal, knowledge_epoch);

CREATE INDEX IF NOT EXISTS semantic_cache_records_embedding_256_hnsw_idx
  ON bivelio_savings.semantic_cache_records USING hnsw (embedding_256 vector_cosine_ops)
  WHERE embedding_dimensions = 256;

CREATE TABLE IF NOT EXISTS bivelio_savings.semantic_calibrations (
  namespace text PRIMARY KEY,
  revision bigint NOT NULL CHECK (revision >= 0),
  backend_identity text NOT NULL,
  state jsonb NOT NULL,
  updated_at_ms bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS bivelio_savings.semantic_calibration_observations (
  namespace text NOT NULL,
  observation_id text NOT NULL,
  segment text NOT NULL CHECK (segment IN ('single_shot', 'agentic')),
  record_id text NOT NULL,
  score double precision NOT NULL,
  correct boolean NOT NULL,
  payload_fingerprint text NOT NULL,
  created_at_ms bigint NOT NULL,
  PRIMARY KEY (namespace, observation_id)
);

CREATE INDEX IF NOT EXISTS semantic_calibration_observations_namespace_record_id_idx
  ON bivelio_savings.semantic_calibration_observations (namespace, record_id);
