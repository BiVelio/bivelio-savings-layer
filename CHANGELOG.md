# Changelog

## 0.6.0-rc.1 — SDK release candidate

This prerelease adds opt-in, customer-operated persistence while preserving the
0.5 API compatibility baseline. Existing in-memory defaults remain in place. It
is not a final release or a live-SLA claim.

### Added

- `SemanticCacheStore`, shared `SemanticCalibrationJournal` and
  `SemanticCacheSafety` for interchangeable semantic-cache backends.
- `ConstraintMemoryStore` for durable value-constraint learning, with a local
  write-through `Set` and no provider-call retry on storage failure.
- Exact-cache and semantic-cache reference behavior, coordinated breakpoint
  learning and calibration across instances.
- `requestTimeoutMs` and `signal` in `generate` and `generateStream`, with
  `RequestTimeoutError` and no cache or learning writes for incomplete answers.
- Exact-tokenizer loading only for the encodings used by the requested or served
  model, avoiding unrelated cold-start work without changing token accounting.
- Anthropic history normalization that preserves empty assistant turns with an
  explicit `(empty)` text block instead of dropping their role.
- PostgreSQL integration coverage, including real concurrency and 100,000-record
  local benchmark evidence.

### Compatibility and requirements

- Node.js `>=20.19.0`.
- Existing 0.5 APIs remain available; this minor only adds reviewed APIs.
- `@bivelio/persistence-postgres` is a separate package. The core SDK has no new
  runtime dependency and does not require PostgreSQL.

## 0.1.0-rc.1 — PostgreSQL persistence release candidate

### Added

- `PgExactCache` with TTL, defensive copies and deletion.
- `PgCacheBreakpointStore` with versions and compare-and-set.
- `PgSemanticCache` with vector search, hard identity filters and transactional,
  idempotent calibration.
- `PgConstraintMemoryStore` with idempotent durable hints.
- Manual idempotent migrations:
  - `001_exact_and_breakpoints.sql`
  - `002_semantic_cache.sql`
  - `003_constraint_memory.sql`

### Requirements

- Node.js `>=20.19.0`.
- `@bivelio/savings-layer >=0.6.0-rc.1 <1`.
- `pg >=8.23.1 <9` as a required peer of this package only.
- The PostgreSQL vector extension for semantic caching.

### Isolation, failure behavior and rollback

- Durable keys are scoped by the relevant tenant, permissions, provider, model,
  contract or namespace. No production connection or migration runs automatically.
- Reads/writes have bounded timeouts. Storage errors do not create cache hits or
  repeat a provider call. Transaction clients are not released with work pending.
- Exact and semantic records can contain customer content and derived embeddings;
  constraint hints contain only a hash and timestamp.
- Rollback is opt-out: remove the injected stores. Migrations are additive and do
  not require destructive down migrations.

### Dependency hygiene

The lockfile and clean consumers are audited by `rc:verify`. This RC updates
Vitest and vulnerable direct/transitive packages, including Zod, Undici, Vite,
Tinypool, esbuild, Hono, langsmith, body-parser, nanoid, PostCSS and source-map-js.
`pg` types are no longer leaked into persistence declarations, and persistence
ships no sourcemaps.

### Verification scope

The RC includes local unit/integration, concurrency, migration, clean-consumer
and 100,000-record benchmark evidence. Production latency, backup/restore and a
customer canary remain separate release gates.
