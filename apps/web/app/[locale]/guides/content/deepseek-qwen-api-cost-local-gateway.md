DeepSeek and Qwen are cheap per token, which makes it easy to stop watching the bill until it is not small any more. Both providers also cache prompts on their side, and a request that hits the cache is billed at a much lower input price than one that misses. So the real cost of your traffic depends on a number most dashboards hide: how many input tokens hit the cache on each request. This guide explains how both providers bill and cache, how to compute the cost of a request from its usage fields, and how to see it per request for any app or coding agent with a free local gateway.

## How DeepSeek bills a request

DeepSeek splits every request's input in two: tokens that hit its context cache and tokens that miss it, each with its own price, plus the output tokens. Its [context caching](https://api-docs.deepseek.com/guides/kv_cache) is on by default for every account. A hit needs the beginning of the request to match an earlier one exactly, the cache is best effort, and unused entries are cleared after some hours or days. The response tells you what happened:

- `usage.prompt_cache_hit_tokens`: input tokens served from the cache.
- `usage.prompt_cache_miss_tokens`: input tokens processed in full.
- `usage.prompt_tokens_details.cached_tokens`: the same hit count, in the field OpenAI-compatible tools read.

DeepSeek's [pricing page](https://api-docs.deepseek.com/quick_start/pricing) lists the hit, miss and output prices for each model, and an off-peak window at a lower price. Prices change; copy them with the date you read them.

## How Qwen bills a request

