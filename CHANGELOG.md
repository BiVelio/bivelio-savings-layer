# Changelog

## 1.2.3 — 2026-11-21 — fixes from the pre-launch audit

### Changed: what you will notice after upgrading

- **`layer.generate({ tools })` sends every tool you declare,** write and
  destructive tools included, as the framework adapters and untyped catalogues
  already did. Until now a catalogue that declared `risk` lost its write tools on
  any request that did not contain one of 11 verbs ("Refund order 4411" was sent
  without `refund_order`). The gate is now opt-in:
  `new ToolSelector({ withholdWriteTools: true })`. A write or destructive tool left
  out by the selector is never credited as a saving: it does not count in
  `tokens.eliminatedInput` or in `cost.*`, and the `tool-selector` trace lists it
  under `withheldWritesNotCredited`.
- **The exact cache starts cold.** Its key generation moves from `n2` to `n3` (see
  the key fix below), so no entry written by an earlier version is read again:
  expect fewer exact hits for the first days. Old entries in Redis, KV or
  PostgreSQL stay until their TTL runs out.
- **The exact cache keeps capital letters.** The exact key and in-flight coalescing
  no longer merge questions that differ only in a capital that changes the meaning:
  `curl -O` and `curl -o`, `git branch -D` and `-d`, `5 MW` and `5 mW`, `3 Mb` and
  `3 MB`, `[A-Z]+` and `[a-z]+`, `Name` and `name`. Only the capital that opens a
  turn is still folded, along with accents, sentence punctuation and whitespace.
  Near-duplicates that differ in other capitals (ALL CAPS, a lower-cased proper
  noun) are now separate entries: expect fewer exact hits on those. An exact repeat
  always hits. The semantic cache (opt-in) is unchanged.
- **Requests that transform their own text are keyed verbatim.** When any turn,
  the system prompt included, asks to translate, rewrite, summarize, fix, convert,
  format or correct text, each turn enters the exact key as written, trimmed only at
  the ends: "Translate to French: I love Polish food" and "…polish food", or "Can you
  help me?" and "Can you help me!", never share a cached answer. The word list is
  wide on purpose; with one of those words in your system prompt, only exact
  repeats hit.
- **Empty answers and calls without a full usage counter are not cached.** They are
  served as before, but not written to the exact or semantic cache, so a repeat goes
  back to the provider. An endpoint that never reports usage therefore stops using
  the cache.
- **An HTTP 200 without an answer is an error.** A 2xx body that carries an error
  (`{"error": …}`, Anthropic's `{"type": "error"}`) or no completion (no
  `choices[0].message`, no `content`, no `finishReason`) makes `generate()` throw
  instead of returning empty text. Batch results are unchanged.
