# Crush through the gateway

**Source:** `docs/PASARELA-S3-TERMINALES.md` §3 [V]. Crush (Charm) configures
providers through **`~/.config/crush/crushrc`** (a Bash script); `crush.json` is
**deprecated** (verified 2026-08-30). Its Go SDK resolves paths relatively, and
that dictates the shape of the URL: **with `/v1`, no trailing slash**.

## What you need

- `crush` installed.
- `ANTHROPIC_API_KEY` exported (Crush removed its Claude OAuth in January 2026:
  API key only).
- `bvsala` installed. Open core: with no keys the gateway starts in Community mode (free, zero telemetry: it measures every request, and one lever is on by default, cache TTL tuning); `BIVELIO_SERVICE_KEY` only adds the cloud dashboard (see [README](README.md)).

## User config: `~/.config/crush/crushrc`

Add this line:

```bash
provider add bvsala --type anthropic --base-url http://127.0.0.1:8402/v1 --api-key "$ANTHROPIC_API_KEY"
```

And choose the `bvsala` provider in Crush. Not `crush.json`: deprecated.

There is no `bvsala crush` wrapper: the routing is user config. The `bvsala
doctor --write crush` planned in S3 will append that line, commented, to your
`crushrc` (with a `.bak` copy); it does not exist yet, and today `bvsala doctor`
only prints the line.

## Starting and checking

```bash
bvsala gateway        # http://127.0.0.1:8402
crush
```

```
[gateway] POST /v1/messages  · <model> · $0.001234 (in 120, cache↑0 cache↓0, out 8)
```

## The typical pitfall

- **Trailing slash.** `--base-url http://127.0.0.1:8402/v1/` → the Go SDK
  resolves relatively and asks for `/v1/v1/messages` →
  `[gateway] POST /v1/v1/messages → 404` [V]. No slash.
- **No `/v1`** → `[gateway] POST /messages → 404`.
- **`crush.json`** → deprecated; if you have an old one with another provider,
  it may still win. Use `crushrc`.

## BYOK note

**API key only.** Crush already removed its Claude OAuth; the gateway would
forward any credential without blinking, but this is the recipe.
