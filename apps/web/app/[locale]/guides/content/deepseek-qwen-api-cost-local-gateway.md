DeepSeek and Qwen are cheap per token, which makes it easy to stop watching the bill. Both providers cache prompts on their side, and input that hits the cache is billed far below input that misses. So the real cost of your traffic depends on a number most dashboards hide: how many input tokens hit the cache on each request. This guide explains how both providers bill and cache, how to price a request from its usage fields, and how to see it per request with a free local gateway.

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

To avoid touching every call site, put a gateway in front of the provider. [BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) ships one in its npm package: Apache-2.0, local, **no key and no signup**, and nothing is sent to BiVelio. Run one gateway per provider, each on its own port:

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

The same works for Qwen with the other gateway and `OpenAI(base_url="https://dashscope-intl.aliyuncs.com/compatible-mode/v1", ...)`. If an HTTP proxy variable is set, add `NO_PROXY=127.0.0.1,localhost` before creating the client, or requests to the local gateway, provider key included, go through the proxy; version 1.2.5 warns when they would. If no gateway is running, `wrap()` raises `GatewayUnavailable` rather than calling the provider directly, and says how to start one, with no key.

Any other language or tool works too: point its OpenAI base URL at the gateway, and each request becomes one line in the gateway's log, with the model, the cost at list price and the input split into full-price tokens and cache reads (`cache↓`).

One exception matters for chat tools and agents: a **streamed** request that does not ask for usage (`stream_options: {"include_usage": true}`) gets none from the provider, so version 1.2.5 logs it as `not metered: the request did not ask for usage`. Ask for usage in your client, or start the gateway with `BVSALA_GATEWAY_USAGE_INJECT=1`, which adds that option to streams that lack it. The last chunk of those streams then has an empty `choices` list, which code that reads `choices[0]` unchecked does not expect.

## Coding agents on DeepSeek or Qwen

DeepSeek also publishes an Anthropic-format endpoint, and documents how to use it with Claude Code. With `--upstream deepseek`, the gateway sends Anthropic-format requests to that endpoint by itself:

```bash
npx @bivelio/savings-layer gateway --upstream deepseek --port 8402
ANTHROPIC_BASE_URL=http://127.0.0.1:8402 ANTHROPIC_AUTH_TOKEN="$DEEPSEEK_API_KEY" ANTHROPIC_MODEL=deepseek-flash claude
```

On this route the gateway meters but saves nothing: DeepSeek's Anthropic-format endpoint ignores `cache_control` and reports no cache writes ([its guide](https://api-docs.deepseek.com/guides/anthropic_api)), so the default lever has nothing to lower. Running a non-Claude model behind Claude Code is DeepSeek's integration, not a setup Anthropic supports, and the quality of the model for your work is yours to judge.

**Qwen Code on Qwen models** needs a different route: in version 1.2.5, `npx @bivelio/savings-layer qwen` requires Qwen Code's Anthropic auth type and forwards to Anthropic's API, so it only meters Claude models used with an Anthropic key, and refuses a DashScope Anthropic-format base URL. For Qwen models, use Qwen Code's OpenAI-compatible mode, which [its documentation](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/) configures with `OPENAI_API_KEY`, `OPENAI_BASE_URL` and `OPENAI_MODEL`, and point that base URL at a gateway. Set `DASHSCOPE_PROXY_BASE_URL` to exactly the same URL:

```bash
npx @bivelio/savings-layer gateway --upstream https://dashscope-intl.aliyuncs.com --port 8404

GW=http://127.0.0.1:8404/compatible-mode/v1
OPENAI_BASE_URL="$GW" DASHSCOPE_PROXY_BASE_URL="$GW" OPENAI_API_KEY="$DASHSCOPE_API_KEY" OPENAI_MODEL=qwen-plus qwen
```

The second variable matters for the bill. Qwen Code decides from the base URL's host whether it is talking to DashScope, and `127.0.0.1` is not a DashScope host. Without the variable it falls back to its generic OpenAI provider, which sends no explicit-cache markers (`cache_control` and the `X-DashScope-CacheControl` header). Your requests then fall back to Model Studio's implicit cache, where hits typically cost 20 % of the input price and are best effort, instead of the explicit cache's 10 % ([context cache](https://www.alibabacloud.com/help/en/model-studio/context-cache)). Qwen Code treats a base URL that matches `DASHSCOPE_PROXY_BASE_URL` exactly as DashScope, and keeps the markers ([its DashScope provider](https://github.com/QwenLM/qwen-code/blob/8fab857da5/packages/core/src/core/openaiContentGenerator/provider/dashscope.ts), read on 23 November 2026).

