# Ollama, vLLM and LM Studio (local models)

The gateway can also sit in front of a local OpenAI-compatible server: useful to
give an agent a free local tier while the gateway keeps metering the paid calls.

```bash
bvsala gateway --upstream ollama --port 8402    # http://localhost:11434
bvsala gateway --upstream vllm --port 8402      # http://localhost:8000
bvsala gateway --upstream lmstudio --port 8402  # http://localhost:1234
```

Then point any OpenAI SDK at `http://127.0.0.1:8402/v1` (**with** `/v1`).

**Honesty about the measurement:** local models have no list price, so this
traffic is forwarded and the log says so (`not metered: model "…" has no list
price in the catalog`). Nothing is credited in dollars; the value is
operational: a single base URL for every model, with the metering of the paid
providers working alongside.
