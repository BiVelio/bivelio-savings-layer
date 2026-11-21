# Per-terminal guides — measuring AI spend with the local gateway

**Date:** 2026-08-30 · **Source of truth:** `docs/PASARELA-S3-TERMINALES.md`
§3 (URL shapes and routing mechanisms verified against each terminal's code).
Every claim is marked **[V]** (verified in the source) or **[I]** (inferred). If
a guide contradicts that document, the document wins.

## What this is

`bvsala gateway` is a local metering proxy: it listens on `127.0.0.1`, forwards
every request to the provider (`https://api.anthropic.com` by default) —**byte
for byte**, except for the levers explained below (the rate lever is armed by
default)— and, once the response has been served, reads the `usage` from the
stream and turns it into cost. Neither your prompts, nor the responses, nor your
provider key are sent from your machine to BiVelio: only the usage of each
request travels —token counts, cost, the model id, a request id and the opaque
seat and session ids—, and the exact list of fields is in LICENSE-CLOUD.md §5.
**Open core**: it starts with no key at all, in Community mode —free, zero
telemetry, and the measurement stays on this machine: one log line per request,
the summary on exit and the local `/_bvsala` routes—.
Every gateway lever is free, with no key; one is on by default (cache TTL tuning) and the others you switch on.
`BIVELIO_SERVICE_KEY` (optional) only adds the cloud: the dashboard and license
collection. With the free Measure license it switches no lever off; with a paid
license the levers follow that license, as in 1.2.3 (checked fail-closed: with no
service key, or while savings.bivelio.com cannot confirm it, requests travel
untouched). One dependency comes with a key, the free Measure key included:
with BIVELIO_SERVICE_KEY set, the gateway needs savings.bivelio.com to start (or a
valid BIVELIO_LICENSE_KEY as a fallback); once running it keeps serving without it.
With no key there is no such dependency. A license that is PRESENT but expired or
revoked only refuses NEW requests with an HTTP 402 until it is renewed (or until you
unset the keys and relaunch, free in Community mode), never one in flight.
Metering is best-effort: with ingestion down, it forwards and warns.

It measures every request with the provider's own counter. The **default
lever** lowers the cache-write TTL from one hour to five minutes only on turns
where a large part of the prompt is new (at least 30 % of the request body: a
session's first turn, a compaction) and leaves chained turns as they are — it
changes the rate, never the content the model reads. It only has something to
lower when the client pays per token and asks for the one-hour cache: Claude Code on an API
key asks for the five-minute one unless you set `promptCacheTtl` to `1h`, so out
of the box the gateway only measures. The others (sibling model, per-turn
effort) stay off until you turn them on. And it measures **all the inference
traffic** the terminal routes through the base URL — not "all the traffic": each
guide says what its terminal sends around it.

On a subscription (claude.ai login in Claude Code, ChatGPT account in Codex)
there is no per-token invoice: that traffic is metered at list-price equivalent,
it is never credited any saving and nothing is charged on it, and the TTL lever
does not touch it (Claude Max/Pro: there is no write premium to save).

## Index

| Guide | Exact base URL | `/v1` | Routing [V] | Wrapper | Status |
|---|---|---|---|---|---|
| [Claude Code](claude-code.md) | `http://127.0.0.1:8402` | **without** | env `ANTHROPIC_BASE_URL` | `bvsala claude` ✅ | [V] in production |
| [Codex CLI](codex.md) | `http://127.0.0.1:8402/v1` (API key) · `…/backend-api/codex` (ChatGPT) | **with** | `codex -c openai_base_url=…` | `bvsala codex` ✅ | [V] validated by hand on 30 Aug (426 → HTTP fallback, stream intact) |
| [Goose](goose.md) | `http://127.0.0.1:8402` | **without** | env `ANTHROPIC_HOST` | `bvsala goose` ✅ | [V] |
| [Qwen Code](qwen-code.md) | `http://127.0.0.1:8402` | **without** | env `ANTHROPIC_BASE_URL` + `~/.qwen/settings.json` | `bvsala qwen` ✅ | [V] |
| [opencode](opencode.md) | `http://127.0.0.1:8402/v1` | **with** | env `OPENCODE_CONFIG_CONTENT` or `~/.config/opencode/opencode.json` | `bvsala opencode` ✅ (nothing written to disk) | [V] in code (v1.18.32) |
| [Kilo Code](kilo.md) (CLI and extensions) | `http://127.0.0.1:8402/v1` | **with** | env `KILO_CONFIG_CONTENT` or `~/.config/kilo/kilo.json` | `bvsala kilo` ✅ (CLI) | [V] in code (v7.8.1, a fork of opencode) |
| [Copilot CLI](copilot.md) (BYOK only) | anthropic: `http://127.0.0.1:8402` · openai: `…/v1` | anthropic **without**, openai **with** | env `COPILOT_PROVIDER_BASE_URL` | `bvsala copilot` ✅ (anthropic type) | [V] in the official docs; not validated by hand. openai type: by hand, not validated (WebSocket → 426) |
| [Copilot in VS Code](copilot.md#copilot-in-vs-code-byok-custom-endpoint) (BYOK only) | `http://127.0.0.1:8402/v1/messages` (full path) | full path | UI → Custom Endpoint (`chatLanguageModels.json`) | — | [V] in the official docs; not validated by hand |
| [Aider](aider.md) | Anthropic: `http://127.0.0.1:8402` · OpenAI: `…/v1` | Anthropic **without**, OpenAI **with** | env `ANTHROPIC_API_BASE` / `OPENAI_API_BASE` (litellm) | `bvsala aider` ✅ | [V] in code (litellm 1.82.3); OpenAI streams only with `BVSALA_GATEWAY_USAGE_INJECT=1` |
| [Continue](continue.md) (`cn` CLI and extensions) | `http://127.0.0.1:8402/v1` | **with** | `~/.continue/config.yaml` (`apiBase`) | — (user config) | [V] in code |
| [Crush](crush.md) | `http://127.0.0.1:8402/v1` | **with**, no trailing slash | `~/.config/crush/crushrc` | — (user config) | [V] |
| [Droid](droid.md) | `http://127.0.0.1:8402` | without **[I]** | `~/.factory/settings.json` | — (user config) | validate by hand |
| [Cline](cline.md) | `http://127.0.0.1:8402/v1` | **with** | UI | — | [V] |
| [Gemini CLI](gemini.md) | `http://127.0.0.1:8402` | n/a (Gemini protocol) | env `GOOGLE_GEMINI_BASE_URL` | `bvsala gemini` ✅ | [V] in a test (fake upstream): `:generateContent` and `:streamGenerateContent` |
| [Cursor](cursor.md) (BYOK) | `http://127.0.0.1:8402/v1` | **with** | UI → Settings → Models → OpenAI API Base URL | — (UI config) | [I]: only the traffic sent with YOUR key goes through the gateway |
| [Claude Code with DeepSeek](deepseek.md) | `http://127.0.0.1:8402` | **without** | env `ANTHROPIC_BASE_URL` | `bvsala gateway --upstream deepseek` | [V] in a test: `/v1/messages` → `/anthropic` |
| [Ollama / vLLM / LM Studio](ollama.md) (local) | `http://127.0.0.1:8402/v1` | **with** | the SDK's `base_url` | `bvsala gateway --upstream ollama|vllm|lmstudio` | [V] in a test; no list price → forwarded, not metered in dollars |
| [Python and any SDK](../../README.md#python-and-any-other-language-the-local-gateway) (OpenAI · Anthropic) | OpenAI: `http://127.0.0.1:8403/v1` · Anthropic: `http://127.0.0.1:8402` | OpenAI **with**, Anthropic **without** | the SDK's `base_url` | `bvsala gateway --upstream openai` | [V] in a test (fake upstream) |

Rules for the "Base URL" column: **never a trailing slash**, **never
redirects** (a 3xx on the base URL is a failure by the client's design, and the
gateway forwards it instead of following it). And never copy the URL from one
terminal to another: each SDK appends its own path segment and the error is
silent (§ "Checking that it meters").

Claude Code, Codex, Goose, Qwen Code, opencode, Kilo, Copilot CLI (BYOK), Aider
and Gemini CLI have their **own wrapper** (`bvsala
claude|codex|goose|qwen|opencode|kilo|copilot|aider|gemini`): it starts a gateway
on an ephemeral port, launches the terminal pointed at it and shuts it down on
exit. Zero persistent configuration: opencode and Kilo get theirs through a
variable (`OPENCODE_CONFIG_CONTENT`, `KILO_CONFIG_CONTENT`), merged with yours.
The manual recipe in each guide does exactly the same. For the rest,
`bvsala doctor` prints the exact block for each installed terminal.

**On exit, every wrapper says what it metered, what it cost and what it
saved.** Inside a wrapper the per-request log stays silent so that it does not
write over the TUI, so when it finishes it prints a line like these to stderr:

```
[bvsala claude] metering in this run: 16 inference request(s) went through the gateway · 16 request(s) metered with the provider's usage · spent $1.84 at list-price equivalent (subscription traffic: there is no per-token invoice) · saved $0.00: no saving is credited on a subscription (there is no per-token invoice); with the defaults the gateway changes nothing there. Per-request detail: run it again with BVSALA_GATEWAY_LOG=1 (one line per request, on stderr).
[bvsala copilot] metering in this run: 41 request(s) metered with the provider's usage · spent $0.9312 at list price · saved $0.0410 (measured) · 3 forwarded but NOT metered (nothing is estimated in their place): 3 × the request did not ask for usage (stream_options.include_usage). What each reason means and what to do: docs/terminales/README.md. Per-request detail: run it again with BVSALA_GATEWAY_LOG=1 (one line per request, on stderr).
```

The money is the sum of the same per-request reports your dashboard would
receive: `spent` is the provider's own usage at list price, and the saving is
shown by basis (`measured`, `by reference`, `estimated`), never added into one
figure. When nothing was credited the line says why: on a Claude or ChatGPT
subscription no saving is credited and, with the defaults, the gateway changes
nothing; on an API key the default lever (cache TTL tuning) is credited only
when the client asks for the one-hour cache from the official API. If
that lever cost more than it saved (a five-minute entry expired during a long
pause and was rewritten), the line says so too, with the variable that turns it
off. The figures above are made up.

The reasons are the ones in the `· not metered: …` table below. If no request
went through the gateway, it says that too: the terminal was not pointed at it.
`bvsala gateway` prints the same line when you stop it with Ctrl-C. It is local,
like the degraded-traffic warning: it is not sent to BiVelio.

## Common to every guide

### 1 · Install and start the gateway

```bash
npm i -g @bivelio/savings-layer      # brings the `bvsala` binary
bvsala gateway                        # listens on http://127.0.0.1:8402 — no keys: Community mode
bvsala gateway --port 8500            # another port if 8402 is taken
bvsala gateway --upstream deepseek    # Claude Code with DeepSeek; qwen|glm|moonshot|minimax|gemini|ollama|vllm|lmstudio too
# export BIVELIO_SERVICE_KEY=bvk_…      # OPTIONAL: only adds the cloud dashboard; uncomment it with your real key (without it: Community mode)
```

On startup it prints, among others, these lines:

```
[bvsala gateway] v1.2.x listening on http://127.0.0.1:8402 → https://api.anthropic.com
[bvsala gateway] COMMUNITY MODE (open core): no BiVelio keys set - free, zero telemetry, nothing sent to BiVelio
[bvsala gateway] metering: LOCAL ONLY (community mode, no BiVelio service key): every request is measured on this machine with the provider's usage and nothing is sent to BiVelio · per-request reports with x-bvsala-report
[bvsala gateway] savings levers (community mode: free, no key needed): cache TTL tuning is the only one ON by default and it only acts on Anthropic API-key traffic that asks for the 1-hour cache - on a Claude or ChatGPT subscription the default lever changes nothing and this run only measures · BVSALA_GATEWAY_ELISION=0 turns it off · opt-in: BVSALA_GATEWAY_SIBLING_MODEL=1, BVSALA_GATEWAY_EFFORT=low|medium · context elision dials OFF (BVSALA_GATEWAY_DIALES_ELISION=1 turns them on)
```

With `BIVELIO_SERVICE_KEY` the license is collected automatically (a `license:
PRO, active until …` line) and the last line reads `metering: ON`. If something
does not start (it exits with code 1), the message says exactly what is missing:

| Message | What is happening | Fix |
|---|---|---|
| `BIVELIO_SERVICE_KEY is not recognised` | the key was deleted, rotated or only half copied | create another one |
| `your organization has no active BiVelio license` | there is no subscription | subscribe in Account and start again, or unset the keys and relaunch, free |
| `your BiVelio license expired on …` | the license expired and its grace period is over | renew in Account, or unset the keys and relaunch, free |
| `could not collect your license from savings.bivelio.com` | savings.bivelio.com cannot be reached | check the connection; as a fallback, `BIVELIO_LICENSE_KEY` (verified offline and replaced by hand every period) |
| an HTTP 402 in the terminal in the middle of a session | the license expired or was revoked with the session open | renew, or unset the keys and relaunch, free; the requests already in flight were not cut |

If you run `bvsala gateway` as a service (launchd/systemd), a license failure
ends up in the service log with exit code 1 and the terminal only sees
"connection refused": look at that log.

A gateway talks to **one** upstream (`BVSALA_GATEWAY_UPSTREAM`, by default
`https://api.anthropic.com`). The terminals of the Anthropic dialect share an
instance; Codex needs its own against OpenAI — `bvsala codex` starts it by
itself with the right upstream for your auth mode (see its guide). With
`bvsala gateway --upstream openai|anthropic|<origin>` you choose it without an
environment variable (the flag wins over `BVSALA_GATEWAY_UPSTREAM`). For an
OpenAI SDK (Python, Node…) start one with `--upstream openai` on another port;
when streaming, the request has to carry `stream_options.include_usage` or the
gateway forwards it without metering it and says so in the log.

### 2 · Checking that it meters: the gateway log

For every inference call served and metered, the gateway writes a line with the
cost:

```
[gateway] POST /v1/messages  · <model> · $0.001234 (in 120, cache↑0 cache↓46792, out 8)
```

If you see that line with a `$`, the terminal is routed and metered. What the
other lines mean:

| Line in the log | What is happening | Fix |
|---|---|---|
| `[gateway] POST /v1/v1/messages → 404` | the base URL has one `/v1` **too many** for that terminal | remove the `/v1` |
| `[gateway] POST /messages → 404` | the base URL is **missing** `/v1` (the SDK only appends `/messages`) | add the `/v1` |
| `[gateway] POST /v1/messages → 402 (license expired)` | the license expired, was revoked or the org is blocked: NEW requests are refused (the ones in flight finished) | renew in Account, or unset the keys and relaunch, free; the terminal shows the reason |
| nothing at all | the terminal is not pointed at the gateway (config not read, env overridden by config, another port) | check the pitfall in its guide |

Every request the gateway forwards **without metering** leaves its own line with
`· not metered: <reason>`, and nothing is estimated in its place. The reasons,
exactly as they are printed today:

| `· not metered: …` | What is happening | Fix |
|---|---|---|
| `the provider cut the answer before its final usage` | the provider cut the answer halfway: the final counter never arrived. The gateway breaks the connection with the client (it does not close it as if it had ended well), so the terminal sees the cut and can retry | nothing; the terminal's retry is metered separately |
| `model "…" has no list price in the catalog` | a model outside the price catalog, on purpose: a price that is present and wrong is worse than none (the console warns once per model) | nothing; it is forwarded without metering |
| `could not read the model from the request body (content-encoding: …)` | the body could not be read: unreadable JSON or a compression this Node cannot open (zstd, the one Codex uses, needs Node ≥ 22.15) | upgrade Node |
| `the request did not ask for usage (stream_options.include_usage)` | streamed Chat Completions without `include_usage`: the provider sends no counter | add `stream_options={"include_usage": True}` to the call, or start with `BVSALA_GATEWAY_USAGE_INJECT=1` |
| `…; usage injection skips compressed request bodies` | injection is on, but it only adds the option to uncompressed bodies | ask for it in the call |
| `…, and the upstream rejects that option` | the upstream rejected `stream_options` and injection was switched off for the rest of the process | when streaming there is no fix from the gateway; with `stream: false` it is metered |
| `the stream ended without the provider's final usage event` | the stream was cut before it completed (`message_delta` and `message_stop` in Anthropic, `response.completed`/`incomplete`/`failed`, the usage chunk or `[DONE]`): without a counter and a terminal close there is no measurement | nothing |
| `the response ended as response.failed without usage` | the Responses API closed with `response.failed` and no `usage`. If it carries one, it is metered | nothing |
| `the response ended as response.incomplete without usage` | the Responses API closed with `response.incomplete` and no `usage`. If it carries one, it is metered: the provider bills a `response.incomplete` caused by `max_output_tokens` or by the content filter | nothing |
| `the response carried no usage` | a JSON response (`stream: false`) without `usage` | nothing |
| `the response was too large to read its usage` | a JSON response larger than 5 MB: the gateway does not keep it whole to read it | nothing |
| `the response is neither JSON nor an event stream (content-type: …)` | the upstream answered with another content type on a route the gateway does know how to meter | check the upstream |
| `no usage dialect for this route` | a route without a counter the gateway knows how to read (embeddings, images, audio…): it only meters `/v1/messages`, `…/chat/completions`, `…/responses` and the Gemini protocol (`:generateContent` / `:streamGenerateContent`) | nothing |

With `BVSALA_GATEWAY_COALESCE=1` (off by default), a read-inference request
(`messages`, `chat/completions`, `responses` or `embeddings`) identical to
another one still in flight does not travel: it receives the replica. Batches,
administration and unknown routes always run separately. The line carries
`· COALESCED (call avoided)`. It is followed by `· by reference: floor $… (cache
read price, …)` when it is valued with the counter of the request that did
travel —at the cache-read price, without premiums and with the output only if
the body carries `temperature: 0` and the model does not reason (the same model
guard as the SDK)—, or by `· estimated, not by reference: <reason>` when it is
not. That line is the local valuation: the dashboard still receives these
requests as `estimated`, and they do not enter the measured base, because the
gateway does not yet read the reasoning tokens the provider declares and the
`reference-v2` rule requires them.

| `· estimated, not by reference: …` | Why not |
|---|---|
| `no-primary-record` | the request that travelled left no final counter (neither a final stream event nor `usage` in the JSON) |
| `subscription` | subscription traffic (Claude or ChatGPT): there is no per-token invoice |
| `unofficial-upstream` | the gateway is not talking to a provider's official origin (a mock, a proxy, Azure, a reseller — Ollama/vLLM/LM Studio and OpenRouter included): the list price is on nobody's invoice |
| `layer-changed-request` | a lever changed what travelled (model, body, headers; the cache TTL reduction too): it is no longer the client's request byte for byte |
| `primary-failed` | the request that travelled closed with `response.failed` |
| `client-disconnected` | this request's client left before receiving the whole replica |
| `service-tier` | the `service_tier` asked for or served has no published per-token price (`scale`, a new one) |
| `no-cached-price` | the model has no cache-read price in its own catalog row |
| `no-credit` | the counter leaves nothing to credit |

Claude Code also sends a `HEAD /api/hello` before the first call: it is the
liveness probe, not an inference.

`bvsala doctor [--port N]`: it probes the PATH and the existence of the user
configs (it never reads their contents) and prints the exact block per terminal
with the given port. It only prints: it writes no configuration.

### 3 · Windows

`npm i -g @bivelio/savings-layer` and `bvsala claude` are identical on the three
systems. What changes is how the key is set in the session — the `export` in
these guides is POSIX; in PowerShell:

```powershell
# $env:BIVELIO_SERVICE_KEY = "bvk_…"  # OPTIONAL: only adds the cloud dashboard; uncomment it with your real key (without it: Community mode)
bvsala claude
```

(In `cmd`: `set BIVELIO_SERVICE_KEY=` followed by your real key, only if you want the cloud.) The `VAR=value command` prefix of
the manual recipes is POSIX too: on Windows, set the variable first and launch
afterwards.

And one hard condition: the terminal must be installed with its **native
installer** (a `claude.exe` / `codex.exe` on the PATH — Claude Code, Codex, Goose
and Qwen Code have one [V]). The `.cmd` shim that `npm i -g <terminal>` leaves
cannot be launched safely with arguments (CVE-2024-27980) and `bvsala` refuses
with a guide instead of failing with a mute ENOENT. opencode, Kilo and Copilot
CLI are also installed through npm: on Windows, use their native binary (GitHub
releases, winget or scoop) **[I: not validated on Windows]**. Aider is installed
with pip, which leaves an `aider.exe`.

### 4 · The BYOK rule, without exception

Every ring-2 recipe (Goose, Qwen Code, opencode, Kilo, Copilot, Aider, Crush,
Droid, Cline, Continue) is **API key only**. Anthropic forbids using the Claude
Pro/Max OAuth in third-party harnesses (opencode documents it; Crush removed its
OAuth in January 2026). The gateway would forward a subscription Bearer without
blinking — and that is neither promoted nor documented as a recipe.

### 5 · Honest wording

"Anthropic doesn't endorse, maintain, or audit third-party gateway products"
[V]. BV-SALA mode is a **supported configuration of the unmodified binary**:
say that, never "approved by Anthropic". The gateway contract is an open list of
headers and fields that grows with every release of the terminal; the
byte-for-byte passthrough is what keeps it alive without touching anything.

## What the gateway guarantees: it forwards what your client sends

A proxy in front of your provider can raise your bill without breaking anything
you can see: a lost cache marker, a dropped beta header, a block it does not
recognise. This gateway is built not to do that, and a test suite checks it
against a fake upstream on 127.0.0.1: `test/gateway-no-empeora.test.ts`, which
runs in our CI on every pull request and every push to `main`. The suite is in
the public repository, and this section lists exactly what it checks.

**With no lever armed, your provider receives what your client sent, byte for
byte:**

- **The request body**, including `tool_reference` blocks (from the provider's
  tool search and from a client-side search tool such as Claude Code's), tools
  with `defer_loading`, `cache_control` in every place the API reads it (top
  level, `system`, `tools`, and text, image, document, `tool_use` and
  `tool_result` blocks, including blocks nested inside a `tool_result` or inside
  a document's `source.content`), each with its `ttl: "1h"`, the advisor tool
  with its `advisor_tool_result` blocks, thinking signatures, and fields the
  gateway does not know. Not a JSON equivalent: the same bytes.
- **The path and query string** (`/v1/messages?beta=true`).
- **Every request header**, including every `anthropic-beta` value (the 1-hour
  cache TTL, the advisor, context management, OAuth, and betas that do not exist
  yet). Three kinds stay on the hop from your client to the gateway, as HTTP
  requires: hop-by-hop headers (RFC 7230 §6.1, plus `expect` and any header named
  in `Connection`), `host` and `content-length`. One more stays with the gateway
  because it is addressed to it: `x-bvsala-report`, with which a client asks for
  its per-request report (below).
- **The response**: the same bytes and headers, except the transport ones
  (`content-encoding`, `content-length`, `transfer-encoding`), because the
  gateway receives the body already decompressed. A request sent with
  `x-bvsala-report: 1` also gets one header added, `x-bvsala-request-id`; a
  request without it gets none.

**Per-request reports, in any language.** Send `x-bvsala-report: 1` with a
request and the gateway keeps the report it recorded for your dashboard for
that request, and answers with `x-bvsala-request-id`. Read it back from the
same gateway with `GET /_bvsala/v1/reports/<x-bvsala-request-id>` or
`GET /_bvsala/v1/reports?response_id=<the id of the provider's response>`;
add `wait_ms=<milliseconds>` (30,000 at most) to wait for a request still in
flight. The answer carries `status` (`metered`, `not_metered` with the same
`reason` as the log line, or `pending`) and, when metered, the `SavingsReport`
the gateway queued for your dashboard: nothing is computed for this answer.
`GET /_bvsala/v1/status` returns the gateway's version, upstream origin and
license state. These routes are answered by the gateway and never forwarded;
the gateway listens on 127.0.0.1 only, they send no CORS headers, they answer
403 to a `Host` other than 127.0.0.1 or localhost (so a web page cannot reach
them by rebinding its own name to 127.0.0.1), no route lists reports (you need
the id), and like every other route they answer 402 when a live license does not
serve (in COMMUNITY mode there is no license: they answer as usual). The gateway
keeps the last 1,000 reports for one hour at most, in memory; nothing is
written to disk and nothing more is sent to BiVelio.

"No lever armed" means any of: a license without that lever's feature,
`BVSALA_GATEWAY_ELISION=0`, or a lever you have not turned on (the sibling
model, per-turn effort, the context-editing dials and usage injection are off by
default). The suite checks each of these with the request exactly as Claude
Code sends it (compact JSON, which every armed lever would rewrite) and with a
hand-formatted one, and next to each it runs the same setup with the lever armed
and checks that the request does change, so a lever that stopped switching off
would fail it.

**With a lever armed, the only change is the one it declares:**

| Lever | Applies to | What changes | What does not |
|---|---|---|---|
| Cache TTL (`cache_ttl_tuning`, armed by default with no key and with Measure; with a paid license, only if the license includes it (fail-closed)) | `/v1/messages` requests billed per token where a large part of the prompt is new (session start, compaction); a chained turn travels untouched, and so does subscription traffic (Claude Max/Pro: no write premium to save, and a 5-minute entry would be rewritten after any pause) | every `cache_control` with `ttl: "1h"` becomes `"5m"`, the top-level one included (a 1-hour top-level marker behind 5-minute block markers would be a 400) | a key named `cache_control` inside a tool call's `input` or a tool's `input_schema` is content and stays as it is; so does the advisor's `caching`; headers are untouched |
| Per-turn effort (`BVSALA_GATEWAY_EFFORT=low` or `medium`) | `/v1/messages` for `claude-fable-5-1`, `claude-mythos-5-1`, `claude-opus-5-5` and `claude-opus-5`, when the level is below the model's default effort (`high`; `medium` on `claude-opus-5-5`) and the request carries no `output_config` of its own (top level or in a message); a level at or above the default leaves the request untouched | one message appended at the end of `messages`, `{"role":"system","content":[],"output_config":{"effort":…}}`, and `mid-conversation-output-config-2026-07-01` appended after your `anthropic-beta` value | your `anthropic-beta` value is kept verbatim in front; nothing earlier in `messages` moves |
| Sibling model (`BVSALA_GATEWAY_SIBLING_MODEL=1`) | `/v1/messages` and `/v1/messages/count_tokens` for `claude-fable-5`, except with a forced `tool_choice` or the 1M-context beta | `model` becomes `claude-fable-5-1` | headers are untouched |
| Context-editing dials (`BVSALA_GATEWAY_DIALES_ELISION=1`; measured as a net loss, off) | `/v1/messages` | your `clear_tool_uses_20250919` edit in `context_management` is replaced by ours | your other edits are kept, `clear_thinking_20251015` first; your `anthropic-beta` value is kept verbatim, with `context-management-2025-06-27` appended if it was not there |
| Usage in Chat Completions streams (`BVSALA_GATEWAY_USAGE_INJECT=1`, off) | streaming `…/chat/completions` requests without `stream_options` of their own | `"stream_options":{"include_usage":true},` inserted as text right after the opening `{` | the rest of the body, byte for byte (nothing is re-serialized); headers are untouched; a 400 or 422 gets your original request once more |

A lever that changes the body parses it and writes it back: your provider reads
the same JSON values, although whitespace and the way strings are escaped may
differ. When writing it back would change anything else (a number JavaScript
prints differently, such as `1.0`, `1e5`, `-0` or an integer beyond 2^53; an
object key that looks like an array index, which JavaScript moves to the front;
a key repeated in the same object; invalid UTF-8; a compressed body), no lever
is applied and the request travels byte for byte. If the provider answers 400 to
a request a lever changed, the gateway sends your original request once more,
unchanged, and meters that one.

**Degraded traffic.** The gateway also watches, with the provider's own usage
counters, for requests that come out worse than your client asked for:

| Log line: `[gateway] degraded traffic (session …) · …` | What it means |
|---|---|
| `prompt caching: … no cache read and no cache write` | the request marked `cache_control` at its end (top level or in the last message), the provider counted at least 4,096 input tokens (the largest minimum cacheable prompt in [Anthropic's prompt caching documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), checked on 2026-09-27) and reported neither a cache read nor a cache write |
| `cache TTL: … wrote the cache at the 5-minute TTL only` | every `cache_control` asked for `ttl: "1h"`, the TTL lever did not touch the request, and the provider wrote only 5-minute entries |
| `tool search: … tool search is off` | Claude Code traffic (a `x-claude-code-session-id` header or a `claude-cli/` user agent) sent at least 40 full tool definitions, none with `defer_loading` and no `tool_reference`. Claude Code turns tool search off by default behind any proxy, this gateway included: `bvsala claude` turns it back on in a new window, or export `ENABLE_TOOL_SEARCH=true` |

Each kind is logged once per session (Claude Code's session id; once per gateway
process for clients that send none) and every case is counted. `bvsala` prints
the totals when it exits, because the per-request log is silent inside `bvsala
claude|codex|goose|qwen` (unless `BVSALA_GATEWAY_LOG=1`). None of this is sent to BiVelio: the usage record has
no field for it (LICENSE-CLOUD.md §5), so it stays on your machine.

**Limits.**

- The guarantee covers what the gateway sends. It cannot make the provider
  cache: the watcher reports, it does not fix.
- The cache TTL lever changes the price of a cache write, never the content the
  model reads, and it is a trade: if a 5-minute entry expires before the next
  turn starts, that turn pays for a cache write that a 1-hour entry would have
  saved. The lever only acts where a large part of the prompt is being written
  anyway (session start, compaction), and `BVSALA_GATEWAY_ELISION=0` turns it
  off.
- On a request that declares server tools (web search, web fetch, code
  execution, tool search, the advisor, MCP servers; the gateway counts any typed
  tool other than a client tool such as bash or the text editor), the cache TTL
  lever still applies but its saving is recorded as zero. When Claude uses a
  server tool, the provider caches its result at the 5-minute TTL on its own,
  whatever TTL your markers ask for, and reports that write in the same
  `ephemeral_5m_input_tokens` counter
  ([Anthropic's documentation](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching#server-tool-results-are-cached-automatically),
  checked on 2026-09-27), so the invoice cannot tell which part the lever wrote.
- The two cache checks need the provider's usage: a request that is not metered
  is not checked. The prompt-caching check uses the largest documented minimum
  for every model, so a future model with a larger minimum would raise false
  alarms until the threshold moves.
- For the same reason, the TTL check skips requests that declare server tools.
- The tool-search check only looks at Claude Code traffic: another client with
  many tools may never have used tool search, and that is not degraded traffic.
- Header names arrive in lower case (HTTP header names are case-insensitive),
  and a header your client sends twice arrives once, with both values joined by
  a comma, in order.
