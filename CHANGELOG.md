# Changelog

## Unreleased — the open-core release (Community mode)

### Changed (breaking for the license contract)

- **Open core.** `createSavingsLayer({ provider })` without a `licenseKey` now
  runs on the COMMUNITY gate: every local saving lever on, zero telemetry, zero
  network. A license key that IS configured but invalid, expired or revoked
  still fails closed with `LicenseError`; only its absence stopped being an
  error.
- **Gateway starts with no keys.** `bvsala gateway` (and every `bvsala <agent>`
  wrapper) launches in COMMUNITY mode: local levers armed by default, local
  `/_bvsala` reports working, nothing sent to BiVelio. `BIVELIO_SERVICE_KEY`
  remains the (optional) door to the cloud dashboard, org entitlements and
  metering.

### Added

- **Gemini protocol in the gateway**: `:generateContent` and
  `:streamGenerateContent` (SSE with `alt=sse` and newline-delimited JSON) are
  metered from `usageMetadata` (implicit-cache discount, thinking tokens as
  output), plus the `bvsala gemini` wrapper (`GOOGLE_GEMINI_BASE_URL`).
- **Chinese providers and local servers as first-class upstreams**:
  `--upstream deepseek | qwen | glm | moonshot | minimax | openrouter | ollama |
  vllm | lmstudio`; DeepSeek rewrites Anthropic traffic to its `/anthropic`
  endpoint automatically.
- **Catalog**: list-price rows for deepseek-flash / deepseek-v4-pro (peak rates,
  the conservative side), qwen3.8 / qwen3.7 / qwen-flash / qwen-plus and
  glm-5.3 (+flash); cache-write premium is 1× for Chinese providers. Moonshot and
  MiniMax stay out until their official pages are verifiable.
- **Cursor recipe** (Settings → Models → OpenAI API Base URL, BYOK) and a
  **Claude Desktop MCP recipe** in `bvsala doctor`, plus new terminal guides
  (Gemini CLI, Cursor, DeepSeek, Ollama/vLLM/LM Studio).

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
