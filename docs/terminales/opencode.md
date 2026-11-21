# opencode through the gateway

**Source:** `docs/PASARELA-S3-TERMINALES.md` §3 [V] and
`docs/investigacion/2026-09-27/agentes-de-codigo.md` (code of
`anomalyco/opencode` v1.18.32, 2026-09-27). opencode routes through
**configuration**, and its protocol layer appends `/messages` to
`https://api.anthropic.com/v1` by default: that is why the URL carries `/v1`
here [V].

## What you need

- `opencode` installed, the `anthropic` provider with your Anthropic **API key**.
- `bvsala` installed. Open core: with no keys the gateway starts in Community mode (free, zero telemetry: it measures every request, and one lever is on by default, cache TTL tuning); `BIVELIO_SERVICE_KEY` only adds the cloud dashboard (see [README](README.md)).

## Wrapper: `bvsala opencode [args…]`

```bash
export BIVELIO_SERVICE_KEY=bvk_…  # OPTIONAL: only adds the cloud dashboard (without it: Community mode)
bvsala opencode
```

opencode accepts the whole configuration in the `OPENCODE_CONFIG_CONTENT`
variable and merges it **on top of** the global one and the project one
(`config.ts`: it is loaded after the global `opencode.json`, the project one and
`.opencode/`; only the remote account config and the one managed by the company
come later) [V]. The wrapper starts an ephemeral gateway and launches `opencode`
with that variable pointing `provider.anthropic.options.baseURL` at
`http://127.0.0.1:<port>/v1`. **It writes nothing to disk** and everything dies
on exit.

- If you already export your own `OPENCODE_CONFIG_CONTENT`, the wrapper
  **merges** it: it only changes `provider.anthropic.options.baseURL`; your key,
  your models and the rest stay the same. If it is not a JSON object (JSONC with
  comments, for example), it refuses before starting and does not repeat its
  value.
- Only the `anthropic` provider goes through the gateway. The other providers
  (OpenAI, OpenCode Zen, OpenRouter…) go direct and are not metered.
- On exit it prints how many requests it metered and which ones it forwarded
  without metering, and why.

## Manual: `~/.config/opencode/opencode.json`

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

**With `/v1`, no trailing slash.** It is the
`provider.anthropic.options.baseURL` key [V]. The project `opencode.json`
overrides the global one: if you have one in the repo, that is the one that
wins.

### Alternative [V]: `baseURL` from an environment variable

```json
{ "provider": { "anthropic": { "options": { "baseURL": "{env:BVSALA_BASE_URL}" } } } }
```

Written once, it enables a pure-env use (`BVSALA_BASE_URL=http://127.0.0.1:8402/v1 opencode`).
**Pitfall:** without the variable, the `baseURL` is empty and opencode does not
work.

## Starting and checking

```bash
bvsala gateway        # http://127.0.0.1:8402
opencode
```

```
[gateway] POST /v1/messages  · <model> · $0.001234 (in 120, cache↑0 cache↓0, out 8)
```

## The typical pitfall

- **No `/v1`** → opencode asks for `http://127.0.0.1:8402/messages` → `[gateway] POST /messages → 404`.
- **Trailing slash** (`…/v1/`) → no.
- **A project config** with another `baseURL` overriding the global one without
  you knowing (it does not happen with the wrapper: its variable wins over
  both).
- **Gateway off with the config written**: opencode fails until you start
  `bvsala gateway` again. The config is persistent; the gateway is not. (The
  `{env:…}` variant without exporting the variable also fails, because it is
  empty.) The wrapper does not have this pitfall.

## BYOK note

**API key only.** opencode expressly documents that the Claude Pro/Max OAuth
cannot be used in third-party harnesses; this recipe respects that.
