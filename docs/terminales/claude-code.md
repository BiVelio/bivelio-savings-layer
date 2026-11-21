# Claude Code through the gateway

Conformance with Claude Code's official gateway protocol, read in full on
2026-08-30. It is the reference
terminal: the passthrough meets 10 of the protocol's 12 requirements by
construction, with a test.

## What you need

- `claude` on the PATH.
- **An Anthropic API key** (`ANTHROPIC_API_KEY`, or `ANTHROPIC_AUTH_TOKEN` /
  `apiKeyHelper`): this is the case where there is a per-token invoice. By
  default the gateway **measures** there: its TTL reduction only saves if Claude
  Code asks for the one-hour cache, and on an API key it asks for the
  five-minute one unless you set `promptCacheTtl` to `1h` in its configuration.
  With a claude.ai login the routing works too — the official docs sanction it:
  the login is still the active credential and "its usage limits and billing
  apply" [V] — but there is no per-token invoice there: the gateway meters it at
  list-price equivalent and never credits it any saving.
- `bvsala` installed. Open core: with no keys the gateway starts in Community mode (free, zero telemetry: it measures every request, and one lever is on by default, cache TTL tuning); `BIVELIO_SERVICE_KEY` only adds the cloud dashboard (see [README](README.md)).

## Wrapper: `bvsala claude` (recommended)

```bash
# export BIVELIO_SERVICE_KEY=bvk_…  # OPTIONAL: only adds the cloud dashboard; uncomment it with your real key (without it: Community mode)
bvsala claude                    # every argument is passed as is: bvsala claude -p "hello"
```

It starts the gateway on an **ephemeral port**, launches `claude` with
`ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` in its environment, inherits your
whole terminal (the TUI works as is) and shuts the gateway down when `claude`
exits. It writes no configuration. It does not touch credentials: `Authorization`
/ `x-api-key` are forwarded whole.

## Manual: `ANTHROPIC_BASE_URL`

If you prefer a shared gateway on a fixed port (for several terminals at once,
for example):

```bash
bvsala gateway                                       # window 1: http://127.0.0.1:8402
ENABLE_TOOL_SEARCH=true ANTHROPIC_BASE_URL=http://127.0.0.1:8402 claude   # window 2 — NO /v1
```

Claude Code appends `/v1/messages` on its own. No trailing slash.

**`ENABLE_TOOL_SEARCH=true` is not optional.** When it sees an
`ANTHROPIC_BASE_URL` that is not the official one, Claude Code turns tool search
off by default and puts ALL the definitions (the ones from your MCP servers
included) in the cached prefix of every request. Measured on 2026-09-09 on a
setup with 226 MCP tools: 450 KB per request, 66 % of the bytes and 25 % of the
day's bill. The gateway forwards the beta and the `tool_reference` blocks
intact, so the search works through it. `bvsala claude` turns it on by itself;
if you already have the variable set (`false`, `auto`, `auto:N`), your value is
respected.

## Checking that it works

**With `bvsala claude` (the wrapper), the check is the summary it prints on
exit** (and your dashboard, if you set `BIVELIO_SERVICE_KEY`): the per-request
log is silent by default — printing it wrote over Claude Code's TUI (the words
landed on top of the dialogs). The summary says how many requests it metered,
what they cost at list price and what the levers saved; with a claude.ai login,
or on an API key with the five-minute cache, that is $0.00 and the line says
why. For one line per request, `BVSALA_GATEWAY_LOG=1 bvsala claude`.

With a plain `bvsala gateway` (two terminals), the log is the check, in this
order:

```
[gateway] HEAD /api/hello → 200
[gateway] POST /v1/messages  · <model> · $0.001234 (in 120, cache↑49268 (1h 49268) cache↓43430, out 8)
```

The `HEAD /api/hello` is the liveness probe Claude Code sends before the first
call. The line with a `$` is the metered inference. `cache↑` is everything the
provider wrote to the cache in that request, and the `(1h …)` part, which only
appears when it is not zero, is how much of it was written at the one-hour TTL.
You will see it when Claude Code asks for the one-hour cache: with a claude.ai
login, or on an API key with `promptCacheTtl` set to `1h`. On an API key with
the default configuration Claude Code asks for the five-minute cache, the line
carries `cache↑` alone and the TTL lever has nothing to lower. When the client
does ask for one hour on an API key, the lever lowers the write to five minutes
only where a large part of the prompt is being written anyway (session start,
compaction); a chained turn travels untouched.

## Model discovery (optional, API key only)

```bash
CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1 bvsala claude
```

With the flag, Claude Code asks the gateway for `GET /v1/models?limit=1000`
(3 s timeout, credential in `Authorization` **and** `x-api-key`) and filters ids
that contain "claude"/"anthropic" [V]. The passthrough serves it by construction
(api.anthropic.com answers `{data:[{id,display_name}]}`) and "From gateway"
should appear in `/model`.

Honesty about its status: the passthrough of `GET /v1/models` **has a test** (it
passes whole and is not billed); the validation by hand with an API key is
pending (S3 §1.2). And the only credential sources for discovery are
`ANTHROPIC_AUTH_TOKEN`/`apiKeyHelper` and `ANTHROPIC_API_KEY`: a claude.ai login
is **not** a source, so on a pure subscription the client writes
`[gatewayDiscovery] skipped` and does not even ask.

## The typical pitfall

1. **`/v1` in the base URL.** `ANTHROPIC_BASE_URL=http://127.0.0.1:8402/v1` gives
   `[gateway] POST /v1/v1/messages → 404` and Claude Code reports a generic
   error. No `/v1`.
2. **The 300 s watchdog.** On connections through `ANTHROPIC_BASE_URL` Claude
   Code cuts a stream with no bytes for 300 s (the only value the official docs
   document today). On the normal path the gateway does not buffer and forwards
   the pings as bytes, so it does not trip. Only under
   `BVSALA_GATEWAY_COALESCE=1` (off by default) does a twin request wait for the
   primary to finish, and a primary longer than 300 s would kill it — this is
   identified in S3 §1.1 and it is not turned on by default until it is fixed.
3. **Redirects.** Any 3xx on the base URL is a discovery failure by the client's
   design; the gateway forwards the 3xx instead of following it with your
   credential (`redirect: "manual"`, verified).

## What does NOT go through the gateway (an honest warning)

The measurement promise is "all the **inference** traffic", not "all the
traffic": **fast mode and WebFetch's safety check go straight to
api.anthropic.com by the client's design** [V]. That spend does not appear on
your dashboard and cannot be computed from the gateway. The contract is an open
list that grows with every Claude Code release; BV-SALA repeats the `bvsala
claude` smoke test against each new version.

The `x-claude-code-session-id` / `agent-id` / `parent-agent-id` headers arrive
in real traffic and are forwarded to the provider untouched. In addition, the
gateway READS the first two and, if they have the shape of an identifier,
attaches their value (`sessionId`, `agentId`) to the usage record it sends to
BiVelio (only with `BIVELIO_SERVICE_KEY`; with no key nothing is sent): this is
what splits the cost per session and per subagent on the dashboard. They are the
ids Claude Code already puts in its own requests, not a person and not content;
`parent-agent-id` is not read. The full list of what travels is in
LICENSE-CLOUD.md §5.

## BYOK note and wording

BV-SALA mode is a **supported configuration of the unmodified binary**, never
"approved by Anthropic" ("Anthropic doesn't endorse, maintain, or audit
third-party gateway products" [V]). Savings are credited only on API-key usage;
the gateway persists no credential, whatever it is.