- **Models without a list price are `estimated`.** A model with no catalog row and
  none in `costModels` or `defaultCostModel` is still priced at the illustrative
  rate, but `cost.basis` is `"estimated"`, not `"measured"`, and a `price` trace
  carries `priceSource: "illustrative"`. Ids with `:` (`gpt-4o-mini:free`) and
  relatives whose suffix is not an alias of the same model (`gpt-4o-mini-tts`
  no longer takes `gpt-4o-mini`'s row) have no list price; dated,
  `-latest`, `-preview` and `-exp` ids keep their model's.
- **Random output and the current time are not served from cache.** A request
  whose user turns ask for random or freshly generated output (a random pick, a new
  UUID or password, a dice roll, a coin toss) or for the current time or date skips
  the exact and semantic cache. With `seed`, a random request is cacheable again; a
  time question never is. The phrases are in English and Spanish; a false positive
  costs one cache hit.
- **The arithmetic resolver answers only a bare question:** one user message, with
  no system prompt, no earlier turns, no tools and no structured data, phrased as a
  question with an operator. It declines dates, phone numbers, percentages, `2.500`,
  leading zeros, numbers a double cannot hold exactly, and results it cannot write
  exactly in nine decimals (`10 / 3`). A Mastra agent with `instructions` sends the
  question to the model. It also declines superscripts, subscripts, circled numbers
  and fraction characters: "What is 3² + 4²?" was answered locally as 74 and now goes
  to the model. The quickstart (`What is 2 + 2 * 3?` → `"8"`) is unchanged.

### Fixed

- **Exact-cache key.** Normalization no longer merges different code questions: text
  in backticks or code blocks is kept as written, a sign attached to what follows is
  an operator (`if (ok)` and `if (!ok)` are two questions), and quoted text keeps its
  case. It runs in linear time on adversarial input, and the tool selector's
  relevance folds backticks and case again.
- **`npm install` with current peers.** Installing next to `@anthropic-ai/sdk` 1.x
  or `gpt-tokenizer` 4 no longer fails with ERESOLVE: the optional peer ranges are
  now `>=0.103.0 <2` and `^3 || ^4`, and `bvsala init` picks the Anthropic SDK
  adapter for SDK 1.x. Projects on AI SDK 5, LangChain 0.3 or Mastra below 1.68
  still need `--legacy-peer-deps`; the README lists each adapter's minimum version.
- **Counting tokens with `gpt-tokenizer` is linear.** A long run of one kind of
  character (400 KB of spaces took 70 s) no longer blocks the process. Counts for
  text without such runs are unchanged; inside a run longer than 512 characters the
  count can be at most 2 tokens higher per 512 characters, never lower.
- **`content` as a list of parts.** OpenAI-compatible endpoints that return
  `content` as a list of parts (for example Mistral reasoning models), also when
  streaming, no longer fail with `TypeError: me.trim is not a function`: the answer
  is the text of the text parts.

### Gateway and `bvsala` CLI

- **Without a key the gateway meters locally.** In community mode every request is
  measured on this machine with the provider's usage: log line, exit summary and the
  local `/_bvsala` report routes. Only sending it to BiVelio needs
  `BIVELIO_SERVICE_KEY`. The exit summary counts the inference requests that went
  through, and `metering` in `/_bvsala/v1/status` is now always `true`. With
  `BVSALA_GATEWAY_USAGE_INJECT=1`, `include_usage` is injected without a key too.
- **Subscription traffic keeps its TTL.** The cache-write TTL lever (1h→5m) no
  longer touches Claude Max/Pro traffic: there is no write premium to save. Traffic
  billed per token is unchanged.
- **`bvsala claude` (and `qwen`, `goose`, `aider`) keeps the base URL you already
  had.** A pre-set `ANTHROPIC_BASE_URL` (`ANTHROPIC_HOST` for Goose,
  `OPENAI_BASE_URL` or `ANTHROPIC_API_BASE` for Aider) becomes the gateway's
  upstream, with a line that says so. One with a path prefix, or one that disagrees
  with `BVSALA_GATEWAY_UPSTREAM`, stops the wrapper with exit 1 and says why.
- **A provider cut mid-response reaches the client as a cut**, not as a complete
  body, and the request is counted as not metered with its reason.
- **The request path never changes the upstream host.** Repeated leading slashes
  are collapsed (a base URL ending in `/` works), an absolute-form target keeps only
  its path, and a target that would resolve to another origin, or is not a path
  (`OPTIONS *`), gets a 400 and is not forwarded.
- `--port=N` works like `--port N`; any other `--port…` form is an error.
- **`bvsala gateway` and `bvsala doctor` reject what they do not know.** An unknown
  or misspelled flag or a stray argument (`--upsteam`, `-p`, `--Port`) exits with 1,
  names the flag and suggests the closest one, instead of starting with defaults.
- `bvsala doctor` and the README no longer tie the levers to a PRO license: they run
  free, with no key. The same now holds for the gateway's startup lines,
  `bvsala --help` and the terminal guides: in community mode the levers are on and
  free, and the startup line names the full switch, `BVSALA_GATEWAY_ELISION=0`. Only
  with an organization license does that license's feature list apply.
- **Wrappers keep stdout clean.** `bvsala <terminal>` prints its banner, the
  terminal note and the per-request log on stderr, so
  `bvsala claude -p … --output-format json | jq` gets clean JSON. `bvsala gateway`
  on its own is unchanged.
- **Ctrl-C belongs to the agent.** Inside `bvsala aider`, `bvsala goose` or any
  wrapped agent that keeps running after Ctrl-C, the gateway stays up until the
  agent exits, then exits with the agent's code. SIGTERM is forwarded to the agent.
- **`bvsala gateway` always stops.** Open connections are cut 5 seconds after
  Ctrl-C, a stuck streaming response included, and a second Ctrl-C exits at once
  (code 130; 143 for SIGTERM).
- **`bvsala gemini`, `codex`, `opencode` and `kilo` keep the endpoint you already
  had** (`GOOGLE_GEMINI_BASE_URL`, `OPENAI_BASE_URL`, or a `baseURL` in the inline
  opencode/Kilo config), as `bvsala claude` already did: the gateway forwards
  there, or the wrapper stops with exit 1 and says why. For codex, opencode and
  Kilo the base URL must end in `/v1`.
- **Claude Code through `--upstream deepseek` is metered** and counted in the exit
  summary; before, every request was forwarded but reported as not metered.
- **`bvsala init` wires the cloud from the environment.** The code it prints or
  writes (and `examples/stacks`) has `licenseServerUrl` and `serviceAccountKey`
  enabled: with `BIVELIO_SERVICE_KEY` set, usage reaches the Savings Cloud dashboard
  and the license renews itself; with no keys, nothing is sent to BiVelio. The
  README's adapter snippets carry `licenseServerUrl` too.

### Python client

- `pyproject.toml` links the public repository, and the README's LICENSE link is an
  absolute GitHub URL (it was a 404 on pypi.org). From the extracted sdist, the
  parity tests are skipped with their reason instead of failing.

### Catalog

- List-price rows for `claude-fable-5-2` and `gemini-2.5-flash-lite` (list prices
  checked on 2026-11-19), so both are `measured` instead of `estimated`.
- List-price rows for `gpt-5.1`, `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6.2-sol`,
  `gpt-6.2-astra`, `gemini-4-carbon`, `gemini-4-argon`, `gemini-4-neon` and
  `gemini-4-hydrogen`, with their Flex and Batch rates and the 1 December 2026 price
  step of Gemini 4 Carbon and Argon. Their dollar figures no longer fall back to the
  illustrative price.
- Claude Sonnet 5.5 cache reads are priced at $0.10 per million tokens ($0.05 in
  batches), following Anthropic's 2026-10-07 price cut: measured spend on Sonnet 5.5
  requests with cache hits no longer overstates the bill.
- GPT-5.6 Sol Flex and Batch savings are credited through 30 November 2026, the end
  date OpenAI publishes for its promotional price. They used to stop on 21 November.

### Docs

- README and website: "install it and it saves" refers to the SDK. With a coding
  agent, the local gateway meters your spend on your machine, and its cache-write
  TTL lever saves only when the client pays per token and asks for the one-hour
  cache. Claude Code on an API key asks for five minutes unless `promptCacheTtl` is
  set to `1h`.
- The npm README fits under the registry's 64 KiB limit, so the package page no
  longer ends mid-sentence: the 14 optional sections moved word for word to
  `docs/guias/` and the README links each one; "Licensing & privacy" now follows the
  prices. The first screen says what the package is, how to install it, what is free
  and what the paid cloud adds.
- `docs/terminales` (in the tarball): the "not metered" reasons, the TTL lever's
  scope and what community mode meters are up to date.
- `SECURITY.md` and `docs/PUBLISHING.md` say what is true today: the repository is
  public, every version since 1.0.0 carries npm provenance, the SBOM is attached to
  every GitHub Release, and the package is open core.

### Website (savings.bivelio.com)

- /pricing and /privacy are shared as "BiVelio Savings Layer" in the page title and
  the social card, in all 12 languages.
- A card payment whose Stripe events arrive out of order within the same second no
  longer leaves the customer without an active plan: the webhook reads the
  subscription fresh from Stripe before saving it.
- A seat change on a yearly plan keeps the license expiry at the end of the paid
  period, also when Stripe sends the billing period in the format used before API
  version 2025-03-31.
- On the Team plan, the license and the dashboard count at least the seats included
  in the plan, even if the quantity is lowered in the billing portal.
- A sign-up confirmation link that was already used (often by an email security
  scanner) or has expired lands on the sign-in page in your language and says that
  a confirmed account can sign in with email and password.
- The dashboard's install snippet reads the keys from the environment, and its
  closing note no longer says that the layer refuses to run without a license: it
  refuses only a key that is set but invalid.

## 1.2.2 — los tres READMEs cuentan la misma historia

### Changed

- **PyPI**: el README del cliente Python abre con la marca, la evidencia medida
  (0→95 % −82,76 %; 31,50 %/75,08 %) y el DOI de Zenodo, y apunta al README
  canónico del repositorio (el que muestra npm).
- **npm**: el README del tarball incorpora el arreglo del desplegable de precios
  (el modelo vigente sin comisión primero; la comisión marcada como legado).

Sin cambios de código: misma superficie que 1.2.1.

## 1.2.1 — README revisado para la comunidad, paper v2.3-r1 enlazado

### Changed

- **README**: primera lectura de ~135 líneas (héroe, evidencia medida, pitch,
  instalación en 60 s, paper, tabla Community/Cloud) y el manual completo plegado
  en `<details>`; enlace del paper a la **v2.3-r1** (revisada externamente) y
  documentación de los levers 1.2.0 (`cachePrefix` y `crossProviderShadow`).
- `.zenodo.json` con los metadatos del depósito (listo para la integración
  GitHub→Zenodo).

Sin cambios de código: misma superficie que 1.2.0.

## 1.2.0 — cache-aware prompt management, cross-provider shadow, live evidence

### Added

- **Cacheable-prefix reorder** (`savings.cachePrefix: true`, opt-in): lines of the leading
  `system` prompt that carry per-request content (ISO/RFC 2822 timestamps, UUID v4, epoch
  ms/s) move to the end of the header, and only the stable part is declared as the cache
  prefix — the provider's prefix cache can hit where a mutable token used to force a full
  miss plus a paid write on every call. The `cache-prefix` trace reports what moved; the
  saving stays the provider's. **Live A/B** (claude-haiku-4-5): 0 % → 95 % hit-rate,
  −82.8 % per request, measured with the provider's cache counters.
- **Cross-provider shadow** (`savings.crossProviderShadow: true`, measure-only): what
  THIS request's measured usage would have cost on DeepSeek/Qwen/GLM at list prices,
  published as `report.crossProviderShadow` (`basis: "shadow"`). Nothing is routed or
  billed; the alternative's quality is what the cascade's gate certifies.
- **Live experiments of the preregistered roadmap** (`pnpm` via the `experimentos.yml`
  workflow): the ρ curve (14.7 % / 23.7 %), the dedup × cache_control factorial (85.9 %
  with attribution) and the cascade non-inferiority (67.9 %, no quality loss on a golden
  list). Evidence in `benchmarks/evidencia/*-2026-11-15.json`; paper §6.6–6.9.

## 1.1.1 — corrected packaging text

- The Python client's README and module docstring no longer say "Commercial
  software … paid to run": they state the Apache-2.0 open-core license, matching
  the package and the gateway it talks to.
- The npm README no longer says "the repository is private" (it is public) and
  links the paper as v2.2.

## 1.1.0 — savings levers reach the batch surface, cache audit, cascade 2026

### Added

- **Cache-break audit.** The layer detects per-request content (ISO/RFC 2822
  timestamps, UUID v4, epoch ms/s) in the cacheable `system` prefix and reports it
  as a `cache-audit` trace plus a one-per-process warning: the diagnosis of a
  prompt cache that never hits, without rewriting the caller's prompt.
- **Levers inside the batch.** `layer.batches.submit()` now runs the same pure,
  lossless request-body levers as `generate()`: elision by supersession
  (default-on, `savings.elision: false` opts out) and tool-output compaction
  (opt-in, same as `generate()`). A batch item's prompt byte-equals the prompt
  `generate()` sends for the same request and toggle.
- **Intra-batch dedup** (opt-in `submit(…, { deduplicate: true })`): requests whose
  final provider body is identical are sent once and replayed from the first
  result; the summary counts the money once, over the sent executions, and reports
  a `deduplicated` count.
- **Cascade 2026.** The default model-cascade table now covers the current
  frontier's same-family cheap siblings (`gpt-5/5.2/5.4 → *-mini`,
  `claude-opus-5/-5-5 → claude-haiku-4-5`); `claude-sonnet-5/-5-5` stay without a
  default pair on purpose (r = 0.50 exact leaves no quality margin).

## 1.0.0 — the open-core release (Community mode)

### License

- The npm package is now **Apache-2.0** (LICENSE); the optional cloud services
  keep their own terms in LICENSE-CLOUD.md (§5 fields, §6 fees) and a NOTICE
  covers trademarks and attribution.

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
