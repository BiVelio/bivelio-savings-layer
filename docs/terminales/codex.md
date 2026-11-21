# Codex CLI through the gateway

**Source:** `docs/PASARELA-S3-TERMINALES.md` §2 (code of `openai/codex`,
`openai-node` and OpenAI's docs, 2026-08-30). **Status: wrapper in the package
and validated by hand on 30 Aug** (a real Codex v0.134 session with ChatGPT
auth: 426 → HTTP fallback, stream intact, a `measured` record in ingestion).
Read "What it meters" and the pending validations before announcing figures.

## What you need

- `codex` on the PATH.
- A Codex login: an **OpenAI API key** (the case with a per-token invoice) or a
  ChatGPT subscription (it is routed and metered at list-price equivalent,
  **with no saving credited**: there is no per-token invoice; see below).
- `bvsala` installed. Open core: with no keys the gateway starts in Community mode (free, zero telemetry: it measures every request, and one lever is on by default, cache TTL tuning); `BIVELIO_SERVICE_KEY` only adds the cloud dashboard (see [README](README.md)).

## Wrapper: `bvsala codex [args…]`

```bash
export BIVELIO_SERVICE_KEY=bvk_…  # OPTIONAL: only adds the cloud dashboard (without it: Community mode)
bvsala codex                       # every argument is passed as is to codex
```

A mirror of `bvsala claude`: an ephemeral gateway with the right upstream +
`spawn("codex", ["-c", 'openai_base_url="http://127.0.0.1:<port><prefix>"', ...rest])`
(a quoted TOML string: "values are parsed as TOML", official docs). Why this way
and not through an environment variable:

- `-c` is a global flag with the **highest precedence** [V]; there is **no**
  `OPENAI_BASE_URL` env in Codex (zero references in its config code) [V].
- With no config written, the setting dies with the process: nothing is left
  pointing at a gateway that is no longer running.
- **The prefix depends on the auth mode** [V `AuthDotJson`, `to_api_provider`]:
  `ApiKey` → upstream `https://api.openai.com`, prefix `/v1`; the whole ChatGPT
  family → upstream `https://chatgpt.com`, prefix `/backend-api/codex`. The
  wrapper reads `auth_mode` from `~/.codex/auth.json` **by existence/enum value,
  it never prints tokens**; `BVSALA_CODEX_AUTH=api-key|chatgpt` forces it.

## Manual (API key): `-c openai_base_url=…`

```bash
BVSALA_GATEWAY_UPSTREAM=https://api.openai.com bvsala gateway     # window 1: http://127.0.0.1:8402
codex -c openai_base_url=http://127.0.0.1:8402/v1                 # window 2 — WITH /v1, no trailing slash
```

Codex appends `/responses` (`POST {base_url}/responses`, always `stream: true`)
[V]. If you already have the Anthropic gateway on 8402 for other terminals,
start this one on another port (`--port 8403`) and point there: a gateway talks
to a single upstream.

Do not write it in `~/.codex/config.toml`: it would stay fixed there and Codex
would fail every time the gateway is not running. The per-session `-c` is the
way.

## Checking that it works

In the gateway log you will see, in this order, the real session (30 Aug):

```
[gateway] GET /backend-api/codex/models → 200
[gateway] GET /backend-api/codex/responses → 426 (WebSocket not supported; the client falls back to HTTP)
[gateway] POST /backend-api/codex/responses → client closed after the final usage; metered anyway
[gateway] POST /backend-api/codex/responses  · gpt-5.5 · $0.210766 (in 41880, cache↑0 cache↓2432, out 5)
```

(With an API key the route is `/v1/responses`.) The line with a `$` is the
measurement.

**What it meters:** the `usage` of `event: response.completed` with OpenAI's
official formula (`uncached input = input − cached − writes`; `cached` at the catalog's
cached rate; `writes` at 1.25×, the official premium of gpt-5.6+) [V]. Three
things real traffic taught and the gateway already handles:

- Codex **closes the connection as soon as it receives `response.completed`**;
  the gateway meters anyway with the usage it already observed ("metered anyway"
  in the log).
- The ChatGPT backend serves the SSE **without a `content-type` header**; on the
  `…/responses` routes the gateway assumes SSE if it is missing.
- Codex sends the request body **compressed with zstd**; the gateway forwards it
  intact and reads the `model` through the `content-encoding` (Node ≥ 22.15 for
  zstd; on a Node without zstd the request goes through and is not metered).

## The typical pitfall

1. **The prefix.** With an API key it is **exactly** `/v1`. With the ChatGPT
   family the base_url has to end **exactly** in `/backend-api/codex` or
   `supports_codex_backend_routes()` switches off [V]. Mixing them = a silent
   404.
2. **A `failed to connect to websocket: HTTP error: 426` line** on startup is
   normal: Codex tries WebSocket first (`supports_websockets: true` is hardcoded
   and cannot be turned off by config [V]); the gateway answers `426 Upgrade
   Required` and the fallback to HTTP is immediate and sticky per session [V
   test `websocket_fallback.rs`]. No "Reconnecting…".
3. **`failed to refresh available models: unknown variant …`** comes from your
   Codex version against its backend: it appears just the same **without** the
   gateway (checked).
4. **Trailing slash.** `…/v1/` no.

## ChatGPT subscription mode — validated, metered, no saving credited

Validated by hand on 30 Aug (prefix `/backend-api/codex`, upstream
`https://chatgpt.com`): 200, stream intact, `usage` present in
`response.completed` and a `measured` record in ingestion. **But a subscriber
does not pay per token**: the figure they see is the list-price equivalent for
an API key, not an invoice; that is why this traffic is **credited no saving** —
the same as the subscription OAuth in Claude Code (`docs/PASARELA-F0.md`). (The
commission on measured savings was an earlier plan and is closed: today the
gateway is free and the only thing paid for is Savings Cloud, which is
optional.) OpenAI neither blesses nor forbids proxying a subscription (silence
from its staff, unlike Anthropic, which documents it). The stance is identical
to Claude Code's: zero persistence of `Authorization` / `ChatGPT-Account-ID`, an
unmodified binary, and it is not promoted as a saving mode.

**Zero saving by design:** the gateway classifies as subscription the traffic
of `/backend-api/…` or with a chatgpt.com upstream (and Claude Code's with
`anthropic-beta: oauth-*`) and credits it no saving: `baseline == actual`. The
gap that remains: the record carries no label of its own on the wire, so the
dashboard does not tell a subscription from an API key (it needs a migration;
outside this front).

## Validations by hand

- ✅ (b) ChatGPT subscription: 426 → fallback, 200, stream intact, `usage`
  present, a `measured` record (30 Aug).
- ⏳ (a) A session with an **API key** (route `/v1/responses` against
  api.openai.com): same mechanics, pending an account with an API key.
- ⏳ (c) Plausibility of `cached + writes ≤ input` on a repeated prompt of more
  than 1,024 tokens (OpenAI acknowledged wrong counters at the launch of 5.6).
  The gateway already clamps to the side that under-measures if it does not add
  up.
- ⏳ Compare the gateway's figure with the provider's console on a long session
  (Codex prints its own "tokens used"; BV-SALA's source is the provider's
  `usage`, not that counter).

## BYOK note

The documented recipe is **API key only**. The gateway persists no credential;
savings are credited only on API-key usage.
