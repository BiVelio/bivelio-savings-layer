# Changelog

## 1.2.5 — 2026-11-22 — fixes from an end-to-end test of the 1.2.4 package, run like a new user

We installed the 1.2.4 tarball in clean projects and followed every README and guide
block literally, with no key and local stand-in providers. The free mode saved as
promised and nothing reached BiVelio without a key. What follows is what did not
match the docs. No saving lever changed: what is sent to the provider, the caches,
the trimming and the license checks behave exactly as in 1.2.4.

### Fixed

- **Python: wrapped clients no longer send gateway traffic through `HTTP_PROXY`.**
  The copy that `Gateway.wrap()` returns used the SDK's default HTTP client, which
  reads `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY`: traffic to the local gateway,
  provider API key and prompt included, went through the proxy in plain text, and
  behind a corporate proxy the call failed with 502. The copy now connects to the
  gateway directly (OpenAI and Anthropic, sync and async), keeping the client's
  timeout and the SDK's default limits. A client created with your own
  `http_client=` keeps it: set `NO_PROXY=127.0.0.1,localhost` before creating it.
- **Python: error messages give a command that works after `pip install`.**
  `GatewayUnavailable` and `GatewayMismatch` now say
  `npx @bivelio/savings-layer gateway` instead of `bvsala gateway`, which is not on
  the PATH of a pip user.
- **A provider that cuts a streamed answer is reported as the guide says.** The
  gateway log reads `→ 200 (stream) · not metered: the provider cut the answer
  before its final usage · detail: <transport error>`, and the local report carries
  the same reason. The client still sees the cut and can retry.
