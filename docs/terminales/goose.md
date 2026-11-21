# Goose through the gateway

**Source:** `docs/PASARELA-S3-TERMINALES.md` §3 [V]. Goose speaks the pure
Anthropic dialect and authenticates with `x-api-key` + `anthropic-version`,
which the forwarding passes intact: **nothing to change in the gateway**, it is
all in the shape of the URL.

## What you need

- `goose` on the PATH, with the Anthropic provider chosen.
- `ANTHROPIC_API_KEY` exported (Goose is BYOK only).
- `bvsala` installed. Open core: with no keys the gateway starts in Community mode (all the local saving, zero telemetry); `BIVELIO_SERVICE_KEY` adds the dashboard and the org's entitlements (see [README](README.md)).

## Wrapper: `bvsala goose`

```bash
export BIVELIO_SERVICE_KEY=bvk_…  # OPTIONAL: dashboard + org entitlements (without it: Community mode)
bvsala goose                       # an exact mirror of `bvsala claude`
```

An exact mirror of `bvsala claude`: an ephemeral gateway, `goose` launched with
`ANTHROPIC_HOST=http://127.0.0.1:<port>`, everything dies on exit. The table
lives in `gateway/envoltorios.ts`. The manual recipe below is literally the
same.

## Manual: `ANTHROPIC_HOST`

```bash
bvsala gateway                                        # window 1: http://127.0.0.1:8402
ANTHROPIC_HOST=http://127.0.0.1:8402 goose            # window 2 — NO /v1
```

`ANTHROPIC_HOST` **overrides** whatever is in `config.yaml` [V], so there is no
need to touch any file. No `/v1`, no trailing slash: Goose appends
`/v1/messages` on its own.

## Checking that it works

```
[gateway] POST /v1/messages  · <model> · $0.001234 (in 120, cache↑0 cache↓0, out 8)
```

## The typical pitfall

- **`/v1` in `ANTHROPIC_HOST`** → `[gateway] POST /v1/v1/messages → 404`. Remove it.
- **Writing the host in `config.yaml`** instead of the variable: it works, but
  it stays fixed and Goose fails every time the gateway is not running. The
  per-session environment variable is the way; the env overrides the file
  anyway.

## BYOK note

**API key only.** Anthropic forbids using the Claude Pro/Max OAuth in
third-party harnesses; Goose is BYOK and so is this recipe. The gateway would
forward any credential without blinking — that is not a recipe.
