# Qwen Code through the gateway

**Source:** `docs/PASARELA-S3-TERMINALES.md` §3 [V]. Qwen Code with the
Anthropic provider speaks the pure Anthropic dialect (the official TS SDK), so
the current meter understands it without changes. qwen models travel another
way (further down).

## What you need

- `qwen` on the PATH.
- **An Anthropic API key** (`ANTHROPIC_API_KEY`) and a Claude model id in
  `ANTHROPIC_MODEL`, with Qwen Code configured to use the Anthropic auth type.
- `bvsala` installed. Open core: with no keys the gateway starts in Community mode (free, zero telemetry: it measures every request, and one lever is on by default, cache TTL tuning); `BIVELIO_SERVICE_KEY` only adds the cloud dashboard (see [README](README.md)).

## User config: `~/.qwen/settings.json`

The routing needs the `ANTHROPIC_BASE_URL` environment variable **and** Qwen
Code on the Anthropic auth type, which `~/.qwen/settings.json` selects with the
nested key `security.auth.selectedType`:

```json
{
  "security": {
    "auth": {
      "selectedType": "anthropic"
    }
  }
}
```

Keep the rest of your `settings.json`. **[V] in Qwen Code's source (v0.28.3,
2026-11-21):** the settings schema reads `security.auth.selectedType`, the
`--auth-type anthropic` flag overrides it for one run, and only when neither is
set does Qwen Code pick the Anthropic type from `ANTHROPIC_API_KEY`,
`ANTHROPIC_MODEL` and `ANTHROPIC_BASE_URL` together (a complete set of OpenAI
or Gemini variables is checked before them). A top-level
`"selectedType"` is not read; the old flat settings files used
`"selectedAuthType"`, which current Qwen Code moves to
`security.auth.selectedType` on its own. Qwen Code has no default model for the
Anthropic type: export `ANTHROPIC_MODEL` (or set `model.name`).

## Wrapper: `bvsala qwen`

```bash
# export BIVELIO_SERVICE_KEY=bvk_…  # OPTIONAL: only adds the cloud dashboard; uncomment it with your real key (without it: Community mode)
bvsala qwen
```

A mirror of `bvsala claude` with `ANTHROPIC_BASE_URL`. The wrapper **does not
read** `settings.json`: check yourself that `security.auth.selectedType` is
`anthropic` (`bvsala doctor` reminds you of the path), or run
`bvsala qwen --auth-type anthropic` (the arguments go to `qwen` as they are).
The manual recipe below is the same.

## Manual: `ANTHROPIC_BASE_URL`

```bash
bvsala gateway                                         # window 1: http://127.0.0.1:8402
ANTHROPIC_BASE_URL=http://127.0.0.1:8402 ANTHROPIC_MODEL=claude-sonnet-5-5 qwen   # window 2 — NO /v1; any Claude model id
```

No `/v1`: Anthropic's official TS SDK appends `/v1/messages` [V]. No trailing
slash.

## Checking that it works

```
[gateway] POST /v1/messages  · <model> · $0.001234 (in 120, cache↑0 cache↓0, out 8)
```

## The typical pitfall

1. **`/v1` in the base URL** → `[gateway] POST /v1/v1/messages → 404`.
2. **`security.auth.selectedType` is not `anthropic`** (after `/auth` with a
   Qwen account, for example) → the gateway log shows nothing: Qwen Code is
   talking to its default provider, not to you. The same happens if a
   `modelProviders.anthropic` entry for your model has its own `baseUrl`: in Qwen
   Code that wins over `ANTHROPIC_BASE_URL` [V in source].
3. **qwen models (DashScope / Model Studio)** go through Qwen Code's `openai`
   auth type, which this recipe does not route. The gateway can sit in front of
   them with `bvsala gateway --upstream qwen` and the base URL
   `http://127.0.0.1:<port>/compatible-mode/v1` (see
   [OpenAI-compatible upstreams](README.md#openai-compatible-upstreams-keep-the-providers-own-path))
   **[I: not validated with Qwen Code]**.

## BYOK note

**API key only.** Anthropic forbids the Claude Pro/Max OAuth in third-party
harnesses; Qwen Code has been BYOK since April 2026 and so is this recipe.
