# Aider through the gateway

**Source:** `docs/investigacion/2026-09-27/agentes-de-codigo.md`: code of
`Aider-AI/aider` (branch `main` at 2026-05-22; the latest published release is
v0.86, from August 2025) and of `BerriAI/litellm` 1.82.3, the version aider's
`main` pins. Aider calls the models through litellm, so the variables that count
are litellm's [V].

## What you need

- `aider` on the PATH and your **API key** (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`).
- `bvsala` installed. Open core: with no keys it starts in Community mode; `BIVELIO_SERVICE_KEY` (optional) adds the cloud dashboard (see [README](README.md)).

## Wrapper: `bvsala aider [args…]`

```bash
bvsala aider                                            # Anthropic models
BVSALA_GATEWAY_UPSTREAM=openai bvsala aider --model gpt-…   # OpenAI models
```

A gateway talks to a single provider, so the wrapper routes one:

- **Anthropic (the default).** With `ANTHROPIC_API_KEY` present, aider picks
  Sonnet by default [V]. The wrapper exports `ANTHROPIC_API_BASE`, which litellm
  reads **before** `ANTHROPIC_BASE_URL`, and litellm appends `/v1/messages` if
  the URL does not end that way: **no `/v1`** [V].
- **OpenAI**, with `BVSALA_GATEWAY_UPSTREAM=openai`: it exports
  `OPENAI_BASE_URL` and `OPENAI_API_BASE` (litellm reads them in that order),
  **with `/v1`** [V].

Whatever does not belong to the routed provider goes direct and is not metered
(a weak model from another provider, for example). On exit, the wrapper prints
how many requests it metered and which ones it forwarded without metering, and
why.

### The OpenAI pitfall: usage in streams

litellm only adds `stream_options: {"include_usage": true}` when it talks to
`api.openai.com` **directly** (`get_stream_options`: no `api_base`, or host
`api.openai.com`) [V]. Behind the gateway the host is `127.0.0.1`, so OpenAI
streams **do not ask for their counter** and are forwarded without metering. Two
ways out:

```bash
BVSALA_GATEWAY_UPSTREAM=openai BVSALA_GATEWAY_USAGE_INJECT=1 bvsala aider --model gpt-…
BVSALA_GATEWAY_UPSTREAM=openai bvsala aider --model gpt-… --no-stream
```

The first one adds the option in the gateway (the last chunk arrives with an
empty `choices`, the same thing aider receives when it talks to OpenAI
directly); the second asks for whole responses, which carry the `usage` in the
JSON. Anthropic does not have this pitfall: its stream always carries the
counter.

## Manual

```bash
bvsala gateway                                           # 8402, Anthropic
ANTHROPIC_API_BASE=http://127.0.0.1:8402 aider           # NO /v1

bvsala gateway --upstream openai --port 8403
OPENAI_API_BASE=http://127.0.0.1:8403/v1 aider --model gpt-…   # WITH /v1
```

## The typical pitfall

- `--openai-api-base` on the command line or `openai-api-base:` in
  `.aider.conf.yml` override the variable (aider rewrites it on startup) [V].
- An `api_base` in `extra_params` of `.aider.model.settings.yml` wins over
  everything: that request does not go through the gateway.

## What aider already measures

Aider shows tokens and cost per message, with litellm's prices; when the
response carries no `usage`, it counts the tokens with its local tokenizer,
which is an estimate [V]. The gateway adds the provider's counter on every
request, the notice of what it could not meter and the team dashboard.
