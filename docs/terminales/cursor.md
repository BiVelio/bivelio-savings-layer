# Cursor (BYOK: your own OpenAI-compatible key)

Cursor only goes through a local gateway when the request is sent with **your**
provider key: its own models travel through Cursor's servers and do not reach
`127.0.0.1` (its usage dashboard meters those).

**Mechanism [I]:** Cursor → Settings → Models → **OpenAI API Base URL**. The
OpenAI-compatible requests made with your key go out to that URL.

## Recipe

1. Start the gateway with the upstream you want (one gateway per upstream):

   ```bash
   bvsala gateway --upstream openai --port 8402
   ```

2. In Cursor: Settings → Models → **OpenAI API Base URL** =
   `http://127.0.0.1:8402/v1` (**with** `/v1`) for `--upstream openai`.
   Another upstream keeps its provider's own path, because the gateway swaps
   only the origin: `http://127.0.0.1:8402/compatible-mode/v1` for `qwen`,
   `…/api/paas/v4` for `glm`, `…/v1beta/openai` for `gemini`, `…/api/v1` for
   `openrouter`, no path for `deepseek`, and `…/v1` for `moonshot`, `minimax`,
   `ollama`, `vllm` and `lmstudio` (the full table:
   [OpenAI-compatible upstreams](README.md#openai-compatible-upstreams-keep-the-providers-own-path)).

3. Add an OpenAI-compatible model with your API key, as you would without the
   gateway.

## What is metered and what is not

- Metered: what Cursor sends with YOUR key to that base URL, at list price for
  the models with a row in the catalog.
- Not metered: Cursor's own models (its usage dashboard is the meter there) and
  streams without `stream_options.include_usage`.

## Checking that it meters

The gateway log has to show `POST /v1/chat/completions …` with a `$` (with
another upstream, its own path: `POST /compatible-mode/v1/chat/completions …`
for `qwen`).
