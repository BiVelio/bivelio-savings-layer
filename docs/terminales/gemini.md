# Gemini CLI

`bvsala gemini` launches the Gemini CLI through the local gateway, without
touching its configuration.

**Mechanism [V]:** the Gemini CLI only speaks the generativelanguage protocol;
the gateway understands it (`:generateContent` and `:streamGenerateContent`,
with `alt=sse` SSE or line-delimited JSON) and reads the `usageMetadata` of
every response. The CLI's `GOOGLE_GEMINI_BASE_URL` points at the gateway, and
your `GEMINI_API_KEY` travels in `x-goog-api-key`, intact.

## Requirements

- `bvsala` installed (`npm i -g @bivelio/savings-layer`). With no keys it starts
  in Community mode; `BIVELIO_SERVICE_KEY` (optional) adds the dashboard.
- The Gemini CLI installed and your `GEMINI_API_KEY` exported.

## One command

```bash
bvsala gemini
```

On exit it prints how many requests it metered and which ones it forwarded
without metering, and why.

## By hand

```bash
bvsala gateway --upstream gemini --port 8402   # the gateway with the Gemini dialect
GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:8402 gemini
```

## Checking that it meters

The gateway log has to show `POST /v1beta/models/…:streamGenerateContent` with
a `$` and the tokens. Models with a list price in the catalog are metered at
list price; one without a row is forwarded and the line says so.