- **Coalesced duplicates no longer hide the call that was paid.** With
  `BVSALA_GATEWAY_COALESCE=1`, a report looked up by the provider's response id
  (`?response_id=`, which Python's `gw.report(resp)` uses) now returns the request
  that called the provider, with its real cost, instead of "call avoided" at $0.
  Each duplicate's own report is still available by its `x-bvsala-request-id`.
- **Placeholder service keys are rejected before any network call.**
  `BIVELIO_SERVICE_KEY='bvk_...'`, `bvk_xxx`, `bvk_<your key>`, `bvk_YOUR_KEY` and
  similar values get the "does not look like a service key" message and the free
  exit; nothing is sent to savings.bivelio.com.
- **Startup and exit texts of `bvsala gateway`.** The banner says COMMUNITY MODE
  once. `BVSALA_GATEWAY_COALESCE=1` prints a startup line, and
  `BVSALA_GATEWAY_SHADOW=1` without `BIVELIO_SERVICE_KEY` says it is ignored (also in
  `--help`). A malformed `BIVELIO_LICENSE_KEY` with no service key points to the free
  COMMUNITY exit instead of promising online collection. With
  `BVSALA_GATEWAY_ELISION=0` a $0 summary blames that switch, not the TTL rule.
  Amounts below one cent keep six decimals (`$0.000044`, not `$0.0000`).
- **`bvsala init` for the framework adapters** says identical requests in flight are
  shared unless that one is a stream, as the README does.
- **Python test suite passes with anthropic 2.x**, which sends the key as
  `Authorization: Bearer` instead of `x-api-key`.

### Documentation

- **The first README example runs when pasted on its own.** The TypeScript block
  under "Install anywhere, in 60 seconds" carries its own `import` line; before, it
  failed with `ReferenceError: OpenAICompatibleProvider is not defined`. The repo now
  compiles every README block that starts with an `import` on its own and runs the
  core ones from the packed tarball.
- **OpenAI-compatible upstreams keep their provider's path.** The gateway forwards
  the path your client sends to the provider's bare origin, so the base URL is the
  provider's own with `http://127.0.0.1:<port>` as host: `/v1` for openai, moonshot,
  minimax, ollama, vllm and lmstudio; no path for deepseek; `/compatible-mode/v1`
  for qwen; `/api/paas/v4` for glm; `/v1beta/openai` for gemini; `/api/v1` for
  openrouter. The README, `bvsala doctor`, the Cursor guide and docs/terminales say
  the same (one table, checked by a test). Cline is listed under the Anthropic
  gateway, as its guide says.
- **Simultaneous streamed requests.** A stream joins an identical `generate()`
  already in flight, but nothing joins a stream: identical requests started while a
  stream runs are each paid; a repeat after it finished is served from the exact
  cache. The Mastra adapter never shares a request in flight. The README now says
  so.
- **"About 0 %" on non-repeating traffic has one exception, now stated.** With no
  key, on Anthropic, a long system prompt that changes on every request (a
  timestamp, a user id) is marked for the prompt cache every time and costs about
  20 % more than no layer. Keep the system prompt identical and put what changes in
  the user message (then it saves), or pass `maxCacheBreakpoints: 0` to
  `AnthropicProvider`. `report.cost.netSavingsRatio` is documented as negative when
  the layer costs more.
- **Qwen Code: one settings key everywhere.** The guide, `bvsala doctor` and
  `bvsala qwen` say `security.auth.selectedType: "anthropic"` in
  `~/.qwen/settings.json` (or `--auth-type anthropic`), the key current Qwen Code
  reads, and that it needs `ANTHROPIC_MODEL`.
- **Droid, Codex, Gemini and DeepSeek guides.** The Droid `customModels` entry
  carries `model` and `displayName`, the same JSON `bvsala doctor` prints. The Codex
  block says a hand-started gateway needs `--upstream openai`. The Gemini line no
  longer shows a fixed port for `bvsala gemini`. The DeepSeek guide says its
  Anthropic endpoint reports no cache writes, so the TTL lever credits nothing there.
- **Python README on PyPI.** A paragraph that ran together now renders as a list,
  every Python block runs on its own, and the README and docstrings say what the
  gateway does with no key (it measures on your machine; a key adds the cloud).
  With `BVSALA_GATEWAY_COALESCE=1`, per-request reports need the raw response, the
  stream or the `x-bvsala-request-id`.
- **Smaller fixes.** A visible line under the first install command says npm needs
  `--legacy-peer-deps` on AI SDK 5, LangChain 0.3 or Mastra < 1.68. The
  `BVSALA_SEAT_ID` example is an `export`. NOTICE lists "cloud metering" (local
  metering is free). The `savings.semanticCache` type docs name
  `createSavingsLayer({ semanticCacheStore })` and no longer say a license is
  needed. The 1.2.4 entry now says `python -m bvsala status` prints `metering: on`
  against a gateway with no key.

## 1.2.4 — 2026-11-21 — the free Measure plan saves exactly like no key, paid plans trim Anthropic tool loops, honest texts

### Changed: what you will notice after upgrading

- **A Measure license now applies the levers.** Up to 1.2.3 the free Measure
  license ran the SDK and the gateway in shadow mode: every request went to the
  provider untouched and nothing was served from cache, so setting the free key
  saved less than setting none. From 1.2.4 a layer or a gateway with a Measure
  license does exactly what it does with no key: same calls, same request bodies,
  same savings in the report, trimming of superseded tool results included. If you run
  Measure today, your traffic starts being cached, deduplicated, trimmed and
  cache-marked as soon as you upgrade, and the usage sent to your dashboard carries
  real savings instead of `shadow` records. Measure usage is still never billed. To
  keep only watching, opt in on any plan: `observeOnly: true` in the SDK, or
  `BVSALA_GATEWAY_OBSERVE_ONLY=1` in the gateway.
  In observe-only mode `report.measure.wouldHaveSaved` is reported as before, and
  submitting a batch throws an `Error`, because a batch is itself a lever. Where a
  keyless lever costs more than not using the layer (a system prompt that changes
  on every request, for example: +21 % on Anthropic, as in 1.2.3 with no key), a
  Measure layer now does too; `observeOnly: true` keeps the 1.2.3 behaviour.
- **Pro, Team and Enterprise licenses trim superseded tool results inside an
  Anthropic tool loop.** Up to 1.2.3 a paid license did not trim them at all:
  trimming of superseded tool results (an old tool result is replaced by a stub
  when a newer call re-reads the same resource) asked for a feature that no issued
  license carried. With a live paid license (Pro, Team or Enterprise) the SDK now
  trims them with `AnthropicProvider` and the default cache placement, and only
  results from the tool loop in progress (after your last user message), which that
  placement never marks for caching (`elision` trace `partial` when it keeps an
  older one). With a paid license it stays off with `cacheBreakpoints: "auto"` and
  with any provider other than `AnthropicProvider` without `automaticCache` (Claude
  through an OpenAI-compatible endpoint such as OpenRouter or LiteLLM included), as
  in 1.2.3 (`elision` trace `skipped`). This is the only lever a paid license
  applies differently from no key in the SDK. The free Measure license has no such
  exception and trims exactly as with no key, so a Measure layer never costs more
  than a layer with no key. It is decided in the client, so it works with the
  license you already have. Opt out per request with
  `savings: { elision: false }`. An expired, revoked or invalid license still fails
  closed, as before.
- **In the gateway, a Measure license applies the levers; paid licenses work as in
  1.2.3.** With the free Measure license `bvsala` applies the same levers as with no
  keys: cache TTL tuning by default, and sibling model routing, per-turn effort and
  the context dials only with their own flags, whatever the entitlements endpoint
  answers. With a Pro, Team or Enterprise license nothing changes from 1.2.3: each
  lever also needs its feature in your organization's license, checked fail-closed,
  so with no service key, an unreachable entitlements endpoint, a 401 or a license
  without the feature, requests travel untouched. `BVSALA_GATEWAY_ELISION=0` still
  turns them all off, and a blocked, expired or revoked license still answers 402.
  The startup lines say "free Measure license: the same levers as no key" with
  Measure, and "ON if your organization's licence includes …; fail-closed" with a
  paid license, as in 1.2.3.
- **With no key and with Measure, trimming of superseded tool results works exactly
  as in 1.2.3.**
  Replacing an old tool result with a stub changes the middle of the history, so on
  a provider that caches the whole prompt by itself everything after it is billed
  again. Measured with a fake provider, cost against not using the layer, the same
  in 1.2.3 and 1.2.4 with no key: on a 60-step agent loop, gpt-5 +12.2 %, Gemini 2.5
  Flash +11.9 %, DeepSeek +166 % and Qwen +13 %; on Anthropic with
  `cacheBreakpoints: "auto"`, −71.5 % against −84.4 % with trimming off, with
  `AnthropicProvider({ automaticCache: true })`, −69.0 % against −85.2 %, and in a
  chat that re-reads the same tool output on every user turn (a 12-turn support chat
  on Sonnet 4.5), −30.1 % against −67.2 % with trimming off. Set
  `savings: { elision: false }` there. With a paid license it only acts inside a
  tool loop on Anthropic (see above): agent loops on Anthropic go from 0 % to
  −71.6 % with Pro, and every other load we measured trims nothing, as in 1.2.3
  with a paid key.
- **`bvsala` shows the money when it exits.** The exit summary of the terminal
  wrappers adds the spend at list price and the saving by basis (measured, by
  reference, estimated). When nothing was saved it says why: on a subscription no
  saving is credited, and otherwise which traffic cache TTL tuning is credited on.
  When the levers cost more than they saved, it says so and names the variable that
  turns them off.
- **The startup banner says which lever acts.** With no keys it no longer prints
  "every local saving lever on" above three levers that are OFF: it says that cache
  TTL tuning is the only gateway lever on by default, that it only acts on Anthropic
  API-key traffic asking for the 1-hour cache, that on a Claude or ChatGPT
  subscription the run only measures, and the variable for each opt-in lever.
  `--help`, `bvsala doctor` and `bvsala init` say what a BiVelio key adds: the
  cloud, with exactly the same levers as no key under the free Measure license; a
  paid license keeps the trimming exception above in the SDK, and in the gateway
  works as in 1.2.3. The manual Claude Code line that the gateway prints at startup
  and `bvsala doctor` now starts with `ENABLE_TOOL_SEARCH=true`, as the Claude Code
  guide says.
- **`bvsala init` describes what a framework adapter does.** For the Vercel AI SDK,
  Mastra, LangChain and Anthropic SDK stacks it no longer lists prompt-cache
  placement, trimming and compact serialization as on by default, or
  `observeOnly: true` as the way to only observe: the adapters never rewrite what
  your framework sends and have no observe-only mode. It says what they do: exact
  repeats, identical requests already in flight (not in Mastra) and the questions
  the layer computes locally.
- **`bvsala doctor` checks each terminal against its own route.** Gemini CLI, Cursor,
  Aider, DeepSeek and Ollama name the log line of their own protocol
  (`:generateContent`, `/v1/chat/completions`, …) instead of inheriting the
  `/v1/messages` check, and the report has no Spanish left in it.
- **Usage ingest answers 503 instead of accepting a batch blind.** When the cloud
  cannot read your organization's license during ingest, it retries once and then
  answers 503 without storing the batch. The SDK and the gateway re-queue a batch
  on any 5xx (up to 1,000 records per process; beyond that the oldest are dropped),
  so a short outage loses no usage; it arrives on the next flush.
- **Commission is billed only to organizations on a commission plan.** The monthly
  billing run now invoices commission only when the organization had a subscription
  on a commission-plan price in the billed period; Measure, Pro and Team are never
  billed a commission, and any other case is held for manual review instead of
  being invoiced.

### Fixed

- **LangChain.js with a model string such as `"openai:gpt-4o-mini"` saves.** That
  form (the one in the README and in `bvsala init`) goes through the OpenAI
  Responses API, whose message carries no `finish_reason` (`@langchain/openai`
  1.6) or reports it as `"completed"` (1.8). The adapter did not read it as a
  finished answer, so no answer was replayable: an exact repeat and two identical
  requests in flight each reached the provider twice. It now reads the Responses
  `status` (`completed` is a finished answer, or a tool call; `incomplete` because
  of `max_output_tokens` is a truncated one), and an answer that carries the
  provider's own tool outputs (web search, code interpreter) is never replayed. A
  `ChatOpenAI` instance on Chat Completions already worked. 1.2.3 had the same bug.
  Reasoning models on the Responses API (gpt-5, the o series) still reach the
  provider on every repeat, as in 1.2.3: their answer carries a reasoning item the
  adapter does not replay. With those models, pass a `ChatOpenAI` instance.
- **The Python client no longer says the gateway needs a key.** When no gateway
  answered, it said the gateway "needs BIVELIO_SERVICE_KEY"; it starts with no key,
  free, in COMMUNITY mode, and the message now says so. `python -m bvsala status`
  no longer adds `(no BIVELIO_SERVICE_KEY)`: a gateway with no key meters locally, so
  it prints `metering: on`.
- **A key that is set but wrong says how to keep running free.** When the gateway
  does not start because `BIVELIO_SERVICE_KEY` is malformed or not recognised, or
  `BIVELIO_LICENSE_KEY` does not verify, the message adds, after the fix, that
  unsetting both keys and relaunching runs the gateway free in COMMUNITY mode. A
  service key that is not plain ASCII (the `bvk_…` placeholder of an example) is
  reported as malformed instead of as a network error. A leftover message that said
  the gateway does not start without a subscription and a service key is gone.
- **Example blocks that are pasted whole start free.** The optional key lines in
  the README and in the terminal guides (`export BIVELIO_SERVICE_KEY=bvk_…`, its
  PowerShell form and `export BIVELIO_LICENSE_KEY=…`) are commented out and marked
  OPTIONAL; pasted as written, the placeholder became the key and the gateway
  exited with code 1.
- **With the free Measure license, a failed entitlements fetch or a deleted service
  key no longer says "savings features disabled".** With Measure the gateway's
  levers keep working in both cases, and the lines say what is actually lost (the
  organization status refresh, or the usage reporting to your dashboard). With a
  paid license the lines and the behaviour are those of 1.2.3: the savings features
  switch off (fail-closed) and traffic keeps flowing.
- **`bvsala` says what it is doing in observe-only mode.** With
  `BVSALA_GATEWAY_OBSERVE_ONLY=1` the startup banner prints one observe-only line
  instead of "cache TTL tuning is the only one ON by default", and the exit summary
  explains a $0.00 saving by that mode, not by the TTL rule. The banner names the
  variable that turns the context elision dials on, and `bvsala <unknown command>`
  says the command does not exist before printing the help (exit code 1, as before).
- **The tarball is readable by every user, whatever the packer's umask.** A `prepack`
  step adds read permission for everyone to the published files, so a tarball packed
  from a tree created with umask 077 no longer installs files only their owner can
  read. Releases built by CI were not affected.

### Documentation and license texts

- **README and PyPI page.** They list what is on by default (exact cache,
  deduplication, local resolvers, prompt-cache placement, trimming of superseded
  tool results, compact serialization of the structured data you pass) and what you
  switch on. "Shared caches" is gone from the paid column: BiVelio hosts no cache.
  A cache shared by several machines is a store you run, through the `exactCache`
  option (three methods, `get`, `set`, `delete`, over a key-value store such as
  Redis), free and with no key. The README says that the package ships no compressor
  (compaction of JSON tool outputs is opt-in and lossless) and that no compression
  figure is published. It says that with Claude Code out of the box the gateway
  measures and the default lever saves nothing, because that lever only acts when
  the client asks for the 1-hour cache. The −82.76 % figure is stated with the
  opt-in it needs (`savings.cachePrefix: true`) and with what it was measured
  against (the layer itself without that option, 20 requests per arm).
- **Terminal guides in English.** The per-terminal guides in `docs/terminales`
  (shipped in the package) are in English, with the real log lines.
- **`LICENSE-CLOUD.md` §1 and `NOTICE`.** §1 now says that under a Measure license
  the software applies exactly the same saving levers as with no key, and that
  Measure usage is never billed and never part of any commission; under a paid
  license, trimming of superseded tool results only acts inside a tool loop on
  Anthropic through `AnthropicProvider`. "Shared caches" is removed from the list of
  Cloud Services in both files.
- **`SECURITY.md`, Availability.** The gateway section says that with the free
  Measure license the levers do not depend on the entitlements fetch, and that with
  a paid license a failed fetch switches them off, as in 1.2.3.
- **What a key ties you to, and the conditions of the headline figures.** The README,
  the PyPI page, `init`, `doctor` and `--help` say that a key, the free Measure key
  included, makes the layer depend on savings.bivelio.com: with `licenseServerUrl`, 72
  hours with no answer fail closed with `LicenseError` until it answers or you remove
  the key; the gateway with a service key needs it to start. With no key there is no
  such dependency. The 31.50 % / 75.08 % figures now say their workload (built from
  GSM8K questions, 30 % exact repeats) and that about 41 points of the 75.08 % are
  Anthropic's cache pricing. `--help` and the terminal guide describe cache TTL tuning
  as the code runs it: only on turns where a large part of the request is new, never
  on chained turns. A license that is expired, revoked or missing now says, in the SDK
  and in the gateway, that removing the key keeps the layer running free. The
  terminal guide says when cache TTL tuning is armed: by default with no key and
  with Measure, and with a paid license only if that license includes it
  (fail-closed).

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
  under `withheldWritesNotCredited`. If you set `maxTools`, it keeps pruning read
  tools exactly as before, and outside an action request the write tools are sent
  on top of them, so a request can carry more than `maxTools` tools.
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

## 1.2.2 — the three READMEs tell the same story

### Changed

- **PyPI**: the Python client's README opens with the brand, the measured evidence
  (0→95 % −82.76 %; 31.50 %/75.08 %) and the Zenodo DOI, and points to the
  repository's canonical README (the one npm shows).
- **npm**: the tarball's README includes the fix to the pricing dropdown (the
  current model with no commission first; the commission marked as legacy).

No code changes: same surface as 1.2.1.

## 1.2.1 — README revised for the community, paper v2.3-r1 linked

### Changed

- **README**: a first read of ~135 lines (hero, measured evidence, pitch, install in
  60 s, paper, Community/Cloud table) and the full manual folded in `<details>`; the
  paper link points to **v2.3-r1** (externally reviewed), and the 1.2.0 levers
  (`cachePrefix` and `crossProviderShadow`) are documented.
- `.zenodo.json` with the deposit's metadata (ready for the GitHub→Zenodo
  integration).

No code changes: same surface as 1.2.0.

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
