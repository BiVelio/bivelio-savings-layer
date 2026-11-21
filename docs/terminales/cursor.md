# Cursor (BYOK: your own OpenAI-compatible key)

Cursor only goes through a local gateway when the request is sent with **your**
provider key: its own models travel through Cursor's servers and do not reach
`127.0.0.1` (its usage dashboard meters those).

**Mechanism [I]:** Cursor → Settings → Models → **OpenAI API Base URL**. The
OpenAI-compatible requests made with your key go out to that URL.

## Recipe

1. Start the gateway with the upstream you want:

   ```bash
   bvsala gateway --upstream openai --port 8402    # deepseek, qwen, glm, moonshot, ollama… too
   ```

2. In Cursor: Settings → Models → **OpenAI API Base URL** =
   `http://127.0.0.1:8402/v1` (**with** `/v1`).

3. Add an OpenAI-compatible model with your API key, as you would without the
   gateway.

## What is metered and what is not

- Metered: what Cursor sends with YOUR key to that base URL, at list price for
  the models with a row in the catalog.
- Not metered: Cursor's own models (its usage dashboard is the meter there) and
  streams without `stream_options.include_usage`.

## Checking that it meters

The gateway log has to show `POST /v1/chat/completions …` with a `$`.
