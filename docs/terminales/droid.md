# Droid (Factory) through the gateway

**Source:** `docs/PASARELA-S3-TERMINALES.md` §3 and Factory's BYOK docs
(<https://docs.factory.com/cli/byok/overview>, read on 2026-11-22). Droid is
**closed source**; the routing mechanism is in its official docs [V]
(`~/.factory/settings.json` → `customModels[]` with `provider: "anthropic"`), and
so is the base URL without `/v1` (they give `https://api.anthropic.com` for
this provider), but **it has not been validated by hand against the gateway
log yet.** This guide says so plainly.

## What you need

- `droid` installed, in BYOK mode with your Anthropic **API key**.
- `bvsala` installed. Open core: with no keys the gateway starts in Community mode (free, zero telemetry: it measures every request, and one lever is on by default, cache TTL tuning); `BIVELIO_SERVICE_KEY` only adds the cloud dashboard (see [README](README.md)).

## User config: `~/.factory/settings.json`

```json
{
  "customModels": [
    {
      "model": "<Anthropic model id>",
      "displayName": "<display name>",
      "provider": "anthropic",
      "baseUrl": "http://127.0.0.1:8402",
      "apiKey": "<your Anthropic API key>"
    }
  ]
}
```

It is the same block `bvsala doctor` prints. The fields, from Factory's BYOK
docs [V]: `model` (required: the model id sent to the API, such as
`claude-sonnet-5-5`), `displayName` (the label under **Custom Models** in
`/model`), `provider`, `baseUrl` and `apiKey` (Factory also accepts an
environment variable reference there, such as `${ANTHROPIC_API_KEY}`). Keep the
rest of your `settings.json` (the `doctor --write droid` planned in S3 will do
the conservative JSON merge with a `.bak` copy; it does not exist yet, and today
`bvsala doctor` only prints the block).

## Validate by hand (mandatory before you trust it)

1. `bvsala gateway` in one window.
2. Launch `droid` with that custom model and ask a trivial question.
3. Look at the gateway log:
   - `[gateway] POST /v1/messages  · <model> · $…` → the shape without `/v1` is
     the right one. Record it in S3 as validated by hand.
   - `[gateway] POST /messages → 404` → Droid only appends `/messages`: change
     the `baseUrl` to `http://127.0.0.1:8402/v1` and repeat.
   - nothing in the log → Droid is not reading the custom model; check that it
     is the selected model (`/model` → **Custom Models**, by its `displayName`).

## The typical pitfall

- **Guessing the `/v1`**: that is why the validation step exists. A malformed
  URL fails silently (a 404 from the upstream, not metered).
- **The API key goes in the JSON**: it is user config on your machine; do not
  copy it to any repo or paste it in a ticket.

## BYOK note

**API key only.** Droid is BYOK; Anthropic forbids the Claude Pro/Max OAuth in
third-party harnesses, and this recipe does not cover it.
