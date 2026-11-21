# Kilo Code through the gateway

**Source:** `docs/investigacion/2026-09-27/agentes-de-codigo.md` (code of
`Kilo-Org/kilocode` v7.8.1, 2026-09-25). Since the 7 series, Kilo is a fork of
opencode (`.opencode-version`: v1.18.26): the CLI (`kilo`), the VS Code
extension and the JetBrains one read the same configuration, `kilo.json`, and
the `anthropic` provider is pointed with `provider.anthropic.options.baseURL`.
Its protocol layer appends `/messages` to `https://api.anthropic.com/v1`: **with
`/v1`** [V]. This replaces the previous recipe (a custom provider through the
UI, shape inferred).

## What you need

- Kilo (the `kilo` CLI, or the extension) with the **`anthropic`** provider and your Anthropic **API key**.
- `bvsala` installed. Open core: with no keys the gateway starts in Community mode (free, zero telemetry: it measures every request, and one lever is on by default, cache TTL tuning); `BIVELIO_SERVICE_KEY` only adds the cloud dashboard (see [README](README.md)).

**What does not go through here:** Kilo's default provider is its own gateway
(Kilo Gateway, models hosted by Kilo with its account). That traffic goes to
Kilo, not to a base URL of yours, and is not metered. Neither are the other
providers.

## Wrapper (CLI): `bvsala kilo [args…]`

```bash
# export BIVELIO_SERVICE_KEY=bvk_…  # OPTIONAL: only adds the cloud dashboard; uncomment it with your real key (without it: Community mode)
bvsala kilo
```

Kilo accepts the whole configuration in `KILO_CONFIG_CONTENT` and merges it on
top of the global one and the project one [V]. The wrapper starts an ephemeral
gateway and launches `kilo` with that variable pointing the `anthropic` provider
at `http://127.0.0.1:<port>/v1`. **It writes nothing to disk.** If you already
export your own `KILO_CONFIG_CONTENT`, it merges it and only changes that
`baseURL`; if it is not a JSON object, it refuses before starting without
repeating its value. On exit it prints how many requests it metered and which
ones it forwarded without metering, and why.

## Manual (CLI and extensions): `~/.config/kilo/kilo.json`

```json
{
  "provider": {
    "anthropic": {
      "options": {
        "baseURL": "http://127.0.0.1:8402/v1"
      }
    }
  }
}
```

**With `/v1`, no trailing slash.** Precedence (lowest to highest): global
(`~/.config/kilo/kilo.json`), `KILO_CONFIG`, project (`./kilo.json`,
`.kilo/kilo.json`), `KILO_CONFIG_CONTENT`, managed [V]. Start the gateway
separately with `bvsala gateway`.

## Checking

```
[gateway] POST /v1/messages  · <model> · $0.001234 (in 120, cache↑0 cache↓0, out 8)
```

- `[gateway] POST /messages → 404` → the `/v1` is missing.
- `[gateway] POST /v1/v1/messages → 404` → there is one `/v1` too many.
- nothing in the log → the active model does not belong to the `anthropic` provider (Kilo Gateway?).

## The typical pitfall

- **Gateway off with the config written**: `kilo.json` remembers the base URL;
  without `bvsala gateway` running, Kilo fails until you start it or remove the
  key. The wrapper does not have this pitfall.

## BYOK note

**API key only.** Anthropic forbids using the Claude Pro/Max OAuth in
third-party harnesses; this recipe is the `anthropic` provider with an API key.
