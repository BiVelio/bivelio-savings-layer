# Claude Code with DeepSeek (an endpoint in Anthropic's format)

DeepSeek publishes an endpoint compatible with the Anthropic protocol
(`https://api.deepseek.com/anthropic`): the gateway rewrites `/v1/messages` to
`/anthropic/v1/messages` automatically, so Claude Code talks to DeepSeek without
touching its configuration **[V] in a test** (`test/gateway-gemini.test.ts`).

Why it is worth it: DeepSeek's cache reads cost $0.003/1M and off-peak input
$0.15/1M — the most aggressive cheap sibling for Claude traffic.

## Recipe

```bash
bvsala gateway --upstream deepseek --port 8402
ANTHROPIC_BASE_URL=http://127.0.0.1:8402 \
ANTHROPIC_AUTH_TOKEN="$DEEPSEEK_API_KEY" \
ANTHROPIC_MODEL=deepseek-flash \
claude
```

## Notes

- It is metered at list price for `deepseek-flash` and `deepseek-v4-pro` (the
  catalog prices them at PEAK, the conservative side: off-peak is half).
- `deepseek-chat` (the classic alias) has no row of its own: it is forwarded and
  the log says "not metered". Use `deepseek-flash`.
- The quality of the model is your business: the gateway does not route by
  quality, it only meters what you send it.
