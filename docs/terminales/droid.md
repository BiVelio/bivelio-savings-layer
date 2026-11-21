# Droid (Factory) through the gateway

**Source:** `docs/PASARELA-S3-TERMINALES.md` §3. Droid is **closed source**; the
routing mechanism is verified [V] (`~/.factory/settings.json` →
`customModels[]` with `provider: "anthropic"`), but **the shape of the base URL
is inferred [I]: it has to be validated by hand against the gateway log.** This
guide says so plainly; no validation has been done.

## What you need

- `droid` installed, in BYOK mode with your Anthropic **API key**.
- `bvsala` installed. Open core: with no keys the gateway starts in Community mode (all the local saving, zero telemetry); `BIVELIO_SERVICE_KEY` adds the dashboard and the org's entitlements (see [README](README.md)).

## User config: `~/.factory/settings.json`

```json
{
  "customModels": [
    {
      "provider": "anthropic",
      "baseUrl": "http://127.0.0.1:8402",
      "apiKey": "<your ANTHROPIC_API_KEY>"
    }
  ]
}
```

The verified keys [V] are `customModels[]{provider:"anthropic", baseUrl,
apiKey}`. The shape **without `/v1`** is inferred [I]. Keep the rest of your
`settings.json` (the `doctor --write droid` planned in S3 will do the
conservative JSON merge with a `.bak` copy; it does not exist yet, and today
`bvsala doctor` only prints the block).

## Validate by hand (mandatory before you trust it)

1. `bvsala gateway` in one window.
2. Launch `droid` with that custom model and ask a trivial question.
3. Look at the gateway log:
   - `[gateway] POST /v1/messages  · <model> · $…` → the shape without `/v1` is
     the right one. Confirm it in S3 (move the [I] to [V]).
   - `[gateway] POST /messages → 404` → Droid only appends `/messages`: change
     the `baseUrl` to `http://127.0.0.1:8402/v1` and repeat.
   - nothing in the log → Droid is not reading the custom model; check that it
     is the selected model.

## The typical pitfall

- **Guessing the `/v1`**: that is why the validation step exists. A malformed
  URL fails silently (a 404 from the upstream, not metered).
- **The API key goes in the JSON**: it is user config on your machine; do not
  copy it to any repo or paste it in a ticket.

## BYOK note

**API key only.** Droid is BYOK; Anthropic forbids the Claude Pro/Max OAuth in
third-party harnesses, and this recipe does not cover it.