We checked the gateway side of this route with version 1.2.5 (both markers pass unchanged), not Qwen Code itself, so read the gateway's log: one line with a cost per request. A `not metered` line says why: usually a stream that does not ask for usage (restart the gateway with `BVSALA_GATEWAY_USAGE_INJECT=1`), or a model with no row in the 1.2.5 catalog, which has `qwen-plus`, `qwen-flash`, `qwen3.7-flash`, `qwen3.8-flash` and `qwen3.8-max` but not, for example, `qwen3-coder-plus`.

Two pricing gaps in 1.2.5 depend on the second variable. **With `DASHSCOPE_PROXY_BASE_URL` set**, as above, Model Studio bills each explicit-cache write at 125 % of the input price and reports it in `usage.prompt_tokens_details.cache_creation_input_tokens`. The 1.2.5 gateway does not read that field: it logs those tokens as ordinary input, with `cache↑0`, at 80 % of what they cost. Its hit price for `qwen-plus` is the explicit cache's 10 %, which matches. **Without the variable** there are no explicit writes, but the hits are implicit ones, billed at about 20 %, and the gateway logs them at the same 10 %, about half their cost.

## What the gateway measures, and what it does not

- **The dollar figure comes from a catalog, not from DeepSeek's time-of-day prices.** Version 1.2.5 has rows for `deepseek-flash` and `deepseek-v4-pro`. For cache misses and output they use DeepSeek's peak price, so in off-peak hours those buckets show twice what DeepSeek bills. For cache hits both rows use $0.003 per million tokens, which is DeepSeek's off-peak hit price for `deepseek-flash` (its peak hit price is twice that) and below both hit prices DeepSeek publishes for `deepseek-v4-pro` ([pricing page](https://api-docs.deepseek.com/quick_start/pricing), read on 23 November 2026). Depending on the hour and on how much of your input hits the cache, the gateway's total can come out above or below the bill. The token counts are exact; compare those first. The classic `deepseek-chat` alias has no row: it is forwarded, and the log says it was not metered.
- **It does not change these requests.** On OpenAI-compatible traffic the gateway measures and forwards (the only exception is the opt-in usage injection above); its saving levers are for Anthropic-format traffic. The saving on DeepSeek and Qwen comes from their own caches, which is why the hit count is the number to watch.

## If you call DeepSeek or Qwen from TypeScript

The BV-SALA SDK talks to any OpenAI-compatible endpoint and skips exact repeats and identical requests in flight, free and with no key ([how that works](/en/guides/deduplicate-llm-requests)). On DeepSeek those avoided calls are reported as `estimated`, not `reference`: version 1.2.5 values a repeat by reference only when the call that ran went to OpenAI's, Anthropic's or Google's own API. One caution for agent loops: its default trimming of superseded tool results rewrites the middle of the history, and on a provider that caches the whole prompt by itself that can cost more than it saves. The project's changelog reports +166 % on a 60-step agent loop on DeepSeek, measured against a fake provider with versions 1.2.3 and 1.2.4 and no key; 1.2.5 trims the same. For agent loops, switch it off per request:

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

Once a day, compare the gateway's totals per model (input, cache hits, output) with the usage page of the DeepSeek platform or Model Studio for the same key. Total token counts should match, with one exception in how they are split: on Qwen, version 1.2.5 counts explicit-cache writes as plain input, not as cache writes. Dollar amounts can differ, in either direction: the catalog ignores DeepSeek's time-of-day prices, on Qwen it prices explicit-cache writes as ordinary input and implicit hits at the explicit rate, and regional prices and discounts change the money too. For a step-by-step method, see [how to verify LLM savings against your provider's bill](/en/guides/verify-llm-savings-against-provider-bill). The gateway's code and its per-terminal guides are on [GitHub](https://github.com/BiVelio/bivelio-savings-layer), and what the project has measured, and what it has not, is on the [benchmarks page](/en/benchmarks).