Qwen models on Alibaba Cloud Model Studio have two kinds of [context cache](https://www.alibabacloud.com/help/en/model-studio/context-cache). The implicit cache is automatic for prompts above a minimum length, and its hits are billed at a discount. The explicit cache works like Anthropic's: you mark a block with `cache_control`, the entry lives a few minutes, and writing it costs a little more than plain input while reading it costs much less. In the OpenAI-compatible API, the hit count arrives in `usage.prompt_tokens_details.cached_tokens`. Model Studio has regional endpoints, so check which one your key belongs to.

## Make the cache hit, on either provider

The rules are the same as for any prefix cache:

1. Put what never changes first: the system prompt, the tool definitions, long reference text, few-shot examples.
2. Keep it byte-identical between requests: no timestamps, request ids or user names inside it, and tool definitions in a fixed order.
3. Put what changes last: the user's question, the latest tool result.
4. For agents, append to the history instead of rewriting it. Editing an old message in the middle invalidates everything after it.

## Compute the cost of one request

You do not need any tool to price a request. Read the usage block and multiply each bucket by its price:

```python
def request_cost(usage: dict, price_miss: float, price_hit: float, price_out: float) -> float:
    """USD cost of one chat completion. Prices are per million tokens, from the provider's pricing page."""
    details = usage.get("prompt_tokens_details") or {}
    hit = usage.get("prompt_cache_hit_tokens", details.get("cached_tokens", 0)) or 0
    miss = usage["prompt_tokens"] - hit
    return (miss * price_miss + hit * price_hit + usage["completion_tokens"] * price_out) / 1_000_000
```

Log that number with the model, the hit share (`hit / prompt_tokens`) and a timestamp for every request, and you can answer the questions that matter: which feature costs the most, whether the cache hit rate dropped after a deploy, and how much of your traffic falls in the off-peak window.

## See every request with a local gateway

If you would rather not touch every call site, put a gateway in front of the provider. [BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) ships one in its npm package: Apache-2.0, it runs on your machine, needs **no key and no signup**, and sends nothing to BiVelio. One gateway forwards to one provider, so run one per provider on its own port:

```bash
# DeepSeek
npx @bivelio/savings-layer gateway --upstream deepseek --port 8403

# Qwen on Model Studio's international endpoint (`--upstream qwen` is the Beijing one)
npx @bivelio/savings-layer gateway --upstream https://dashscope-intl.aliyuncs.com --port 8404
```

The gateway forwards the path your client sends to the provider, so your base URL is the provider's own with the gateway as host:

| Provider | `--upstream` | Base URL for your OpenAI client |
| --- | --- | --- |
| DeepSeek | `deepseek` | `http://127.0.0.1:8403` |
| Qwen (Beijing) | `qwen` | `http://127.0.0.1:<port>/compatible-mode/v1` |
| Qwen (international) | `https://dashscope-intl.aliyuncs.com` | `http://127.0.0.1:8404/compatible-mode/v1` |
| GLM | `glm` | `http://127.0.0.1:<port>/api/paas/v4` |

`npx @bivelio/savings-layer --help` lists the other upstreams (Moonshot, MiniMax, OpenRouter, Gemini, Ollama, vLLM, LM Studio).

In Python, the package's small client does the base URL for you: build your usual OpenAI client for the provider, and `wrap()` returns a copy that goes through the gateway, keeping the provider's path.

```python
# pip install bivelio-savings-layer openai
import os

import bvsala
from openai import OpenAI

gw = bvsala.Gateway("http://127.0.0.1:8403")  # the DeepSeek gateway started above
deepseek = gw.wrap(OpenAI(base_url="https://api.deepseek.com", api_key=os.environ["DEEPSEEK_API_KEY"]))

resp = deepseek.chat.completions.create(
    model="deepseek-flash",
    messages=[
        {"role": "system", "content": "You review Python diffs for an invented team. House rules: ..."},
        {"role": "user", "content": "Review this diff: ..."},
    ],
)
report = gw.report(resp)
print(report.summary())  # model · basis · cost (in, cached, out)
print(report.tokens.provider_cached_input, report.cost.actual)
```

The same works for Qwen with the other gateway and `OpenAI(base_url="https://dashscope-intl.aliyuncs.com/compatible-mode/v1", ...)`. If you route your traffic through an HTTP proxy, set `NO_PROXY=127.0.0.1,localhost` so requests to the local gateway do not go through it. If no gateway is running, `wrap()` raises `GatewayUnavailable` rather than calling the provider directly. In version 1.2.3 that error message also says the gateway needs a service key: it does not, it starts with none.

Any other language or tool works too: point its OpenAI base URL at the gateway, and each request becomes one line in the gateway's log, with the model, the cost at list price and the input split into full-price tokens and cache reads (`cache↓`).

## Coding agents on DeepSeek or Qwen

DeepSeek also publishes an Anthropic-format endpoint, and documents how to use it with Claude Code. With `--upstream deepseek`, the gateway sends Anthropic-format requests to that endpoint by itself:

```bash
npx @bivelio/savings-layer gateway --upstream deepseek --port 8402
ANTHROPIC_BASE_URL=http://127.0.0.1:8402 ANTHROPIC_AUTH_TOKEN="$DEEPSEEK_API_KEY" ANTHROPIC_MODEL=deepseek-flash claude
```

Running a non-Claude model behind Claude Code is DeepSeek's integration, not a setup Anthropic supports, and the quality of the model for your work is yours to judge. For Qwen Code, `npx @bivelio/savings-layer qwen` launches it through the gateway.

## What the gateway measures, and what it does not

- **Metering is at list price.** The gateway prices each request with a versioned catalog. In version 1.2.3 it has rows for `deepseek-flash` and `deepseek-v4-pro`, priced at the peak rate, so off-peak traffic shows a higher cost than DeepSeek bills. The classic `deepseek-chat` alias has no row: it is forwarded, and the log says it was not metered.
- **It does not change these requests.** On OpenAI-compatible traffic the gateway measures and forwards; its saving levers are for Anthropic-format traffic. The saving on DeepSeek and Qwen comes from their own caches, which is why the hit count is the number to watch.

## If you call DeepSeek or Qwen from TypeScript

The BV-SALA SDK talks to any OpenAI-compatible endpoint and skips exact repeats and identical requests in flight, free and with no key ([how that works](/en/guides/deduplicate-llm-requests)). One caution for agent loops: its default trimming of superseded tool results rewrites the middle of the history, and on a provider that caches the whole prompt by itself that can cost more than it saves. The project's changelog reports +166 % on a 60-step agent loop on DeepSeek, measured against a fake provider with versions 1.2.3 and 1.2.4 and no key. For agent loops, switch it off per request:

```ts
// npm i @bivelio/savings-layer   (ESM: a "type": "module" project or a .mts file)
import { createSavingsLayer, OpenAICompatibleProvider } from "@bivelio/savings-layer";

const layer = createSavingsLayer({
  provider: new OpenAICompatibleProvider({ baseUrl: "https://api.deepseek.com/v1", apiKey: process.env.DEEPSEEK_API_KEY }),
});

const { text, report } = await layer.generate({
  model: "deepseek-flash",
  messages: [{ role: "user", content: "Explain what a race condition is in two sentences." }],
  savings: { elision: false }, // keep the history byte-identical for DeepSeek's own cache
});
console.log(text, report.tokens.providerCachedInput, report.cost.basis);
```

## Check the numbers against your provider

Once a day, compare the gateway's totals per model (input, cache hits, output) with the usage page of the DeepSeek platform or Model Studio for the same key. Token counts should match. Dollar amounts can differ for a known reason: the catalog's list price against your real price (off-peak hours, regional prices, discounts). For a step-by-step method, see [how to verify LLM savings against your provider's bill](/en/guides/verify-llm-savings-against-provider-bill). The gateway's code and its per-terminal guides are on [GitHub](https://github.com/BiVelio/bivelio-savings-layer), and what the project has measured, and what it has not, is on the [benchmarks page](/en/benchmarks).
